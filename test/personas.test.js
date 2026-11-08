import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTERS,
  GENDER_CHOICES,
  NONE_PROFILE,
  OPENING_LINE,
  PERSONAS,
  PERSONA_TOTAL_WEIGHT,
  characterNamesByArchetype,
  charactersForGender,
  genderLabel,
  personaById,
  personaPercent,
  pickPersona,
  profileForTopic,
  resolveGender,
  selectCharacter,
  selectPersona
} from '../public/js/personas.js';

test('四种人格权重与概率精确匹配需求', () => {
  assert.equal(PERSONAS.length, 4);
  assert.deepEqual(
    PERSONAS.map((persona) => [persona.name, persona.weight]),
    [
      ['温柔知心', 30],
      ['时而傲娇白切黑', 15],
      ['聪明理性', 25],
      ['感性幽默风趣', 30]
    ]
  );
  assert.equal(
    PERSONAS.reduce((total, persona) => total + persona.weight, 0),
    PERSONA_TOTAL_WEIGHT
  );
  for (const persona of PERSONAS) {
    assert.equal(persona.probability, persona.weight / 100);
  }
});

test('固定开场白逐字符合需求', () => {
  assert.equal(OPENING_LINE, '你好，我们一起聊聊吧？');
});

test('累计权重边界选择正确', () => {
  assert.equal(selectPersona(0).id, 'gentle');
  assert.equal(selectPersona(0.299999).id, 'gentle');
  assert.equal(selectPersona(0.3).id, 'tsundere');
  assert.equal(selectPersona(0.449999).id, 'tsundere');
  assert.equal(selectPersona(0.45).id, 'rational');
  assert.equal(selectPersona(0.699999).id, 'rational');
  assert.equal(selectPersona(0.7).id, 'humorous');
  assert.equal(selectPersona(0.999999).id, 'humorous');
});

test('非法 roll 不会抛错', () => {
  assert.equal(selectPersona(Number.NaN).id, 'gentle');
  assert.equal(selectPersona(-1).id, 'gentle');
  assert.equal(selectPersona(2).id, 'humorous');
  assert.equal(pickPersona(() => 0.5).id, 'rational');
});

test('十万次抽样的概率误差小于 1%', () => {
  let seed = 20261107;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const counts = Object.fromEntries(PERSONAS.map((persona) => [persona.id, 0]));
  const rounds = 100_000;
  for (let index = 0; index < rounds; index += 1) {
    counts[pickPersona(random).id] += 1;
  }
  for (const persona of PERSONAS) {
    const observed = counts[persona.id] / rounds;
    assert.ok(
      Math.abs(observed - persona.probability) < 0.01,
      `${persona.name}: ${observed} vs ${persona.probability}`
    );
  }
});

test('人格元数据完整且可查询', () => {
  const ids = new Set();
  for (const persona of PERSONAS) {
    assert.ok(persona.id);
    assert.ok(!ids.has(persona.id));
    ids.add(persona.id);
    assert.ok(persona.name);
    assert.ok(persona.sigil);
    assert.ok(persona.tagline);
    assert.ok(persona.followUp);
    assert.ok(persona.voice.length > 10);
    assert.equal(persona.habits.length, 3);
    const profile = personaById(persona.id);
    assert.equal(profile.id, persona.id);
    assert.equal(profile.name, persona.name);
    assert.equal(profile.isLegacy, true);
    assert.equal(profile.archetypeId, persona.id);
    assert.equal(personaPercent(persona), `${Math.round(persona.probability * 100)}%`);
  }
  assert.equal(personaById('missing'), null);
});

test('16 位角色：类型与性别分布完整，姓名、简介、签名齐全', () => {
  assert.equal(CHARACTERS.length, 16);
  assert.equal(new Set(CHARACTERS.map((character) => character.id)).size, 16);
  assert.equal(new Set(CHARACTERS.map((character) => character.name)).size, 16);
  for (const archetype of PERSONAS) {
    const group = CHARACTERS.filter(
      (character) => character.archetypeId === archetype.id
    );
    assert.equal(group.length, 4, archetype.name);
    assert.equal(group.filter((character) => character.gender === 'female').length, 2);
    assert.equal(group.filter((character) => character.gender === 'male').length, 2);
  }
  for (const character of CHARACTERS) {
    assert.ok(character.name.length >= 2);
    assert.ok(['male', 'female'].includes(character.gender));
    assert.ok(character.age >= 20 && character.age <= 40);
    assert.ok(character.occupation.length >= 2);
    assert.ok(character.signature.length >= 4);
    assert.ok(character.opening.length >= 8, character.name);
    assert.ok(!character.opening.includes(OPENING_LINE));
    assert.ok(character.bio.length > 80, character.name);
  }
});

test('16 位角色都有可主动分享的具体故事', () => {
  for (const character of CHARACTERS) {
    const profile = personaById(character.id);
    assert.ok(Array.isArray(profile.stories), character.name);
    assert.ok(profile.stories.length >= 2, character.name);
    assert.ok(
      profile.stories.every((story) => typeof story === 'string' && story.length > 20),
      character.name
    );
  }
  assert.ok(NONE_PROFILE.stories.length >= 2);
});

test('性别筛选与随机性别解析', () => {
  assert.equal(charactersForGender('male').length, 8);
  assert.equal(charactersForGender('female').length, 8);
  assert.equal(charactersForGender('none').length, 16);
  assert.equal(charactersForGender('random').length, 16);
  assert.ok(
    charactersForGender('male').every((character) => character.gender === 'male')
  );
  assert.ok(
    charactersForGender('female').every((character) => character.gender === 'female')
  );
  assert.equal(resolveGender('male'), 'male');
  assert.equal(resolveGender('female'), 'female');
  assert.equal(resolveGender('none'), 'none');
  assert.equal(resolveGender('random', () => 0.2), 'male');
  assert.equal(resolveGender('random', () => 0.8), 'female');
  assert.equal(genderLabel('male'), '男');
  assert.equal(genderLabel('none'), '不限定');
  assert.equal(GENDER_CHOICES.length, 4);
});

test('角色档案包含角色、人格与性别信息', () => {
  const profile = personaById('suwanqing');
  assert.equal(profile.name, '苏晚晴');
  assert.equal(profile.isCharacter, true);
  assert.equal(profile.isNone, false);
  assert.equal(profile.gender, 'female');
  assert.equal(profile.archetypeId, 'gentle');
  assert.equal(profile.archetypeName, '温柔知心');
  assert.equal(profile.age, 30);
  assert.ok(profile.bio.includes('花店'));
  assert.ok(profile.roleplay.includes('# 角色'));
  assert.ok(profile.identityLine.includes('开花店的'));
  assert.ok(profile.roleBreakLine.includes('花名'));
  assert.ok(profile.examples.length >= 1);
  assert.equal(personaPercent(profile), '30%');

  const none = personaById('none');
  assert.equal(none, NONE_PROFILE);
  assert.equal(none.isNone, true);
  assert.equal(none.probability, null);
  assert.equal(personaPercent(none), '');
});

test('无性别与角色性别在 profileForTopic 中正确处理', () => {
  assert.equal(profileForTopic({ personaId: 'none', gender: 'female' }).gender, 'female');
  assert.equal(profileForTopic({ personaId: 'none', gender: 'none' }).gender, 'none');
  assert.equal(profileForTopic({ personaId: 'suwanqing', gender: 'male' }).gender, 'female');
  assert.equal(profileForTopic(null).isNone, true);
});

test('随机角色遵守性别筛选与人格类型概率', () => {
  let seed = 20261108;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const counts = Object.fromEntries(PERSONAS.map((persona) => [persona.id, 0]));
  const rounds = 100_000;
  for (let index = 0; index < rounds; index += 1) {
    const character = selectCharacter({ gender: 'female', random });
    assert.equal(character.gender, 'female');
    counts[character.archetypeId] += 1;
  }
  for (const persona of PERSONAS) {
    const observed = counts[persona.id] / rounds;
    assert.ok(
      Math.abs(observed - persona.probability) < 0.01,
      `${persona.name}: ${observed}`
    );
  }
  const male = selectCharacter({ gender: 'male', random: () => 0.1 });
  assert.equal(male.gender, 'male');
  const none = selectCharacter({ gender: 'none', random: () => 0.5 });
  assert.ok(none);
});

test('四位温柔知心角色拥有完整扮演卡与离线行为字段', () => {
  for (const id of ['suwanqing', 'zhouxubai', 'xunianan', 'luhuaizhou']) {
    const profile = personaById(id);
    assert.ok(profile.roleplay.includes('# 角色'), id);
    assert.ok(profile.roleplay.includes('# 语言风格'), id);
    assert.ok(profile.roleplay.includes('# 行为准则'), id);
    assert.ok(profile.roleplay.includes('# 示例对话'), id);
    assert.ok(profile.identityLine, id);
    assert.ok(profile.roleBreakLine, id);
    assert.ok(profile.decisionLine, id);
    assert.ok(profile.boundaryLine, id);
    assert.ok(profile.examples.length > 0, id);
    assert.ok(profile.localMaxSentences >= 1, id);
  }
});

test('其余 12 位角色也拥有注入卡与本地行为字段', () => {
  for (const id of [
    'chengjianyue',
    'peizhilin',
    'lumiao',
    'wenzhao',
    'shaolingyi',
    'liangsiche',
    'weimingli',
    'fuzeyan',
    'jiangxiaoman',
    'hekailang',
    'songleyan',
    'baixi'
  ]) {
    const profile = personaById(id);
    assert.ok(profile.roleplay.includes('# 角色注入'), id);
    assert.ok(profile.identityLine, id);
    assert.ok(profile.selfAnswers.work, id);
    assert.ok(profile.selfQuestionActions.work.length > 0, id);
    assert.ok(profile.actions.length > 0, id);
    assert.ok(profile.examples.length > 0, id);
  }
});

test('每种人格下都有 4 个角色名，供说明弹层展示', () => {
  const groups = characterNamesByArchetype();
  assert.equal(groups.length, 4);
  for (const group of groups) {
    assert.equal(group.characters.length, 4);
    assert.ok(group.characters.every((character) => character.name.length >= 2));
  }
});
