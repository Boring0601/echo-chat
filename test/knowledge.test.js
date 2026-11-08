import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDailyQuestion } from '../public/js/knowledge.js';

const NOW = new Date(2026, 10, 7, 23, 30, 0);

test('日期与时间问题使用本地当前时间', () => {
  const date = resolveDailyQuestion('今天几号', { now: NOW });
  assert.ok(date);
  assert.ok(date.answer.includes('2026年11月7日'));
  assert.ok(date.answer.includes('星期六'));

  const time = resolveDailyQuestion('现在几点', { now: NOW });
  assert.ok(time);
  assert.ok(time.answer.includes('23:30'));

  const both = resolveDailyQuestion('今天星期几，现在几点', { now: NOW });
  assert.ok(both);
  assert.ok(both.answer.includes('2026年11月7日'));
  assert.ok(both.answer.includes('23:30'));
});

test('实时天气不编造，明确说明没有数据', () => {
  const weather = resolveDailyQuestion('今天天气怎么样');
  assert.ok(weather);
  assert.ok(weather.answer.includes('没有实时天气数据'));
  assert.ok(weather.answer.includes('天气 App'));

  const rain = resolveDailyQuestion('今天会下雨吗');
  assert.ok(rain);
  assert.ok(rain.answer.includes('没有实时天气数据'));
});

test('单位换算', () => {
  assert.ok(
    resolveDailyQuestion('100华氏度是多少摄氏度').answer.includes('37.7778')
  );
  assert.ok(resolveDailyQuestion('1公里等于多少米').answer.includes('1000'));
  assert.ok(resolveDailyQuestion('1斤是多少克').answer.includes('500'));
  assert.ok(resolveDailyQuestion('1小时等于多少秒').answer.includes('3600'));
});

test('安全算术与百分比', () => {
  assert.ok(resolveDailyQuestion('1+1等于几').answer.includes('2'));
  assert.ok(resolveDailyQuestion('15%的200是多少').answer.includes('30'));
  assert.ok(resolveDailyQuestion('2的平方').answer.includes('4'));
  assert.ok(resolveDailyQuestion('9的平方根').answer.includes('3'));
});

test('日常知识命中常见主题', () => {
  assert.ok(resolveDailyQuestion('感冒了怎么办').answer.includes('就医'));
  assert.ok(resolveDailyQuestion('为什么会下雨').answer.includes('水汽'));
  assert.ok(resolveDailyQuestion('天为什么是蓝的').answer.includes('蓝光'));
  assert.ok(resolveDailyQuestion('周报怎么写').answer.includes('本周结果'));
  assert.ok(resolveDailyQuestion('怎么学好英语').answer.includes('输入'));
  assert.ok(resolveDailyQuestion('番茄炒蛋怎么做').answer.includes('番茄'));
});

test('基础学科知识命中并给出关键结论', () => {
  const cases = [
    ['什么是光合作用', '叶绿体'],
    ['勾股定理是什么', 'a²+b²'],
    ['牛顿第一定律是什么', '匀速直线运动'],
    ['水的沸点是多少', '100℃'],
    ['唐朝是什么', '贞观之治'],
    ['什么是宪法', '根本法'],
    ['股票是什么', '所有权凭证'],
    ['英语时态有哪些', '现在完成时']
  ];
  for (const [question, needle] of cases) {
    const result = resolveDailyQuestion(question);
    assert.ok(result, question);
    assert.ok(result.answer.includes(needle), `${question}: ${result.answer}`);
  }
});

test('常识问答直接给准确答案', () => {
  assert.ok(resolveDailyQuestion('钢琴有几个键').answer.includes('88'));
  assert.ok(resolveDailyQuestion('中国什么时候成立').answer.includes('1949'));
  assert.ok(resolveDailyQuestion('正常体温是多少').answer.includes('36'));
  assert.ok(resolveDailyQuestion('一年多少天').answer.includes('365'));
  assert.ok(resolveDailyQuestion('几点开会').answer.includes('日程'));
  assert.ok(resolveDailyQuestion('这东西多少钱').answer.includes('哪一款'));
});

test('专业领域的回答带边界提示', () => {
  assert.ok(resolveDailyQuestion('股票是什么').answer.includes('专业人士'));
  assert.ok(resolveDailyQuestion('合同违约怎么办').answer.includes('律师'));
  assert.ok(resolveDailyQuestion('消费者权益有哪些').answer.includes('咨询'));
});

test('不能确定的内容返回 null，而不是硬编', () => {
  assert.equal(resolveDailyQuestion('量子纠缠的第十种解释'), null);
  assert.equal(resolveDailyQuestion('今天有点累'), null);
  assert.equal(resolveDailyQuestion('你最近怎么样'), null);
  assert.equal(resolveDailyQuestion(''), null);
});

test('为什么下雨走知识而不是实时天气', () => {
  const result = resolveDailyQuestion('今天为什么下雨');
  assert.ok(result);
  assert.ok(result.answer.includes('水汽'));
  assert.ok(!result.answer.includes('没有实时天气数据'));
});
