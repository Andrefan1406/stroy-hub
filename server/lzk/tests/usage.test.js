const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// отдельная временная база: db.js читает CONCRETE_DATA_DIR при загрузке
process.env.CONCRETE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lzk-usage-'));
const { initSchema } = require('../../db');
const { logUsage, readUsage } = require('../usage');

test('журнал использования: пользователи, ошибки, частые ненайденные работы', () => {
  initSchema();
  const unmatched = (name) => [{ name, unit: 'шт', qty: 3, reason: 'нет норм' }];
  logUsage({ email: 'a@x.kz', fileSize: 1000, summary: { rows: 10, works: [1, 2], materials: [1, 2, 3], unmatched: unmatched('Монтаж плит') } });
  logUsage({ email: 'a@x.kz', fileSize: 900, summary: { rows: 5, works: [1], materials: [1], unmatched: unmatched('Монтаж плит') } });
  logUsage({ email: 'b@x.kz', fileSize: 50, error: 'В шапке таблицы ВДЦ не найден столбец «Кол-во»' });

  const u = readUsage(10);
  assert.deepEqual(u.totals, { requests: 3, users: 2, errors: 1 });
  assert.equal(u.perUser.find((x) => x.email === 'a@x.kz').requests, 2);
  assert.equal(u.perUser.find((x) => x.email === 'b@x.kz').errors, 1);
  assert.deepEqual(u.topUnmatched.map((x) => [x.name, x.count]), [['Монтаж плит', 2]]);
  assert.equal(u.recent[0].email, 'b@x.kz'); // новые сверху
  assert.match(u.recent[0].error, /не найден столбец/);
  assert.equal(u.recent[2].works_count, 2);
});
