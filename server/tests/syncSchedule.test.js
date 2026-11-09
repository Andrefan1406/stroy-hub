const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('node-cron');
const { SYNC_TZ, DEFAULT_CRON } = require('../syncSchedule');

test('плановые синки: корректные cron-выражения, раз в сутки, ночью по Алматы, в разное время', () => {
  assert.equal(SYNC_TZ, 'Asia/Almaty');
  const entries = Object.entries(DEFAULT_CRON);
  assert.equal(entries.length, 5);
  const times = new Set();
  for (const [name, expr] of entries) {
    assert.ok(cron.validate(expr), `${name}: некорректное выражение «${expr}»`);
    const [minute, hour, dom, month, dow] = expr.split(' ');
    assert.deepEqual([dom, month, dow], ['*', '*', '*'], `${name}: должен идти раз в сутки`);
    assert.ok(/^\d+$/.test(minute) && /^\d+$/.test(hour), `${name}: фиксированное время`);
    assert.ok(Number(hour) >= 1 && Number(hour) <= 2, `${name}: ночью (01:00–02:59)`);
    times.add(`${hour}:${minute}`);
  }
  assert.equal(times.size, 5, 'синки не должны стартовать одновременно');
  assert.equal(DEFAULT_CRON.objects, '0 1 * * *', 'первый — в час ночи');
});

test('самый тяжёлый синк (люди) идёт последним и не ближе 15 минут к предыдущему', () => {
  const minutes = (expr) => {
    const [m, h] = expr.split(' ');
    return Number(h) * 60 + Number(m);
  };
  const sorted = Object.entries(DEFAULT_CRON).map(([k, v]) => [k, minutes(v)]).sort((a, b) => a[1] - b[1]);
  assert.equal(sorted.at(-1)[0], 'people');
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i][1] - sorted[i - 1][1] >= 15);
});
