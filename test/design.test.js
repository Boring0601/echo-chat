import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('所有十六进制颜色都是纯灰阶（R=G=B）', () => {
  const bad = new Set();
  for (const match of css.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const value = match[1].toLowerCase();
    let channels = '';
    if (value.length === 3 || value.length === 4) {
      channels = value.slice(0, 3);
    } else if (value.length === 6 || value.length === 8) {
      channels = value.slice(0, 6);
    } else {
      continue;
    }
    const red = channels.length === 3 ? channels[0] : channels.slice(0, 2);
    const green = channels.length === 3 ? channels[1] : channels.slice(2, 4);
    const blue = channels.length === 3 ? channels[2] : channels.slice(4, 6);
    if (!(red === green && green === blue)) bad.add(value);
  }
  assert.deepEqual([...bad], []);
});

test('不使用外部字体、样式或脚本，现场可离线运行', () => {
  assert.ok(!css.includes('@import'));
  assert.ok(!css.includes('fonts.googleapis'));
  assert.ok(!css.includes('url(http'));
  assert.ok(!html.includes('<script src="http'));
  assert.ok(!html.includes('fonts.googleapis'));
  assert.ok(html.includes('<script type="module" src="/js/app.js"></script>'));
});

test('基础可访问性与响应式规则存在', () => {
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(css.includes('prefers-reduced-motion: reduce'));
  assert.ok(css.includes(':focus-visible'));
  assert.ok(css.includes('@media (max-width: 860px)'));
  assert.ok(css.includes('@media (max-width: 640px)'));
});

test('明确的纯灰阶变量被两套主题使用', () => {
  for (const variable of [
    '--paper',
    '--surface',
    '--ink',
    '--muted',
    '--faint',
    '--line',
    '--bubble'
  ]) {
    assert.ok(css.includes(`${variable}:`), variable);
  }
  assert.ok(css.includes('[data-theme="dark"]'));
});
