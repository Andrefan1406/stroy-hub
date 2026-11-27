// Миграция drilling_requests: новые статусы (director, director_decide) и срок исполнения;
// заявки, ждавшие исполнителя Пром Альянс (line1), переносятся на шаг директора.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drreq-mig-'));
process.env.CONCRETE_DATA_DIR = dir;
process.env.RIDES_DATA_DIR = path.join(dir, 'rides');

test('старая таблица заявок: данные целы, line1 → director, колонка due_date добавлена, повтор безопасен', () => {
  const { DB_PATH } = require('../../db');
  const raw = new Database(DB_PATH);
  raw.exec(`CREATE TABLE drilling_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, initiator_email TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('engineer','line1','line2','returned','accepted','completed','cancelled')),
    round INTEGER NOT NULL DEFAULT 1, accepted_company_id INTEGER, accepted_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const ins = raw.prepare("INSERT INTO drilling_requests (initiator_email, status, round, created_at, updated_at) VALUES (?, ?, 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')");
  for (const st of ['engineer', 'line1', 'line2', 'accepted', 'returned']) ins.run('a@x.kz', st);
  raw.close();

  const { initSchema, getWriteDb } = require('../../db');
  initSchema();
  initSchema(); // повторный запуск ничего не ломает
  const db = getWriteDb();
  assert.deepEqual(db.prepare('SELECT status FROM drilling_requests ORDER BY id').all().map((r) => r.status),
    ['engineer', 'director', 'line2', 'accepted', 'returned']);
  assert.ok(db.prepare('PRAGMA table_info(drilling_requests)').all().some((c) => c.name === 'due_date'));
  assert.doesNotThrow(() => db.prepare("INSERT INTO drilling_requests (initiator_email, status, round, created_at, updated_at, due_date) VALUES ('b@x.kz', 'director_decide', 1, 'x', 'x', '2099-01-01')").run());
});
