// SQLite-хранилище модуля ПТО (ведомости по проектной документации).
// Отдельный файл БД, как у системы поездок (server/rides/db.js): модуль не
// делит ни схему, ни соединение с concrete.db и Google-синками. Решения
// пользователя (правки, подтверждённые соответствия расценок) — постоянные
// таблицы CREATE TABLE IF NOT EXISTS, которые никогда не пересоздаются.
//
// PTO_DATA_DIR — путь к персистентному диску: на хостинге с эфемерной файловой
// системой (Render) без него база стирается при каждом деплое.
//
// Иерархия — по справочникам сайта (src/data/concreteObjectTaxonomy.json):
// категория → объект → позиция → раздел проекта (КЖ, потом АР, КР, ОВ, ВК, ЭОМ).
// Блок (секция) здания пользователь не выбирает: он определяется по чертежам и
// хранится у каждой строки (pto_items.block, pto_works.block); pto_documents.block
// остался от первой версии и не используется. Раздел — просто значение
// pto_documents.section; всё, что зависит от раздела (разбор PDF, виды работ),
// подключается через реестр server/pto/sections.js.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.PTO_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'pto.sqlite');

const SCHEMA = `
-- Загруженный PDF раздела проекта. Сам файл не храним (на хостинге диск
-- эфемерный): только то, что из него извлечено, и отчёт о разборе.
CREATE TABLE IF NOT EXISTS pto_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  section      TEXT NOT NULL,
  category     TEXT,
  object_name  TEXT NOT NULL,
  position     TEXT,
  block        TEXT,
  file_name    TEXT NOT NULL,
  file_size    INTEGER,
  page_count   INTEGER,
  -- parsing — идёт разбор; draft — разобран, ждёт проверки; confirmed —
  -- проверен пользователем; error — разобрать не удалось (текст в error).
  status       TEXT NOT NULL DEFAULT 'parsing' CHECK(status IN ('parsing','draft','confirmed','error')),
  error        TEXT,
  report_json  TEXT,
  uploaded_by  TEXT,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  parsed_at    TEXT,
  -- 1: ведомость правили после расчёта видов работ — их стоит пересчитать.
  works_stale  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pto_documents_object ON pto_documents(object_name, position, block);

-- Строка ведомости материалов. Одинаковые позиции с разных листов уже
-- объединены (сумма в quantity), листы-источники — в sources_json:
-- [{ "page": 23, "quantity": 92 }].
--   kind  — steel (арматура) | embedded (закладные) | concrete | metal (прочая сталь)
--   basis — summary (сводная «Ведомость расхода стали») | spec (спецификации элементов)
--   counted — 0: строка справочная и в стоимость/объёмы работ не входит
--             (спецификационная арматура, когда есть сводная ведомость).
--   status — draft (извлечено автоматически) | confirmed (проверено)
--   edited — 1: количество/название правили вручную; manual — строку добавили вручную.
CREATE TABLE IF NOT EXISTS pto_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES pto_documents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  block       TEXT,
  element     TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  mark_class  TEXT NOT NULL DEFAULT '',
  unit        TEXT NOT NULL,
  quantity    REAL NOT NULL,
  basis       TEXT NOT NULL DEFAULT 'spec',
  counted     INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'draft',
  edited      INTEGER NOT NULL DEFAULT 0,
  manual      INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pto_items_doc ON pto_items(document_id);

-- Вид работ с объёмом (из материалов или добавлен вручную) и подобранная
-- расценка. price — цена за единицу с НДС.
--   mapping_status — none (расценка не подобрана) | suggested (предложена,
--   ждёт подтверждения) | confirmed (подтверждена пользователем / взята из
--   ранее подтверждённых).
CREATE TABLE IF NOT EXISTS pto_works (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id    INTEGER NOT NULL REFERENCES pto_documents(id) ON DELETE CASCADE,
  block          TEXT,
  element        TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  unit           TEXT NOT NULL,
  quantity       REAL,
  basis_note     TEXT,
  rate_query     TEXT,
  pages_json     TEXT NOT NULL DEFAULT '[]', -- листы PDF, из которых получена работа ([23, 25])
  rate_id        INTEGER,
  rate_class     TEXT,
  rate_name      TEXT,
  rate_unit      TEXT,
  price          REAL,
  confidence     REAL,
  mapping_status TEXT NOT NULL DEFAULT 'none',
  manual_rate    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'draft',
  edited         INTEGER NOT NULL DEFAULT 0,
  manual         INTEGER NOT NULL DEFAULT 0,
  sort           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pto_works_doc ON pto_works(document_id);

-- Подтверждённые соответствия «вид работ → расценка» — переживают новые
-- загрузки: при следующем документе та же работа получает ту же расценку.
-- work_key — нормализованное название работы + единица (см. rates.workKey).
CREATE TABLE IF NOT EXISTS pto_price_mappings (
  work_key     TEXT PRIMARY KEY,
  rate_id      INTEGER,
  rate_class   TEXT,
  rate_name    TEXT NOT NULL,
  rate_unit    TEXT NOT NULL,
  price        REAL,
  manual       INTEGER NOT NULL DEFAULT 0,
  confirmed_by TEXT,
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Цены на материалы (в своде расценок их нет, только работы). Пока — ориентиры,
-- заданные вручную; потом сюда подключится утверждённый прайс.
CREATE TABLE IF NOT EXISTS pto_material_prices (
  kind       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL,
  price      REAL NOT NULL,
  note       TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Ориентировочные цены на материалы (₸ за единицу), заданы заказчиком модуля
// до появления утверждённого прайса. INSERT OR IGNORE — правки в таблице
// (через API) при перезапуске не затираются.
const DEFAULT_MATERIAL_PRICES = [
  { kind: 'steel', name: 'Арматура (сталь)', unit: 'тн', price: 400000, note: 'Ориентировочная цена, утверждённого прайса пока нет' },
  { kind: 'concrete', name: 'Бетон', unit: 'м³', price: 40000, note: 'Ориентировочная цена, утверждённого прайса пока нет' },
];

let db = null;

function getDb() {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// Колонки, добавленные после первого выпуска: у уже созданной базы их нет, CREATE TABLE IF NOT EXISTS их не добавит.
function migrate(d) {
  const has = (table, column) => d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  for (const table of ['pto_items', 'pto_works']) {
    if (!has(table, 'block')) d.exec(`ALTER TABLE ${table} ADD COLUMN block TEXT`);
  }
  if (!has('pto_works', 'pages_json')) d.exec("ALTER TABLE pto_works ADD COLUMN pages_json TEXT NOT NULL DEFAULT '[]'");
}

function initSchema() {
  const d = getDb();
  d.exec(SCHEMA);
  migrate(d);
  const ins = d.prepare('INSERT OR IGNORE INTO pto_material_prices (kind, name, unit, price, note) VALUES (@kind, @name, @unit, @price, @note)');
  for (const p of DEFAULT_MATERIAL_PRICES) ins.run(p);
  return d;
}

module.exports = { DB_PATH, DATA_DIR, getDb, initSchema, DEFAULT_MATERIAL_PRICES };
