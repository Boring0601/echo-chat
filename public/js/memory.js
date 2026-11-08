/**
 * 记忆抽取、合并与性格画像。
 *
 * 设计原则：
 * 1. 对话原文由 store 完整保存；这里只做「值得长期记住」的结构化线索。
 * 2. 规则尽量稳，宁可少记，也不要把整句话当成事实。
 * 3. 所有函数保持纯函数，方便用 node:test 验证。
 */

import { randomId, clamp } from './rng.js';

export const MEMORY_CATEGORIES = Object.freeze({
  basic: '基本信息',
  relationship: '关系',
  preference: '偏好',
  goal: '目标计划',
  experience: '经历',
  emotion: '情绪状态',
  opinion: '观点',
  habit: '习惯'
});

const CATEGORY_KEYS = new Set(Object.keys(MEMORY_CATEGORIES));
const MAX_VALUE_LENGTH = 40;
const MAX_MEMORIES = 300;
const MAX_PER_MESSAGE = 14;

const STOP_VALUES = new Set([
  '你',
  '我',
  '他',
  '她',
  '它',
  '我们',
  '你们',
  '这个',
  '那个',
  '这样',
  '那样',
  '什么',
  '怎么',
  '为什么',
  '是',
  '的',
  '了',
  '一下',
  '一点',
  '一些',
  '事情',
  '东西',
  '感觉',
  '觉得',
  '知道',
  '说',
  '聊',
  '问',
  '好',
  '行',
  '可以',
  '聊聊',
  '说说'
]);

const CITY_STOP = /^(这里|那里|哪|家|公司|学校|外面|附近|一起|准备|做|想|看|听|上班|工作)$/;

const JOB_WORDS = [
  '程序员',
  '工程师',
  '设计师',
  '产品经理',
  '学生',
  '老师',
  '医生',
  '护士',
  '律师',
  '会计',
  '运营',
  '编辑',
  '记者',
  '摄影师',
  '创业者',
  '自由职业者',
  '研究生',
  '大学生',
  '博士生',
  '销售',
  '客服',
  '公务员',
  '导演',
  '作家',
  '音乐人',
  '建筑师',
  '投资人',
  '咨询师',
  '策划',
  '财务',
  '测试',
  '前端',
  '后端',
  '算法'
];

const JOB_RE = new RegExp(
  `(?:我)?(?:是|做|当|我的职业是)\\s*(?:一名|一个|位)?\\s*(${JOB_WORDS.join('|')})`,
  'g'
);

const PET_TYPES = ['龙猫', '仓鼠', '猫', '狗', '兔', '鸟', '鱼', '龟'];
const PET_TYPE_RE = new RegExp(`^(${PET_TYPES.join('|')})$`);

const EMOTION_WORDS = [
  '焦虑',
  '压力',
  '疲惫',
  '累',
  '难过',
  '伤心',
  '失落',
  '孤独',
  '害怕',
  '恐惧',
  '生气',
  '愤怒',
  '委屈',
  '崩溃',
  '失眠',
  '烦',
  '郁闷',
  '难受',
  '想哭',
  '紧张',
  '不安',
  '迷茫',
  '开心',
  '高兴',
  '快乐',
  '兴奋',
  '幸福',
  '满足',
  '期待',
  '轻松'
];

const KEY_LABELS = Object.freeze({
  name: '名字',
  age: '年龄',
  birthday: '生日',
  city: '城市',
  workAt: '工作地点',
  job: '职业',
  study: '专业',
  pet: '宠物',
  like: '喜欢',
  dislike: '不喜欢',
  goal: '想做的事',
  focus: '最近在忙',
  relationship: '关系',
  experience: '经历',
  mood: '状态',
  opinion: '观点',
  habit: '习惯'
});

export function cleanValue(raw) {
  let value = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s，。,.!！?？；;：:"'“”‘’]+/, '')
    .replace(/[\s，。,.!！?？；;：:"'“”‘’]+$/, '')
    .trim();

  value = value.replace(/^(的|了|着|过)\s*/, '').trim();
  value = value.replace(/^(一个|一名|一位|一只|一条|一件)\s*/, '').trim();
  return value.slice(0, MAX_VALUE_LENGTH);
}

export function normalizeValue(value) {
  return String(value ?? '')
    .replace(/[\s，。,.!！?？；;：:"'“”‘’（）()【】[\]…—-]+/g, '')
    .toLowerCase();
}

export function memoryKey(memory) {
  return `${memory?.category ?? ''}|${memory?.key ?? ''}|${normalizeValue(memory?.value)}`;
}

function truncate(text, length) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function addCandidate(found, seen, category, key, value, confidence = 0.78) {
  if (!CATEGORY_KEYS.has(category)) return;
  const clean = cleanValue(value);
  if (!clean || clean.length < 1 || STOP_VALUES.has(clean)) return;
  const composite = `${category}|${key}|${normalizeValue(clean)}`;
  if (seen.has(composite)) return;
  seen.add(composite);
  found.push({
    category,
    key,
    value: clean,
    quote: '',
    confidence
  });
}

/**
 * 从一条用户消息中抽取结构化记忆。
 * @param {string} text
 * @param {{ quote?: string }} [options]
 * @returns {Array<{category:string,key:string,value:string,quote:string,confidence:number}>}
 */
export function extractMemories(text, options = {}) {
  const source = String(text ?? '').trim();
  if (!source) return [];

  const quote = truncate(options.quote ?? source, 96);
  const found = [];
  const seen = new Set();

  // 名字
  for (const match of source.matchAll(
    /(?:我叫|我的名字(?:是|叫)|叫我)\s*([\u4e00-\u9fa5·]{2,4}|[A-Za-z][A-Za-z'’-]{1,24})/g
  )) {
    const value = match[1];
    if (/^(你|他|她|它|我们|你们|外卖|车|醒|人|什么|名字)/.test(value)) continue;
    addCandidate(found, seen, 'basic', 'name', value, 0.92);
  }

  // 年龄
  for (const match of source.matchAll(/(?:我)?(?:今年|已经|才|快|马上)?\s*(\d{1,2})\s*岁/g)) {
    const age = Number(match[1]);
    if (age > 0 && age < 120) addCandidate(found, seen, 'basic', 'age', `${age}岁`, 0.9);
  }

  // 生日
  for (const match of source.matchAll(
    /(?:我的)?生日(?:是|在|：|:)?\s*([0-9一二三四五六七八九十]{1,2}月[0-9一二三四五六七八九十]{1,3}[日号]?)/g
  )) {
    addCandidate(found, seen, 'basic', 'birthday', match[1], 0.88);
  }

  // 城市 / 所在地
  for (const match of source.matchAll(
    /(?:我)?(?:住在|家在|来自|坐标)\s*([\u4e00-\u9fa5]{2,10}?)(?=[，。,.!！?？；;\s]|$)/g
  )) {
    if (CITY_STOP.test(match[1])) continue;
    addCandidate(found, seen, 'basic', 'city', match[1], 0.84);
  }
  for (const match of source.matchAll(
    /(?:我)?在\s*([\u4e00-\u9fa5]{2,8})\s*(?:工作|上班|生活|读书|上学|定居)/g
  )) {
    if (CITY_STOP.test(match[1])) continue;
    addCandidate(found, seen, 'basic', 'workAt', match[1], 0.8);
  }

  // 职业 / 专业
  for (const match of source.matchAll(JOB_RE)) {
    addCandidate(found, seen, 'basic', 'job', match[1], 0.88);
  }
  for (const match of source.matchAll(
    /(?:我学|我读|我的专业是|我在学)\s*([\u4e00-\u9fa5A-Za-z]{2,12})/g
  )) {
    addCandidate(found, seen, 'basic', 'study', match[1], 0.82);
  }

  // 宠物：养了一只叫豆豆的猫 / 我的猫叫豆豆 / 我养猫
  for (const match of source.matchAll(
    /(?:我|我家)?(?:养了|有)(?:一只|一个|一条)?\s*(?:叫|名叫)?\s*([\u4e00-\u9fa5A-Za-z]{1,6}?)?\s*的?\s*(龙猫|仓鼠|猫|狗|兔|鸟|鱼|龟)/g
  )) {
    const maybeName =
      match[1] && !PET_TYPE_RE.test(match[1]) ? cleanValue(match[1]).replace(/的$/, '') : '';
    addCandidate(
      found,
      seen,
      'relationship',
      'pet',
      maybeName ? `${match[2]} · ${maybeName}` : match[2],
      0.86
    );
  }
  for (const match of source.matchAll(
    /(?:我的|我家)(龙猫|仓鼠|猫|狗|兔|鸟|鱼|龟)\s*(?:叫|名字叫|名叫)\s*([\u4e00-\u9fa5A-Za-z]{1,6})/g
  )) {
    addCandidate(found, seen, 'relationship', 'pet', `${match[1]} · ${match[2]}`, 0.9);
  }
  for (const match of source.matchAll(/(?:我|我家)(?:养了|养|有)\s*(龙猫|仓鼠|猫|狗|兔|鸟|鱼|龟)/g)) {
    addCandidate(found, seen, 'relationship', 'pet', match[1], 0.78);
  }

  // 喜欢 / 不喜欢
  for (const match of source.matchAll(
    /(?:我)?(?:很|特别|超|最|更|挺|真的|一直)?(?:喜欢|爱|迷上了|爱上|在追|在听|在看|沉迷于|沉迷)\s*([^，。,.!！?？；;\n]{1,30})/g
  )) {
    addCandidate(found, seen, 'preference', 'like', match[1], 0.8);
  }
  for (const match of source.matchAll(
    /(?:我)?(?:不喜欢|不爱|讨厌|很讨厌|受不了|受够了|害怕|很怕|怕)\s*([^，。,.!！?？；;\n]{1,30})/g
  )) {
    addCandidate(found, seen, 'preference', 'dislike', match[1], 0.8);
  }

  // 目标与最近在忙
  for (const match of source.matchAll(
    /(?:我)?(?:想|打算|准备|计划|希望|决定|要)\s*(?:去|要|把|在)?\s*([^，。,.!！?？；;\n]{2,36})/g
  )) {
    const before = source.slice(Math.max(0, match.index - 3), match.index);
    if (/(?:不|没|别)/.test(before)) continue;
    addCandidate(found, seen, 'goal', 'goal', match[1], 0.76);
  }
  for (const match of source.matchAll(
    /(?:最近|正在|这阵子|目前)\s*(?:在|忙着)?\s*(?:准备|做|写|学|搞|忙|弄)\s*([^，。,.!！?？；;\n]{2,24})/g
  )) {
    addCandidate(found, seen, 'goal', 'focus', match[1], 0.8);
  }
  for (const match of source.matchAll(
    /(?:我)?在(?:做|写|忙|准备|学|搞|弄)\s*([^，。,.!！?？；;\n]{2,24})/g
  )) {
    addCandidate(found, seen, 'goal', 'focus', match[1], 0.8);
  }

  // 关系
  for (const match of source.matchAll(
    /(?:我的|我)?(男朋友|女朋友|对象|老公|老婆|伴侣|妈妈|爸爸|母亲|父亲|父母|女儿|儿子|姐姐|妹妹|哥哥|弟弟|朋友|闺蜜|室友|同事|老板|导师|老妈|老爸|妈|爸)\s*([^，。,.!！?？；;\n]{0,24})/g
  )) {
    const rest = cleanValue(match[2]);
    addCandidate(
      found,
      seen,
      'relationship',
      'relationship',
      rest ? `${match[1]} · ${rest}` : match[1],
      0.74
    );
  }

  // 经历
  for (const match of source.matchAll(
    /(?:我)?(?:去过|搬到|搬来|毕业于|参加了|经历了|第一次|曾经)\s*([^，。,.!！?？；;\n]{2,30})/g
  )) {
    addCandidate(found, seen, 'experience', 'experience', match[1], 0.72);
  }

  // 情绪状态
  let emotionCount = 0;
  for (const word of EMOTION_WORDS) {
    if (emotionCount >= 2) break;
    if (!source.includes(word)) continue;
    if (word === '累' && /积累|累计/.test(source)) continue;
    addCandidate(found, seen, 'emotion', 'mood', word, 0.72);
    emotionCount += 1;
  }

  // 观点
  for (const match of source.matchAll(
    /(?:我觉得|我认为|在我看来|我感觉|对我来说)\s*([^。！？!?\n]{4,40})/g
  )) {
    addCandidate(found, seen, 'opinion', 'opinion', match[1], 0.7);
  }

  // 习惯
  for (const match of source.matchAll(
    /(?:我每天|我经常|我习惯|我总是|我一般|我每周|我平时)\s*([^。！？!?\n]{2,30})/g
  )) {
    addCandidate(found, seen, 'habit', 'habit', match[1], 0.7);
  }

  return found.slice(0, MAX_PER_MESSAGE).map((item) => ({ ...item, quote }));
}

export function sanitizeMemoryCandidate(raw, fallbackQuote = '') {
  if (!raw || typeof raw !== 'object') return null;
  if (!CATEGORY_KEYS.has(raw.category)) return null;
  const value = cleanValue(raw.value);
  if (!value) return null;
  const key =
    String(raw.key ?? raw.category)
      .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '')
      .slice(0, 24) || raw.category;
  return {
    category: raw.category,
    key,
    value,
    quote: truncate(raw.quote || fallbackQuote || value, 96),
    confidence: clamp(Number(raw.confidence) || 0.72, 0, 1)
  };
}

/**
 * 合并新抽取的记忆；相同 category+key+value 视为同一条，更新 quote 与时间。
 */
export function mergeMemories(existing, incoming, options = {}) {
  const now = Number(options.now) || Date.now();
  const topicId = options.topicId ?? null;
  const max = Number(options.max) || MAX_MEMORIES;
  const map = new Map();

  for (const item of Array.isArray(existing) ? existing : []) {
    if (!item || !CATEGORY_KEYS.has(item.category)) continue;
    const clone = { ...item };
    map.set(memoryKey(clone), clone);
  }

  const added = [];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const candidate = sanitizeMemoryCandidate(raw, options.quote ?? '');
    if (!candidate) continue;
    const key = memoryKey(candidate);
    const previous = map.get(key);
    if (previous) {
      previous.quote = candidate.quote || previous.quote;
      previous.updatedAt = now;
      previous.mentions = Number(previous.mentions || 1) + 1;
      previous.confidence = Math.max(Number(previous.confidence) || 0, candidate.confidence);
      continue;
    }
    const item = {
      ...candidate,
      id: randomId('mem'),
      topicId,
      createdAt: now,
      updatedAt: now,
      mentions: 1
    };
    map.set(key, item);
    added.push(item);
  }

  const memories = [...map.values()]
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, max);

  return { memories, added };
}

export function findUserName(memories) {
  const item = (Array.isArray(memories) ? memories : []).find(
    (memory) => memory?.category === 'basic' && memory?.key === 'name' && memory?.value
  );
  return item ? String(item.value) : '';
}

export function categoryLabel(category) {
  return MEMORY_CATEGORIES[category] ?? '其他';
}

export function formatMemoryLabel(memory) {
  const label = KEY_LABELS[memory?.key] ?? categoryLabel(memory?.category);
  return `${label} · ${memory?.value ?? ''}`;
}

export const DEFAULT_TRAITS = Object.freeze({
  warmth: 50,
  directness: 50,
  emotionality: 50,
  curiosity: 50
});

export const TRAIT_LABELS = Object.freeze({
  warmth: '温暖度',
  directness: '直接度',
  emotionality: '情绪浓度',
  curiosity: '好奇度'
});

export function sanitizeTraits(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const key of Object.keys(DEFAULT_TRAITS)) {
    result[key] = Math.round(clamp(source[key] ?? DEFAULT_TRAITS[key], 0, 100));
  }
  return result;
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

/**
 * 根据一条用户消息更新性格画像（指数滑动平均）。
 * 返回 { traits, signals }，不修改入参。
 */
export function inferTraits(previous, text) {
  const base = sanitizeTraits(previous);
  const source = String(text ?? '');
  const signals = {};

  const warmCues = countMatches(
    source,
    /谢谢|辛苦|抱抱|暖|呀|呢|啦|嘛|～|~|关心|陪你|加油|开心|喜欢/g
  );
  if (warmCues > 0) {
    signals.warmth = clamp(52 + warmCues * 9, 5, 95);
  }

  const hedge = countMatches(source, /可能|也许|有点|似乎|大概|或许/g);
  const direct = countMatches(source, /直接|重点|别绕|直说|简单点|赶紧|就/g);
  const length = source.replace(/\s+/g, '').length;
  let directSignal = length <= 12 ? 68 : length <= 32 ? 57 : length <= 80 ? 48 : 40;
  directSignal += direct * 5 - hedge * 4;
  signals.directness = clamp(directSignal, 5, 95);

  const emotionCues = countMatches(
    source,
    /焦虑|压力|累|疲惫|难过|伤心|失落|孤独|害怕|恐惧|生气|愤怒|委屈|崩溃|失眠|烦|郁闷|难受|想哭|紧张|不安|迷茫|开心|高兴|兴奋|幸福|期待|轻松/g
  );
  const intensity = countMatches(source, /！|!|非常|特别|太|超级|真的|好想|受不了/g);
  signals.emotionality =
    emotionCues || intensity ? clamp(58 + emotionCues * 8 + intensity * 4, 5, 95) : 44;

  const questionCues =
    countMatches(source, /[?？]/g) +
    countMatches(source, /为什么|怎么|如何|好奇|想知道|想了解|能不能|是不是|有没有/g);
  signals.curiosity = questionCues ? clamp(48 + questionCues * 10, 5, 95) : 42;

  const traits = { ...base };
  for (const key of Object.keys(traits)) {
    if (signals[key] == null) continue;
    const alpha = key === 'directness' ? 0.35 : 0.32;
    traits[key] = clamp(base[key] * (1 - alpha) + signals[key] * alpha, 0, 100);
  }

  for (const key of Object.keys(traits)) traits[key] = Math.round(traits[key]);
  return { traits, signals };
}

/**
 * 把画像翻译成可展示、可注入提示词的对话习惯。
 */
export function deriveHabits(traits) {
  const t = sanitizeTraits(traits);
  const habits = [];
  if (t.emotionality >= 55) habits.push('先让人缓口气，再说怎么办');
  if (t.directness >= 60) habits.push('少铺垫，直接说重点');
  if (t.warmth >= 58) habits.push('语气更亲近，可以叫你的名字');
  if (t.curiosity >= 58) habits.push('多给一个新角度，再留一个问题');
  if (t.directness <= 36) habits.push('多留一点停顿，不催你');
  if (habits.length === 0) habits.push('保持轻盈，不追问');
  return habits.slice(0, 3);
}
