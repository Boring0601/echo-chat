/**
 * 回声 ECHO 的零依赖服务器。
 * - 托管 public/ 静态文件
 * - /api/health 告知前端是否配置了云端模型
 * - /api/chat 在配置 Key 时代理 OpenAI 兼容接口；否则让前端走本地引擎
 */

import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadEnvFile } from './lib/config.mjs';
import { buildSystemPrompt } from './lib/prompt.mjs';
import { callModel, LLMError } from './lib/llm.mjs';
import {
  personaById,
  personaWeights
} from './public/js/personas.js';
import {
  findUserName,
  sanitizeMemoryCandidate,
  sanitizeTraits
} from './public/js/memory.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8']
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new HttpError(413, 'too_large', '请求体超过大小限制');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON');
  }
}

function createRateLimiter(limit = 20, windowMs = 60_000) {
  const buckets = new Map();
  return function consume(ip) {
    const now = Date.now();
    const bucket = buckets.get(ip);
    if (!bucket || now - bucket.start >= windowMs) {
      buckets.set(ip, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    if (buckets.size > 2000) {
      for (const [key, value] of buckets) {
        if (now - value.start >= windowMs) buckets.delete(key);
      }
    }
    return bucket.count <= limit;
  };
}

function buildChatPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_payload', '请求体格式不正确');
  }
  const persona = personaById(body.personaId);
  if (!persona) throw new HttpError(400, 'invalid_persona', '未知的人格');

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages = rawMessages
    .filter(
      (message) =>
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.text === 'string' &&
        message.text.trim()
    )
    .slice(-16)
    .map((message) => ({
      role: message.role,
      text: message.text.trim().slice(0, 2200)
    }));

  const isOpening = Boolean(body.isOpening);
  if (messages.length === 0) {
    if (!isOpening) throw new HttpError(400, 'empty_messages', '没有可用的对话内容');
    // 空话题开场：给模型一个不可见的起点，让它在角色内主动开口。
    messages.push({
      role: 'user',
      text: '（用户刚选择人设并开启了一个空话题，还没有说话。请以角色身份自然开场。）'
    });
  }

  const memories = (Array.isArray(body.memories) ? body.memories : [])
    .slice(-80)
    .map((memory) => sanitizeMemoryCandidate(memory))
    .filter(Boolean);

  const habitNotes = (Array.isArray(body.habitNotes) ? body.habitNotes : [])
    .filter((note) => typeof note === 'string' && note.trim())
    .slice(0, 5)
    .map((note) => note.trim().slice(0, 50));

  const requestedGender =
    body.gender === 'male' || body.gender === 'female' ? body.gender : 'none';
  const gender = persona.isCharacter ? persona.gender : requestedGender;
  const allowedSelection = new Set(['specific', 'random', 'none', 'legacy']);
  const selectionMode = allowedSelection.has(body.selectionMode)
    ? body.selectionMode
    : persona.isNone
      ? 'none'
      : persona.isCharacter
        ? 'specific'
        : 'legacy';

  return {
    persona,
    gender,
    selectionMode,
    messages,
    memories,
    traits: sanitizeTraits(body.traits),
    habitNotes,
    userName: findUserName(memories),
    isOpening,
    openingGreeting: Boolean(body.openingGreeting),
    openingMode: body.openingMode === 'empty' ? 'empty' : 'topic'
  };
}

function createRequestHandler(config) {
  const allowRequest = createRateLimiter();

  return async function handleRequest(req, res) {
    setSecurityHeaders(res);
    let pathname = '/';
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }

    if (pathname.includes('\0')) {
      sendText(res, 400, 'Bad Request');
      return;
    }

    try {
      if (pathname === '/api/health') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          llm: {
            enabled: config.enabled,
            model: config.enabled ? config.model : ''
          },
          version: config.version,
          personas: personaWeights()
        });
        return;
      }

      if (pathname === '/api/chat') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!allowRequest(ip)) {
          res.setHeader('Retry-After', '60');
          sendJson(res, 429, { error: 'rate_limited', message: '慢一点，先喘口气。' });
          return;
        }

        const payload = buildChatPayload(await readJsonBody(req, config.maxBodyBytes));
        if (!config.enabled) {
          sendJson(res, 200, { mode: 'local', reason: 'no_api_key' });
          return;
        }

        const systemPrompt = buildSystemPrompt({
          personaId: payload.persona.id,
          gender: payload.gender,
          selectionMode: payload.selectionMode,
          memories: payload.memories,
          traits: payload.traits,
          habitNotes: payload.habitNotes,
          userName: payload.userName,
          isOpening: payload.isOpening,
          openingGreeting: payload.openingGreeting,
          openingMode: payload.openingMode
        });

        const result = await callModel({
          config,
          systemPrompt,
          messages: payload.messages,
          temperature: payload.persona.temperature
        });

        sendJson(res, 200, {
          mode: 'llm',
          reply: result.reply,
          memories: result.memories,
          habitNotes: result.habitNotes,
          model: result.model
        });
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed');
        return;
      }

      await serveStatic(req, res, pathname);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
        return;
      }
      if (error instanceof LLMError) {
        console.error('[echo] LLM error:', error.status, error.message);
        sendJson(res, 502, {
          error: 'llm_unavailable',
          message: '云端心智暂时不可用，已切换本地模式。'
        });
        return;
      }
      console.error('[echo] unexpected error:', error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error', message: '服务器开小差了。' });
      } else {
        res.end();
      }
    }
  };
}

async function serveStatic(req, res, pathname) {
  let requested = pathname;
  if (requested === '/') requested = '/index.html';

  let filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendText(res, 404, 'Not Found');
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }

  if (info.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
      sendText(res, 404, 'Not Found');
      return;
    }
    try {
      info = await stat(filePath);
    } catch {
      sendText(res, 404, 'Not Found');
      return;
    }
  }

  if (!info.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES.get(ext) ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(data);
}

export function createAppServer(config = loadConfig()) {
  return http.createServer(createRequestHandler(config));
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 启动服务器；端口被占用时自动尝试后续端口，返回实际 URL。
 */
export async function startServer(config, options = {}) {
  const host = config.host ?? '127.0.0.1';
  const startPort = Number(config.port) || 4173;
  const maxTries = Number(options.maxTries) || 8;

  for (let offset = 0; offset < maxTries; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) break;
    const attemptConfig = { ...config, host, port };
    const server = createAppServer(attemptConfig);
    try {
      await listenOn(server, port, host);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return {
        server,
        config: { ...attemptConfig, port: actualPort },
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`
      };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('没有可用端口，请设置 PORT 环境变量。');
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  loadEnvFile(path.join(ROOT, '.env'));
  const config = loadConfig();
  const started = await startServer(config);
  console.log('');
  console.log('  回声 ECHO 已启动');
  console.log(`  → ${started.url}`);
  console.log(
    `  心智模式：${started.config.enabled ? `云端 · ${started.config.model}` : '本地 · 完全离线'}`
  );
  console.log('');

  const shutdown = () => {
    started.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
