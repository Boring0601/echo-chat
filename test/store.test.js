import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  appendMessage,
  countMessages,
  countUserMessages,
  createInitialData,
  createTopic,
  exportPayload,
  findTopic,
  listUserMessages,
  loadData,
  sanitizeData,
  saveData,
  titleFromText
} from '../public/js/store.js';

class FakeStorage {
  constructor(limit = Infinity) {
    this.map = new Map();
    this.limit = limit;
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    if (value.length > this.limit) {
      const error = new Error('QuotaExceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.map.set(key, value);
  }
}

test('初始数据完整，空存储返回默认值', () => {
  const data = createInitialData(123);
  assert.equal(data.version, 1);
  assert.deepEqual(data.topics, []);
  assert.equal(data.activeTopicId, null);
  assert.deepEqual(data.memories, []);
  assert.equal(data.settings.theme, 'light');
  const loaded = loadData(new FakeStorage());
  assert.deepEqual(loaded.topics, []);
  assert.deepEqual(loaded.memories, []);
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.traits, { warmth: 50, directness: 50, emotionality: 50, curiosity: 50 });
  assert.equal(loaded.settings.theme, 'light');
});

test('保存与读取完整往返', () => {
  const storage = new FakeStorage();
  const data = createInitialData(100);
  const topic = createTopic({ title: '今天有点累', personaId: 'gentle', now: 200 });
  appendMessage(topic, { role: 'user', text: '今天有点累', now: 300 });
  data.topics.push(topic);
  data.activeTopicId = topic.id;
  data.memories.push({
    id: 'm1',
    category: 'basic',
    key: 'name',
    value: '林一',
    quote: '我叫林一',
    topicId: topic.id,
    createdAt: 400,
    updatedAt: 400,
    mentions: 1,
    confidence: 0.9
  });

  const result = saveData(data, storage);
  assert.equal(result.ok, true);
  const loaded = loadData(storage);
  assert.equal(loaded.topics.length, 1);
  assert.equal(loaded.topics[0].title, '今天有点累');
  assert.equal(loaded.topics[0].messages.length, 1);
  assert.equal(loaded.memories[0].value, '林一');
  assert.equal(loaded.activeTopicId, topic.id);
});

test('损坏 JSON 与非法结构会安全回退', () => {
  const storage = new FakeStorage();
  storage.setItem(STORAGE_KEY, '{broken');
  const loaded = loadData(storage);
  assert.deepEqual(loaded.topics, []);
  assert.equal(loaded.version, 1);

  const sanitized = sanitizeData({
    topics: [{ id: 't', title: '', personaId: 'gentle', messages: [null, { role: 'x', text: 'x' }] }],
    memories: [{ category: 'bad', value: 'x' }, { category: 'basic', value: '' }],
    settings: { theme: 'purple' },
    traits: { warmth: 200 }
  });
  assert.equal(sanitized.topics.length, 1);
  assert.equal(sanitized.topics[0].title, '未命名话题');
  assert.equal(sanitized.topics[0].messages.length, 0);
  assert.equal(sanitized.memories.length, 0);
  assert.equal(sanitized.settings.theme, 'light');
  assert.equal(sanitized.traits.warmth, 100);
});

test('标题、消息与计数工具', () => {
  assert.equal(titleFromText('   '), '未命名话题');
  assert.equal(titleFromText('  第一行\n第二行  '), '第一行 第二行');
  assert.ok(titleFromText('很长的标题'.repeat(10)).endsWith('…'));

  const topic = createTopic({ title: '测试', personaId: 'rational', now: 1 });
  appendMessage(topic, { role: 'user', text: '一', now: 2 });
  appendMessage(topic, { role: 'assistant', text: '二', now: 3 });
  appendMessage(topic, { role: 'user', text: '三', now: 4 });
  assert.equal(topic.messages.length, 3);
  assert.equal(countUserMessages(topic), 2);
  assert.equal(topic.updatedAt, 4);
  assert.equal(countMessages({ topics: [topic] }), 3);
  assert.equal(findTopic({ topics: [topic] }, topic.id), topic);
  assert.equal(findTopic({ topics: [topic] }, 'missing'), null);
});

test('话题保存性别、性别选择与相遇方式', () => {
  const topic = createTopic({
    title: '指定人设',
    personaId: 'suwanqing',
    gender: 'female',
    genderChoice: 'female',
    selectionMode: 'specific',
    now: 10
  });
  assert.equal(topic.gender, 'female');
  assert.equal(topic.genderChoice, 'female');
  assert.equal(topic.selectionMode, 'specific');

  appendMessage(topic, { role: 'user', text: '你好', now: 11 });
  const sanitized = sanitizeData({ topics: [topic], activeTopicId: topic.id });
  assert.equal(sanitized.topics[0].personaId, 'suwanqing');
  assert.equal(sanitized.topics[0].gender, 'female');
  assert.equal(sanitized.topics[0].genderChoice, 'female');
  assert.equal(sanitized.topics[0].selectionMode, 'specific');

  const legacy = sanitizeData({
    topics: [{ id: 'old', personaId: 'gentle', messages: [] }]
  });
  assert.equal(legacy.topics[0].gender, 'none');
  assert.equal(legacy.topics[0].selectionMode, 'legacy');
});

test('导出结构包含版本与时间', () => {
  const data = createInitialData(1);
  const payload = exportPayload(data);
  assert.equal(payload.app, 'echo');
  assert.equal(payload.version, 1);
  assert.equal(payload.data, data);
  assert.ok(Date.parse(payload.exportedAt));
});

test('原文存档只取用户消息并按时间倒序', () => {
  const first = createTopic({ title: '第一段', now: 10 });
  appendMessage(first, { role: 'user', text: '我叫林一', now: 11 });
  appendMessage(first, { role: 'assistant', text: '你好', now: 12 });
  appendMessage(first, { role: 'user', text: '养了只猫', now: 13 });
  const second = createTopic({ title: '第二段', now: 20 });
  appendMessage(second, { role: 'assistant', text: '来了', now: 21 });
  appendMessage(second, { role: 'user', text: '最近有点累', now: 22 });

  const result = listUserMessages({ topics: [first, second] });
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((item) => item.text),
    ['最近有点累', '养了只猫', '我叫林一']
  );
  assert.equal(result.items[0].topicTitle, '第二段');
  assert.equal(result.items[0].topicId, second.id);

  const limited = listUserMessages({ topics: [first, second] }, { limit: 2 });
  assert.equal(limited.total, 3);
  assert.equal(limited.items.length, 2);
  assert.deepEqual(listUserMessages(null), { total: 0, items: [] });
  assert.equal(listUserMessages({ topics: [first] }, { limit: 0 }).items.length, 1);
  assert.equal(listUserMessages({ topics: [first] }, { limit: 'bad' }).items.length, 2);
});

test('无存储与配额不足会返回可处理的结果', () => {
  assert.deepEqual(saveData(createInitialData(), null), {
    ok: false,
    reason: 'unavailable',
    trimmed: false
  });

  const data = createInitialData();
  for (let index = 0; index < 30; index += 1) {
    const topic = createTopic({ title: `对话 ${index}`, personaId: 'gentle', now: index });
    for (let message = 0; message < 20; message += 1) {
      appendMessage(topic, { role: 'user', text: 'x'.repeat(200), now: index });
    }
    data.topics.push(topic);
  }
  data.activeTopicId = data.topics[0].id;
  const storage = new FakeStorage(80_000);
  const result = saveData(data, storage);
  assert.equal(result.ok, true);
  assert.equal(result.trimmed, true);
  const loaded = loadData(storage);
  assert.ok(loaded.topics.length < 30);
  assert.equal(loaded.activeTopicId, data.activeTopicId);
});
