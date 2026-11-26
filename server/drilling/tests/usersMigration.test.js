// Миграция rides.users (новые роли и колонки): данные и внешние ключи целы, повтор безопасен.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rides-mig-'));
process.env.RIDES_DATA_DIR = dir;

const OLD_USERS = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('employee','dispatcher','driver','admin')),
  full_site_access INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

test('миграция старой базы: строки и связи на месте, новые роли допустимы, повтор безопасен', () => {
  const { SCHEMA, DB_PATH } = require('../../rides/db');
  // «боевая» база до обновления: старая users + остальные таблицы со связанными данными
  const raw = new Database(DB_PATH);
  raw.pragma('foreign_keys = ON');
  raw.exec(OLD_USERS);
  raw.exec(SCHEMA); // users уже есть (старая) — создаст остальные таблицы со ссылками на неё
  raw.prepare("INSERT INTO users (email, name, phone, role, full_site_access) VALUES ('emp@x.kz','Иван','+7 701 000 00 01','employee',1)").run();
  raw.prepare("INSERT INTO users (email, name, phone, role, full_site_access) VALUES ('drv@x.kz','Пётр','+7 701 000 00 02','driver',0)").run();
  raw.prepare("INSERT INTO users (email, name, phone, role) VALUES ('disp@x.kz','Анна','+7 701 000 00 03','dispatcher')").run();
  raw.prepare("INSERT INTO vehicles (plate_number, model) VALUES ('123ABC01','Camry')").run();
  raw.prepare('INSERT INTO drivers (user_id, vehicle_id) VALUES (2, 1)').run();
  raw.prepare("INSERT INTO requests (employee_id, driver_id, from_address, to_address, requested_at) VALUES (1, 1, 'А', 'Б', '2026-11-18T09:00')").run();
  assert.equal(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql.includes('chief_engineer'), false);
  raw.close();

  const { initSchema, getWriteDb } = require('../../rides/db');
  initSchema();
  const db = getWriteDb();

  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('position') && cols.includes('company_id'));
  const users = db.prepare('SELECT id, email, name, phone, role, full_site_access, position, company_id FROM users ORDER BY id').all();
  assert.deepEqual(users.map((u) => [u.id, u.email, u.role, u.full_site_access]), [[1, 'emp@x.kz', 'employee', 1], [2, 'drv@x.kz', 'driver', 0], [3, 'disp@x.kz', 'dispatcher', 0]]);
  assert.equal(users[0].name, 'Иван');
  assert.equal(users[0].position, '');

  // связи не потеряны
  assert.equal(db.prepare('SELECT u.email FROM drivers d JOIN users u ON u.id = d.user_id').get().email, 'drv@x.kz');
  assert.equal(db.prepare('SELECT u.email FROM requests r JOIN users u ON u.id = r.employee_id').get().email, 'emp@x.kz');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'внешние ключи снова включены');

  // новые роли допустимы, левая нет; автонумерация продолжается
  for (const role of ['staff', 'chief_engineer', 'prom_alyans', 'driller']) {
    db.prepare("INSERT INTO users (email, name, phone, role) VALUES (?, 'X', '', ?)").run(`${role}@x.kz`, role);
  }
  assert.ok(db.prepare("SELECT id FROM users WHERE email = 'driller@x.kz'").get().id > 3);
  assert.throws(() => db.prepare("INSERT INTO users (email, name, phone, role) VALUES ('bad@x.kz','X','','boss')").run());

  // повторный запуск ничего не ломает
  initSchema();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 7);
});
