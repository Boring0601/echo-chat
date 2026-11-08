import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRAITS,
  deriveHabits,
  extractMemories,
  findUserName,
  formatMemoryLabel,
  inferTraits,
  memoryKey,
  mergeMemories,
  sanitizeMemoryCandidate,
  sanitizeTraits
} from '../public/js/memory.js';

function values(memories) {
  return memories.map((memory) => `${memory.category}:${memory.key}:${memory.value}`);
}

test('一句自我披露能抽出姓名、宠物、目标与状态', () => {
  const memories = extractMemories('我叫林一，在做毕业设计，养了一只叫豆豆的猫，最近总失眠。');
  const list = values(memories);
  assert.ok(list.includes('basic:name:林一'));
  assert.ok(list.includes('relationship:pet:猫 · 豆豆'));
  assert.ok(list.includes('goal:focus:毕业设计'));
  assert.ok(list.includes('emotion:mood:失眠'));
  assert.ok(memories.every((memory) => memory.quote.includes('林一')));
});

test('城市、职业、年龄、生日、关系与习惯', () => {
  const list = values(
    extractMemories('我今年28岁，生日是5月20日，在杭州工作，是一名产品经理。我妈妈最近生病了，我每天六点起床跑步。')
  );
  assert.ok(list.includes('basic:age:28岁'));
  assert.ok(list.includes('basic:birthday:5月20日'));
  assert.ok(list.includes('basic:workAt:杭州'));
  assert.ok(list.includes('basic:job:产品经理'));
  assert.ok(list.some((item) => item.startsWith('relationship:relationship:妈妈')));
  assert.ok(list.some((item) => item.startsWith('habit:habit:')));
});

test('喜欢与不喜欢分别记录，宠物名字不会拖上“的”', () => {
  const list = values(
    extractMemories('我特别喜欢下雨天听陈奕迅，但讨厌香菜。我的猫叫豆豆。')
  );
  assert.ok(list.some((item) => item.startsWith('preference:like:下雨天听陈奕迅')));
  assert.ok(list.some((item) => item.startsWith('preference:dislike:香菜')));
  assert.ok(list.includes('relationship:pet:猫 · 豆豆'));
});

test('否定目标不会被记成“想做的事”', () => {
  const negative = extractMemories('我不想休息。');
  assert.ok(!negative.some((memory) => memory.category === 'goal' && memory.value.includes('休息')));
  const positive = extractMemories('我想休息。');
  assert.ok(positive.some((memory) => memory.category === 'goal' && memory.value.includes('休息')));
});

test('空输入与无信息文本不会抛错或硬造事实', () => {
  assert.deepEqual(extractMemories(''), []);
  assert.deepEqual(extractMemories('   '), []);
  assert.deepEqual(extractMemories('今天天气还不错。'), []);
});

test('合并同一记忆只更新提及次数与时间', () => {
  const first = mergeMemories([], extractMemories('我叫林一。'), {
    topicId: 't1',
    now: 1000
  });
  assert.equal(first.added.length, 1);
  const second = mergeMemories(first.memories, extractMemories('我叫林一。'), {
    topicId: 't2',
    now: 2000
  });
  assert.equal(second.added.length, 0);
  assert.equal(second.memories.length, 1);
  assert.equal(second.memories[0].mentions, 2);
  assert.equal(second.memories[0].updatedAt, 2000);
  assert.equal(second.memories[0].quote.includes('林一'), true);
});

test('不同值即使 key 相同也会保留', () => {
  const result = mergeMemories([], extractMemories('我喜欢猫，也喜欢下雨。'), {
    topicId: 't1',
    now: 1000
  });
  assert.ok(result.memories.length >= 2);
  assert.equal(new Set(result.memories.map(memoryKey)).size, result.memories.length);
});

test('模型记忆候选会被校验，非法类别被丢弃', () => {
  assert.equal(sanitizeMemoryCandidate({ category: 'bad', value: 'x' }), null);
  const good = sanitizeMemoryCandidate({
    category: 'basic',
    key: 'name',
    value: '  林一  ',
    confidence: 2
  });
  assert.equal(good.value, '林一');
  assert.equal(good.key, 'name');
  assert.equal(good.confidence, 1);
});

test('性格画像对温暖、直接、情绪、好奇有方向性', () => {
  const warm = inferTraits(DEFAULT_TRAITS, '谢谢你听我说，抱抱你呀～');
  assert.ok(warm.traits.warmth > 50);

  const direct = inferTraits(DEFAULT_TRAITS, '别绕了，直接说重点。');
  assert.ok(direct.traits.directness > 55);

  const emotional = inferTraits(DEFAULT_TRAITS, '我快崩溃了，真的撑不住。');
  assert.ok(emotional.traits.emotionality > 55);

  const curious = inferTraits(DEFAULT_TRAITS, '为什么会这样？我很好奇别的可能。');
  assert.ok(curious.traits.curiosity > 50);
});

test('画像习惯能翻译成人话并限制为三条', () => {
  const habits = deriveHabits({
    warmth: 80,
    directness: 80,
    emotionality: 80,
    curiosity: 80
  });
  assert.equal(habits.length, 3);
  assert.ok(habits.some((habit) => habit.includes('缓口气')));
  assert.ok(habits.some((habit) => habit.includes('重点')));

  const neutral = deriveHabits(DEFAULT_TRAITS);
  assert.deepEqual(neutral, ['保持轻盈，不追问']);
});

test('画像与类别工具函数', () => {
  assert.deepEqual(sanitizeTraits({ warmth: 200, directness: -5 }), {
    warmth: 100,
    directness: 0,
    emotionality: 50,
    curiosity: 50
  });
  assert.equal(findUserName([{ category: 'basic', key: 'name', value: '林一' }]), '林一');
  assert.equal(findUserName([]), '');
  assert.equal(
    formatMemoryLabel({ category: 'relationship', key: 'pet', value: '猫 · 豆豆' }),
    '宠物 · 猫 · 豆豆'
  );
});
