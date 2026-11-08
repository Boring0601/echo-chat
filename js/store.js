/**
 * 本地存储与话题数据模型。
 * 没有账号、没有服务端数据库：对话原文与记忆都留在这个浏览器里。
 */

import { DEFAULT_TRAITS, MEMORY_CATEGORIES, sanitizeTraits } from './memory.js';
import { randomId } from './rng.js';

export const STORAGE_KEY = 'echo.v1';
export const DATA_VERSION = 1;
export const MAX_TOPICS = 60;
export const MAX_MESSAGES_PER_TOPIC = 240;

const VALID_ROLES = new Set(['user', 'assistant', 'system']);
const VALID_CATEGORIES = new Set(Object.keys(MEMORY_CATEGORIES));

export function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createInitialData(now = Date.now()) {
  return {
    version: DATA_VERSION,
    topics: [],
    activeTopicId: null,
    memories: [],
    traits: { ...DEFAULT_TRAITS },
    settings: { theme: 'light' },
    meta: { createdAt: now }
  };
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeMessage(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const role = VALID_ROLES.has(raw.role) ? raw.role : null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!role || !text.trim()) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `msg_${index}_${Date.now().toString(36)}`,
    role,
    text,
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    createdAt: asNumber(raw.createdAt, Date.now())
  };
}

function sanitizeTopic(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map((message, messageIndex) => sanitizeMessage(message, messageIndex))
    .filter(Boolean)
    .slice(-MAX_MESSAGES_PER_TOPIC);
  const createdAt = asNumber(raw.createdAt, Date.now());
  const gender =
    raw.gender === 'male' || raw.gender === 'female' ? raw.gender : 'none';
  const genderChoice =
    raw.genderChoice === 'male' ||
    raw.genderChoice === 'female' ||
    raw.genderChoice === 'none' ||
    raw.genderChoice === 'random'
      ? raw.genderChoice
      : null;
  const selectionMode =
    raw.selectionMode === 'specific' ||
    raw.selectionMode === 'random' ||
    raw.selectionMode === 'none'
      ? raw.selectionMode
      : 'legacy';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `topic_${index}_${Date.now().toString(36)}`,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 60) : '未命名话题',
    personaId: typeof raw.personaId === 'string' ? raw.personaId : 'gentle',
    gender,
    genderChoice,
    selectionMode,
    messages,
    createdAt,
    updatedAt: asNumber(raw.updatedAt, createdAt)
  };
}

function sanitizeMemory(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  if (!VALID_CATEGORIES.has(raw.category)) return null;
  const value = typeof raw.value === 'string' ? raw.value.trim().slice(0, 80) : '';
  if (!value) return null;
  const createdAt = asNumber(raw.createdAt, Date.now());
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `mem_${index}_${Date.now().toString(36)}`,
    category: raw.category,
    key: typeof raw.key === 'string' && raw.key ? raw.key.slice(0, 30) : raw.category,
    value,
    quote: typeof raw.quote === 'string' ? raw.quote.slice(0, 140) : '',
    topicId: typeof raw.topicId === 'string' ? raw.topicId : null,
    createdAt,
    updatedAt: asNumber(raw.updatedAt, createdAt),
    mentions: Math.max(1, asNumber(raw.mentions, 1)),
    confidence: Math.min(1, Math.max(0, asNumber(raw.confidence, 0.7)))
  };
}

export function sanitizeData(raw) {
  if (!raw || typeof raw !== 'object') return createInitialData();
  const topics = (Array.isArray(raw.topics) ? raw.topics : [])
    .map((topic, index) => sanitizeTopic(topic, index))
    .filter(Boolean)
    .slice(0, MAX_TOPICS);
  const topicIds = new Set(topics.map((topic) => topic.id));
  const activeTopicId =
    typeof raw.activeTopicId === 'string' && topicIds.has(raw.activeTopicId)
      ? raw.activeTopicId
      : topics[0]?.id ?? null;
  const memories = (Array.isArray(raw.memories) ? raw.memories : [])
    .map((memory, index) => sanitizeMemory(memory, index))
    .filter(Boolean)
    .slice(-500);
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  return {
    version: DATA_VERSION,
    topics,
    activeTopicId,
    memories,
    traits: sanitizeTraits(raw.traits),
    settings: { theme: settings.theme === 'dark' ? 'dark' : 'light' },
    meta: {
      createdAt: asNumber(raw.meta?.createdAt, Date.now())
    }
  };
}

export function loadData(storage = getStorage()) {
  const fallback = createInitialData();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return sanitizeData(parsed);
  } catch {
    return fallback;
  }
}

function trimForQuota(data, level = 0) {
  const active = data.topics.find((topic) => topic.id === data.activeTopicId);
  const rest = data.topics.filter((topic) => topic.id !== data.activeTopicId);
  const topicLimit = level === 0 ? 16 : 6;
  const messageLimit = level === 0 ? 24 : 10;
  const topics = (active ? [active, ...rest] : rest)
    .slice(0, topicLimit)
    .map((topic) => ({
      ...topic,
      messages: topic.messages.slice(-messageLimit)
    }));
  return {
    ...data,
    topics,
    activeTopicId: topics.some((topic) => topic.id === data.activeTopicId)
      ? data.activeTopicId
      : topics[0]?.id ?? null,
    memories: data.memories.slice(0, level === 0 ? 120 : 60)
  };
}

/**
 * 保存；配额不足时分级裁剪旧话题/旧记忆再试。
 */
export function saveData(data, storage = getStorage()) {
  if (!storage) return { ok: false, reason: 'unavailable', trimmed: false };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
    return { ok: true, reason: '', trimmed: false };
  } catch {
    for (const level of [0, 1]) {
      const trimmedData = trimForQuota(data, level);
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(trimmedData));
        return { ok: true, reason: 'quota', trimmed: true };
      } catch {
        // 继续尝试更激进的裁剪。
      }
    }
    return { ok: false, reason: 'quota', trimmed: false };
  }
}

export function titleFromText(text, maxLength = 24) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '未命名话题';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

export function createTopic(options = {}) {
  const now = Number(options.now) || Date.now();
  return {
    id: options.id || randomId('topic'),
    title: options.title ? titleFromText(options.title) : '未命名话题',
    personaId: options.personaId || 'gentle',
    gender: options.gender === 'male' || options.gender === 'female' ? options.gender : 'none',
    genderChoice: options.genderChoice ?? null,
    selectionMode: options.selectionMode || 'legacy',
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

export function appendMessage(topic, options = {}) {
  if (!topic || !Array.isArray(topic.messages)) throw new Error('invalid topic');
  const now = Number(options.now) || Date.now();
  const message = {
    id: options.id || randomId('msg'),
    role: options.role || 'user',
    text: String(options.text ?? ''),
    kind: options.kind || '',
    createdAt: now
  };
  topic.messages.push(message);
  if (topic.messages.length > MAX_MESSAGES_PER_TOPIC) {
    topic.messages.splice(0, topic.messages.length - MAX_MESSAGES_PER_TOPIC);
  }
  topic.updatedAt = now;
  return message;
}

export function countUserMessages(topic) {
  return (topic?.messages ?? []).filter((message) => message.role === 'user').length;
}

export function countMessages(data) {
  return (data?.topics ?? []).reduce((total, topic) => total + topic.messages.length, 0);
}

/**
 * 原文档案：从已保存的话题里取出用户说过的每一句话。
 * 这不改变数据模型，只供记忆抽屉展示；limit 只限制渲染条数，total 始终是全部。
 */
export function listUserMessages(data, options = {}) {
  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(500, Math.max(1, Math.floor(rawLimit)))
    : 100;
  const items = [];
  for (const topic of data?.topics ?? []) {
    if (!topic || !Array.isArray(topic.messages)) continue;
    for (const message of topic.messages) {
      if (
        !message ||
        message.role !== 'user' ||
        typeof message.text !== 'string' ||
        !message.text.trim()
      ) {
        continue;
      }
      items.push({
        messageId: message.id,
        topicId: topic.id,
        topicTitle: topic.title || '未命名话题',
        text: message.text,
        createdAt: Number(message.createdAt) || 0
      });
    }
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  return { total: items.length, items: items.slice(0, limit) };
}

export function findTopic(data, topicId) {
  return (data?.topics ?? []).find((topic) => topic.id === topicId) ?? null;
}

export function exportPayload(data) {
  return {
    app: 'echo',
    version: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    data
  };
}
