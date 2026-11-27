// Заявки на технологическое бурение и резку: создание, согласование, выполнение
// по строкам. Все изменения статуса — в транзакции (SQLite синхронный), поэтому
// «кто первый среагировал, тот и зафиксирован» гарантировано.
//
// Путь заявки в каждом круге: главный инженер → линия 1 (Пром Альянс) → линия 2
// (субподрядчики).
// - Главный инженер (роль chief_engineer, один): согласует — заявка идёт в линию 1,
//   отклоняет (с причиной) — сразу возвращается автору. Его собственная заявка этот
//   этап пропускает и идёт в линию 1.
// - Линия 1 (роль prom_alyans, несколько равнозначных): любой отказ передаёт заявку
//   в линию 2; принял первый.
// - Линия 2 (роль driller + компания-субподрядчик): все равнозначны, принимает
//   первый; автору возвращают, только когда отказали ВСЕ субподрядчики (отказ
//   компании — первая реакция любого её бурильщика).
// После возврата автор может исправить и перезапустить: новый круг, снова с главного
// инженера. Люди (роль, ФИО, должность, компания бурильщика) берутся из rides.users —
// они назначаются главным админом на /rides-admin. События — в drilling_events.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWriteDb, DB_PATH } = require('../db');
const { getWriteDb: ridesDb } = require('../rides/db');
const { validateItems, validateFact } = require('./validation');
const { MAX_FILE_BYTES, MAX_FILES_PER_REQUEST, detectFileType, safeFileName } = require('./files');

class DrillingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const db = () => getWriteDb();

// Роли, которым подача заявок на бурение закрыта (исполнители не подают сами себе).
const SUBMIT_FORBIDDEN_ROLES = ['prom_alyans', 'driller'];
const OPEN_STATUSES = ['engineer', 'line1', 'line2'];

// Первичное наполнение: две компании из согласованного сценария.
function seedDefaults() {
  const d = db();
  if (d.prepare('SELECT COUNT(*) AS n FROM drilling_companies').get().n > 0) return;
  const ins = d.prepare('INSERT INTO drilling_companies (name, addressee, line) VALUES (?, ?, ?)');
  ins.run('Пром Альянс', 'Директору ТОО "Пром Альянс"', 1);
  ins.run('Жеңіс групп', 'Директору ТОО "Жеңіс групп"', 2);
}

// ---------- люди: роли и карточки (rides.users) ----------

const ridesUser = (email) => ridesDb().prepare('SELECT * FROM users WHERE email = ?').get(normEmail(email)) || null;
const chiefEngineer = () => ridesDb().prepare("SELECT * FROM users WHERE role = 'chief_engineer' ORDER BY id LIMIT 1").get() || null;

// ФИО и должность автора/подписанта для документов и списков.
function personCard(email) {
  const u = ridesUser(email);
  return { email: normEmail(email), fullName: u?.name?.trim() || normEmail(email), position: u?.position?.trim() || '' };
}

// ---------- исполнители (админка) ----------

function companyById(id) {
  return db().prepare('SELECT id, name, addressee, line, active FROM drilling_companies WHERE id = ?').get(id) || null;
}

// Компания-субподрядчик (линия 2, активная) — к ней можно привязать бурильщика.
function isSubcontractor(id) {
  const c = companyById(id);
  return !!c && c.line === 2 && !!c.active;
}

// Список для админки; users — кто назначен ролями: линия 1 — все Пром Альянс,
// линия 2 — бурильщики этой компании (read-only, назначаются на /rides-admin).
function listCompanies() {
  const r = ridesDb();
  const prom = r.prepare("SELECT email FROM users WHERE role = 'prom_alyans' ORDER BY email").all().map((u) => u.email);
  return db().prepare('SELECT id, name, addressee, line, active FROM drilling_companies ORDER BY line, id').all().map((c) => ({
    ...c,
    active: !!c.active,
    users: c.line === 1 ? prom : r.prepare("SELECT email FROM users WHERE role = 'driller' AND company_id = ? ORDER BY email").all(c.id).map((u) => u.email),
  }));
}

function saveCompany({ id, name, addressee, line, active = true }) {
  const n = String(name || '').trim();
  const a = String(addressee || '').trim();
  if (!n || !a) throw new DrillingError('Укажите название и адресата (строка «Директору …»)');
  if (![1, 2].includes(Number(line))) throw new DrillingError('Линия — 1 или 2');
  const d = db();
  if (Number(line) === 1) {
    const other = d.prepare('SELECT id FROM drilling_companies WHERE line = 1 AND id != ?').get(id || 0);
    if (other) throw new DrillingError('Линия 1 — одна компания (Пром Альянс). Субподрядчики добавляются в линию 2', 409);
  }
  try {
    if (id) {
      const r = d.prepare('UPDATE drilling_companies SET name = ?, addressee = ?, line = ?, active = ? WHERE id = ?')
        .run(n, a, Number(line), active ? 1 : 0, id);
      if (!r.changes) throw new DrillingError('Компания не найдена', 404);
      return id;
    }
    return d.prepare('INSERT INTO drilling_companies (name, addressee, line, active) VALUES (?, ?, ?, ?)')
      .run(n, a, Number(line), active ? 1 : 0).lastInsertRowid;
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new DrillingError('Компания с таким названием уже есть');
    throw err;
  }
}

// ---------- кто за какую линию отвечает ----------

// Компании, за которые отвечает пользователь: Пром Альянс — компания линии 1,
// бурильщик — своя компания (users.company_id).
function companiesOfUser(email) {
  const u = ridesUser(email);
  if (!u) return [];
  let company = null;
  if (u.role === 'prom_alyans') {
    company = db().prepare('SELECT id, name, addressee, line FROM drilling_companies WHERE line = 1 AND active = 1 ORDER BY id LIMIT 1').get();
  } else if (u.role === 'driller' && u.company_id) {
    company = db().prepare('SELECT id, name, addressee, line FROM drilling_companies WHERE id = ? AND active = 1').get(u.company_id);
  }
  return company ? [company] : [];
}

// Компании линии, у которых есть хотя бы один ответственный (иначе реагировать некому).
function staffedCompanies(line) {
  const r = ridesDb();
  return db().prepare('SELECT id, name FROM drilling_companies WHERE line = ? AND active = 1 ORDER BY id').all(line)
    .filter((c) => (line === 1
      ? r.prepare("SELECT 1 FROM users WHERE role = 'prom_alyans' LIMIT 1").get()
      : r.prepare("SELECT 1 FROM users WHERE role = 'driller' AND company_id = ? LIMIT 1").get(c.id)));
}

// ---------- вспомогательное ----------

function logEvent(requestId, round, type, { actor = null, companyId = null, line = null, reason = null } = {}) {
  db().prepare('INSERT INTO drilling_events (request_id, round, at, type, actor_email, company_id, line, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(requestId, round, now(), type, actor, companyId, line, reason);
}

function getRequestRow(id) {
  const row = db().prepare('SELECT * FROM drilling_requests WHERE id = ?').get(id);
  if (!row) throw new DrillingError('Заявка не найдена', 404);
  return row;
}

// Первая линия исполнителей, у которой есть ответственные (после согласования
// главного инженера).
function executorStage() {
  if (staffedCompanies(1).length) return { status: 'line1', line: 1 };
  if (staffedCompanies(2).length) return { status: 'line2', line: 2 };
  throw new DrillingError('Исполнители не назначены — обратитесь к администратору', 409);
}

// С какого этапа начинается круг: главный инженер, а для его собственной заявки —
// сразу исполнители. Без главного инженера заявку подать нельзя.
function firstStage(initiatorEmail) {
  const chief = chiefEngineer();
  if (!chief) throw new DrillingError('Главный инженер не назначен — обратитесь к администратору', 409);
  const executors = executorStage(); // проверяем заранее, чтобы заявка не застряла после согласования
  if (chief.email === normEmail(initiatorEmail)) return executors;
  return { status: 'engineer', line: null };
}

// Может ли человек подавать заявки: исполнителям (Пром Альянс, бурильщик) нельзя; у остальных
// должна быть карточка с ФИО и должностью (они печатаются в «Составил»). Админ — без проверки карточки.
function submitBlock(email, isAdmin) {
  const u = ridesUser(email);
  if (u && SUBMIT_FORBIDDEN_ROLES.includes(u.role)) return { status: 403, message: 'Вашей роли недоступна подача заявок на бурение и резку' };
  if (isAdmin) return null;
  if (!u || !u.name.trim() || !u.position.trim()) {
    return { status: 409, message: 'В вашей карточке не заполнены ФИО и должность — обратитесь к администратору' };
  }
  return null;
}

function writeItems(requestId, items) {
  const d = db();
  d.prepare('DELETE FROM drilling_request_items WHERE request_id = ?').run(requestId);
  const ins = d.prepare(
    `INSERT INTO drilling_request_items (request_id, line_no, object, obj_position, work_type, material, diameter_mm, thickness_cm, quantity, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  items.forEach((it, i) => ins.run(requestId, i + 1, it.object, it.position, it.workType, it.material, it.diameterMm, it.thicknessCm, it.quantity, it.reason));
}

const tx = (fn) => db().transaction(fn)();

function requireInitiator(row, email) {
  if (row.initiator_email !== normEmail(email)) throw new DrillingError('Заявку может менять только её автор', 403);
}

// ---------- действия ----------

function createRequest(email, rawItems, { isAdmin = false } = {}) {
  const block = submitBlock(email, isAdmin);
  if (block) throw new DrillingError(block.message, block.status);
  const v = validateItems(rawItems);
  if (!v.ok) throw new DrillingError(v.error);
  return tx(() => {
    const first = firstStage(email);
    const t = now();
    const id = db().prepare('INSERT INTO drilling_requests (initiator_email, status, round, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
      .run(normEmail(email), first.status, t, t).lastInsertRowid;
    writeItems(id, v.items);
    logEvent(id, 1, 'created', { actor: normEmail(email), line: first.line });
    return Number(id);
  });
}

function updateRequest(id, email, rawItems) {
  const v = validateItems(rawItems);
  if (!v.ok) throw new DrillingError(v.error);
  return tx(() => {
    const row = getRequestRow(id);
    requireInitiator(row, email);
    if (row.status !== 'returned') throw new DrillingError('Править можно только возвращённую заявку', 409);
    writeItems(id, v.items);
    db().prepare('UPDATE drilling_requests SET updated_at = ? WHERE id = ?').run(now(), id);
    logEvent(id, row.round, 'edited', { actor: normEmail(email) });
  });
}

function restartRequest(id, email) {
  return tx(() => {
    const row = getRequestRow(id);
    requireInitiator(row, email);
    if (row.status !== 'returned') throw new DrillingError('Перезапустить можно только возвращённую заявку', 409);
    const first = firstStage(row.initiator_email);
    const round = row.round + 1;
    db().prepare('UPDATE drilling_requests SET status = ?, round = ?, updated_at = ? WHERE id = ?').run(first.status, round, now(), id);
    logEvent(id, round, 'restarted', { actor: normEmail(email), line: first.line });
  });
}

function cancelRequest(id, email) {
  return tx(() => {
    const row = getRequestRow(id);
    requireInitiator(row, email);
    if (![...OPEN_STATUSES, 'returned'].includes(row.status)) throw new DrillingError('Заявку уже нельзя отменить', 409);
    db().prepare("UPDATE drilling_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), id);
    logEvent(id, row.round, 'cancelled', { actor: normEmail(email) });
  });
}

// Компания пользователя в текущей линии заявки (или null).
function responderCompany(row, email) {
  const line = row.status === 'line1' ? 1 : row.status === 'line2' ? 2 : null;
  if (!line) return null;
  return companiesOfUser(email).find((c) => c.line === line) || null;
}

function rejectedCompanyIds(requestId, round, line) {
  return new Set(
    db().prepare("SELECT company_id FROM drilling_events WHERE request_id = ? AND round = ? AND type = 'rejected' AND line = ?")
      .all(requestId, round, line).map((r) => r.company_id)
  );
}

// Реакция на заявку: главный инженер на своём этапе, исполнители — на своей линии.
function respond(id, email, action, reason) {
  if (!['accept', 'reject'].includes(action)) throw new DrillingError('Неизвестное действие');
  const why = String(reason || '').trim();
  if (action === 'reject' && !why) throw new DrillingError('Укажите причину отказа');
  if (why.length > 500) throw new DrillingError('Причина длиннее 500 символов');
  return tx(() => {
    const row = getRequestRow(id);
    if (!OPEN_STATUSES.includes(row.status)) throw new DrillingError('Заявка уже обработана', 409);

    if (row.status === 'engineer') {
      if (chiefEngineer()?.email !== normEmail(email)) throw new DrillingError('Эта заявка сейчас ждёт согласования главного инженера', 403);
      const actor = normEmail(email);
      if (action === 'accept') {
        const next = executorStage();
        db().prepare('UPDATE drilling_requests SET status = ?, updated_at = ? WHERE id = ?').run(next.status, now(), id);
        logEvent(id, row.round, 'engineer_approved', { actor });
      } else {
        db().prepare("UPDATE drilling_requests SET status = 'returned', updated_at = ? WHERE id = ?").run(now(), id);
        logEvent(id, row.round, 'engineer_rejected', { actor, reason: why });
      }
      return;
    }

    const company = responderCompany(row, email);
    if (!company) throw new DrillingError('Эта заявка сейчас не ждёт вашей реакции', 403);
    const line = company.line;
    const base = { actor: normEmail(email), companyId: company.id, line };
    if (rejectedCompanyIds(id, row.round, line).has(company.id)) throw new DrillingError('Ваша компания уже отказала по этой заявке', 409);

    if (action === 'accept') {
      db().prepare("UPDATE drilling_requests SET status = 'accepted', accepted_company_id = ?, accepted_by = ?, updated_at = ? WHERE id = ?")
        .run(company.id, normEmail(email), now(), id);
      logEvent(id, row.round, 'accepted', base);
      return;
    }

    logEvent(id, row.round, 'rejected', { ...base, reason: why });

    let next = null;
    if (line === 1) {
      next = staffedCompanies(2).length ? 'line2' : 'returned';
    } else {
      const rejected = rejectedCompanyIds(id, row.round, 2);
      if (staffedCompanies(2).every((c) => rejected.has(c.id))) next = 'returned';
    }
    if (next) {
      db().prepare('UPDATE drilling_requests SET status = ?, updated_at = ? WHERE id = ?').run(next, now(), id);
      logEvent(id, row.round, next === 'line2' ? 'forwarded' : 'returned', { line: next === 'line2' ? 2 : null });
    } else {
      db().prepare('UPDATE drilling_requests SET updated_at = ? WHERE id = ?').run(now(), id);
    }
  });
}

// Отметка выполнения одной или сразу нескольких строк (все проверяются до записи — либо
// записываются все, либо ни одна). entries: [{ itemId, factQuantity, comment }].
function markItemsDone(id, email, entries) {
  return tx(() => {
    const row = getRequestRow(id);
    requireInitiator(row, email);
    if (row.status !== 'accepted') throw new DrillingError('Отметить выполнение можно после принятия заявки', 409);
    if (!Array.isArray(entries) || entries.length === 0) throw new DrillingError('Нет строк для отметки');
    const seen = new Set();
    const prepared = entries.map((e) => {
      const item = db().prepare('SELECT * FROM drilling_request_items WHERE id = ? AND request_id = ?').get(Number(e.itemId), id);
      if (!item) throw new DrillingError('Строка не найдена', 404);
      if (item.done_at || seen.has(item.id)) throw new DrillingError(`Строка ${item.line_no} уже отмечена`, 409);
      seen.add(item.id);
      const v = validateFact(e.factQuantity, item);
      if (!v.ok) throw new DrillingError(`Строка ${item.line_no}: ${v.error}`);
      const comment = String(e.comment || '').trim();
      if (comment.length > 300) throw new DrillingError(`Строка ${item.line_no}: комментарий длиннее 300 символов`);
      return { item, value: v.value, comment };
    });
    const t = now();
    for (const p of prepared) {
      db().prepare('UPDATE drilling_request_items SET fact_quantity = ?, fact_comment = ?, done_at = ? WHERE id = ?').run(p.value, p.comment || null, t, p.item.id);
    }
    const left = db().prepare('SELECT COUNT(*) AS n FROM drilling_request_items WHERE request_id = ? AND done_at IS NULL').get(id).n;
    if (left === 0) {
      db().prepare("UPDATE drilling_requests SET status = 'completed', updated_at = ? WHERE id = ?").run(t, id);
      logEvent(id, row.round, 'completed', { actor: normEmail(email) });
    } else {
      db().prepare('UPDATE drilling_requests SET updated_at = ? WHERE id = ?').run(t, id);
    }
  });
}

function markItemDone(id, itemId, email, rawFact, comment) {
  return markItemsDone(id, email, [{ itemId, factQuantity: rawFact, comment }]);
}

// ---------- вложения: чертежи и фото ----------

// Менять набор файлов может автор, пока заявку не приняли (и после возврата).
const ATTACH_STATUSES = [...OPEN_STATUSES, 'returned'];
const filesDir = () => process.env.DRILLING_FILES_DIR || path.join(path.dirname(DB_PATH), 'drilling-files');

function listAttachments(requestId) {
  return db().prepare('SELECT id, original_name AS name, mime, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt FROM drilling_attachments WHERE request_id = ? ORDER BY id')
    .all(requestId);
}

function addAttachment(requestId, email, originalName, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new DrillingError('Файл пустой');
  const type = detectFileType(buffer);
  if (buffer.length > MAX_FILE_BYTES) throw new DrillingError(`Файл больше ${MAX_FILE_BYTES / 1024 / 1024} МБ`, 413);
  if (!type) throw new DrillingError('Допустимы файлы PDF и картинки (JPEG, PNG, WebP)', 415);
  return tx(() => {
    const row = getRequestRow(requestId);
    requireInitiator(row, email);
    if (!ATTACH_STATUSES.includes(row.status)) throw new DrillingError('Файлы можно менять, пока заявку не приняли', 409);
    const count = db().prepare('SELECT COUNT(*) AS n FROM drilling_attachments WHERE request_id = ?').get(requestId).n;
    if (count >= MAX_FILES_PER_REQUEST) throw new DrillingError(`К заявке можно приложить не больше ${MAX_FILES_PER_REQUEST} файлов`, 409);
    const name = safeFileName(originalName, type.ext);
    const stored = `${crypto.randomBytes(16).toString('hex')}${type.ext}`;
    fs.mkdirSync(filesDir(), { recursive: true });
    fs.writeFileSync(path.join(filesDir(), stored), buffer);
    try {
      const id = db().prepare(
        'INSERT INTO drilling_attachments (request_id, original_name, stored_name, mime, size, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(requestId, name, stored, type.mime, buffer.length, normEmail(email), now()).lastInsertRowid;
      db().prepare('UPDATE drilling_requests SET updated_at = ? WHERE id = ?').run(now(), requestId);
      logEvent(requestId, row.round, 'attached', { actor: normEmail(email), reason: name });
      return Number(id);
    } catch (err) {
      fs.rmSync(path.join(filesDir(), stored), { force: true }); // запись не удалась — файл не оставляем
      throw err;
    }
  });
}

function removeAttachment(requestId, attachmentId, email) {
  return tx(() => {
    const row = getRequestRow(requestId);
    requireInitiator(row, email);
    if (!ATTACH_STATUSES.includes(row.status)) throw new DrillingError('Файлы можно менять, пока заявку не приняли', 409);
    const att = db().prepare('SELECT * FROM drilling_attachments WHERE id = ? AND request_id = ?').get(attachmentId, requestId);
    if (!att) throw new DrillingError('Файл не найден', 404);
    db().prepare('DELETE FROM drilling_attachments WHERE id = ?').run(att.id);
    fs.rmSync(path.join(filesDir(), att.stored_name), { force: true });
    logEvent(requestId, row.round, 'detached', { actor: normEmail(email), reason: att.original_name });
  });
}

// Файл для просмотра/скачивания — тем, кто вправе видеть заявку.
function getAttachmentFile(requestId, attachmentId, email, isAdmin) {
  const row = getRequestRow(requestId);
  if (!involvement(row, email, isAdmin).canSee) throw new DrillingError('Нет доступа к заявке', 403);
  const att = db().prepare('SELECT * FROM drilling_attachments WHERE id = ? AND request_id = ?').get(attachmentId, requestId);
  if (!att) throw new DrillingError('Файл не найден', 404);
  const file = path.join(filesDir(), att.stored_name);
  if (!fs.existsSync(file)) throw new DrillingError('Файл не найден на сервере', 404);
  return { file, mime: att.mime, name: att.original_name };
}

// ---------- чтение ----------

// Что пользователь значит для заявки. Главный инженер видит все заявки (все проходят
// через него); исполнитель — те, что ждут его компанию или проходили через неё.
function involvement(row, email, isAdmin) {
  const e = normEmail(email);
  const me = ridesUser(e);
  const isChief = me?.role === 'chief_engineer';
  const mine = companiesOfUser(e);
  const myIds = new Set(mine.map((c) => c.id));
  const isInitiator = row.initiator_email === e;
  const responder = responderCompany(row, e);
  const waitingForMe = (row.status === 'engineer' && isChief)
    || (!!responder && !(row.status === 'line2' && rejectedCompanyIds(row.id, row.round, 2).has(responder.id)));
  const wasInvolved = !!(row.accepted_company_id && myIds.has(row.accepted_company_id))
    || (myIds.size > 0 && db().prepare('SELECT company_id FROM drilling_events WHERE request_id = ? AND company_id IS NOT NULL').all(row.id).some((r) => myIds.has(r.company_id)));
  return {
    isInitiator, isChief, waitingForMe,
    canSee: isAdmin || isChief || isInitiator || waitingForMe || wasInvolved || !!responder,
    isResponsible: mine.length > 0 || isChief,
  };
}

function getItems(id) {
  return db().prepare('SELECT * FROM drilling_request_items WHERE request_id = ? ORDER BY line_no').all(id).map((i) => ({
    id: i.id, lineNo: i.line_no, object: i.object, position: i.obj_position, workType: i.work_type, material: i.material,
    diameterMm: i.diameter_mm, thicknessCm: i.thickness_cm, quantity: i.quantity, reason: i.reason,
    factQuantity: i.fact_quantity, factComment: i.fact_comment || '', doneAt: i.done_at,
  }));
}

function getEvents(id) {
  return db().prepare(
    `SELECT e.id, e.round, e.at, e.type, e.actor_email AS actor, e.company_id AS companyId, c.name AS companyName, e.line, e.reason
     FROM drilling_events e LEFT JOIN drilling_companies c ON c.id = e.company_id
     WHERE e.request_id = ? ORDER BY e.id`
  ).all(id);
}

// Полные данные заявки + что с ней может делать этот пользователь.
function getRequestView(id, email, isAdmin) {
  const row = getRequestRow(id);
  const inv = involvement(row, email, isAdmin);
  if (!inv.canSee) throw new DrillingError('Нет доступа к заявке', 403);
  const items = getItems(id);
  const acceptedCompany = row.accepted_company_id
    ? db().prepare('SELECT id, name, addressee FROM drilling_companies WHERE id = ?').get(row.accepted_company_id) : null;
  const author = personCard(row.initiator_email);
  return {
    id: row.id,
    status: row.status,
    round: row.round,
    initiator: { email: author.email, fullName: author.fullName, position: author.position },
    acceptedCompany,
    acceptedBy: row.accepted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
    attachments: listAttachments(id),
    attachmentLimits: { maxFiles: MAX_FILES_PER_REQUEST, maxMb: MAX_FILE_BYTES / 1024 / 1024 },
    events: getEvents(id).map((e) => ({ ...e, actorName: e.actor ? personCard(e.actor).fullName : null })),
    permissions: {
      accept: inv.waitingForMe,
      reject: inv.waitingForMe,
      cancel: inv.isInitiator && [...OPEN_STATUSES, 'returned'].includes(row.status),
      attach: inv.isInitiator && ATTACH_STATUSES.includes(row.status), // добавлять и удалять чертежи и фото
      edit: inv.isInitiator && row.status === 'returned',
      restart: inv.isInitiator && row.status === 'returned',
      markDone: inv.isInitiator && row.status === 'accepted',
      download: ['accepted', 'completed'].includes(row.status) && (isAdmin || inv.isInitiator || inv.isResponsible),
    },
  };
}

function summaries(rows, email) {
  return rows.map((r) => {
    const items = getItems(r.id);
    return {
      id: r.id, status: r.status, round: r.round, createdAt: r.created_at, updatedAt: r.updated_at,
      waitingForMe: involvement(r, email, false).waitingForMe, // можно согласовать/принять/отклонить прямо из списка
      initiator: personCard(r.initiator_email).fullName,
      itemsCount: items.length,
      attachmentsCount: db().prepare('SELECT COUNT(*) AS n FROM drilling_attachments WHERE request_id = ?').get(r.id).n,
      // коротко, что просят сделать — чтобы не открывать каждую заявку ради состава работ
      works: items.slice(0, 3).map((i) => (i.workType === 'drill'
        ? `Сверление Ø ${i.diameterMm} мм — ${i.quantity} шт, ${i.material}`
        : `Резка, толщина ${String(i.thicknessCm).replace('.', ',')} см — ${String(i.quantity).replace('.', ',')} м.п., ${i.material}`)),
      places: [...new Set(items.map((i) => `${i.object}, ${i.position}`))].slice(0, 3),
    };
  });
}

// Что пользователь может открыть списком: all — все (админ и главный инженер),
// inbox — ждёт его реакции или принята его компанией, mine — свои.
function listRequests(email, scope, isAdmin) {
  const e = normEmail(email);
  const all = db().prepare('SELECT * FROM drilling_requests ORDER BY id DESC').all();
  if (scope === 'all') {
    if (!isAdmin && ridesUser(e)?.role !== 'chief_engineer') throw new DrillingError('Только для администратора и главного инженера', 403);
    return summaries(all, e);
  }
  if (scope === 'inbox') {
    const myIds = new Set(companiesOfUser(e).map((c) => c.id));
    return summaries(all.filter((r) => involvement(r, e, false).waitingForMe || (r.accepted_company_id && myIds.has(r.accepted_company_id))), e);
  }
  return summaries(all.filter((r) => r.initiator_email === e), e);
}

// Красный счётчик: «ждёт вашей реакции» у главного инженера и исполнителей; у автора —
// возвращённые заявки и принятые, по которым ещё есть строки без отметки.
// items — сами заявки, требующие действия (для выпадающего списка у логина):
// kind respond — ждёт ответа, returned — вернули автору, mark — принята, ждёт отметки
// выполнения. Свежие сверху.
function counters(email) {
  const e = normEmail(email);
  const all = db().prepare("SELECT * FROM drilling_requests WHERE status IN ('engineer','line1','line2','returned','accepted') ORDER BY id DESC").all();
  const items = [];
  for (const r of all) {
    let kind = null;
    if (involvement(r, e, false).waitingForMe) kind = 'respond';
    else if (r.initiator_email === e && r.status === 'returned') kind = 'returned';
    else if (r.initiator_email === e && r.status === 'accepted') kind = 'mark';
    if (!kind) continue;
    const places = [...new Set(getItems(r.id).map((i) => `${i.object}, ${i.position}`))];
    items.push({ id: r.id, kind, status: r.status, places: places.slice(0, 2), createdAt: r.created_at });
  }
  const inbox = items.filter((i) => i.kind === 'respond').length;
  return { inbox, mine: items.length - inbox, total: items.length, items };
}

// Профиль для страниц: роль, чем занимается, может ли подавать заявки.
function profile(email, isAdmin) {
  const e = normEmail(email);
  const me = ridesUser(e);
  const block = submitBlock(e, isAdmin);
  return {
    email: e,
    role: me?.role || null,
    isAdmin: !!isAdmin,
    isChief: me?.role === 'chief_engineer',
    companies: companiesOfUser(e),
    canSubmit: !block,
    submitBlock: block ? block.message : null,
    counters: counters(e),
  };
}

// ---------- реестр: заявки построчно (по строкам работ) ----------

const almatyDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date(iso));
const round1 = (n) => Math.round(n * 10) / 10;

// Реестр для личного кабинета: по одной строке на строку работ. Видимость: админ и
// главный инженер — все заявки; исполнитель — только заявки, принятые его компанией (итоги
// не смешиваются с работами других исполнителей; ждущие его ответа — во «Входящих»);
// остальные — только поданные ими самими.
// filters: from, to (дата создания, «ГГГГ-ММ-ДД», по Алматы), status (массив), object,
// workType, company (название исполнителя), author (ФИО), onlyMine. facets — значения
// для списков фильтров среди ВСЕХ доступных пользователю заявок, до фильтрации.
function registry(email, isAdmin, filters = {}) {
  const e = normEmail(email);
  const me = ridesUser(e);
  let scope = 'own';
  const myCompanyIds = new Set(companiesOfUser(e).map((c) => c.id));
  if (isAdmin || me?.role === 'chief_engineer') scope = 'all';
  else if (myCompanyIds.size) scope = 'company';

  const requests = db().prepare('SELECT * FROM drilling_requests ORDER BY id DESC').all().filter((r) => {
    if (scope === 'all') return true;
    if (scope === 'company') return !!r.accepted_company_id && myCompanyIds.has(r.accepted_company_id);
    return r.initiator_email === e;
  });

  const companyName = new Map(db().prepare('SELECT id, name FROM drilling_companies').all().map((c) => [c.id, c.name]));
  const acceptedAt = new Map(
    db().prepare("SELECT request_id, round, MAX(at) AS at FROM drilling_events WHERE type = 'accepted' GROUP BY request_id, round").all()
      .map((x) => [`${x.request_id}:${x.round}`, x.at])
  );

  const all = [];
  for (const r of requests) {
    const base = {
      requestId: r.id, status: r.status, round: r.round, createdAt: r.created_at,
      authorEmail: r.initiator_email, author: personCard(r.initiator_email).fullName,
      company: r.accepted_company_id ? companyName.get(r.accepted_company_id) || '' : '',
      acceptedAt: r.accepted_company_id ? acceptedAt.get(`${r.id}:${r.round}`) || null : null,
    };
    for (const i of getItems(r.id)) {
      all.push({
        ...base, itemId: i.id, lineNo: i.lineNo, object: i.object, position: i.position, workType: i.workType, material: i.material,
        diameterMm: i.diameterMm, thicknessCm: i.thicknessCm, quantity: i.quantity, unit: i.workType === 'drill' ? 'шт' : 'м.п.',
        factQuantity: i.factQuantity, factComment: i.factComment, doneAt: i.doneAt, reason: i.reason,
      });
    }
  }

  const uniq = (key) => [...new Set(all.map((x) => x[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const facets = { objects: uniq('object'), companies: uniq('company'), authors: uniq('author') };

  const statuses = Array.isArray(filters.status) ? filters.status.filter(Boolean) : [];
  const rows = all.filter((x) => {
    const d = almatyDate(x.createdAt);
    if (filters.from && d < filters.from) return false;
    if (filters.to && d > filters.to) return false;
    if (statuses.length && !statuses.includes(x.status)) return false;
    if (filters.object && x.object !== filters.object) return false;
    if (filters.workType && x.workType !== filters.workType) return false;
    if (filters.company && x.company !== filters.company) return false;
    if (filters.author && x.author !== filters.author) return false;
    if (filters.onlyMine && x.authorEmail !== e) return false;
    return true;
  });

  const totals = {};
  for (const x of rows) {
    const t = (totals[x.unit] = totals[x.unit] || { plan: 0, fact: 0 });
    t.plan += x.quantity;
    t.fact += x.factQuantity || 0;
  }
  for (const t of Object.values(totals)) { t.plan = round1(t.plan); t.fact = round1(t.fact); }

  return { scope, rows, totals, facets, requestsCount: new Set(rows.map((x) => x.requestId)).size };
}

// ---------- данные заявки для карточек и подписей ----------

const STAMP_TYPES = { accepted: 'принята', rejected: 'отклонена', engineer_approved: 'согласована', engineer_rejected: 'отклонена' };

function getDocData(id) {
  const row = getRequestRow(id);
  const events = getEvents(id).filter((e) => e.round === row.round);
  const start = events.find((e) => e.type === 'created' || e.type === 'restarted');
  const stamps = events.filter((e) => STAMP_TYPES[e.type])
    .map((e) => ({ company: e.companyName || 'Главный инженер', type: e.type, label: STAMP_TYPES[e.type], at: e.at }));
  const company = row.accepted_company_id
    ? db().prepare('SELECT id, name, addressee FROM drilling_companies WHERE id = ?').get(row.accepted_company_id) : null;
  const acceptedEvent = events.find((e) => e.type === 'accepted');

  // «Согласовано» — главный инженер, согласовавший заявку в этом круге; для его
  // собственной заявки — он сам, иначе действующий главный инженер.
  const approvedBy = events.find((e) => e.type === 'engineer_approved')?.actor;
  const chief = chiefEngineer();
  const approverEmail = approvedBy || chief?.email || null;
  const approverCard = approverEmail ? personCard(approverEmail) : null;

  const author = personCard(row.initiator_email);
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    roundStartedAt: start?.at || row.created_at,
    acceptedAt: acceptedEvent?.at || null,
    company,
    initiator: { email: author.email, fullName: author.fullName, position: author.position },
    approver: { fullName: approverCard?.fullName || '', position: approverCard?.position || 'Главный инженер' },
    items: getItems(id),
    stamps,
  };
}

module.exports = {
  DrillingError, seedDefaults, listCompanies, saveCompany, isSubcontractor,
  companiesOfUser, createRequest, updateRequest, restartRequest, cancelRequest, respond, markItemDone, markItemsDone,
  getRequestView, listRequests, counters, profile, getDocData, registry,
  addAttachment, removeAttachment, getAttachmentFile,
};
