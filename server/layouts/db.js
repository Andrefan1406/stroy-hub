// Схемы расположения бытовок на стройплощадке (страница /site-layouts).
// Отдельный файл SQLite, как и у системы поездок: на Render по умолчанию
// лежит рядом с базой поездок (RIDES_DATA_DIR — постоянный диск), чтобы не
// заводить для этого новую переменную; можно задать LAYOUTS_DATA_DIR.
//
// Объекты схемы (layout_objects) хранятся по одному: совместная правка идёт
// пообъектно — «бытовка 17 сдвинута», — и при одновременных правках разных
// объектов ничего не теряется; одну и ту же бытовку побеждает последняя правка.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.LAYOUTS_DATA_DIR || process.env.RIDES_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'layouts.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS layouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 0,       -- растёт с каждой правкой
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- type: cabin (бытовка, size '12x2.5' | '6x2.5'), title (заголовок объекта,
-- крупный текст где угодно), label (подпись внутри бытовки, parent_id —
-- бытовка, sort — порядок строк). x, y — центр, в метрах; rotation —
-- градусы, кратно 45.
CREATE TABLE IF NOT EXISTS layout_objects (
  layout_id   INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('cabin', 'title', 'label')),
  size        TEXT,
  x           REAL NOT NULL DEFAULT 0,
  y           REAL NOT NULL DEFAULT 0,
  rotation    INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL DEFAULT '',
  parent_id   TEXT,
  sort        REAL NOT NULL DEFAULT 0,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (layout_id, id)
);
-- Кому, кроме главного админа, можно открывать и править схемы.
CREATE TABLE IF NOT EXISTS layout_editors (
  email       TEXT PRIMARY KEY,
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let db = null;

function getLayoutsDb() {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
  }
  return db;
}

module.exports = { getLayoutsDb, DB_PATH };
