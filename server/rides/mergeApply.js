// Совместные поездки: попутная заявка B (из пула) вливается в поездку A
// (назначенную или уже в пути) — точки B встают в маршрут A на ближайший
// участок, B получает того же водителя и merged_into = A.
//
// Объединение мгновенное, без согласований: его делает водитель A
// («Подвезти попутно» — на сайте или в Telegram) или диспетчер («Добавить
// попутно»). Ограничение одно — по времени (driverAvailability.fitsMergeWindow):
// подача B не раньше чем за 15 мин до подачи A и не позже окончания A.
//
// Тут же каскады: расформирование при отмене/снятии машины с A, общее
// завершение, снятие отменённой B с маршрута A.
const { getWriteDb } = require('./db');
const {
  recomputeRequestEstimate, estimateFromPoints, chooseInsertIndex, geocodeAddress,
} = require('./routeEstimate');
const { logEvent } = require('./events');
const { emitToDrivers, emitToDispatcher, emitToEmployee, emitToDriver } = require('./socket');
const {
  getRow, serializeForDriver, serializeForEmployee, serializeForDispatcher, staleThreshold,
} = require('./requestView');
const { requestedAtMs } = require('./slots');
const { fitsMergeWindow, MERGE_LEAD_MINUTES } = require('./driverAvailability');

const MINUTE = 60000;

function renumberStops(db, requestId) {
  const rows = db.prepare('SELECT id FROM request_stops WHERE request_id = ? ORDER BY stop_order ASC').all(requestId);
  rows.forEach((s, i) => db.prepare('UPDATE request_stops SET stop_order = ? WHERE id = ?').run(i, s.id));
}

const getRequest = (db, id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);

// Поездка, к которой можно добавлять попутчиков: в работе у водителя и сама
// не попутная.
const isCarrier = (row) => !!row && ['assigned', 'in_progress'].includes(row.status) && !!row.driver_id && !row.merged_into;
// Заявка, которую можно добавить попутно: свободна в пуле.
const isInPool = (row) => !!row && row.status === 'pending_assignment' && !row.on_hold && !row.merged_into;

// Тексты согласованы с заказчиком: «основная заявка» — на которую уже
// назначен водитель, «эта заявка» — которую добавляем попутно.
const TIME_MISMATCH_TEXT =
  `Нельзя добавить попутно: не совпадает время. Время подачи этой заявки должно быть не раньше чем за ${MERGE_LEAD_MINUTES} минут до подачи основной заявки и до того, как водитель её выполнит.`;

function mergeError(A, B, now = Date.now()) {
  if (A && B && A.id === B.id) return 'Нельзя объединить заявку саму с собой';
  if (!isInPool(B)) return 'Эта заявка уже не в пуле — её взяли или отменили';
  if (!isCarrier(A)) return 'Поездка, к которой добавляем, уже не в работе';
  if (!fitsMergeWindow(A, B, now)) return TIME_MISMATCH_TEXT;
  return null;
}

// Поездки, к которым можно добавить заявку B (driverId — только поездки
// этого водителя), ближайшие по времени подачи к B — первыми.
function mergeCandidates(db, B, { driverId = null, now = Date.now() } = {}) {
  if (!isInPool(B)) return [];
  const rows = db
    .prepare(
      `SELECT r.* FROM requests r JOIN drivers d ON d.id = r.driver_id
        WHERE r.status IN ('assigned', 'in_progress') AND r.merged_into IS NULL AND d.active = 1
          ${driverId ? 'AND r.driver_id = ?' : ''}`
    )
    .all(...(driverId ? [driverId] : []));
  const pickupB = requestedAtMs(B.requested_at);
  return rows
    .filter((A) => A.id !== B.id && fitsMergeWindow(A, B, now))
    .sort((a, b) => Math.abs(requestedAtMs(a.requested_at) - pickupB) - Math.abs(requestedAtMs(b.requested_at) - pickupB));
}

const coordsOf = async (address, lat, lng) =>
  (lat != null && lng != null ? { lat, lng } : geocodeAddress(address).catch(() => null));

// Куда встанут точки B в маршруте A: stop_order первой точки блока B
// (0 — сразу после A.to). Точки B идут подряд: посадка, высадка, доп. пункты.
async function planMerge(db, A, B) {
  const bStops = db
    .prepare('SELECT address, lat, lng FROM request_stops WHERE request_id = ? ORDER BY stop_order ASC')
    .all(B.id);
  const bPoints = [
    { address: B.from_address, lat: B.from_lat, lng: B.from_lng },
    { address: B.to_address, lat: B.to_lat, lng: B.to_lng },
    ...bStops,
  ];
  const aStops = db
    .prepare('SELECT address, lat, lng FROM request_stops WHERE request_id = ? ORDER BY stop_order ASC')
    .all(A.id);
  const bFrom = await coordsOf(B.from_address, B.from_lat, B.from_lng);
  const chain = [
    A.to_lat != null ? { lat: A.to_lat, lng: A.to_lng } : null,
    ...aStops.map((s) => (s.lat != null ? { lat: s.lat, lng: s.lng } : null)),
  ];
  return { bPoints, aStops, insertAt: chooseInsertIndex(chain, bFrom) };
}

// От какого момента считать время поездки A: начатая — от «сейчас», иначе —
// от времени подачи (если оно ещё впереди).
function tripStartMs(A, now = Date.now()) {
  if (A.status === 'in_progress') return now;
  const start = requestedAtMs(A.requested_at);
  return Number.isNaN(start) ? now : Math.max(start, now);
}

// Прогноз для диспетчера без записи в базу: насколько удлинится поездка A и
// примерное время посадки пассажира B. Поля — null, если маршрут не
// построился (адрес не нашёлся на карте).
async function previewMerge(db, A, B, now = Date.now()) {
  const plan = await planMerge(db, A, B);
  const aStopCoords = [];
  for (const s of plan.aStops) aStopCoords.push(await coordsOf(s.address, s.lat, s.lng));
  const bCoords = [];
  for (const p of plan.bPoints) bCoords.push(await coordsOf(p.address, p.lat, p.lng));
  const aFrom = await coordsOf(A.from_address, A.from_lat, A.from_lng);
  const aTo = await coordsOf(A.to_address, A.to_lat, A.to_lng);
  const coords = [aFrom, aTo, ...aStopCoords.slice(0, plan.insertAt), ...bCoords, ...aStopCoords.slice(plan.insertAt)];
  const est = await estimateFromPoints(coords, !!A.with_return);
  if (!est) return { durationMin: null, deltaMin: null, pickupEtaAt: null };
  // «Было» считаем тем же способом, а не берём сохранённое duration_min:
  // оно могло устареть, и разница вышла бы с минусом.
  const before = await estimateFromPoints([aFrom, aTo, ...aStopCoords], !!A.with_return);
  const pickup = est.perPoint.find((p) => p.index === plan.insertAt + 2);
  return {
    durationMin: est.durationMin,
    deltaMin: before ? est.durationMin - before.durationMin : null,
    pickupEtaAt: pickup ? new Date(tripStartMs(A, now) + pickup.etaMinutes * MINUTE).toISOString() : null,
  };
}

// Объединить сразу. initiator — 'driver' | 'dispatcher' (в журнал и в
// assigned_by заявки B). Возвращает { request: A, merged: B, mergeId,
// pickupEtaAt, deltaMin } либо { error, status }.
async function mergeRequests({ bId, aId, actorUserId, initiator }) {
  const db = getWriteDb();
  const first = mergeError(getRequest(db, aId), getRequest(db, bId));
  if (first) return { error: first, status: 409 };

  // Геокодирование — до транзакции (сеть); состояние заявок после него
  // проверяется заново: за это время B могли взять, а A — завершить.
  const A0 = getRequest(db, aId);
  const plan = await planMerge(db, A0, getRequest(db, bId));

  const committed = db.transaction(() => {
    const A = getRequest(db, aId);
    const B = getRequest(db, bId);
    const err = mergeError(A, B);
    if (err) return { error: err };
    const stopCount = db.prepare('SELECT COUNT(*) AS n FROM request_stops WHERE request_id = ?').get(A.id).n;
    const insertAt = Math.min(plan.insertAt, stopCount);

    db.prepare('UPDATE request_stops SET stop_order = stop_order + ? WHERE request_id = ? AND stop_order >= ?')
      .run(plan.bPoints.length, A.id, insertAt);
    const ins = db.prepare(
      'INSERT INTO request_stops (request_id, address, stop_order, lat, lng, merged_from_request_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    plan.bPoints.forEach((p, i) => ins.run(A.id, p.address, insertAt + i, p.lat ?? null, p.lng ?? null, B.id));

    db.prepare(
      `UPDATE requests SET status = 'assigned', driver_id = ?, assigned_by = ?, on_hold = 0,
         merge_lock = 0, merged_into = ?, claimed_at = datetime('now') WHERE id = ?`
    ).run(A.driver_id, initiator === 'driver' ? 'self' : 'dispatcher', A.id, B.id);
    db.prepare(`INSERT INTO request_status_history (request_id, status, changed_by) VALUES (?, 'assigned', ?)`)
      .run(B.id, actorUserId);
    const info = db
      .prepare(
        `INSERT INTO request_merges (request_a_id, request_b_id, driver_id, status, decided_by, decided_at, initiated_by, initiator_role)
         VALUES (?, ?, ?, 'approved', ?, datetime('now'), ?, ?)`
      )
      .run(A.id, B.id, A.driver_id, actorUserId, actorUserId, initiator);
    return { mergeId: Number(info.lastInsertRowid), insertAt, durationBefore: A.duration_min };
  })();
  if (committed.error) return { error: committed.error, status: 409 };

  const est = await recomputeRequestEstimate(aId, { actorUserId }).catch(() => null);
  const pickup = est?.perPoint?.find((p) => p.index === committed.insertAt + 2);
  const pickupEtaAt = pickup ? new Date(tripStartMs(getRequest(db, aId)) + pickup.etaMinutes * MINUTE).toISOString() : null;
  const deltaMin = est && committed.durationBefore != null ? est.durationMin - committed.durationBefore : null;

  // Журнал — после пересчёта: уведомления (telegram/notifier.js) берут из
  // заявки уже посчитанное время посадки.
  db.transaction(() => {
    db.prepare('UPDATE requests SET pickup_eta_at = ? WHERE id = ?').run(pickupEtaAt, bId);
    db.prepare('UPDATE request_merges SET pickup_eta_at = ? WHERE id = ?').run(pickupEtaAt, committed.mergeId);
    const common = { mergeId: committed.mergeId, initiator, pickupEtaAt, deltaMin };
    logEvent(db, { requestId: aId, type: 'requests_merged', actorUserId, payload: { ...common, mergedRequestId: bId } });
    logEvent(db, { requestId: bId, type: 'requests_merged', actorUserId, payload: { ...common, mergedIntoRequestId: aId } });
  })();

  const aRow = getRow(db, aId);
  const bRow = getRow(db, bId);
  emitToDrivers('request:removed', { id: bId });
  emitToDispatcher('request:updated', serializeForDispatcher(aRow, staleThreshold()));
  emitToDispatcher('request:updated', serializeForDispatcher(bRow, staleThreshold()));
  emitToEmployee(aRow.employee_id, 'request:status', serializeForEmployee(aRow));
  emitToEmployee(aRow.employee_id, 'merge:applied', { requestId: aId, mergedRequestId: bId });
  emitToEmployee(bRow.employee_id, 'request:merged', serializeForEmployee(bRow));
  // updateReason: 'merge' — Telegram пришлёт водителю своё сообщение о
  // попутчике по журналу, общее «маршрут изменён» не нужно.
  emitToDriver(aRow.driver_id, 'request:updated', { ...serializeForDriver(aRow), updateReason: 'merge' });
  emitToDriver(aRow.driver_id, 'merge:applied', { requestId: aId, mergedRequestId: bId, initiator });
  return { request: aRow, merged: bRow, mergeId: committed.mergeId, pickupEtaAt, deltaMin };
}

// Водитель добавляет попутно к СВОЕЙ поездке (сайт и Telegram).
async function driverMerge({ userId, bId, aId }) {
  const db = getWriteDb();
  const driver = db.prepare('SELECT * FROM drivers WHERE user_id = ? AND active = 1').get(userId);
  if (!driver) return { error: 'Вы не зарегистрированы как водитель', status: 403 };
  const A = getRequest(db, aId);
  if (!A || A.driver_id !== driver.id) return { error: 'Попутно можно добавить только к своей поездке', status: 409 };
  return mergeRequests({ bId, aId, actorUserId: userId, initiator: 'driver' });
}

// Расформировать все объединения, где A — «несущая» заявка: точки B
// вынимаются из маршрута A, каждая B возвращается в общий пул. Вызывать,
// когда A отменяют / водитель отказывается / машину перебрасывают.
// Синхронно (внутри своей транзакции); эмиты и пересчёт A — на вызывающей
// стороне через возвращённый список id заявок B.
function dissolveMergesForA(db, aId, reason, actorUserId) {
  const merged = db.prepare("SELECT id FROM requests WHERE merged_into = ?").all(aId).map((r) => r.id);
  if (!merged.length) return [];
  db.transaction(() => {
    for (const bId of merged) {
      db.prepare('DELETE FROM request_stops WHERE request_id = ? AND merged_from_request_id = ?').run(aId, bId);
      renumberStops(db, aId);
      db.prepare(
        `UPDATE requests SET status = 'pending_assignment', driver_id = NULL, assigned_by = NULL,
           claimed_at = NULL, merged_into = NULL, merge_lock = 0, pickup_eta_at = NULL WHERE id = ?`
      ).run(bId);
      db.prepare(`INSERT INTO request_status_history (request_id, status, changed_by) VALUES (?, 'pending_assignment', ?)`)
        .run(bId, actorUserId);
      const mr = db.prepare("SELECT id FROM request_merges WHERE request_b_id = ? AND status = 'approved'").get(bId);
      if (mr) {
        db.prepare("UPDATE request_merges SET status = 'rejected', decision_reason = ?, decided_at = datetime('now') WHERE id = ?")
          .run(reason, mr.id);
      }
      logEvent(db, { requestId: bId, type: 'merge_dissolved', actorUserId, payload: { fromRequestId: aId, reason } });
    }
  })();
  return merged;
}

// Попутную заявку B отменили (заказчик или диспетчер) — её точки больше не
// нужны в маршруте A. Без этого водитель заехал бы за отменившим пассажиром,
// а при завершении A отменённая B «завершилась» бы вместе с ней. Вызывать
// после фиксации отмены; пересчитывает маршрут A и сообщает водителю.
async function detachCancelledB(db, bId, actorUserId) {
  const B = getRequest(db, bId);
  if (!B || B.status !== 'cancelled' || !B.merged_into) return null;
  const aId = B.merged_into;
  db.transaction(() => {
    db.prepare('DELETE FROM request_stops WHERE request_id = ? AND merged_from_request_id = ?').run(aId, bId);
    renumberStops(db, aId);
    db.prepare('UPDATE requests SET merged_into = NULL, pickup_eta_at = NULL WHERE id = ?').run(bId);
    db.prepare("UPDATE request_merges SET status = 'rejected', decision_reason = ?, decided_at = datetime('now') WHERE request_b_id = ? AND status = 'approved'")
      .run('Попутную заявку отменили', bId);
    logEvent(db, { requestId: aId, type: 'merged_request_cancelled', actorUserId, payload: { cancelledRequestId: bId } });
  })();
  await recomputeRequestEstimate(aId, { actorUserId }).catch(() => null);
  const aRow = getRow(db, aId);
  if (aRow) {
    emitToDispatcher('request:updated', serializeForDispatcher(aRow, staleThreshold()));
    emitToEmployee(aRow.employee_id, 'request:status', serializeForEmployee(aRow));
    if (aRow.driver_id) emitToDriver(aRow.driver_id, 'request:updated', serializeForDriver(aRow));
  }
  return aId;
}

// Заявка A завершена — попутные B завершаются вместе с ней (одна поездка
// обслужила обе, время не делим). Вызывать ВНУТРИ транзакции /status.
function cascadeCompleteMergedB(db, aId, actorUserId) {
  const bs = db
    .prepare("SELECT id FROM requests WHERE merged_into = ? AND status IN ('assigned', 'in_progress')")
    .all(aId)
    .map((r) => r.id);
  for (const bId of bs) {
    db.prepare("UPDATE requests SET status = 'completed' WHERE id = ?").run(bId);
    db.prepare(`INSERT INTO request_status_history (request_id, status, changed_by) VALUES (?, 'completed', ?)`)
      .run(bId, actorUserId);
    logEvent(db, { requestId: bId, type: 'status_changed', actorUserId, payload: { to: 'completed', viaMergeWith: aId } });
  }
  return bs;
}

// Эмиты для заявок B, вернувшихся в пул после расформирования.
function emitDissolvedB(db, restoredIds) {
  for (const bId of restoredIds) {
    const bRow = getRow(db, bId);
    if (!bRow) continue;
    emitToDrivers('request:new', serializeForDriver(bRow));
    emitToDispatcher('request:updated', serializeForDispatcher(bRow, staleThreshold()));
    emitToEmployee(bRow.employee_id, 'request:unmerged', serializeForEmployee(bRow));
  }
}

module.exports = {
  TIME_MISMATCH_TEXT,
  MERGE_LEAD_MINUTES,
  isCarrier,
  isInPool,
  mergeError,
  mergeCandidates,
  previewMerge,
  mergeRequests,
  driverMerge,
  dissolveMergesForA,
  detachCancelledB,
  cascadeCompleteMergedB,
  emitDissolvedB,
  renumberStops,
};
