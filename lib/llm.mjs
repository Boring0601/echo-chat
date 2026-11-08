/**
 * OpenAI 兼容接口调用与模型输出清洗。
 * 未配置 Key 时不会走到这里；配置后失败也会由前端回退本地引擎。
 */

import { sanitizeMemoryCandidate } from '../public/js/memory.js';

export class LLMError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanRawReply(raw) {
  return String(raw ?? '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
    .slice(0, 1600);
}

export function normalizeModelResult(parsed, raw = '') {
  let reply = '';
  let memories = [];
  let habitNotes = [];

  if (typeof parsed === 'string') {
    reply = parsed.trim();
  } else if (parsed && typeof parsed === 'object') {
    if (typeof parsed.reply === 'string') reply = parsed.reply.trim();
    if (Array.isArray(parsed.memories)) {
      memories = parsed.memories
        .slice(0, 8)
        .map((item) => sanitizeMemoryCandidate(item, ''))
        .filter(Boolean);
    }
    if (Array.isArray(parsed.habitNotes)) {
      habitNotes = parsed.habitNotes
        .filter((note) => typeof note === 'string' && note.trim())
        .slice(0, 3)
        .map((note) => note.trim().slice(0, 40));
    }
  }

  if (!reply) reply = cleanRawReply(raw);
  if (!reply) throw new LLMError('empty_model_reply');

  return {
    reply: reply.slice(0, 1600),
    memories,
    habitNotes
  };
}

function parseResponseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function messageContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * 调用一次模型。失败抛出 LLMError，由路由层转成 502。
 */
export async function callModel(options = {}) {
  const config = options.config ?? {};
  const systemPrompt = String(options.systemPrompt ?? '');
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const temperature = Number.isFinite(Number(options.temperature))
    ? Number(options.temperature)
    : 0.8;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) || 30000;

  if (!config.key) throw new LLMError('missing_api_key', 0);
  if (typeof fetchImpl !== 'function') throw new LLMError('fetch_unavailable', 0);

  const url = chatCompletionsUrl(config.baseUrl);
  if (!url) throw new LLMError('invalid_base_url', 0);

  const baseBody = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.text ?? message.content ?? '')
      }))
    ],
    temperature,
    max_tokens: 650
  };

  async function request(useJsonMode) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.key}`
        },
        body: JSON.stringify(
          useJsonMode ? { ...baseBody, response_format: { type: 'json_object' } } : baseBody
        ),
        signal: controller.signal
      });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  }

  let result;
  try {
    result = await request(true);
    if (result.response.status === 400) {
      // 一些兼容服务不支持 response_format，去掉后重试一次。
      result = await request(false);
    }
    if (
      result.response.status === 429 ||
      result.response.status >= 500 ||
      result.response.status === 408
    ) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      result = await request(false);
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw new LLMError('timeout', 0);
    throw new LLMError('network_error', 0);
  }

  if (!result.response.ok) {
    const detail = parseResponseBody(result.text);
    const message =
      typeof detail?.error?.message === 'string'
        ? detail.error.message.slice(0, 180)
        : `http_${result.response.status}`;
    throw new LLMError(message, result.response.status);
  }

  const data = parseResponseBody(result.text);
  if (!data) throw new LLMError('invalid_json_response', result.response.status);
  const content = messageContent(data);
  if (!content.trim()) throw new LLMError('empty_model_content', result.response.status);

  const parsed = extractJson(content);
  const normalized = normalizeModelResult(parsed, content);
  return {
    ...normalized,
    usage: data.usage ?? null,
    model: data.model ?? config.model
  };
}
