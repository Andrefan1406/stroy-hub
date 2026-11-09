// Периодическая синхронизация вкладки "Объекты" реестровой Google Таблицы
// (жилые дома, соцобъекты, инженерные сети и т.п.) -> таблица objects.
// Та же стратегия полной перезаписи, что и в syncConcrete.js: у строк
// исходной таблицы нет стабильного ID.
const cron = require('node-cron');
const Papa = require('papaparse');
const { getWriteDb } = require('./db');

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/1rwFYAqu7ORfB3oSslgziytD-5A7x5O6eQs5W9kjKBtQ/export?format=csv&gid=0';

const { SYNC_TZ, DEFAULT_CRON } = require('./syncSchedule');
const CRON_SCHEDULE = process.env.OBJECTS_SYNC_CRON || DEFAULT_CRON.objects;

// Реестр начинается с двух пустых строк оформления, реальный заголовок — третья строка.
const HEADER_ROW_INDEX = 2;

// "1 640 083 472,00" / "  640 083 472,00   " -> 640083472; "-"/"" -> null
function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).replace(/[\s ]/g, '').trim();
  if (!trimmed || trimmed === '-') return null;
  const num = parseFloat(trimmed.replace(',', '.'));
  return isNaN(num) ? null : num;
}

function parseInteger(value) {
  const num = parseNumber(value);
  return num === null ? null : Math.round(num);
}

// "ДД.ММ.ГГГГ" -> "ГГГГ-ММ-ДД"; мусор/пусто -> null
function normalizeDate(raw) {
  if (!raw) return null;
  const match = String(raw).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const clean = (value) => {
  const v = (value || '').toString().trim();
  return v ? v : null;
};

async function fetchAndParseCsv() {
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`Не удалось скачать CSV с объектами: HTTP ${res.status}`);
  }
  const csvText = await res.text();
  // header:false, чтобы сохранить позиции строк (первые две — пустые) и
  // корректно взять заголовок из третьей — Papa сам разберёт переносы строк
  // внутри кавычек (напр. в названии заказчика).
  const { data } = Papa.parse(csvText, { skipEmptyLines: false });
  const header = (data[HEADER_ROW_INDEX] || []).map((h) => h.trim());
  const dataRows = data.slice(HEADER_ROW_INDEX + 1);

  return dataRows
    .map((rowArr) => {
      const row = {};
      header.forEach((h, i) => {
        row[h] = rowArr[i];
      });
      return row;
    })
    .filter((row) => Object.values(row).some((v) => v && String(v).trim()));
}

function normalizeRow(row) {
  return {
    object_name: clean(row['Наименование объекта']),
    object_name_short: clean(row['Наименование объекта кратко']),
    position: clean(row['Позиция']),
    apartments_count: parseInteger(row['Кол-во квартир']),
    object_type: clean(row['Тип']),
    status: clean(row['Статус']),
    address: clean(row['Присвоенный адрес']),
    commissioning_date: normalizeDate(row['Дата акта ввода в эксплуатацию']),
    building_area_m2: parseNumber(row['Общая площадь жилого здания; м2']),
    apartments_area_m2: parseNumber(row['Общая площадь квартир; м2']),
    sewer_network_m: parseNumber(row['Сети канализации; м']),
    water_network_m: parseNumber(row['Сети водоснабжения; м']),
    heating_network_m: parseNumber(row['Сети теплоснабжения; м']),
    power_network_m: parseNumber(row['Сети электроснабжения; м']),
    low_current_network_m: parseNumber(row['Слаботочные сети; м']),
    coverage_area_m2: parseNumber(row['Площадь покрытия; м2']),
  };
}

function syncObjectsData(rows) {
  const db = getWriteDb();
  const insert = db.prepare(`
    INSERT INTO objects (
      object_name, object_name_short, position, apartments_count, object_type, status, address,
      commissioning_date, building_area_m2, apartments_area_m2, sewer_network_m, water_network_m,
      heating_network_m, power_network_m, low_current_network_m, coverage_area_m2
    ) VALUES (
      @object_name, @object_name_short, @position, @apartments_count, @object_type, @status, @address,
      @commissioning_date, @building_area_m2, @apartments_area_m2, @sewer_network_m, @water_network_m,
      @heating_network_m, @power_network_m, @low_current_network_m, @coverage_area_m2
    )
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const replaceAll = db.transaction((normalizedRows) => {
    db.prepare('DELETE FROM objects').run();
    for (const row of normalizedRows) insert.run(row);
    upsertMeta.run({ key: 'objects_last_synced_at', value: new Date().toISOString() });
    upsertMeta.run({ key: 'objects_row_count', value: String(normalizedRows.length) });
  });

  replaceAll(rows);
  return rows.length;
}

async function runSyncOnce() {
  const rawRows = await fetchAndParseCsv();
  const normalizedRows = rawRows.map(normalizeRow);
  const count = syncObjectsData(normalizedRows);
  console.log(`[objects-sync] загружено ${count} строк`);
  return count;
}

function startObjectsSync() {
  runSyncOnce().catch((err) => console.error('[objects-sync] ошибка стартового синка:', err.message));
  cron.schedule(CRON_SCHEDULE, () => {
    runSyncOnce().catch((err) => console.error('[objects-sync] ошибка планового синка:', err.message));
  }, { timezone: SYNC_TZ });
}

module.exports = { startObjectsSync, runSyncOnce, CSV_URL };
