// Заявки на технологическое бурение и резку: создание, согласование в две
// линии, выполнение по строкам. Все изменения статуса — в транзакции (SQLite
// синхронный), поэтому «кто первый среагировал, тот и зафиксирован» гарантировано.
//
// Линия 1 — своя компания (несколько равнозначных ответственных): любой отказ
// передаёт заявку в линию 2; принял первый. Линия 2 — субподрядчики, все
// равнозначны: принял первый; вернуть инициатору можно, только когда отказали
// ВСЕ субподрядчики (отказ компании — это первая реакция любого её сотрудника).
// Отказ последней линии возвращает заявку инициатору; он может исправить и
// перезапустить (новый круг с линии 1). Все события пишутся в drilling_events.
const { getWriteDb } = require('../db');
const { validateItems, validateFact } = require('./validation');

class DrillingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const db = () => getWriteDb();

const APPROVER_KEY = 'drilling_approver';
const DEFAULT_APPROVER = { fullName: 'Титаренко В.С.', position: 'Главный инженер ТОО «VK development group»' };

// Первичное наполнение: две линии из согласованного сценария.
function seedDefaults() {
  const d = db();
  if (d.prepare('SELECT COUNT(*) AS n FROM drilling_companies').get().n > 0) return;
  const ins = d.prepare('INSERT INTO drilling_companies (name, addressee, line) VALUES (?, ?, ?)');
  ins.run('Пром Альянс', 'Директору ТОО "Пром Альянс"', 1);
  ins.run('Жеңіс групп', 'Директору ТОО "Жеңіс групп"', 2);
}

// ---------- справочники и настройки (админка) ----------

function getApprover() {
  const row = db().prepare('SELECT value FROM app_settings WHERE key = ?').get(APPROVER_KEY);
  try {
    return { ...DEFAULT_APPROVER, ...(row ? JSON.parse(row.value) : {}) };
  } catch {
    return { ...DEFAULT_APPROVER };
  }
}

function setApprover({ fullName, position }, by) {
  const fn = String(fullName || '').trim();
  const pos = String(position || '').trim();
  if (!fn || !pos) throw new DrillingError('Укажите ФИО и должность');
  db().prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(APPROVER_KEY, JSON.stringify({ fullName: fn, position: pos }), by || null);
  return getApprover();
}

function listCompanies() {
  const d = db();
  const users = d.prepare('SELECT company_id, email FROM drilling_company_users ORDER BY email').all();
  return d.prepare('SELECT id, name, addressee, line, active FROM drilling_companies ORDER BY line, id').all().map((c) => ({
    ...c,
    active: !!c.active,
    users: users.filter((u) => u.company_id === c.id).map((u) => u.email),
  }));
}

function saveCompany({ id, name, addressee, line, active = true }) {
  const n = String(name || '').trim();
  const a = String(addressee || '').trim();
  if (!n || !a) throw new DrillingError('Укажите название и адресата (строка «Директору …»)');
  if (![1, 2].includes(Number(line))) throw new DrillingError('Линия — 1 или 2');
  const d = db();
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

function addCompanyUser(companyId, email) {
  const e = normEmail(email);
  if (!/^\S+@\S+\.\S+$/.test(e)) throw new DrillingError('Некорректный email');
  if (!db().prepare('SELECT 1 FROM drilling_companies WHERE id = ?').get(companyId)) throw new DrillingError('Компания не найдена', 404);
  db().prepare('INSERT OR IGNORE INTO drilling_company_users (company_id, email) VALUES (?, ?)').run(companyId, e);
}

function removeCompanyUser(companyId, email) {
  db().prepare('DELETE FROM drilling_company_users WHERE company_id = ? AND email = ?').run(companyId, normEmail(email));
}

function listStaff() {
  return db().prepare('SELECT email, full_name AS fullName, position, organization FROM drilling_staff ORDER BY full_name').all();
}

function saveStaff({ email, fullName, position, organization }) {
  const e = normEmail(email);
  const fn = String(fullName || '').trim();
  const pos = String(position || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(e)) throw new DrillingError('Некорректный email');
  if (!fn || !pos) throw new DrillingError('Укажите ФИО и должность');
  db().prepare(
    `INSERT INTO drilling_staff (email, full_name, position, organization) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET full_name = excluded.full_name, position = excluded.position, organization = excluded.organization`
  ).run(e, fn, pos, String(organization || '').trim());
}

function deleteStaff(email) {
  db().prepare('DELETE FROM drilling_staff WHERE email = ?').run(normEmail(email));
}

// ---------- вспомогательное ----------

function companiesOfUser(email) {
  return db().prepare(
    `SELECT c.id, c.name, c.addressee, c.line FROM drilling_companies c
     JOIN drilling_company_users u ON u.company_id = c.id
     WHERE u.email = ? AND c.active = 1 ORDER BY c.line, c.id`
  ).all(normEmail(email));
}

// Компании линии, у которых есть хотя бы один ответственный (иначе реагировать некому).
function staffedCompanies(line) {
  return db().prepare(
    `SELECT c.id, c.name FROM drilling_companies c
     WHERE c.line = ? AND c.active = 1 AND EXISTS (SELECT 1 FROM drilling_company_users u WHERE u.company_id = c.id)
     ORDER BY c.id`
  ).all(line);
}

function logEvent(requestId, round, type, { actor = null, companyId = null, line = null, reason = null } = {}) {
  db().prepare('INSERT INTO drilling_events (request_id, round, at, type, actor_email, company_id, line, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(requestId, round, now(), type, actor, companyId, line, reason);
}

function getRequestRow(id) {
  const row = db().prepare('SELECT * FROM drilling_requests WHERE id = ?').get(id);
  if (!row) throw new DrillingError('Заявка не найдена', 404);
  return row;
}

function firstLineStatus() {
  if (staffedCompanies(1).length) return { status: 'line1', line: 1 };
  if (staffedCompanies(2).length) return { status: 'line2', line: 2 };
  throw new DrillingError('Ответственные не назначены — обратитесь к администратору', 409);
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

function createRequest(email, rawItems) {
  const v = validateItems(rawItems);
  if (!v.ok) throw new DrillingError(v.error);
  return tx(() => {
    const first = firstLineStatus();
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
    const first = firstLineStatus();
    const round = row.round + 1;
    db().prepare('UPDATE drilling_requests SET status = ?, round = ?, updated_at = ? WHERE id = ?').run(first.status, round, now(), id);
    logEvent(id, round, 'restarted', { actor: normEmail(email), line: first.line });
  });
}

function cancelRequest(id, email) {
  return tx(() => {
    const row = getRequestRow(id);
    requireInitiator(row, email);
    if (!['line1', 'line2', 'returned'].includes(row.status)) throw new DrillingError('Заявку уже нельзя отменить', 409);
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

function respond(id, email, action, reason) {
  if (!['accept', 'reject'].includes(action)) throw new DrillingError('Неизвестное действие');
  const why = String(reason || '').trim();
  if (action === 'reject' && !why) throw new DrillingError('Укажите причину отказа');
  if (why.length > 500) throw new DrillingError('Причина длиннее 500 символов');
  return tx(() => {
    const row = getRequestRow(id);
    if (!['line1', 'line2'].includes(row.status)) throw new DrillingError('Заявка уже обработана', 409);
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

function markItemDone(id, itemId, email, rawFact) {
  return tx(() => {
    const row = getRequestRow(id);
    requireInitiator(row, email);
    if (row.status !== 'accepted') throw new DrillingError('Отметить выполнение можно после принятия заявки', 409);
    const item = db().prepare('SELECT * FROM drilling_request_items WHERE id = ? AND request_id = ?').get(itemId, id);
    if (!item) throw new DrillingError('Строка не найдена', 404);
    if (item.done_at) throw new DrillingError('Строка уже отмечена', 409);
    const v = validateFact(rawFact, item);
    if (!v.ok) throw new DrillingError(v.error);
    db().prepare('UPDATE drilling_request_items SET fact_quantity = ?, done_at = ? WHERE id = ?').run(v.value, now(), itemId);
    const left = db().prepare('SELECT COUNT(*) AS n FROM drilling_request_items WHERE request_id = ? AND done_at IS NULL').get(id).n;
    if (left === 0) {
      db().prepare("UPDATE drilling_requests SET status = 'completed', updated_at = ? WHERE id = ?").run(now(), id);
      logEvent(id, row.round, 'completed', { actor: normEmail(email) });
    } else {
      db().prepare('UPDATE drilling_requests SET updated_at = ? WHERE id = ?').run(now(), id);
    }
  });
}

// ---------- чтение ----------

// Видит ли пользователь заявку: автор, ответственный (сейчас или участвовал), админ.
function involvement(row, email, isAdmin) {
  const e = normEmail(email);
  const mine = companiesOfUser(e);
  const myIds = new Set(mine.map((c) => c.id));
  const isInitiator = row.initiator_email === e;
  const waitingForMe = ['line1', 'line2'].includes(row.status) && !!responderCompany(row, e)
    && !(row.status === 'line2' && rejectedCompanyIds(row.id, row.round, 2).has(responderCompany(row, e).id));
  const wasInvolved = (row.accepted_company_id && myIds.has(row.accepted_company_id))
    || db().prepare('SELECT company_id FROM drilling_events WHERE request_id = ? AND company_id IS NOT NULL').all(row.id).some((r) => myIds.has(r.company_id));
  const visibleToLine = ['line1', 'line2'].includes(row.status) && !!responderCompany(row, e);
  return { isInitiator, waitingForMe, canSee: isAdmin || isInitiator || waitingForMe || wasInvolved || visibleToLine, isResponsible: mine.length > 0 };
}

function getItems(id) {
  return db().prepare('SELECT * FROM drilling_request_items WHERE request_id = ? ORDER BY line_no').all(id).map((i) => ({
    id: i.id, lineNo: i.line_no, object: i.object, position: i.obj_position, workType: i.work_type, material: i.material,
    diameterMm: i.diameter_mm, thicknessCm: i.thickness_cm, quantity: i.quantity, reason: i.reason,
    factQuantity: i.fact_quantity, doneAt: i.done_at,
  }));
}

function getEvents(id) {
  return db().prepare(
    `SELECT e.id, e.round, e.at, e.type, e.actor_email AS actor, e.company_id AS companyId, c.name AS companyName, e.line, e.reason
     FROM drilling_events e LEFT JOIN drilling_companies c ON c.id = e.company_id
     WHERE e.request_id = ? ORDER BY e.id`
  ).all(id);
}

function getStaff(email) {
  return db().prepare('SELECT email, full_name AS fullName, position, organization FROM drilling_staff WHERE email = ?').get(normEmail(email)) || null;
}

// Полные данные заявки + что с ней может делать этот пользователь.
function getRequestView(id, email, isAdmin) {
  const row = getRequestRow(id);
  const inv = involvement(row, email, isAdmin);
  if (!inv.canSee) throw new DrillingError('Нет доступа к заявке', 403);
  const items = getItems(id);
  const acceptedCompany = row.accepted_company_id
    ? db().prepare('SELECT id, name, addressee FROM drilling_companies WHERE id = ?').get(row.accepted_company_id) : null;
  const staff = getStaff(row.initiator_email);
  return {
    id: row.id,
    status: row.status,
    round: row.round,
    initiator: { email: row.initiator_email, fullName: staff?.fullName || row.initiator_email, position: staff?.position || '' },
    acceptedCompany,
    acceptedBy: row.accepted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
    events: getEvents(id),
    permissions: {
      accept: inv.waitingForMe,
      reject: inv.waitingForMe,
      cancel: inv.isInitiator && ['line1', 'line2', 'returned'].includes(row.status),
      edit: inv.isInitiator && row.status === 'returned',
      restart: inv.isInitiator && row.status === 'returned',
      markDone: inv.isInitiator && row.status === 'accepted',
      download: ['accepted', 'completed'].includes(row.status) && (isAdmin || inv.isInitiator || inv.isResponsible),
    },
  };
}

function summaries(rows) {
  return rows.map((r) => {
    const items = getItems(r.id);
    const staff = getStaff(r.initiator_email);
    return {
      id: r.id, status: r.status, round: r.round, createdAt: r.created_at, updatedAt: r.updated_at,
      initiator: staff?.fullName || r.initiator_email,
      itemsCount: items.length,
      places: [...new Set(items.map((i) => `${i.object}, ${i.position}`))].slice(0, 3),
    };
  });
}

// scope: mine — свои; inbox — ждёт моей реакции или принята моей компанией; all — все (админ).
function listRequests(email, scope, isAdmin) {
  const e = normEmail(email);
  const all = db().prepare('SELECT * FROM drilling_requests ORDER BY id DESC').all();
  if (scope === 'all') {
    if (!isAdmin) throw new DrillingError('Только для администратора', 403);
    return summaries(all);
  }
  if (scope === 'inbox') {
    const myIds = new Set(companiesOfUser(e).map((c) => c.id));
    return summaries(all.filter((r) => involvement(r, e, false).waitingForMe || (r.accepted_company_id && myIds.has(r.accepted_company_id))));
  }
  return summaries(all.filter((r) => r.initiator_email === e));
}

// Красный счётчик: «ждёт вашей реакции» у ответственных; у инициатора —
// возвращённые заявки и принятые, по которым ещё есть строки без отметки.
// items — сами заявки, требующие действия (для выпадающего списка у логина):
// kind respond — ждёт ответа исполнителя, returned — отказали все, mark — принята,
// ждёт отметки выполнения. Свежие сверху.
function counters(email) {
  const e = normEmail(email);
  const all = db().prepare("SELECT * FROM drilling_requests WHERE status IN ('line1','line2','returned','accepted') ORDER BY id DESC").all();
  const items = [];
  for (const r of all) {
    let kind = null;
    if (involvement(r, e, false).waitingForMe) kind = 'respond';
    else if (r.initiator_email === e && r.status === 'returned') kind = 'returned';
    else if (r.initiator_email === e && r.status === 'accepted') kind = 'mark';
    if (!kind) continue;
    const places = [...new Set(getItems(r.id).map((i) => `${i.object}, ${i.position}`))];
    items.push({ id: r.id, kind, places: places.slice(0, 2), createdAt: r.created_at });
  }
  const inbox = items.filter((i) => i.kind === 'respond').length;
  return { inbox, mine: items.length - inbox, total: items.length, items };
}

// ---------- реестр: все заявки построчно (по строкам работ) ----------

const almatyDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date(iso));
const round1 = (n) => Math.round(n * 10) / 10;

// Реестр для личного кабинета: по одной строке на строку работ. Админ видит все
// заявки, остальные — только поданные ими самими (рабочая очередь ответственных —
// «Входящие» в listRequests, не реестр). filters: from, to (дата создания, «ГГГГ-ММ-ДД»,
// по Алматы), status (массив), object, workType, company (название исполнителя),
// author (email), onlyMine. facets — значения для выпадающих списков фильтров
// среди ВСЕХ доступных пользователю заявок, до фильтрации.
function registry(email, isAdmin, filters = {}) {
  const e = normEmail(email);
  const requests = db().prepare('SELECT * FROM drilling_requests ORDER BY id DESC').all()
    .filter((r) => isAdmin || r.initiator_email === e);

  const companyName = new Map(db().prepare('SELECT id, name FROM drilling_companies').all().map((c) => [c.id, c.name]));
  const acceptedAt = new Map(
    db().prepare("SELECT request_id, round, MAX(at) AS at FROM drilling_events WHERE type = 'accepted' GROUP BY request_id, round").all()
      .map((x) => [`${x.request_id}:${x.round}`, x.at])
  );
  const staffName = new Map(db().prepare('SELECT email, full_name FROM drilling_staff').all().map((s) => [s.email, s.full_name]));

  const all = [];
  for (const r of requests) {
    const base = {
      requestId: r.id, status: r.status, round: r.round, createdAt: r.created_at,
      authorEmail: r.initiator_email, author: staffName.get(r.initiator_email) || r.initiator_email,
      company: r.accepted_company_id ? companyName.get(r.accepted_company_id) || '' : '',
      acceptedAt: r.accepted_company_id ? acceptedAt.get(`${r.id}:${r.round}`) || null : null,
    };
    for (const i of getItems(r.id)) {
      all.push({
        ...base, itemId: i.id, lineNo: i.lineNo, object: i.object, position: i.position, workType: i.workType, material: i.material,
        diameterMm: i.diameterMm, thicknessCm: i.thicknessCm, quantity: i.quantity, unit: i.workType === 'drill' ? 'шт' : 'м.п.',
        factQuantity: i.factQuantity, doneAt: i.doneAt, reason: i.reason,
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

  return { scope: isAdmin ? 'all' : 'own', rows, totals, facets, requestsCount: new Set(rows.map((x) => x.requestId)).size };
}

// Данные для документа Word.
function getDocData(id) {
  const row = getRequestRow(id);
  const events = getEvents(id).filter((e) => e.round === row.round);
  const start = events.find((e) => e.type === 'created' || e.type === 'restarted');
  const stamps = events.filter((e) => ['rejected', 'accepted'].includes(e.type))
    .map((e) => ({ company: e.companyName, type: e.type, at: e.at }));
  const company = row.accepted_company_id
    ? db().prepare('SELECT id, name, addressee FROM drilling_companies WHERE id = ?').get(row.accepted_company_id) : null;
  const acceptedEvent = events.find((e) => e.type === 'accepted');
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    roundStartedAt: start?.at || row.created_at,
    acceptedAt: acceptedEvent?.at || null,
    company,
    initiator: getStaff(row.initiator_email) || { email: row.initiator_email, fullName: row.initiator_email, position: '', organization: '' },
    approver: getApprover(),
    items: getItems(id),
    stamps,
  };
}

module.exports = {
  DrillingError, seedDefaults, getApprover, setApprover,
  listCompanies, saveCompany, addCompanyUser, removeCompanyUser, listStaff, saveStaff, deleteStaff,
  companiesOfUser, createRequest, updateRequest, restartRequest, cancelRequest, respond, markItemDone,
  getRequestView, listRequests, counters, getDocData, registry,
};
