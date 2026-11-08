import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLMError,
  callModel,
  chatCompletionsUrl,
  extractJson,
  normalizeModelResult
} from '../lib/llm.mjs';

function modelResponse(content, status = 200) {
  return new Response(
    JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content } }],
      usage: { total_tokens: 10 }
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

test('兼容地址拼接', () => {
  assert.equal(
    chatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/chat/completions'
  );
  assert.equal(
    chatCompletionsUrl('https://api.openai.com/v1/'),
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(
    chatCompletionsUrl('https://example.com/chat/completions'),
    'https://example.com/chat/completions'
  );
});

test('从纯 JSON、代码围栏与混杂文本中提取 JSON', () => {
  assert.deepEqual(extractJson('{"reply":"hi"}'), { reply: 'hi' });
  assert.deepEqual(extractJson('```json\n{"reply":"hi"}\n```'), { reply: 'hi' });
  assert.deepEqual(extractJson('前言 {"reply":"hi"} 后记'), { reply: 'hi' });
  assert.equal(extractJson('不是 JSON'), null);
  assert.equal(extractJson(''), null);
});

test('模型结果会被清洗并限制记忆数量', () => {
  const result = normalizeModelResult({
    reply: '  我在听。  ',
    memories: [
      { category: 'basic', key: 'name', value: '林一', confidence: 2 },
      { category: 'bad', key: 'x', value: 'x' },
      { category: 'preference', key: 'like', value: '下雨天' }
    ],
    habitNotes: ['喜欢短句', '情绪浓度高']
  });
  assert.equal(result.reply, '我在听。');
  assert.equal(result.memories.length, 2);
  assert.equal(result.memories[0].confidence, 1);
  assert.deepEqual(result.habitNotes, ['喜欢短句', '情绪浓度高']);
});

test('解析失败时回退原始文本', () => {
  const result = normalizeModelResult(null, '```\n我在这里。\n```');
  assert.equal(result.reply, '我在这里。');
  assert.deepEqual(result.memories, []);
  assert.throws(() => normalizeModelResult(null, ''), LLMError);
});

test('callModel 成功解析 OpenAI 兼容响应', async () => {
  let captured = null;
  const fakeFetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return modelResponse('{"reply":"嗯，我在听。","memories":[],"habitNotes":["喜欢短句"]}');
  };
  const result = await callModel({
    config: {
      key: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat'
    },
    systemPrompt: 'system',
    messages: [{ role: 'user', text: '你好' }],
    fetchImpl: fakeFetch
  });
  assert.equal(result.reply, '嗯，我在听。');
  assert.deepEqual(result.habitNotes, ['喜欢短句']);
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.model, 'deepseek-chat');
  assert.equal(captured.body.response_format.type, 'json_object');
});

test('不支持 response_format 时自动去掉重试', async () => {
  let calls = 0;
  const bodies = [];
  const fakeFetch = async (url, options) => {
    calls += 1;
    bodies.push(JSON.parse(options.body));
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return modelResponse('{"reply":"好。"}');
  };
  const result = await callModel({
    config: { key: 'k', baseUrl: 'https://example.com', model: 'm' },
    systemPrompt: 's',
    messages: [{ role: 'user', text: 'hi' }],
    fetchImpl: fakeFetch
  });
  assert.equal(result.reply, '好。');
  assert.equal(calls, 2);
  assert.ok(bodies[0].response_format);
  assert.equal(bodies[1].response_format, undefined);
});

test('连续 5xx 会抛 LLMError', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: { message: 'upstream down' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  await assert.rejects(
    () =>
      callModel({
        config: { key: 'k', baseUrl: 'https://example.com', model: 'm' },
        systemPrompt: 's',
        messages: [{ role: 'user', text: 'hi' }],
        fetchImpl: fakeFetch
      }),
    (error) => error instanceof LLMError && error.status === 500
  );
});

test('没有 Key 时立即失败，不会抛出网络请求', async () => {
  await assert.rejects(
    () =>
      callModel({
        config: { key: '', baseUrl: 'https://example.com', model: 'm' },
        systemPrompt: 's',
        messages: []
      }),
    (error) => error instanceof LLMError && error.message === 'missing_api_key'
  );
});
