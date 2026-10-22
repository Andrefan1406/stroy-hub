// Периодическая синхронизация: публичный CSV-экспорт Google Таблицы
// (тот же источник, что читает src/ConcreteDailyReportPage.js на клиенте) ->
// таблица concrete_orders. Полная перезапись при каждом синке: у строк
// исходной таблицы нет стабильного ID, поэтому upsert не построить надёжно,
// а объём данных небольшой — DELETE+INSERT в одной транзакции атомарны для
// читателей.
const cron = require('node-cron');
const Papa = require('papaparse');
const { getWriteDb } = require('./db');

// Все заявки собраны в один лист (gid=0) той же книги — раньше синк читал
// gid=949231644, теперь читаем сводный лист.
const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTSu48SFcG0-dZpjkW3Z3uN3jJF0QPkpFUroD1YHWRj_8jy7ZwND096Rgd60fDiQGPHMOY8TDVy-_fl/pub?gid=0&single=true&output=csv';

const CRON_SCHEDULE = process.env.CONCRETE_SYNC_CRON || '0 */2 * * *';

// "12,5" -> 12.5; пусто/мусор -> null
function parseVolume(value) {
  if (!value) return null;
  const num = parseFloat(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return isNaN(num) ? null : num;
}

// В сводном листе даты пришли вперемешку в двух форматах — часть строк
// "ДД.ММ.ГГГГ" (как раньше), часть уже "ГГГГ-ММ-ДД" (похоже, дописаны позже
// напрямую в этом формате), плюс единичный мусор ("/", "202605-04",
// "04.04." без года) — такие возвращаем как null, а не роняем синк.
function normalizeDate(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const dmy = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (dmy) {
    const [, d, m, yRaw] = dmy;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return null;
}

// "06.06.2024 15:26:16" (час без ведущего нуля, как в исходнике) ->
// "2024-06-06 15:26:16" — для стабильной сортировки как обычной строки.
// Мусор/пусто -> null (сортировка отправит такие заявки в конец при ASC).
function normalizeDateTime(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  const match = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, d, m, y, h, min, s] = match;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${h.padStart(2, '0')}:${min}:${s}`;
}

// "Позиция"/"Блок"/"Этаж"/"Конструктив" — раньше это была одна составная
// колонка "Блок, позиция"; в сводном листе для части строк они уже разбиты
// по отдельным столбцам (~20% строк), а для остальных всё так же слито в
// "Позиция". Склеиваем обратно в одну строку — дальнейшая классификация в
// concreteDashboard.js всё равно ищет токены по подстроке, порядок неважен.
function buildBlockPosition(row) {
  return [row['Позиция'], row['Блок'], row['Этаж'], row['Конструктив']]
    .map((v) => (v || '').trim())
    .filter(Boolean)
    .join(' ') || null;
}

async function fetchAndParseCsv() {
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`Не удалось скачать CSV с заявками на бетон: HTTP ${res.status}`);
  }
  const csvText = await res.text();
  const { data } = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  return data;
}

// Естественный ключ строки — у исходной таблицы нет стабильного ID
// (полная перезаписка при каждом синке, см. верхний комментарий файла), а
// локально скрытым в concreteRequestsBoard.js заявкам нужен идентификатор,
// переживающий пересинк. Комбинация из времени подачи + объекта + позиции +
// материала + объёма достаточно уникальна на практике и не меняется, пока
// саму строку не отредактируют в исходной таблице.
function buildRequestKey(row) {
  return [
    row.submitted_at || '',
    row.object_name || '',
    row.block_position || '',
    row.material || '',
    row.volume_planned_m3 ?? '',
  ].join('|');
}

// Значение колонки, название которой начинается с prefix (без учёта
// пробелов/переносов в начале). undefined — такой колонки нет.
function findColumn(row, prefix) {
  const key = Object.keys(row).find((k) => k.trim().startsWith(prefix));
  return key === undefined ? undefined : row[key];
}

function normalizeRow(row) {
  const base = {
    shipment_date: normalizeDate(row['Дата отгрузки']),
    shipment_date_raw: row['Дата отгрузки'] || null,
    // В сводном листе колонка "Категория" встречается дважды: первая — та,
    // что реально выбирает заявитель в форме (совпадает с constructionData.js
    // почти всегда, с редкими опечатками/регистром — их доклассифицирует
    // concreteDashboard.js в "Прочие"); вторая, с тем же названием, дальше по
    // листу — не категория вовсе, а разрозненные логистические пометки
    // ("после 15:00", "своевременно" и т.п.), PapaParse переименовывает её в
    // "Категория_1". Берём только первую, вторую игнорируем полностью.
    category: row['Категория'] || null,
    material: row['Материал'] || null,
    object_name: row['Объект'] || null,
    block_position: buildBlockPosition(row),
    // "Подвижность" (П3/П4 — консистенция смеси) в схему не входит и нигде
    // в приложении не используется, поэтому не сохраняем — только "Марка".
    grade_class: row['Марка'] || null,
    volume_planned_m3: parseVolume(row['Количество']),
    volume_actual_m3: parseVolume(row['Фактический объём']),
    execution_note: row['Отметка о исполнении'] || null,
    // "Планируемая дата поставки" — дата, которую заказчик указал при подаче
    // заявки, в отличие от "Дата отгрузки" (shipment_date), проставляемой по
    // факту исполнения.
    planned_delivery_date: normalizeDate(row['Планируемая дата поставки']),
    submitted_at: normalizeDateTime(row['Дата и время подачи заявки']),
    // 'Согласовано' — единственное непустое значение колонки на практике.
    geo_approved: row['Согласование геодезистов']?.trim() === 'Согласовано' ? 1 : 0,
    // В шапке листа название с переносом строки — "Согласование энергетиков\n
    // (только в зимний период)", поэтому ищем колонку по началу названия.
    energy_approved: findColumn(row, 'Согласование энергетиков')?.trim() === 'Согласовано' ? 1 : 0,
    responsible_name: row['ФИО'] || null,
    responsible_phone: row['Телефон'] || null,
    note: row['Примечание'] || null,
  };
  return { ...base, request_key: buildRequestKey(base) };
}

function syncConcreteData(rows) {
  const db = getWriteDb();
  const insert = db.prepare(`
    INSERT INTO concrete_orders (
      shipment_date, shipment_date_raw, category, material, object_name,
      block_position, grade_class, volume_planned_m3, volume_actual_m3, execution_note,
      planned_delivery_date, submitted_at, geo_approved, energy_approved, responsible_name, responsible_phone,
      note, request_key
    ) VALUES (
      @shipment_date, @shipment_date_raw, @category, @material, @object_name,
      @block_position, @grade_class, @volume_planned_m3, @volume_actual_m3, @execution_note,
      @planned_delivery_date, @submitted_at, @geo_approved, @energy_approved, @responsible_name, @responsible_phone,
      @note, @request_key
    )
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const replaceAll = db.transaction((normalizedRows) => {
    db.prepare('DELETE FROM concrete_orders').run();
    for (const row of normalizedRows) insert.run(row);
    upsertMeta.run({ key: 'last_synced_at', value: new Date().toISOString() });
    upsertMeta.run({ key: 'row_count', value: String(normalizedRows.length) });
  });

  replaceAll(rows);
  return rows.length;
}

async function runSyncOnce() {
  const rawRows = await fetchAndParseCsv();
  const normalizedRows = rawRows
    .filter((row) => Object.values(row).some((v) => v && String(v).trim()))
    .map(normalizeRow);
  const count = syncConcreteData(normalizedRows);
  console.log(`[concrete-sync] загружено ${count} строк`);
  return count;
}

function startConcreteSync() {
  runSyncOnce().catch((err) => console.error('[concrete-sync] ошибка стартового синка:', err.message));
  cron.schedule(CRON_SCHEDULE, () => {
    runSyncOnce().catch((err) => console.error('[concrete-sync] ошибка планового синка:', err.message));
  });
}

module.exports = { startConcreteSync, runSyncOnce, CSV_URL };
