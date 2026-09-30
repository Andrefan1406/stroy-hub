// SQLite-хранилище системы служебного транспорта (заявки на поездки).
// Отдельный файл БД от concrete.db — модуль полностью независим от
// остальных (Google Sheets синков и т.д.), поэтому не разделяет с ними
// ни схему, ни соединение. Одно write-соединение (WAL), без readonly —
// в отличие от concrete.db здесь нет LLM text-to-SQL, которому нужна
// гарантия "не может писать".
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Тот же приём, что и в server/db.js: на хостинге без примонтированного
// диска файл стирается при каждом деплое, RIDES_DATA_DIR даёт явно
// указать путь к персистентному диску, не полагаясь на структуру каталогов
// конкретного хостинга.
const DATA_DIR = process.env.RIDES_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

const SCHEMA = `
-- users — не общий список сотрудников компании (тех пускает Firebase Auth
-- сам по себе), а закрытый список ДОПУЩЕННЫХ к системе поездок: строка
-- появляется здесь только когда админ явно назначил человеку роль на
-- странице /rides-admin. email — тот же, что в decoded.email из Firebase
-- ID-токена (см. server/adminAuth.js) — пароль отдельно не храним, это
-- делает Firebase.
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL,
  role              TEXT NOT NULL CHECK(role IN ('employee','dispatcher','driver','admin')),
  full_site_access  INTEGER NOT NULL DEFAULT 0, -- 1 = сотрудник уже пользовался остальным
                                                  -- сайтом до попадания в систему поездок —
                                                  -- сохраняет доступ туда вдобавок к своей роли
                                                  -- здесь. 0 (по умолчанию) — заперт только на
                                                  -- странице своей роли (/driver, /dispatcher, /employee).
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_number  TEXT NOT NULL UNIQUE,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','busy','maintenance')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drivers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id),
  vehicle_id  INTEGER REFERENCES vehicles(id),
  status      TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('available','busy','offline')),
  -- 0 = уволен/ушёл — скрыт из рабочих списков (см. migrateSchema про active).
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- requested_at — желаемое время подачи машины (задаёт сотрудник в форме),
-- отдельно от created_at (момент фактической подачи заявки в БД).
CREATE TABLE IF NOT EXISTS requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id       INTEGER NOT NULL REFERENCES users(id),
  driver_id         INTEGER REFERENCES drivers(id),
  from_address      TEXT NOT NULL,
  to_address        TEXT NOT NULL,
  requested_at      TEXT NOT NULL,
  purpose           TEXT,
  passengers_count  INTEGER NOT NULL DEFAULT 1,
  with_return       INTEGER NOT NULL DEFAULT 0, -- туда-обратно: водитель ждёт на месте и везёт
                                                  -- обратно в рамках той же заявки, не через
                                                  -- отдельный заказ из пула.
  distance_km       REAL,    -- ориентировочные расстояние/время, посчитанные один раз при
  duration_min      INTEGER, -- подаче (см. server/rides/routeEstimate.js) — NULL, если геокодер/
                              -- роутер не смогли определить хотя бы одну из точек маршрута.
  status            TEXT NOT NULL DEFAULT 'pending_assignment'
                     CHECK(status IN ('created','pending_assignment','assigned','in_progress','completed','cancelled')),
  comment           TEXT,
  assigned_by       TEXT CHECK(assigned_by IN ('self','dispatcher')),
  cancel_reason     TEXT,
  -- on_hold: заявку сняли с машины (экстренная переброска диспетчером,
  -- П.4 ТЗ доработок). Формально статус остаётся pending_assignment, но
  -- в пул водителям такая заявка НЕ отдаётся, пока заказчик не решит:
  -- вернуть в очередь (on_hold -> 0) или отменить. Отдельным статусом не
  -- делаем — это потребовало бы пересборки таблицы (CHECK на status).
  on_hold           INTEGER NOT NULL DEFAULT 0,
  pull_reason       TEXT,
  -- Объединение заявок водителем (П.6). merge_lock — заявка B в пуле
  -- заблокирована на время переговоров об объединении (из пула пропадает).
  -- merged_into — заявка B влита в маршрут заявки A: обслуживается той же
  -- поездкой, отдельного водителя не ищет. pickup_eta_at — ориентировочное
  -- время посадки пассажира B в рамках маршрута A.
  merge_lock        INTEGER NOT NULL DEFAULT 0,
  merged_into       INTEGER REFERENCES requests(id),
  pickup_eta_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_status   ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_employee ON requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_requests_driver   ON requests(driver_id);
CREATE INDEX IF NOT EXISTS idx_drivers_status    ON drivers(status);

-- Доп. пункты назначения сверх to_address (первого/основного) — заявка
-- вида "от А до Б, потом ещё в В и Г". Отдельная таблица, а не несколько
-- колонок to_address_2/3 в requests: пунктов может быть переменное
-- количество, и большинству заявок они вообще не нужны.
CREATE TABLE IF NOT EXISTS request_stops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id),
  address     TEXT NOT NULL,
  stop_order  INTEGER NOT NULL,
  -- Если точка попала в маршрут при объединении заявок (П.6) — id той
  -- «влитой» заявки B, чтобы при расформировании объединения убрать ровно
  -- её точки. NULL — обычная точка самой заявки.
  merged_from_request_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_request_stops_request ON request_stops(request_id);

CREATE TABLE IF NOT EXISTS request_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id),
  status      TEXT NOT NULL,
  changed_by  INTEGER REFERENCES users(id),
  changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_request ON request_status_history(request_id);

-- Единый журнал событий по заявке — шире, чем request_status_history
-- (только смены статуса): сюда пишутся и добавление/правка точек маршрута,
-- и пересчёт оценки времени, и модерация диспетчером, и объединение
-- заявок (см. дорожную карту доработок агрегатора). Append-only: строки
-- не обновляются и не удаляются. payload_json — свободная структура под
-- конкретный тип события (адрес точки, старое/новое время и т.п.).
-- Это источник данных для страницы «Журнал» у диспетчера/админа и выгрузки
-- в Excel.
CREATE TABLE IF NOT EXISTS request_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     INTEGER NOT NULL REFERENCES requests(id),
  event_type     TEXT NOT NULL,
  actor_user_id  INTEGER REFERENCES users(id),
  payload_json   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_events_request ON request_events(request_id);
CREATE INDEX IF NOT EXISTS idx_request_events_type    ON request_events(event_type);
CREATE INDEX IF NOT EXISTS idx_request_events_created ON request_events(created_at);

-- Предложения об изменении маршрута уже поданной заявки (П.1 + П.5 ТЗ
-- доработок). Заказчик и водитель могут только ПРЕДЛОЖИТЬ точку (add) либо
-- её правку/удаление (edit/remove) — предложение висит в status='pending',
-- пока диспетчер не одобрит/отклонит; диспетчер и сам заказчик (пока
-- заявка ещё в пуле) применяют сразу (status сразу 'approved'). Таймаут
-- 5 минут переводит зависшие в 'auto_rejected' (см. proposalTimeout.js).
-- Применённое предложение вставляет/меняет строку в request_stops и
-- запускает пересчёт оценки; сам факт и решение пишутся в request_events.
CREATE TABLE IF NOT EXISTS stop_proposals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        INTEGER NOT NULL REFERENCES requests(id),
  action            TEXT NOT NULL CHECK(action IN ('add','edit','remove')),
  target_stop_id    INTEGER REFERENCES request_stops(id) ON DELETE SET NULL, -- для edit/remove
  address           TEXT,                                 -- для add/edit
  lat               REAL,
  lng               REAL,
  proposed_by       INTEGER NOT NULL REFERENCES users(id),
  proposed_by_role  TEXT,                                 -- роль на момент предложения
  status            TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','approved','rejected','auto_rejected')),
  decided_by        INTEGER REFERENCES users(id),
  decision_reason   TEXT,
  est_delta_min     INTEGER,                              -- ориентировочное «+X мин» к поездке
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_stop_proposals_request ON stop_proposals(request_id);
CREATE INDEX IF NOT EXISTS idx_stop_proposals_status  ON stop_proposals(status);

-- Объединение заявок водителем (П.6 ТЗ доработок). Водитель, у которого
-- на руках заявка A, предлагает подвезти попутно заявку B из пула.
-- Требуется двойное согласование: заказчик A и диспетчер. Пока оба не
-- согласились — status='pending', заявка B «мягко» заблокирована в пуле.
-- При согласии точки B вливаются в маршрут A (request_stops с
-- merged_from_request_id = B), B.merged_into = A. Таймаут 5 минут →
-- auto_rejected (см. proposalTimeout.js).
CREATE TABLE IF NOT EXISTS request_merges (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  request_a_id           INTEGER NOT NULL REFERENCES requests(id), -- активная заявка водителя
  request_b_id           INTEGER NOT NULL REFERENCES requests(id), -- заявка из пула
  driver_id              INTEGER NOT NULL REFERENCES drivers(id),
  status                 TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','approved','rejected','auto_rejected')),
  approved_by_a          INTEGER NOT NULL DEFAULT 0, -- заказчик заявки A согласился
  approved_by_dispatcher INTEGER NOT NULL DEFAULT 0,
  decided_by             INTEGER REFERENCES users(id),
  decision_reason        TEXT,
  pickup_eta_at          TEXT, -- рассчитанное при применении время посадки пассажира B
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_merges_status ON request_merges(status);
CREATE INDEX IF NOT EXISTS idx_request_merges_a ON request_merges(request_a_id);
CREATE INDEX IF NOT EXISTS idx_request_merges_b ON request_merges(request_b_id);

-- Кэш геокодирования адресов (Nominatim): один и тот же адрес подачи/
-- назначения встречается в заявках постоянно, а лимит бесплатного
-- Nominatim — 1 запрос/сек. found = 0 запоминает, что адрес не удалось
-- разобрать, чтобы не долбить сервис повторно тем же мусором. fetched_at
-- позволяет протухать кэшу (TTL проверяется в коде, см. routeEstimate.js).
CREATE TABLE IF NOT EXISTS geocode_cache (
  address     TEXT PRIMARY KEY,
  lat         REAL,
  lng         REAL,
  found       INTEGER NOT NULL DEFAULT 1,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let writeDb = null;

function initSchema() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = getWriteDb();
  db.exec(SCHEMA);
  migrateSchema(db);
}

// CREATE TABLE IF NOT EXISTS — no-op на уже существующей локальной/прод
// базе, поэтому новые колонки в таблицах, которые нельзя пересоздавать
// (заявки нельзя терять), добавляются через ALTER, тем же приёмом, что и
// migrateSchema в server/db.js.
function migrateSchema(db) {
  const requestColumns = db.prepare("PRAGMA table_info(requests)").all().map((c) => c.name);
  if (!requestColumns.includes('with_return')) {
    db.exec('ALTER TABLE requests ADD COLUMN with_return INTEGER NOT NULL DEFAULT 0');
  }
  if (!requestColumns.includes('distance_km')) {
    db.exec('ALTER TABLE requests ADD COLUMN distance_km REAL');
  }
  if (!requestColumns.includes('duration_min')) {
    db.exec('ALTER TABLE requests ADD COLUMN duration_min INTEGER');
  }
  // Координаты точек маршрута храним прямо в БД (раньше геокодировали
  // каждый раз заново) — нужно для «живой» оценки времени: пересчёт при
  // добавлении точки в уже активную заявку не должен снова ходить в
  // геокодер по всем адресам. expected_completion_at — ориентировочный
  // момент освобождения машины, производная величина (см.
  // routeEstimate.recomputeRequestEstimate), но денормализована в
  // requests, чтобы форма подачи могла быстро показать «ближайшая машина
  // освободится ~ЧЧ:ММ» без обхода всех точек.
  if (!requestColumns.includes('from_lat')) db.exec('ALTER TABLE requests ADD COLUMN from_lat REAL');
  if (!requestColumns.includes('from_lng')) db.exec('ALTER TABLE requests ADD COLUMN from_lng REAL');
  if (!requestColumns.includes('to_lat')) db.exec('ALTER TABLE requests ADD COLUMN to_lat REAL');
  if (!requestColumns.includes('to_lng')) db.exec('ALTER TABLE requests ADD COLUMN to_lng REAL');
  if (!requestColumns.includes('expected_completion_at')) {
    db.exec('ALTER TABLE requests ADD COLUMN expected_completion_at TEXT');
  }
  // Экстренная переброска машины (П.4): заявку сняли с водителя, ждём
  // решения заказчика — в пул при этом не отдаём (см. requestsRouter.js).
  if (!requestColumns.includes('on_hold')) {
    db.exec('ALTER TABLE requests ADD COLUMN on_hold INTEGER NOT NULL DEFAULT 0');
  }
  if (!requestColumns.includes('pull_reason')) {
    db.exec('ALTER TABLE requests ADD COLUMN pull_reason TEXT');
  }
  // Объединение заявок (П.6).
  if (!requestColumns.includes('merge_lock')) {
    db.exec('ALTER TABLE requests ADD COLUMN merge_lock INTEGER NOT NULL DEFAULT 0');
  }
  if (!requestColumns.includes('merged_into')) {
    db.exec('ALTER TABLE requests ADD COLUMN merged_into INTEGER REFERENCES requests(id)');
  }
  if (!requestColumns.includes('pickup_eta_at')) {
    db.exec('ALTER TABLE requests ADD COLUMN pickup_eta_at TEXT');
  }

  const stopColumns = db.prepare("PRAGMA table_info(request_stops)").all().map((c) => c.name);
  if (!stopColumns.includes('lat')) db.exec('ALTER TABLE request_stops ADD COLUMN lat REAL');
  if (!stopColumns.includes('lng')) db.exec('ALTER TABLE request_stops ADD COLUMN lng REAL');
  if (!stopColumns.includes('merged_from_request_id')) {
    db.exec('ALTER TABLE request_stops ADD COLUMN merged_from_request_id INTEGER');
  }

  // active — уволенного/ушедшего водителя нельзя удалить (requests.driver_id
  // хранит его для ВСЕЙ истории заказов, не только активных, см.
  // driversRouter.js DELETE), но и держать его в рабочих списках (выбор при
  // принудительном назначении) не нужно — active=0 прячет карточку оттуда,
  // не трогая историю. Карточка и её заказы остаются на месте.
  const driverColumns = db.prepare("PRAGMA table_info(drivers)").all().map((c) => c.name);
  if (!driverColumns.includes('active')) {
    db.exec('ALTER TABLE drivers ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }
}

function getWriteDb() {
  if (!writeDb) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    writeDb = new Database(DB_PATH);
    writeDb.pragma('journal_mode = WAL');
  }
  return writeDb;
}

module.exports = { initSchema, getWriteDb, DB_PATH };
