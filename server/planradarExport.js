// Выгрузка замечаний PlanRadar за период в Excel (страница «Личный кабинет →
// Замечания PlanRadar»). Период — по дате СОЗДАНИЯ замечания (по времени
// Алматы, границы включительно).
//
// Фильтра по дате создания у API PlanRadar нет (параметры filter[created-at]
// игнорируются, проверено), поэтому по каждому объекту забираются все
// замечания и период отбирается здесь. Лимит API — 30 запросов в минуту на
// аккаунт, выгрузка по всем объектам идёт минуты — поэтому это фоновая
// задача: POST создаёт её, GET отдаёт ход выполнения, затем файл.
// Фото «до» и «после»: фото «после» лежат в поле формы «Фотоподтверждение
// устранения замечания» (у вложения заполнен field-id), фото «до» загружены при
// создании замечания и ни к какому полю не привязаны. Исключение — фото без поля,
// добавленное позже чем через час не автором замечания (исполнитель прикрепил
// результат без поля) — это «после». См. classifyPhoto.
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
const { requireAdmin } = require('./adminAuth');
const { loadProjects, attr, API_BASE } = require('./planradar');

const TIMEZONE = 'Asia/Almaty';
const PAGESIZE = 500;
const REFS_TTL_MS = 6 * 3600 * 1000;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const MAX_INLINE_PHOTOS = 4; // сколько фото «до» и сколько «после» встраивается в строку; сколько всего — в столбцах «Фото до, шт.» / «Фото после, шт.»
const AFTER_LATE_MS = 60 * 60 * 1000; // фото без поля позже этого срока от создания и не от автора — «после»
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_BOX = { width: 300, height: 225 }; // плитка под одно фото, пиксели; в ячейке 2×2 плитки
const PHOTO_GAP = 4; // отступ между плитками и от края ячейки, пиксели
const EMU = 9525; // EMU в пикселе
const PHOTO_ROW_HEIGHT = 347; // пункты (≈ 462 пикселя = 2 плитки + отступы)
const PHOTO_COLUMN_WIDTH = 87; // ширина столбца с фото, символы (≈ 612 пикселей = 2 плитки + отступы)
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
    if (batch.length < PAGESIZE) return { tickets, fieldNames };
  }
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

// «before» — фото при создании замечания, «after» — подтверждение устранения.
function classifyPhoto(image, ticket, fieldNames = new Map()) {
  const fieldId = attr(image, 'field-id');
  if (fieldId) {
    const name = String(fieldNames.get(fieldId) || '');
    // поле формы с фото — «после» (так называется поле устранения), если название явно не про нарушение до устранения
    const toRepair = /устран|после/i.test(name);
    const aboutViolation = /нарушен|замечани|(^|\s)до(\s|$)/i.test(name);
    return aboutViolation && !toRepair ? 'before' : 'after';
  }
  const author = attr(ticket, 'author-id', 'author_id');
  const by = attr(image, 'created-by');
  const created = Date.parse(attr(ticket, 'created-at', 'created_at'));
  const at = Date.parse(attr(image, 'created-at'));
  const notAuthor = author != null && by != null && String(by) !== String(author);
  return notAuthor && Number.isFinite(created) && Number.isFinite(at) && at - created > AFTER_LATE_MS ? 'after' : 'before';
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
    const group = result[classifyPhoto(image, ticket, fieldNames)];
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

function ticketRow(ticket, projectName, refs) {
  const status = String(attr(ticket, 'status-id', 'status_id') ?? '');
  const authorId = idOf(attr(ticket, 'author-id', 'author_id'));
  const assigneeId = idOf(attr(ticket, 'assigned-to-id', 'assigned_to_id'));
  const layerId = idOf(attr(ticket, 'component-id', 'component_id'));
  const assignee = assigneeId == null ? '' : refs.users.get(String(assigneeId)) || refs.groups.get(String(assigneeId)) || String(assigneeId);
  return {
    project: projectName,
    number: attr(ticket, 'sequential-id', 'sequential_id'),
    subject: attr(ticket, 'subject') || '',
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

const COLUMNS = [
  { header: 'Объект', key: 'project', width: 28 },
  { header: '№', key: 'number', width: 8 },
  { header: 'Название', key: 'subject', width: 60 },
  { header: 'Статус', key: 'status', width: 14 },
  { header: 'Автор', key: 'author', width: 26 },
  { header: 'Исполнитель', key: 'assignee', width: 26 },
  { header: 'Слой', key: 'layer', width: 26 },
  { header: 'Срок', key: 'deadline', width: 12, date: true },
  { header: 'Создано', key: 'created', width: 12, date: true },
  { header: 'Закрыто', key: 'closed', width: 12, date: true },
];

// Дата «YYYY-MM-DD» → ячейка-дата без сдвига по часовому поясу.
const asCellDate = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);

async function buildWorkbook(rows, errors = [], { withPhotos = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Замечания');
  const columns = [...COLUMNS];
  if (withPhotos) {
    columns.push({ header: 'Фото до, шт.', key: 'beforeCount', width: 11 });
    columns.push({ header: 'Фото после, шт.', key: 'afterCount', width: 12 });
    columns.push({ header: 'Фото до', key: 'photoBefore', width: PHOTO_COLUMN_WIDTH });
    columns.push({ header: 'Фото после', key: 'photoAfter', width: PHOTO_COLUMN_WIDTH });
  }
  ws.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  rows.forEach((r) => {
    const row = ws.addRow(COLUMNS.reduce((acc, c) => ({ ...acc, [c.key]: c.date ? asCellDate(r[c.key]) : r[c.key] }), withPhotos ? { beforeCount: r.beforeCount || null, afterCount: r.afterCount || null } : {}));
    if (!withPhotos || !(r.photosBefore.length || r.photosAfter.length)) return;
    row.height = PHOTO_ROW_HEIGHT;
    // столбцы: после обычных — два счётчика, затем «Фото до» и «Фото после»;
    // в каждой ячейке до четырёх фото сеткой 2×2 (слева направо, сверху вниз)
    const place = (photos, col) => photos.forEach((p, i) => {
      // вписываем в плитку с сохранением пропорций, больше натурального размера не растягиваем
      const scale = Math.min(PHOTO_BOX.width / p.width, PHOTO_BOX.height / p.height, 1);
      const imageId = wb.addImage({ buffer: p.buffer, extension: p.extension });
      const x = PHOTO_GAP + (i % 2) * (PHOTO_BOX.width + PHOTO_GAP);
      const y = PHOTO_GAP + Math.floor(i / 2) * (PHOTO_BOX.height + PHOTO_GAP);
      ws.addImage(imageId, {
        tl: { nativeCol: col, nativeColOff: x * EMU, nativeRow: row.number - 1, nativeRowOff: y * EMU },
        ext: { width: Math.round(p.width * scale), height: Math.round(p.height * scale) },
        editAs: 'oneCell',
      });
    });
    place(r.photosBefore, COLUMNS.length + 2);
    place(r.photosAfter, COLUMNS.length + 3);
  });
  COLUMNS.forEach((c, i) => { if (c.date) ws.getColumn(i + 1).numFmt = 'dd.mm.yyyy'; });
  const head = ws.getRow(1);
  head.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
  head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  ws.getColumn('subject').alignment = { wrapText: true, vertical: 'top' };
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
function startExport({ from, to, projectIds = null, withPhotos = true }) {
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
            const projectRows = tickets.map((t) => ticketRow(t, project.name, refs));
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
      job.buffer = await buildWorkbook(sortRows(rows), job.errors, { withPhotos });
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
router.use(requireAdmin);
router.use(express.json());

router.get('/projects', (req, res) => {
  res.json({ projects: loadProjects().map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')) });
});

router.post('/exports', (req, res) => {
  try {
    const { from, to, projectIds } = req.body || {};
    const job = startExport({ from, to, projectIds: Array.isArray(projectIds) ? projectIds.map(String) : null, withPhotos: (req.body || {}).withPhotos !== false });
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

module.exports = { router, startExport, imageInfo, classifyPhoto, MAX_INLINE_PHOTOS, getJob, filterByPeriod, almatyDate, deadlineOf, ticketRow, buildWorkbook, STATUS_NAMES };
