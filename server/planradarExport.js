// Выгрузка замечаний PlanRadar за период в Excel (страница «Личный кабинет →
// Замечания PlanRadar»). Период — по дате СОЗДАНИЯ замечания (по времени
// Алматы, границы включительно).
//
// Фильтра по дате создания у API PlanRadar нет (параметры filter[created-at]
// игнорируются, проверено), поэтому по каждому объекту забираются все
// замечания и период отбирается здесь. Лимит API — 30 запросов в минуту на
// аккаунт, выгрузка по всем объектам идёт минуты — поэтому это фоновая
// задача: POST создаёт её, GET отдаёт ход выполнения, затем файл.
// Фото: в столбец «Фото после устранения» попадают только фото из поля формы
// «Фотоподтверждение устранения замечания» (у вложения заполнен field-id этого
// поля), все остальные фото замечания — в столбец «Фото». См. classifyPhoto.
//
// Фото: список вложений замечания — отдельный запрос на каждое замечание
// (общий список вложений объекта неполный, признак «есть вложения» в самом
// замечании ненадёжен), поэтому с фото выгрузка идёт ~2,5 с на замечание.
// Миниатюры (300 px) качаются из хранилища PlanRadar по временным ссылкам —
// эти запросы лимит API не расходуют — и встраиваются в таблицу.
// Одновременно выполняется одна выгрузка. Справочники имён (пользователи,
// группы, слои) кэшируются на несколько часов — они почти не меняются.
const express = require('express');
const ExcelJS = require('exceljs');
const { requireEmails, ADMIN_EMAIL } = require('./adminAuth');

// Кроме админа выгрузка открыта сотруднику технадзора (см. src/restrictedAccess.js: у него доступна только эта страница).
const EXPORT_USERS = [ADMIN_EMAIL, 'rabdrakhmanov@kazmintech.com'];
const { loadProjects, attr, API_BASE } = require('./planradar');
const { addTitleSheet, addSummarySheet, describePeriod } = require('./planradarReportSheets');

const TIMEZONE = 'Asia/Almaty';
const PAGESIZE = 500;
const REFS_TTL_MS = 6 * 3600 * 1000;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const MAX_INLINE_PHOTOS = 4; // сколько фото встраивается в ячейку «Фото» и в ячейку «Фото после устранения»
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_GAP = 4; // отступ между плитками и от края ячейки, пиксели
const EMU = 9525; // EMU в пикселе
const RETRY_PAUSE_MS = 20000; // после 429 («слишком часто») ждём, пока освободится минутное окно

// Пауза между запросами, мс. Читается при каждом запросе (в тестах — 0).
const pauseMs = () => (process.env.PLANRADAR_EXPORT_PAUSE_MS !== undefined ? Number(process.env.PLANRADAR_EXPORT_PAUSE_MS) : 2500);
const retryPauseMs = () => (process.env.PLANRADAR_EXPORT_RETRY_MS !== undefined ? Number(process.env.PLANRADAR_EXPORT_RETRY_MS) : RETRY_PAUSE_MS);
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

// Коды статусов из документации PlanRadar (закодированные и числовые).
const STATUS_NAMES = {
  lm: 'Открыто', ol: 'В работе', ma: 'Устранено', ex: 'На проверке', gk: 'Закрыто', ky: 'Отклонено',
  1: 'Открыто', 2: 'В работе', 3: 'Устранено', 4: 'На проверке', 5: 'Закрыто', 6: 'Отклонено',
};

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());

// Момент из API («2026-10-31T20:00:00.000Z») → календарная дата по Алматы.
function almatyDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(d);
}

// Дата «YYYY-MM-DD» из поля (срок задаётся датой, без времени).
const plainDate = (value) => {
  const s = value ? String(value).slice(0, 10) : null;
  return s && isDate(s) ? s : null;
};

// Действующий срок: дата продления, если она позже планового срока.
function deadlineOf(ticket) {
  const dates = [plainDate(attr(ticket, 'due-date', 'due_date')), plainDate(attr(ticket, 'extension-date', 'extension_date'))].filter(Boolean);
  return dates.length ? dates.sort().at(-1) : null;
}

const createdOf = (ticket) => almatyDate(attr(ticket, 'created-at', 'created_at', 'created-on'));

// Замечания, созданные в периоде [from, to] (включительно).
const filterByPeriod = (tickets, from, to) => tickets.filter((t) => {
  const c = createdOf(t);
  return c && c >= from && c <= to;
});

// ---------- запросы к PlanRadar ----------
async function apiGet(pathAndQuery) {
  const key = process.env.PLANRADAR_API_KEY;
  if (!key) throw new Error('не задан PLANRADAR_API_KEY');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}${pathAndQuery}`, { headers: { 'X-PlanRadar-API-Key': key, Accept: 'application/json' } });
    await sleep(pauseMs());
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(retryPauseMs());
      continue;
    }
    if (!res.ok) throw new Error(`PlanRadar ${res.status}`);
    return res.json();
  }
}

const customerId = () => process.env.PLANRADAR_CUSTOMER_ID || '1518857';

// Все замечания объекта (любые статусы), постранично. Заодно — названия полей
// форм (в ответе приходят типы замечаний): нужны, чтобы отличить поле
// «Фотоподтверждение устранения» от других.
async function fetchAllTickets(projectId) {
  const tickets = [];
  const fieldNames = new Map(); // id поля → название
  for (let page = 1; ; page++) {
    const body = await apiGet(`/v2/${customerId()}/projects/${projectId}/tickets?page=${page}&pagesize=${PAGESIZE}`);
    const batch = body.data || [];
    tickets.push(...batch);
    for (const inc of body.included || []) {
      if (inc.type !== 'ticket-types') continue;
      for (const [fieldId, def] of Object.entries(attr(inc, 'typed-fields') || {})) if (def && def.name) fieldNames.set(fieldId, def.name);
    }
    if (batch.length < PAGESIZE) break;
  }
  // в ответе замечаний типов нет — берём их отдельным запросом (один на объект); сбой не страшен:
  // без названий полей фото классифицируются по автору и времени, а описанием остаётся название
  if (tickets.length && !fieldNames.size) {
    try {
      const body = await apiGet(`/v1/${customerId()}/projects/${projectId}/ticket_types`);
      for (const type of body.data || []) {
        for (const [fieldId, def] of Object.entries(attr(type, 'typed-fields') || {})) if (def && def.name) fieldNames.set(fieldId, def.name);
      }
    } catch (err) { /* см. выше */ }
  }
  return { tickets, fieldNames };
}

async function fetchAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const body = await apiGet(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pagesize=${PAGESIZE}`);
    const batch = body.data || [];
    out.push(...batch);
    if (batch.length < PAGESIZE) return out;
  }
}

// ---------- фото ----------
// Размер JPEG/PNG по заголовку — нужен, чтобы вписать картинку без искажений.
function imageInfo(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { extension: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < buf.length) {
      if (buf[pos] !== 0xff) { pos += 1; continue; }
      const marker = buf[pos + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { extension: 'jpeg', height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
      }
      pos += 2 + buf.readUInt16BE(pos + 2);
    }
    return { extension: 'jpeg', width: 4, height: 3 }; // размер не прочитался — считаем 4:3
  }
  return null; // другие форматы (webp, heic…) в таблицу не встраиваем
}

// «after» — только фото из поля «Фотоподтверждение устранения замечания»;
// «before» — все остальные (столбец «Фото»).
function classifyPhoto(image, fieldNames = new Map()) {
  const fieldId = attr(image, 'field-id');
  return fieldId && /фотоподтвержд/i.test(String(fieldNames.get(fieldId) || '')) ? 'after' : 'before';
}

// Фото замечания: { before: { total, urls }, after: { total, urls } } — total всех
// изображений группы, urls — ссылки на миниатюры первых MAX_INLINE_PHOTOS (по порядку
// загрузки). Видео и документы не считаются.
async function fetchTicketPhotos(projectId, ticket, fieldNames) {
  const empty = () => ({ total: 0, urls: [] });
  const result = { before: empty(), after: empty() };
  const uuid = attr(ticket, 'uuid');
  if (!uuid) return result;
  const body = await apiGet(`/v2/${customerId()}/projects/${projectId}/tickets/${uuid}/attachments?page=1&pagesize=${PAGESIZE}`);
  const images = (body.included || [])
    .filter((i) => i.type === 'defectradar-issue-images')
    .sort((a, b) => String(attr(a, 'created-at')).localeCompare(String(attr(b, 'created-at'))));
  for (const image of images) {
    const group = result[classifyPhoto(image, fieldNames)];
    group.total += 1;
    const url = attr(image, 'image-url-thumb-300px', 'image-url-thumb-web', 'image-url-thumb', 'image-url');
    if (url && group.urls.length < MAX_INLINE_PHOTOS) group.urls.push(url);
  }
  return result;
}

// Скачивание одной картинки; не получилось — null (фото пропускается, выгрузка идёт дальше).
async function downloadPhoto(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > PHOTO_MAX_BYTES) return null;
    const info = imageInfo(buffer);
    return info ? { buffer, ...info } : null;
  } catch (err) {
    return null;
  }
}

const refsCache = new Map(); // projectId → { at, users, groups, layers }

// Имена пользователей, групп и слоёв объекта. Сбой справочника не роняет
// выгрузку — вместо имён в таблице будут id.
async function fetchRefs(projectId) {
  const cached = refsCache.get(projectId);
  if (cached && Date.now() - cached.at < REFS_TTL_MS) return cached;
  const refs = { at: Date.now(), users: new Map(), groups: new Map(), layers: new Map() };
  const cid = customerId();
  try {
    for (const u of await fetchAll(`/v1/${cid}/projects/${projectId}/users`)) {
      const name = [attr(u, 'firstname'), attr(u, 'lastname')].filter(Boolean).join(' ') || attr(u, 'mail') || '';
      refs.users.set(String(u.id), name);
    }
  } catch (err) { refs.partial = true; }
  try {
    for (const g of await fetchAll(`/v1/${cid}/projects/${projectId}/project_groups`)) refs.groups.set(String(g.id), attr(g, 'name', 'group-name') || String(g.id));
  } catch (err) { refs.partial = true; }
  try {
    const body = await apiGet(`/v2/${cid}/projects/${projectId}/components/project_components`);
    for (const c of body.data || []) refs.layers.set(String(c.id), attr(c, 'name') || String(c.id));
  } catch (err) { refs.partial = true; }
  if (!refs.partial) refsCache.set(projectId, refs);
  return refs;
}

// ---------- строки и Excel ----------
const idOf = (v) => (v && typeof v === 'object' ? v.id : v);

// Описание замечания — поле формы «Подробное описание замечания»; нет описания — название.
function descriptionOf(ticket, fieldNames) {
  const values = attr(ticket, 'typed-values', 'typed_values') || {};
  for (const [fieldId, name] of fieldNames || []) {
    if (!/описание замечания/i.test(name)) continue;
    const text = values[fieldId];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return attr(ticket, 'subject') || '';
}

function ticketRow(ticket, projectName, refs, fieldNames) {
  const status = String(attr(ticket, 'status-id', 'status_id') ?? '');
  const authorId = idOf(attr(ticket, 'author-id', 'author_id'));
  const assigneeId = idOf(attr(ticket, 'assigned-to-id', 'assigned_to_id'));
  const layerId = idOf(attr(ticket, 'component-id', 'component_id'));
  const assignee = assigneeId == null ? '' : refs.users.get(String(assigneeId)) || refs.groups.get(String(assigneeId)) || String(assigneeId);
  return {
    project: projectName,
    number: attr(ticket, 'sequential-id', 'sequential_id'),
    subject: descriptionOf(ticket, fieldNames),
    status: STATUS_NAMES[status] || status,
    author: authorId == null ? '' : refs.users.get(String(authorId)) || String(authorId),
    assignee,
    layer: layerId == null ? '' : refs.layers.get(String(layerId)) || String(layerId),
    deadline: deadlineOf(ticket),
    created: createdOf(ticket),
    closed: almatyDate(attr(ticket, 'closed-at', 'closed_at')),
    beforeCount: 0,
    afterCount: 0,
    photosBefore: [],
    photosAfter: [],
  };
}

// Вкладка «Замечания» рассчитана на печать на A4 в книжной ориентации: у каждого замечания строка
// «№ / Описание / Статус / Расположение», а под ней — две колонки с фото: «Фото» и «Фото после устранения»
// (до четырёх в каждой, сеткой 2×2). Все ячейки в рамке. Шапка повторяется на каждой странице,
// блок замечания по возможности не разрывается между страницами.
const ISSUE_COLS = [
  { header: '№', key: 'number', width: 6 }, // порядковый номер в этом отчёте, не номер замечания в PlanRadar
  { header: 'Описание', key: 'subject', width: 54 },
  { header: 'Статус', key: 'status', width: 14 },
  { header: 'Расположение', key: 'layer', width: 46 },
];
const colPx = (width) => Math.round(width * 7 + 5); // ширина столбца в пикселях
const PAGE_CAPACITY_PT = 850; // сколько пунктов высоты (в масштабе листа) помещается на страницу A4 при печати
const FONT = 'Arial';

function addIssuesSheet(wb, rows, { withPhotos }) {
  const ws = wb.addWorksheet('Замечания');
  ws.columns = ISSUE_COLS.map(({ header, key, width }) => ({ header, key, width }));
  const widths = ISSUE_COLS.map((c) => colPx(c.width));
  const half = widths[0] + widths[1]; // «Фото» — под № и описанием, «Фото после» — под статусом и слоем (обе половины равны)
  const tileW = Math.floor((half - 3 * PHOTO_GAP) / 2);
  const tileH = Math.round(tileW * 0.75);
  const thin = { style: 'thin', color: { argb: 'FF808080' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const frame = (r, c1 = 1, c2 = ISSUE_COLS.length) => { for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = border; };
  const pt = (px) => Math.ceil(px * 0.75);

  ws.pageSetup = {
    paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    printTitlesRow: '1:1',
  };
  ws.headerFooter.oddFooter = '&CСтраница &P из &N';

  const head = ws.getRow(1);
  head.height = 22;
  head.eachCell((cell) => {
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = border;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // номер столбца и сдвиг в нём по абсолютной координате x (пикселей от левого края листа)
  const colAt = (x) => {
    let left = 0;
    for (let i = 0; i < widths.length; i++) {
      if (x < left + widths[i] || i === widths.length - 1) return { nativeCol: i, nativeColOff: (x - left) * EMU };
      left += widths[i];
    }
    return { nativeCol: 0, nativeColOff: 0 };
  };

  let used = 22; // высота текущей страницы, пункты
  const ensureSpace = (height) => {
    if (used + height > PAGE_CAPACITY_PT && used > 22) {
      ws.getRow(ws.rowCount).addPageBreak(); // новая страница начнётся со следующей строки
      used = 22;
    }
    used += height;
  };

  const place = (photos, row, left, startY) => photos.forEach((p, i) => {
    // вписываем в плитку с сохранением пропорций, больше натурального размера не растягиваем
    const scale = Math.min(tileW / p.width, tileH / p.height, 1);
    const id = wb.addImage({ buffer: p.buffer, extension: p.extension });
    const x = left + PHOTO_GAP + (i % 2) * (tileW + PHOTO_GAP);
    const y = startY + PHOTO_GAP + Math.floor(i / 2) * (tileH + PHOTO_GAP);
    ws.addImage(id, {
      tl: { ...colAt(x), nativeRow: row - 1, nativeRowOff: y * EMU },
      ext: { width: Math.round(p.width * scale), height: Math.round(p.height * scale) },
      editAs: 'oneCell',
    });
  });

  const heightOf = (r) => {
    const lines = Math.max(Math.ceil((r.subject || '').length / 50), Math.ceil((r.layer || '').length / 42), 1);
    return Math.max(20, lines * 13 + 6);
  };
  const photoRowsFor = (r) => Math.min(2, Math.max(Math.ceil(r.photosBefore.length / 2), Math.ceil(r.photosAfter.length / 2)));

  let seq = 0; // сквозной номер по порядку в отчёте
  const addTicket = (r) => {
    seq += 1;
    const row = ws.addRow({ number: seq, subject: r.subject, status: r.status, layer: r.layer });
    row.height = heightOf(r);
    row.eachCell({ includeEmpty: true }, (cell, n) => {
      cell.font = { name: FONT, size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: n === 1 ? 'center' : 'left', wrapText: true };
    });
    frame(row.number);
    if (!withPhotos || !(r.photosBefore.length || r.photosAfter.length)) return;
    const caption = ws.addRow(['Фото', null, 'Фото после устранения', null]);
    ws.mergeCells(caption.number, 1, caption.number, 2);
    ws.mergeCells(caption.number, 3, caption.number, 4);
    caption.height = 16;
    caption.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: FONT, size: 9, bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    frame(caption.number);
    const photoRow = ws.addRow([]);
    ws.mergeCells(photoRow.number, 1, photoRow.number, 2);
    ws.mergeCells(photoRow.number, 3, photoRow.number, 4);
    const px = photoRowsFor(r) * (tileH + PHOTO_GAP) + PHOTO_GAP;
    photoRow.height = pt(px);
    frame(photoRow.number);
    place(r.photosBefore, photoRow.number, 0, 0);
    place(r.photosAfter, photoRow.number, half, 0);
  };
  const blockHeight = (r) => heightOf(r) + (withPhotos && (r.photosBefore.length || r.photosAfter.length) ? 16 + pt(photoRowsFor(r) * (tileH + PHOTO_GAP) + PHOTO_GAP) : 0);

  // объекты — подзаголовки (жирным, на пункт крупнее обычного текста), под ними замечания объекта
  const byProject = new Map();
  rows.forEach((r) => { if (!byProject.has(r.project)) byProject.set(r.project, []); byProject.get(r.project).push(r); });
  const ordered = [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  for (const [project, list] of ordered) {
    ensureSpace(22 + blockHeight(list[0])); // подзаголовок не остаётся один в конце страницы
    const sub = ws.addRow([project]);
    ws.mergeCells(sub.number, 1, sub.number, ISSUE_COLS.length);
    sub.height = 22;
    sub.getCell(1).font = { name: FONT, size: 12, bold: true };
    sub.getCell(1).alignment = { vertical: 'middle' };
    sub.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    frame(sub.number);
    list.forEach((r, i) => {
      if (i > 0) ensureSpace(blockHeight(r)); // у первого замечания место уже учтено вместе с подзаголовком
      addTicket(r);
    });
  }
  return ws;
}

// period ({ from, to }) — если задан, перед замечаниями добавляются вкладки «Титульный» и «Сводная»;
// reportNumber — номер отчёта на титульном листе (необязательный).
async function buildWorkbook(rows, errors = [], { withPhotos = false, period = null, reportNumber = '' } = {}) {
  const wb = new ExcelJS.Workbook();
  if (period) {
    const info = describePeriod(period.from, period.to);
    addTitleSheet(wb, { period: info, reportNumber });
    addSummarySheet(wb, rows, { period: info });
  }
  addIssuesSheet(wb, rows, { withPhotos });
  if (errors.length) {
    const es = wb.addWorksheet('Ошибки');
    es.columns = [{ header: 'Объект', key: 'project', width: 32 }, { header: 'Ошибка', key: 'error', width: 60 }];
    errors.forEach((e) => es.addRow(e));
    es.getRow(1).font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const sortRows = (rows) => rows.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.project.localeCompare(b.project, 'ru') || (Number(a.number) || 0) - (Number(b.number) || 0)));

// ---------- фоновые задачи ----------
const jobs = new Map();
let counter = 0;

function pruneJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id);
}

const runningJob = () => [...jobs.values()].find((j) => j.status === 'running') || null;

const publicJob = (j) => ({
  id: j.id,
  status: j.status,
  from: j.from,
  to: j.to,
  progress: j.progress,
  count: j.count,
  withPhotos: j.withPhotos,
  photoFailures: j.photoFailures,
  errors: j.errors,
  error: j.error || null,
  filename: j.filename || null,
});

// projectIds — только эти объекты (по умолчанию все из справочника).
function startExport({ from, to, projectIds = null, withPhotos = true, reportNumber = '' }) {
  if (!isDate(from) || !isDate(to)) throw Object.assign(new Error('Укажите даты в формате ГГГГ-ММ-ДД'), { status: 400 });
  if (from > to) throw Object.assign(new Error('Начальная дата позже конечной'), { status: 400 });
  if (!process.env.PLANRADAR_API_KEY) throw Object.assign(new Error('На сервере не задан PLANRADAR_API_KEY'), { status: 503 });
  pruneJobs();
  if (runningJob()) throw Object.assign(new Error('Выгрузка уже выполняется — дождитесь её окончания'), { status: 409 });

  const all = loadProjects();
  const projects = projectIds && projectIds.length ? all.filter((p) => projectIds.includes(p.id)) : all;
  if (!projects.length) throw Object.assign(new Error('Не найдено объектов для выгрузки'), { status: 400 });

  const job = {
    id: `exp${Date.now().toString(36)}${++counter}`,
    status: 'running',
    from,
    to,
    progress: { done: 0, total: projects.length, current: null },
    withPhotos: !!withPhotos,
    reportNumber: String(reportNumber || '').trim(),
    photoFailures: 0,
    count: 0,
    errors: [],
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);

  job.promise = (async () => {
    const rows = [];
    try {
      for (const project of projects) {
        job.progress.current = project.name;
        try {
          const all = await fetchAllTickets(project.id);
          const fieldNames = all.fieldNames;
          const tickets = filterByPeriod(all.tickets, from, to);
          if (tickets.length) {
            const refs = await fetchRefs(project.id);
            const projectRows = tickets.map((t) => ticketRow(t, project.name, refs, fieldNames));
            if (withPhotos) {
              const downloads = [];
              for (let i = 0; i < tickets.length; i++) {
                job.progress.current = `${project.name} — фото к замечаниям: ${i + 1} из ${tickets.length}`;
                try {
                  const { before, after } = await fetchTicketPhotos(project.id, tickets[i], fieldNames);
                  projectRows[i].beforeCount = before.total;
                  projectRows[i].afterCount = after.total;
                  // скачивание идёт параллельно с паузой между запросами к API
                  for (const [group, key] of [[before, 'photosBefore'], [after, 'photosAfter']]) {
                    downloads.push(Promise.all(group.urls.map(downloadPhoto)).then((list) => {
                      projectRows[i][key] = list.filter(Boolean);
                      job.photoFailures += list.length - projectRows[i][key].length;
                    }));
                  }
                } catch (err) {
                  job.photoFailures += 1;
                }
              }
              await Promise.all(downloads);
            }
            rows.push(...projectRows);
          }
        } catch (err) {
          job.errors.push({ project: project.name, error: err.message });
        }
        job.progress.done += 1;
      }
      if (job.errors.length === projects.length) throw new Error('PlanRadar не ответил ни по одному объекту');
      job.count = rows.length;
      job.buffer = await buildWorkbook(sortRows(rows), job.errors, { withPhotos, period: { from, to }, reportNumber: job.reportNumber });
      job.filename = `PlanRadar_замечания_${from}_${to}.xlsx`;
      job.status = 'done';
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
    } finally {
      job.progress.current = null;
      job.finishedAt = Date.now();
    }
  })();
  return job;
}

const getJob = (id) => jobs.get(id) || null;

// ---------- маршруты (только администратор) ----------
const router = express.Router();
router.use(requireEmails(EXPORT_USERS));
router.use(express.json());

router.get('/projects', (req, res) => {
  res.json({ projects: loadProjects().map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')) });
});

router.post('/exports', (req, res) => {
  try {
    const { from, to, projectIds, reportNumber } = req.body || {};
    const number = String(reportNumber ?? '').trim().slice(0, 12);
    const job = startExport({ from, to, projectIds: Array.isArray(projectIds) ? projectIds.map(String) : null, withPhotos: (req.body || {}).withPhotos !== false, reportNumber: number });
    res.status(202).json(publicJob(job));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/exports/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Выгрузка не найдена (возможно, устарела) — запустите заново' });
  res.json(publicJob(job));
});

router.get('/exports/:id/file', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'done' || !job.buffer) return res.status(404).json({ error: 'Файл ещё не готов или устарел' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="planradar_${job.from}_${job.to}.xlsx"; filename*=UTF-8''${encodeURIComponent(job.filename)}`);
  res.send(job.buffer);
});

module.exports = { descriptionOf, router, startExport, imageInfo, classifyPhoto, MAX_INLINE_PHOTOS, getJob, filterByPeriod, almatyDate, deadlineOf, ticketRow, buildWorkbook, STATUS_NAMES };
