// Блокировка по просроченным замечаниям PlanRadar: граница в три дня,
// подсчёт по объектам и выдача по email (server/planradar.js).
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planradar-'));
process.env.CONCRETE_DATA_DIR = dir;
process.env.PLANRADAR_API_KEY = 'k';
process.env.PLANRADAR_CUSTOMER_ID = '1';
process.env.PLANRADAR_PROJECTS_FILE = path.join(dir, 'projects.json');
fs.writeFileSync(process.env.PLANRADAR_PROJECTS_FILE, JSON.stringify({
  'Жилой дом поз.63': { id: 'p63', emails: ['a@x.kz', 'Both@X.kz'] },
  'Лицей': { id: 'lic', emails: ['both@x.kz'] },
  'КОС': { id: 'kos', emails: [] },
}));

const { initSchema } = require('./db');
initSchema();
const { countOverdue, ticketDeadline, daysBefore, refreshOverdue, overdueForEmail } = require('./planradar');

const ticket = (due, ext) => ({ attributes: { 'due-date': due, ...(ext ? { 'extension-date': ext } : {}) } });

test('граница: срок истёк три дня назад и раньше — считается, позже — нет', () => {
  assert.equal(daysBefore('2026-11-02', 3), '2026-10-30');
  const tickets = [
    ticket('2026-10-30'),            // ровно 3 дня назад — блокирует
    ticket('2026-10-01'),            // давно
    ticket('2026-10-31'),            // 2 дня — ещё нет
    ticket('2026-11-05'),            // срок впереди
    { attributes: {} },              // срока нет
  ];
  assert.equal(countOverdue(tickets, '2026-11-02'), 2);
});

test('действующий срок — дата продления, если она позже', () => {
  assert.equal(ticketDeadline(ticket('2026-10-01', '2026-11-10')), '2026-11-10');
  assert.equal(ticketDeadline(ticket('2026-10-01T19:00:00Z')), '2026-10-01');
  assert.equal(countOverdue([ticket('2026-10-01', '2026-11-10')], '2026-11-12'), 0, 'продлено — не просрочено');
});

test('опрос PlanRadar и выдача по email: объекты с числом замечаний', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    const id = String(url).match(/projects\/([^/]+)\/tickets/)[1];
    const old = '2020-01-01';
    const data = id === 'p63' ? [ticket(old), ticket(old), ticket('2999-01-01')] : [ticket(old)];
    return { ok: true, json: async () => ({ data }) };
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  const run = refreshOverdue();
  for (let i = 0; i < 10; i++) { await Promise.resolve(); mock.timers.tick(3000); }
  const res = await run;
  mock.timers.reset();

  assert.deepEqual(res, { ok: 2, failed: 0 });
  assert.equal(calls.length, 2, 'объект без закреплённых не опрашивается');
  assert.match(calls[0], /filter\[status_id\]|filter%5Bstatus_id%5D/);
  assert.deepEqual(overdueForEmail('a@x.kz'), [{ project: 'Жилой дом поз.63', count: 2 }]);
  assert.deepEqual(overdueForEmail('BOTH@x.kz'), [{ project: 'Жилой дом поз.63', count: 2 }, { project: 'Лицей', count: 1 }]);
  assert.deepEqual(overdueForEmail('other@x.kz'), [], 'чужой email не блокируется');
});

test('сбой PlanRadar не стирает прежнее значение и не блокирует новых', async () => {
  mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  mock.timers.enable({ apis: ['setTimeout'] });
  const res = await refreshOverdue();
  mock.timers.reset();
  assert.deepEqual(res, { ok: 0, failed: 2 });
  assert.equal(overdueForEmail('a@x.kz')[0].count, 2, 'прежнее значение осталось');
});
