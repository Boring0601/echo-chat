/**
 * 运行时配置。零依赖读取 .env，不覆盖已经存在的环境变量。
 */

import { existsSync, readFileSync } from 'node:fs';

export const SERVER_VERSION = '1.3.0';

export function parseEnvFile(content) {
  const result = {};
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

export function loadEnvFile(filePath, env = process.env) {
  if (!filePath || !existsSync(filePath)) return [];
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const parsed = parseEnvFile(content);
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] == null) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

export function loadConfig(env = process.env) {
  const deepseekKey = String(env.DEEPSEEK_API_KEY ?? '').trim();
  const openaiKey = String(env.OPENAI_API_KEY ?? '').trim();
  const genericKey = String(env.LLM_API_KEY ?? '').trim();
  const key = genericKey || deepseekKey || openaiKey;

  const hasDeepSeek = Boolean(deepseekKey);
  const defaultBaseUrl = hasDeepSeek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1';
  const baseUrl = String(env.LLM_BASE_URL ?? '').trim() || defaultBaseUrl;
  const model =
    String(env.LLM_MODEL ?? '').trim() || (hasDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini');

  const rawPort = Number(env.PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 4173;
  const host = String(env.HOST ?? '').trim() || '127.0.0.1';

  return {
    key,
    baseUrl,
    model,
    port,
    host,
    enabled: Boolean(key),
    maxBodyBytes: 256 * 1024,
    version: SERVER_VERSION
  };
}
