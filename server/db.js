// SQLite-хранилище синхронизированных заявок на бетон.
// Пишущее соединение (WAL) использует только syncConcrete.js,
// читающее (readonly) — только chatHandler.js, чтобы сгенерированный
// LLM SQL физически не мог ничего изменить, даже если бы обошёл sqlGuard.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// На Render (и любом другом хостинге с эфемерной ФС) без подключённого
// Persistent Disk этот файл стирается при каждом деплое/рестарте — вместе с
// ним пропадают и concrete_hidden_requests (локальные "удаления" в таблице
// заявок), и people_gap_decisions (решения по пропускам в отчётах по людям).
// CONCRETE_DATA_DIR позволяет указать путь примонтированного диска явно,
// не завязываясь на внутреннюю структуру каталогов конкретного хостинга.
const DATA_DIR = process.env.CONCRETE_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'concrete.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS concrete_orders (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_date          TEXT,
  shipment_date_raw      TEXT,
  category               TEXT,
  material               TEXT,
  object_name            TEXT,
  block_position         TEXT,
  grade_class            TEXT,
  volume_planned_m3      REAL,
  volume_actual_m3       REAL,
  execution_note         TEXT,
  planned_delivery_date  TEXT, -- "Планируемая дата поставки" из Google Таблицы: дата, которую
                                -- заказчик указал при подаче заявки, 'YYYY-MM-DD'. Отличается
                                -- от shipment_date ("Дата отгрузки"), которая проставляется по
                                -- факту исполнения и может не совпадать с запланированной.
  submitted_at           TEXT, -- "Дата и время подачи заявки", 'YYYY-MM-DD HH:MM:SS' (может
                                -- быть NULL у старых строк без этой колонки в исходнике).
  geo_approved           INTEGER DEFAULT 0, -- 1, если "Согласование геодезистов" = "Согласовано".
  responsible_name       TEXT, -- "ФИО" заявителя из Google Таблицы.
  responsible_phone      TEXT, -- "Телефон" заявителя из Google Таблицы.
  note                   TEXT, -- "Примечание" заявителя из Google Таблицы.
  request_key            TEXT, -- естественный ключ строки (submitted_at+object+position+
                                -- material+volume) — см. syncConcrete.js:buildRequestKey.
                                -- Не проставляется как UNIQUE: два разных синка одной и той же
                                -- заявки должны давать один и тот же ключ, а не конфликтовать.
  synced_at              TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_concrete_date     ON concrete_orders(shipment_date);
CREATE INDEX IF NOT EXISTS idx_concrete_object   ON concrete_orders(object_name);
CREATE INDEX IF NOT EXISTS idx_concrete_material ON concrete_orders(material);
-- idx_concrete_key НЕ здесь: на уже существующей локальной/прод базе
-- (CREATE TABLE IF NOT EXISTS — no-op, если таблица уже есть) колонки
-- request_key ещё может не быть, пока не отработает ALTER TABLE в
-- migrateSchema() ниже. Индекс создаётся там же, сразу после ALTER.

-- Локальное «удаление» строк из таблицы неисполненных заявок (см.
-- src/components/ConcretePendingRequestsTable.jsx) — НЕ трогает исходную
-- Google Таблицу и НЕ пересоздаётся при синке (иначе скрытая строка
-- вернулась бы уже через 2 часа, на следующем DELETE+INSERT в
-- concrete_orders). Единственный источник истины о том, что скрыто.
CREATE TABLE IF NOT EXISTS concrete_hidden_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key  TEXT NOT NULL UNIQUE,
  hidden_by    TEXT NOT NULL, -- email администратора (проверяется на бэкенде через Firebase ID token)
  hidden_at    TEXT DEFAULT (datetime('now'))
);

-- objects — чистое зеркало вкладки "Объекты" Google Таблицы: пересоздаём таблицу
-- при каждом старте (DROP+CREATE), а не ALTER, потому что данные в ней никогда
-- не редактируются вручную и полностью перезаписываются синком сразу после
-- старта (см. syncObjects.js) — так набор колонок в БД гарантированно совпадает
-- с текущей схемой в коде, без ручных миграций.
DROP TABLE IF EXISTS objects;
CREATE TABLE objects (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  object_name           TEXT,
  object_name_short     TEXT,
  position              TEXT,
  apartments_count      INTEGER,
  object_type           TEXT,
  status                TEXT,
  address               TEXT,
  commissioning_date    TEXT,
  building_area_m2      REAL,
  apartments_area_m2    REAL,
  sewer_network_m       REAL,
  water_network_m       REAL,
  heating_network_m     REAL,
  power_network_m       REAL,
  low_current_network_m REAL,
  coverage_area_m2      REAL,
  synced_at             TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_objects_type   ON objects(object_type);
CREATE INDEX IF NOT EXISTS idx_objects_status ON objects(status);

-- defect_acts — чистое зеркало реестра дефектных актов (одна строка = один
-- акт). Та же стратегия, что и у objects/concrete_orders: DROP+CREATE,
-- полная перезапись синком (см. syncDefectActs.js), у строк исходной
-- таблицы нет стабильного ID. embedding_synced_at отдельно от synced_at:
-- проставляется ПОСЛЕ того, как для строки посчитан и загружен в Qdrant
-- эмбеддинг (см. server/embeddings.js) — по нему синк находит новые/
-- изменившиеся строки, которые ещё не проиндексированы для RAG-поиска,
-- не пересчитывая эмбеддинги заново для всех 1000+ строк на каждый синк.
DROP TABLE IF EXISTS defect_acts;
CREATE TABLE defect_acts (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  act_number                TEXT,    -- "№" — не гарантированно уникален/последователен, просто как в реестре
  act_date                  TEXT,    -- дата дефектного акта, 'YYYY-MM-DD' (NULL, если не распарсилась)
  act_date_raw              TEXT,    -- исходная строка даты как есть (на случай нераспознанного формата)
  object_position            TEXT,   -- "Объект, позиция" (объект и позиция вместе, свободный текст из реестра)
  defect_description         TEXT,   -- "Описание дефекта"
  responsible_occurrence     TEXT,   -- "Ответственный за возникновение дефекта"
  responsible_fix            TEXT,   -- "Ответственный за устранение дефекта"
  pto_engineer                TEXT,  -- "инж.ПТО"
  commission_conclusion       TEXT,  -- "Заключение комиссии"
  fix_mark                    TEXT,  -- "Отметка об устранении дефекта" — непусто обычно значит, что устранено
  total_cost                  REAL,  -- "Общие затраты на устранение дефекта"
  amount_to_withhold          REAL,  -- "К удержанию"
  amount_withheld              REAL, -- "Удержано"
  withhold_date                TEXT, -- "Дата удержания", 'YYYY-MM-DD'
  invoice_number                TEXT, -- "№ накладной"
  withhold_status                TEXT, -- 'удержано' | 'подлежит удержанию' | 'не подлежит удержанию' | NULL
  withhold_reason_na             TEXT, -- "Причина по которой не подлежит удержанию"
  note                            TEXT, -- "Примечание"
  embedding_synced_at             TEXT, -- когда для строки последний раз посчитан и загружен эмбеддинг в Qdrant; NULL = ещё не проиндексирована
  synced_at                       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_defect_acts_date            ON defect_acts(act_date);
CREATE INDEX IF NOT EXISTS idx_defect_acts_object_position ON defect_acts(object_position);
CREATE INDEX IF NOT EXISTS idx_defect_acts_withhold_status ON defect_acts(withhold_status);

-- people_reports — чистое зеркало ежедневных отчётов начальников участков
-- по людям (кто, где, сколько человек), без восстановления пропусков.
-- Пересоздаётся при каждом старте по той же причине, что и objects.
DROP TABLE IF EXISTS people_reports;
CREATE TABLE people_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date     TEXT,
  site            TEXT,
  object_category TEXT,
  object_name     TEXT,
  position        TEXT,
  contractor      TEXT,
  profession      TEXT,
  headcount       REAL,
  synced_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_people_reports_date ON people_reports(report_date);
CREATE INDEX idx_people_reports_site ON people_reports(site);

-- people_report_gaps — статус отчётности на уровне (участок, день) на весь
-- календарный диапазон участка, включая субботу и воскресенье — выходные
-- участвуют в пропусках наравне с рабочими днями (по требованию пользователя:
-- раньше выходной без отчёта считался нормой, теперь тоже ждёт решения
-- человека). Только ОБНАРУЖЕНИЕ пропусков (см. peopleGapDetection.js) —
-- никаких данных сюда автоматически не подставляется. Пересчитывается при
-- каждом синке и при каждом изменении решений (people_gap_decisions), поэтому
-- DROP+CREATE.
--   status:
--     'real'                — реальный отчёт за день есть
--     'missing'             — день (рабочий или выходной) без отчёта, ЖДЁТ решения человека
--     'resolved_copy'       — администратор решил заполнить копированием с другого дня
--     'resolved_no_report'  — администратор подтвердил: участок в этот день не работал
--     'resolved_completed'  — администратор отметил: работы на участке завершены с этого дня
--     'inactive'            — день ПОСЛЕ 'resolved_completed': участок закрыт, отчёт не
--                              ожидается, это НЕ пропуск и решения не требует — до тех пор,
--                              пока не появится новый реальный отчёт (например, гарантийные
--                              работы), после чего дальнейшие дни снова становятся 'missing'
-- is_weekend при этом остаётся информационным флагом (для контекста при
-- принятии решения), а не признаком того, что решение не нужно.
DROP TABLE IF EXISTS people_report_gaps;
CREATE TABLE people_report_gaps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date     TEXT,
  site            TEXT,
  is_weekend      INTEGER,
  status          TEXT,
  total_headcount REAL,    -- сумма headcount за день; NULL, если данных нет (включая нерешённые пропуски)
  entries_count   INTEGER,
  decided_by      TEXT,    -- email администратора, принявшего решение (для resolved_*), иначе NULL
  decided_at      TEXT,    -- когда принято решение (для resolved_*), иначе NULL
  source_date     TEXT,    -- для resolved_copy: с какого дня скопированы данные
  synced_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_people_gaps_date ON people_report_gaps(report_date);
CREATE INDEX idx_people_gaps_site ON people_report_gaps(site);
CREATE INDEX idx_people_gaps_status ON people_report_gaps(status);

-- people_gap_decisions — ПОСТОЯННОЕ хранилище решений человека по пропускам.
-- В отличие от остальных people_* таблиц, НЕ пересоздаётся при синке/старте
-- (CREATE TABLE IF NOT EXISTS, без DROP) — это единственный источник истины
-- о том, что решил администратор, и он должен пережить и рестарт процесса,
-- и обновление сырых данных из Google Таблицы.
--   action: 'copy' (скопировать данные с source_date) | 'confirm_no_report' (участок не работал)
--           | 'work_completed' (работы завершены — закрывает все последующие дни участка,
--             см. peopleGapDetection.js, пока не появится новый реальный отчёт)
CREATE TABLE IF NOT EXISTS people_gap_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site            TEXT NOT NULL,
  report_date     TEXT NOT NULL, -- дата пропуска, к которому относится решение
  action          TEXT NOT NULL,
  source_date     TEXT,          -- обязателен для action='copy'
  note            TEXT,
  decided_by      TEXT NOT NULL, -- email администратора (проверяется на бэкенде через Firebase ID token)
  decided_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(site, report_date)
);

-- people_reports_resolved — состав отчёта (по объекту/профессии/подрядчику)
-- поверх РЕАЛЬНЫХ данных плюс данных, которые администратор явно решил
-- скопировать через people_gap_decisions (action='copy'). Пропуски без
-- решения человека сюда не попадают вообще — никаких автоматических догадок.
-- Пересчитывается при каждом синке и при каждом изменении решений.
DROP TABLE IF EXISTS people_reports_resolved;
CREATE TABLE people_reports_resolved (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date     TEXT,
  site            TEXT,
  object_category TEXT,
  object_name     TEXT,
  position        TEXT,
  contractor      TEXT,
  profession      TEXT,
  headcount       REAL,
  is_filled       INTEGER, -- 1 = заполнено администратором вручную (копия с source_date), 0 = реальная запись
  is_weekend      INTEGER,
  source_date     TEXT,    -- для is_filled=1: дата, с которой скопированы данные
  decided_by      TEXT,    -- для is_filled=1: email администратора
  synced_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_people_resolved_date ON people_reports_resolved(report_date);
CREATE INDEX idx_people_resolved_site ON people_reports_resolved(site);

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- people_gap_check_rules — конфигурация того, для какого email какой
-- участок проверять на пропуски в отчётах по людям при подаче заявок (см.
-- server/peopleGapsCheck.js, src/peopleGapsGate.js). Управляется через
-- админ-панель /admin/users (см. server/peopleGapsAdmin.js: /check-rules,
-- src/pages/PeopleGapsUsersAdminPage.jsx) — раньше это был единственный
-- захардкоженный email+участок, теперь произвольный список. ПОСТОЯННОЕ
-- хранилище (CREATE TABLE IF NOT EXISTS, без DROP) — правила не должны
-- пропадать при синке/рестарте, как и people_gap_decisions. Один email
-- может быть привязан к нескольким участкам (и наоборот) — UNIQUE не даёт
-- только продублировать одну и ту же пару.
CREATE TABLE IF NOT EXISTS people_gap_check_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  site       TEXT NOT NULL,
  created_by TEXT,    -- email администратора, добавившего правило
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(email, site)
);
CREATE INDEX IF NOT EXISTS idx_gap_check_rules_email ON people_gap_check_rules(email);

-- gpr_report_values — чистое зеркало еженедельных % готовности из графиков
-- производства работ (ГПР) — НЕСКОЛЬКИХ источников/листов сразу (см. SOURCES
-- в syncGprReport.js: сейчас лист "64,72" — только 'поз.64', и отдельный
-- лист "НЖ3" (ОВ+ВК) — все позиции). source_key различает источники —
-- одинаковый work_name+position может встретиться в РАЗНЫХ источниках
-- (например, "поз.64" есть и на листе "64,72", и как блок внутри "НЖ3") и
-- это разные строки, а не дубликаты. Один столбец исходной таблицы = одна
-- пятница; ячейка может быть пустой (percent IS NULL) — это НЕ 0%, а "ещё
-- не заполнено", и есть основа для обнаружения пропусков (см.
-- computeGprReportGaps в syncGprReport.js). DROP+CREATE, как у
-- defect_acts/objects — у строк исходника нет стабильного ID, при каждом
-- синке проще перезаписать всё целиком.
-- block — используется только источниками с "Блок N" (см. blockMarkerRe в
-- SOURCES, сейчас — 'facades'/"план_processed"): строка "Блок N" в колонке
-- "Конструктивы" сама по себе не работа, а агрегат по своим дочерним
-- строкам (та же природа, что и "Позиция N"/"Отопление"-подытог в НЖ3) —
-- её процент НЕ сохраняется отдельной строкой, а её текст запоминается и
-- проставляется в колонку block всем последующим работам этой позиции,
-- пока не встретится следующий "Блок N" или новая позиция. '' (не NULL!) —
-- принципиально: у позиций без явного блока (значит, блок один и он не
-- поименован) block = '' у всех строк, а NULL в UNIQUE-ограничении SQLite
-- считает НЕ равным другому NULL — с '' повторный синк корректно
-- перезаписывает те же строки, а не плодит дубликаты.
DROP TABLE IF EXISTS gpr_report_values;
CREATE TABLE gpr_report_values (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key   TEXT,    -- 'poz64_72' | 'nz3' | 'facades' — какой источник/лист (см. SOURCES)
  source_label TEXT,    -- человекочитаемая подпись источника, для админ-панели
  position     TEXT,    -- 'поз.64', 'поз.56' и т.п. — сырой маркер позиции из колонки A
  block        TEXT NOT NULL DEFAULT '', -- 'Блок 1'/'Блок 2' и т.п.; '' — блоков нет (один неявный блок)
  work_name    TEXT,    -- "Конструктив" (например, "Оконные блоки")
  report_date  TEXT,    -- 'YYYY-MM-DD', всегда пятница
  percent      REAL,    -- 0-100; NULL, если ячейка в исходнике пустая
  synced_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(source_key, position, block, work_name, report_date)
);
CREATE INDEX IF NOT EXISTS idx_gpr_values_source_position ON gpr_report_values(source_key, position, block, work_name);
CREATE INDEX IF NOT EXISTS idx_gpr_values_date ON gpr_report_values(report_date);

-- Плановые начало/конец раздела (колонки "Начало"/"Окончание" рядом с
-- "Конструктивы" в исходнике) — ОДНО значение на весь раздел, не по неделям,
-- поэтому отдельная таблица, а не колонки в gpr_report_values (там UNIQUE
-- по report_date, значение задваивалось бы на каждую неделю). Нужны для
-- финплана (services/financing-api/) — план по срокам, а не факт прогресса.
DROP TABLE IF EXISTS gpr_report_plan_dates;
CREATE TABLE gpr_report_plan_dates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key   TEXT,
  position     TEXT,
  block        TEXT NOT NULL DEFAULT '',
  work_name    TEXT,
  plan_start   TEXT,    -- 'YYYY-MM-DD'; NULL, если ячейка "Начало" пустая/не дата
  plan_end     TEXT,    -- 'YYYY-MM-DD'; NULL, если ячейка "Окончание" пустая/не дата
  synced_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(source_key, position, block, work_name)
);

-- gpr_report_check_rules — email'ы, для которых подача заявок блокируется,
-- пока в ГПР есть незакрытый пропуск — тот же принцип, что и
-- people_gap_check_rules, только "источник" (source_key, см. SOURCES в
-- syncGprReport.js) вместо "участка": за разные листы ГПР (64,72 и НЖ3)
-- отвечают разные люди, поэтому правило привязано к конкретному источнику,
-- а не блокирует по любому пропуску сразу везде. UNIQUE(email, source_key) —
-- один и тот же email МОЖЕТ быть отдельно назначен на оба источника (если
-- вдруг один человек отвечает за оба), но не дважды на один и тот же.
-- ПОСТОЯННОЕ хранилище (CREATE TABLE IF NOT EXISTS, без DROP) — правила не
-- должны пропадать при синке/рестарте, как и people_gap_check_rules.
CREATE TABLE IF NOT EXISTS gpr_report_check_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  source_key TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(email, source_key)
);

-- manual_user_blocks — ручная блокировка пользователя администратором (см.
-- server/manualBlock.js, /admin/blocked-users), независимо от пропусков в
-- отчётах по людям/ГПР. Строка на email; blocked=0 — блокировка снята, но
-- комментарий сохраняется, чтобы при повторном включении не вводить заново.
-- comment показывается самому пользователю на главной — ВЫШЕ сообщений об
-- автоматических блокировках. ПОСТОЯННОЕ хранилище, как и *_check_rules.
CREATE TABLE IF NOT EXISTS manual_user_blocks (
  email      TEXT PRIMARY KEY,
  blocked    INTEGER NOT NULL DEFAULT 0,
  comment    TEXT,
  updated_by TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

let writeDb = null;
let readDb = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// concrete_orders создаётся через CREATE TABLE IF NOT EXISTS (а не DROP+CREATE,
// как objects/people_reports), поэтому у уже существующих баз (локальных и на
// проде) новая колонка сама не появится — нужна явная миграция ALTER TABLE.
// Добавляем сюда по мере необходимости; безопасно звать многократно —
// проверяем PRAGMA table_info, ADD COLUMN шлём только если колонки ещё нет.
function migrateSchema(db) {
  const columns = db.prepare("PRAGMA table_info(concrete_orders)").all().map((c) => c.name);
  if (!columns.includes('planned_delivery_date')) {
    db.exec('ALTER TABLE concrete_orders ADD COLUMN planned_delivery_date TEXT');
  }
  if (!columns.includes('submitted_at')) {
    db.exec('ALTER TABLE concrete_orders ADD COLUMN submitted_at TEXT');
  }
  if (!columns.includes('geo_approved')) {
    db.exec('ALTER TABLE concrete_orders ADD COLUMN geo_approved INTEGER DEFAULT 0');
  }
  if (!columns.includes('request_key')) {
    db.exec('ALTER TABLE concrete_orders ADD COLUMN request_key TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_concrete_key ON concrete_orders(request_key)');
  }
  if (!columns.includes('responsible_name')) {
    db.exec('ALTER TABLE concrete_orders ADD COLUMN responsible_name TEXT');
  }
  if (!columns.includes('responsible_phone')) {
    db.exec('ALTER TABLE concrete_orders ADD COLUMN responsible_phone TEXT');
  }
  if (!columns.includes('note')) {
    db.exec('ALTER TABLE concrete_orders ADD COLUMN note TEXT');
  }

  // gpr_report_check_rules раньше блокировала по email без источника
  // (UNIQUE(email) — одно правило сразу на все листы ГПР). После появления
  // второго источника (НЖ3) выяснилось, что за разные листы отвечают разные
  // люди — понадобилась колонка source_key и составной UNIQUE(email,
  // source_key). SQLite не даёт менять table-level UNIQUE через ALTER TABLE
  // напрямую, поэтому пересобираем таблицу целиком (стандартный для SQLite
  // приём), перенося уже добавленные администратором правила — старые
  // правила (заведённые до разделения) относим к 'poz64_72' как к первому/
  // основному источнику, чтобы не снять блокировку молча; если правило
  // должно действовать и на НЖ3, администратор добавит его туда явно ещё
  // раз через /admin/users.
  const gprRuleColumns = db.prepare("PRAGMA table_info(gpr_report_check_rules)").all().map((c) => c.name);
  if (!gprRuleColumns.includes('source_key')) {
    db.exec(`
      CREATE TABLE gpr_report_check_rules_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        email      TEXT NOT NULL,
        source_key TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(email, source_key)
      );
      INSERT INTO gpr_report_check_rules_new (id, email, source_key, created_by, created_at)
        SELECT id, email, 'poz64_72', created_by, created_at FROM gpr_report_check_rules;
      DROP TABLE gpr_report_check_rules;
      ALTER TABLE gpr_report_check_rules_new RENAME TO gpr_report_check_rules;
    `);
  }
}

// Открывает/создаёт БД и накатывает схему. Идемпотентно, безопасно
// звать многократно (используется при старте процесса).
function initSchema() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrateSchema(db);
  db.close();
}

function getWriteDb() {
  if (!writeDb) {
    ensureDataDir();
    writeDb = new Database(DB_PATH);
    writeDb.pragma('journal_mode = WAL');
  }
  return writeDb;
}

function getReadDb() {
  if (!readDb) {
    readDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  }
  return readDb;
}

function getLastSyncedAt(key = 'last_synced_at') {
  try {
    const row = getReadDb().prepare('SELECT value FROM sync_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (err) {
    // до первого initSchema()+sync файла/таблиц ещё может не быть
    return null;
  }
}

module.exports = { DB_PATH, initSchema, getWriteDb, getReadDb, getLastSyncedAt };
