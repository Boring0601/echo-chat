/**
 * 随机与 ID 工具。
 * 所有随机入口都可注入，便于测试概率分布与模板选择。
 */

export function secureRandom() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const values = new Uint32Array(1);
    cryptoObj.getRandomValues(values);
    return values[0] / 4294967296;
  }
  return Math.random();
}

export function randomId(prefix = 'id') {
  const cryptoObj = globalThis.crypto;
  const uuid =
    cryptoObj && typeof cryptoObj.randomUUID === 'function'
      ? cryptoObj.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export function pickOne(items, random = secureRandom) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  return items[index];
}

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
