import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from '../server.mjs';
import { loadConfig } from '../lib/config.mjs';

function requestPath(port, pathValue) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathValue, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('HTTP 服务：静态资源、健康接口、本地聊天与安全边界', async (t) => {
  const config = {
    ...loadConfig({}),
    host: '127.0.0.1',
    port: 0,
    enabled: false,
    maxBodyBytes: 256 * 1024
  };
  const server = createAppServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    await t.test('首页与安全响应头', async () => {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes('回声'));
      assert.ok(html.includes('/js/app.js'));
      assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
    });

    await t.test('健康接口说明本地模式与概率', async () => {
      const response = await fetch(`${base}/api/health`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.ok, true);
      assert.equal(data.llm.enabled, false);
      assert.deepEqual(
        data.personas.map((persona) => persona.weight),
        [30, 15, 25, 30]
      );
    });

    await t.test('无 Key 时聊天接口返回本地模式', async () => {
      const response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: 'gentle',
          messages: [{ role: 'user', text: '你好' }],
          memories: [],
          traits: {},
          habitNotes: []
        })
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.mode, 'local');
      assert.equal(data.reason, 'no_api_key');
    });

    await t.test('具体角色与无人设也能通过本地模式校验', async () => {
      for (const payload of [
        {
          personaId: 'suwanqing',
          gender: 'female',
          selectionMode: 'specific',
          messages: [{ role: 'user', text: '你好' }]
        },
        {
          personaId: 'none',
          gender: 'male',
          selectionMode: 'none',
          messages: [{ role: 'user', text: '你好' }]
        }
      ]) {
        const response = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).mode, 'local');
      }
    });

    await t.test('空话题角色开场允许没有消息，普通空对话仍拒绝', async () => {
      const opening = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: 'suwanqing',
          gender: 'female',
          selectionMode: 'specific',
          messages: [],
          isOpening: true,
          openingGreeting: false,
          openingMode: 'empty'
        })
      });
      assert.equal(opening.status, 200);
      assert.equal((await opening.json()).mode, 'local');

      const empty = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: 'suwanqing',
          messages: [],
          isOpening: false
        })
      });
      assert.equal(empty.status, 400);
    });

    await t.test('非法人格与错误方法被拒绝', async () => {
      const badPersona = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId: 'bad', messages: [{ role: 'user', text: 'hi' }] })
      });
      assert.equal(badPersona.status, 400);

      const wrongMethod = await fetch(`${base}/api/chat`);
      assert.equal(wrongMethod.status, 405);

      const unknown = await fetch(`${base}/api/nope`);
      assert.equal(unknown.status, 404);
    });

    await t.test('目录穿越被拒绝', async () => {
      const result = await requestPath(port, '/..%2Fserver.mjs');
      assert.equal(result.status, 404);
    });

    await t.test('超大请求体返回 413', async () => {
      const body = JSON.stringify({
        personaId: 'gentle',
        messages: [{ role: 'user', text: 'x'.repeat(300 * 1024) }]
      });
      const response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      assert.equal(response.status, 413);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('配置 Key 时健康接口显示云端，模型失败返回 502 供前端降级', async () => {
  const config = {
    ...loadConfig({}),
    host: '127.0.0.1',
    port: 0,
    enabled: true,
    key: 'test-key',
    baseUrl: 'http://127.0.0.1:1',
    model: 'test-model'
  };
  const server = createAppServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.llm.enabled, true);
    assert.equal(health.llm.model, 'test-model');

    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personaId: 'gentle',
        messages: [{ role: 'user', text: '你好' }],
        memories: [],
        traits: {},
        habitNotes: []
      })
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error, 'llm_unavailable');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
