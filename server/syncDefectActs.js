// Периодическая синхронизация реестра дефектных актов -> таблица
// defect_acts. Та же стратегия полной перезаписи, что и в
// syncObjects.js/syncConcrete.js: у строк исходной таблицы нет стабильного
// ID, поэтому проще перезаписать всё целиком, чем сверять построчно.
//
// Формат исходника (см. разбор в переписке): строка 0 — заголовок, строка 1 —
// строка с итоговыми суммами (не данные), данные — с строки 2. Последние
// две колонки заголовка ("", "") — служебные год/месяц, которые в реестре
// проставлены формулой не для всех строк (747 из 1058) — не тащим их как
// есть, а сами считаем act_date/withhold_date и при необходимости год/месяц
// через strftime() уже в SQL, чтобы не зависеть от того, дотянута ли формула
// до конца таблицы.
const cron = require('node-cron');
const Papa = require('papaparse');
const { getWriteDb, getLastSyncedAt } = require('./db');
const { embedBatch } = require('./embeddings');
const { getClient, upsertPoints } = require('./qdrantClient');
const { EMBEDDING_DIM } = require('./embeddings');

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSXksChImiQS67MYyuC7VKhOUKukv6KhKihkSk5FOVadZgHzsgb0tmq65U0JnaRbQDXhSMcZ914KQDq/pub?gid=0&single=true&output=csv';

const { SYNC_TZ, DEFAULT_CRON } = require('./syncSchedule');
const CRON_SCHEDULE = process.env.DEFECT_ACTS_SYNC_CRON || DEFAULT_CRON.defectActs;

// Коллекция Qdrant для семантического поиска по свободному тексту актов
// (см. server/qdrantClient.js, server/embeddings.js). Название совпадает с
// именем SQL-таблицы для наглядности — это две проекции одних и тех же
// данных, SQL-таблица и векторная коллекция, а не разные сущности.
const QDRANT_COLLECTION = 'defect_acts';
const EMBED_BATCH_SIZE = 32;

// Заголовок — строка 0, строка с итоговыми суммами по колонкам — строка 1,
// реальные данные начинаются со строки 2.
const FIRST_DATA_ROW_INDEX = 2;

// Колонка 14 (заголовок статуса удержания) в исходнике оформлена как
// "удержано"/\n"подлежит удержанию"/\n"не подлежит удержанию" — с
// вложенными кавычками и переносами строк внутри самого заголовка. Сверять
// по такому заголовку по имени хрупко, поэтому весь разбор строк идёт по
// ПОЗИЦИИ колонки (0-индекс), а не по имени — порядок колонок в реестре
// стабилен, в отличие от текста этого конкретного заголовка.
const COL = {
  actNumber: 0,
  actDate: 1,
  objectPosition: 2,
  defectDescription: 3,
  responsibleOccurrence: 4,
  responsibleFix: 5,
  ptoEngineer: 6,
  commissionConclusion: 7,
  fixMark: 8,
  totalCost: 9,
  amountToWithhold: 10,
  amountWithheld: 11,
  withholdDate: 12,
  invoiceNumber: 13,
  withholdStatus: 14,
  withholdReasonNa: 15,
  note: 16,
};

// "290 047 153,35" / "72 219,60" -> число; "-"/"" -> null (те же деньги,
// что и в syncObjects.js/syncConcrete.js — пробел как разделитель тысяч,
// запятая как десятичный разделитель).
function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).replace(/[\s ]/g, '').trim();
  if (!trimmed || trimmed === '-') return null;
  const num = parseFloat(trimmed.replace(',', '.'));
  return isNaN(num) ? null : num;
}

// "31.12.2021" / "26.07.2024г" / "22.05.2025г." -> "2021-12-31"; мусор
// (например, случайно вписанное имя вместо даты) -> null. Берём только
// префикс ДД.ММ.ГГГГ и игнорируем всё, что после — та же логика, что и в
// syncObjects.js, потому что тут встречается тот же паттерн мусорного
// суффикса "г"/"г." после года.
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
    throw new Error(`Не удалось скачать CSV с дефектными актами: HTTP ${res.status}`);
  }
  const csvText = await res.text();
  // header:false — не парсим по именам колонок вообще (см. комментарий у
  // COL выше), просто берём данные с FIRST_DATA_ROW_INDEX как массивы и
  // разбираем позиционно в normalizeRow. Papa сам корректно обрабатывает
  // переносы строк и кавычки внутри кавычек в заголовке (нам эти строки
  // не нужны, но именно из-за них важно парсить не построчным split, а
  // настоящим CSV-парсером).
  const { data } = Papa.parse(csvText, { skipEmptyLines: false });
  const dataRows = data.slice(FIRST_DATA_ROW_INDEX);

  return dataRows.filter((rowArr) => rowArr.some((v) => v && String(v).trim()));
}

function normalizeRow(rowArr) {
  const actDateRaw = rowArr[COL.actDate];
  return {
    act_number: clean(rowArr[COL.actNumber]),
    act_date: normalizeDate(actDateRaw),
    act_date_raw: clean(actDateRaw),
    object_position: clean(rowArr[COL.objectPosition]),
    defect_description: clean(rowArr[COL.defectDescription]),
    responsible_occurrence: clean(rowArr[COL.responsibleOccurrence]),
    responsible_fix: clean(rowArr[COL.responsibleFix]),
    pto_engineer: clean(rowArr[COL.ptoEngineer]),
    commission_conclusion: clean(rowArr[COL.commissionConclusion]),
    fix_mark: clean(rowArr[COL.fixMark]),
    total_cost: parseNumber(rowArr[COL.totalCost]),
    amount_to_withhold: parseNumber(rowArr[COL.amountToWithhold]),
    amount_withheld: parseNumber(rowArr[COL.amountWithheld]),
    withhold_date: normalizeDate(rowArr[COL.withholdDate]),
    invoice_number: clean(rowArr[COL.invoiceNumber]),
    withhold_status: clean(rowArr[COL.withholdStatus]),
    withhold_reason_na: clean(rowArr[COL.withholdReasonNa]),
    note: clean(rowArr[COL.note]),
  };
}

function syncDefectActsData(rows) {
  const db = getWriteDb();
  const insert = db.prepare(`
    INSERT INTO defect_acts (
      act_number, act_date, act_date_raw, object_position, defect_description,
      responsible_occurrence, responsible_fix, pto_engineer, commission_conclusion, fix_mark,
      total_cost, amount_to_withhold, amount_withheld, withhold_date, invoice_number,
      withhold_status, withhold_reason_na, note
    ) VALUES (
      @act_number, @act_date, @act_date_raw, @object_position, @defect_description,
      @responsible_occurrence, @responsible_fix, @pto_engineer, @commission_conclusion, @fix_mark,
      @total_cost, @amount_to_withhold, @amount_withheld, @withhold_date, @invoice_number,
      @withhold_status, @withhold_reason_na, @note
    )
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const replaceAll = db.transaction((normalizedRows) => {
    db.prepare('DELETE FROM defect_acts').run();
    for (const row of normalizedRows) insert.run(row);
    upsertMeta.run({ key: 'defect_acts_last_synced_at', value: new Date().toISOString() });
    upsertMeta.run({ key: 'defect_acts_row_count', value: String(normalizedRows.length) });
  });

  replaceAll(rows);
  return rows.length;
}

// Собирает "поисковый" текст строки для эмбеддинга — свободнотекстовые поля
// (описание дефекта, заключение комиссии, причина неудержания, примечание)
// плюс ответственных за возникновение/устранение — чтобы семантический
// поиск мог найти акты и по подрядчику/лицу, а не только по описанию (см.
// обсуждение: точный SQL-фильтр по этим полям ненадёжен из-за разного
// написания одного и того же названия в реестре). Пустые поля пропускаются.
// Строки, у которых вообще нет ни одного заполненного текстового поля, не
// индексируются — эмбеддить нечего, и по ним всё равно нечего искать
// семантически (для них достаточно обычного SQL по остальным колонкам).
function buildSearchableText(row) {
  return [
    row.defect_description,
    row.commission_conclusion,
    row.withhold_reason_na,
    row.note,
    row.responsible_occurrence,
    row.responsible_fix,
  ]
    .filter(Boolean)
    .join('. ');
}

// Пересчитывает эмбеддинги и полностью перезаливает коллекцию Qdrant —
// та же стратегия "удалить всё и перезалить", что и у самой SQL-таблицы
// (см. верхний комментарий файла): id строк в SQLite не стабилен между
// синками (DELETE+INSERT с AUTOINCREMENT), поэтому смысла в точечном
// докидывании изменившихся строк в Qdrant нет — id-шники и там, и там
// назначаются заново в рамках одного и того же прохода синка и остаются
// согласованными друг с другом до следующего синка.
async function reindexEmbeddings() {
  const db = getWriteDb();
  const rows = db.prepare(`
    SELECT id, act_number, act_date, object_position, defect_description,
           commission_conclusion, withhold_reason_na, note, withhold_status,
           total_cost, amount_to_withhold, amount_withheld,
           responsible_occurrence, responsible_fix
    FROM defect_acts
  `).all();

  const withText = rows
    .map((row) => ({ row, text: buildSearchableText(row) }))
    .filter(({ text }) => text.trim());

  // Полная перезаливка коллекции — чтобы не оставались "осиротевшие" точки
  // от строк, которых больше нет в реестре (после DELETE+INSERT id-шники
  // переиспользуются с нуля, точечно вычищать их за собой смысла нет).
  await getClient().recreateCollection(QDRANT_COLLECTION, {
    vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
  });

  for (let i = 0; i < withText.length; i += EMBED_BATCH_SIZE) {
    const batch = withText.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(batch.map((b) => b.text));
    const points = batch.map(({ row, text }, j) => ({
      id: row.id,
      vector: vectors[j],
      payload: { ...row, searchable_text: text },
    }));
    await upsertPoints(QDRANT_COLLECTION, points);
  }

  if (withText.length) {
    db.prepare(`UPDATE defect_acts SET embedding_synced_at = datetime('now')`).run();
  }

  return withText.length;
}

const EMBEDDING_SYNCED_DATE_KEY = 'defect_acts_embedding_synced_date';

function setEmbeddingSyncedDate(dateStr) {
  getWriteDb()
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run({ key: EMBEDDING_SYNCED_DATE_KEY, value: dateStr });
}

// Переиндексация эмбеддингов в Qdrant (в отличие от загрузки SQL-данных)
// расходует внешнюю квоту эмбеддингов (Voyage), поэтому гоняем её РЕДКО: по
// требованию пользователя — только в рабочие дни (пн–пт) по чётным датам, и
// не чаще раза в день. SQL-синк реестра при этом продолжает идти по обычному
// расписанию (каждые 6 ч) — текстовый чат по актам остаётся свежим.
//
// Исключение (самолечение): если коллекции в Qdrant нет, она пуста или
// размерность вектора не совпадает с текущей моделью эмбеддингов — индексируем
// сразу, независимо от дня, иначе семантический поиск по актам будет сломан до
// следующей чётной рабочей даты.
async function shouldReindexEmbeddings() {
  try {
    const info = await getClient().getCollection(QDRANT_COLLECTION);
    const vectorSize = info?.config?.params?.vectors?.size;
    if (!info?.points_count || vectorSize !== EMBEDDING_DIM) {
      return { should: true, reason: 'коллекция пуста или размерность вектора изменилась' };
    }
  } catch (err) {
    return { should: true, reason: 'коллекция недоступна или ещё не создана' };
  }

  // Дата в часовом поясе Алматы (как и остальные даты в проекте).
  const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Almaty' }).format(new Date());
  const dayOfMonth = Number(dateStr.slice(8, 10));
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=вс … 6=сб

  if (dow === 0 || dow === 6) return { should: false, reason: `выходной (${dateStr})` };
  if (dayOfMonth % 2 !== 0) return { should: false, reason: `нечётная дата (${dateStr})` };
  if (getLastSyncedAt(EMBEDDING_SYNCED_DATE_KEY) === dateStr) {
    return { should: false, reason: `уже переиндексировано сегодня (${dateStr})` };
  }
  return { should: true, reason: `рабочий день, чётная дата (${dateStr})`, dateStr };
}

async function runSyncOnce() {
  const rawRows = await fetchAndParseCsv();
  const normalizedRows = rawRows.map(normalizeRow);
  const count = syncDefectActsData(normalizedRows);
  console.log(`[defect-acts-sync] загружено ${count} строк`);

  const decision = await shouldReindexEmbeddings();
  if (!decision.should) {
    console.log(`[defect-acts-sync] переиндексация эмбеддингов пропущена: ${decision.reason}`);
    return count;
  }

  try {
    console.log(`[defect-acts-sync] переиндексация эмбеддингов: ${decision.reason}`);
    const embedded = await reindexEmbeddings();
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Almaty' }).format(new Date());
    setEmbeddingSyncedDate(today);
    console.log(`[defect-acts-sync] проиндексировано в Qdrant ${embedded} строк`);
  } catch (err) {
    // Провал переиндексации не должен ронять сам синк SQL-данных — RAG-поиск
    // деградирует до следующей успешной переиндексации, но текстовый чат по
    // обычным (SQL) вопросам продолжит работать.
    console.error('[defect-acts-sync] ошибка переиндексации эмбеддингов:', err.message);
  }

  return count;
}

function startDefectActsSync() {
  runSyncOnce().catch((err) => console.error('[defect-acts-sync] ошибка стартового синка:', err.message));
  cron.schedule(CRON_SCHEDULE, () => {
    runSyncOnce().catch((err) => console.error('[defect-acts-sync] ошибка планового синка:', err.message));
  }, { timezone: SYNC_TZ });
}

module.exports = { startDefectActsSync, runSyncOnce, CSV_URL };
