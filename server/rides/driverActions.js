// Действия водителя над заявками — один код для сайта (requestsRouter.js,
// driversRouter.js) и Telegram-бота (telegram/bot.js). Иначе правила
// (кто первым взял, тот и получил; занятость по времени; что считается
// «можно отказаться») пришлось бы держать в двух местах, и рано или поздно
// один заказ взяли бы двое.
//
// Каждая функция: проверяет право, меняет базу в транзакции, пишет историю
// и журнал, рассылает события (Socket.io + внутренняя шина, см. socket.js)
// и возвращает { request } (сырой ряд getRow) либо { error, status } —
// HTTP-код для сайта, текст — и для сайта, и для всплывающего ответа в боте.
const { getWriteDb } = require('./db');
const { emitToDrivers, emitToDispatcher, emitToEmployee, emitToDriver } = require('./socket');
const { recomputeRequestEstimate } = require('./routeEstimate');
const { logEvent } = require('./events');
const { dissolveMergesForA, cascadeCompleteMergedB, emitDissolvedB } = require('./mergeApply');
const { staleThreshold, getRow, serializeForDriver, serializeForEmployee, serializeForDispatcher } = require('./requestView');
const { findDriverConflict, syncDriverStatus, describeRequest } = require('./driverAvailability');

function driverByUserId(db, userId) {
  return db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(userId);
}

const notDriver = { error: 'Вы не зарегистрированы как водитель', status: 403 };

// Взять заказ из пула — атомарно: побеждает тот, чей UPDATE первым затронул
// строку. Занятость — по пересечению времени с другими заказами водителя.
function claimRequest({ userId, requestId }) {
  const db = getWriteDb();
  const driver = driverByUserId(db, userId);
  if (!driver) return notDriver;
  if (!driver.active) return { error: 'Ваша карточка водителя отключена', status: 403 };
  if (driver.status === 'offline') return { error: 'Выйдите на линию, чтобы брать заказы', status: 409 };

  const outcome = db.transaction(() => {
    const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    if (!row || row.status !== 'pending_assignment' || row.on_hold || row.merge_lock) return { taken: true };
    const conflict = findDriverConflict(db, driver.id, row);
    if (conflict) return { conflict };
    const upd = db
      .prepare(`UPDATE requests SET status = 'assigned', driver_id = ?, assigned_by = 'self', claimed_at = datetime('now') WHERE id = ? AND status = 'pending_assignment'`)
      .run(driver.id, requestId);
    if (upd.changes === 0) return { taken: true };
    syncDriverStatus(db, driver.id);
    db.prepare(`INSERT INTO request_status_history (request_id, status, changed_by) VALUES (?, 'assigned', ?)`)
      .run(requestId, userId);
    logEvent(db, { requestId, type: 'driver_claimed', actorUserId: userId, payload: { driverId: driver.id } });
    return { result: getRow(db, requestId) };
  })();

  if (outcome.conflict) {
    return { error: `По времени пересекается с вашим заказом: ${describeRequest(outcome.conflict)}`, status: 409 };
  }
  if (outcome.taken) return { error: 'Заказ уже взят другим водителем', status: 409 };
  const { result } = outcome;

  emitToDrivers('request:removed', { id: requestId });
  emitToDispatcher('request:updated', serializeForDispatcher(result, staleThreshold()));
  emitToEmployee(result.employee_id, 'request:assigned', serializeForEmployee(result));
  // Самому водителю — чтобы другие его окна (сайт в другой вкладке, бот)
  // узнали о взятии, сделанном не в них.
  emitToDriver(driver.id, 'request:assigned', serializeForDriver(result));
  return { request: result };
}

// Смена статуса своего заказа: assigned -> in_progress -> completed.
async function changeRequestStatus({ userId, requestId, status }) {
  const db = getWriteDb();
  const driver = driverByUserId(db, userId);
  if (!driver) return notDriver;
  const allowedFrom = status === 'in_progress' ? 'assigned' : 'in_progress';

  const outcome = db.transaction(() => {
    const upd = db
      .prepare(`UPDATE requests SET status = ? WHERE id = ? AND driver_id = ? AND status = ?`)
      .run(status, requestId, driver.id, allowedFrom);
    if (upd.changes === 0) return null;
    syncDriverStatus(db, driver.id);
    db.prepare(`INSERT INTO request_status_history (request_id, status, changed_by) VALUES (?, ?, ?)`)
      .run(requestId, status, userId);
    logEvent(db, { requestId, type: 'status_changed', actorUserId: userId, payload: { from: allowedFrom, to: status } });
    // Заявка завершена — попутные (влитые) заявки закрываются вместе с ней.
    const completedMergedB = status === 'completed' ? cascadeCompleteMergedB(db, requestId, userId) : [];
    return { completedMergedB };
  })();

  if (!outcome) return { error: 'Нельзя сменить статус — заказ не ваш или уже в другом статусе', status: 409 };

  for (const bId of outcome.completedMergedB) {
    const b = getRow(db, bId);
    emitToEmployee(b.employee_id, 'request:status', serializeForEmployee(b));
    emitToDispatcher('request:updated', serializeForDispatcher(b, staleThreshold()));
  }

  // При выходе в рейс пересчитываем оценку от «сейчас» (до этого
  // expected_completion_at считался от желаемого времени подачи) — иначе
  // прогноз освобождения машины в форме заказа и у диспетчера врёт.
  if (status === 'in_progress') {
    try {
      await recomputeRequestEstimate(requestId, { actorUserId: userId });
    } catch (err) {
      console.error('[rides] recompute on in_progress failed:', err.message);
    }
  }

  const result = getRow(db, requestId);
  emitToDispatcher('request:updated', serializeForDispatcher(result, staleThreshold()));
  emitToEmployee(result.employee_id, 'request:status', serializeForEmployee(result));
  emitToDriver(driver.id, 'request:status', serializeForDriver(result));
  return { request: result };
}

// Отказ от уже взятого заказа — заявка возвращается в общий пул.
async function declineRequest({ userId, requestId, reason }) {
  const db = getWriteDb();
  const driver = driverByUserId(db, userId);
  if (!driver) return notDriver;

  const result = db.transaction(() => {
    const upd = db
      .prepare(
        `UPDATE requests SET status = 'pending_assignment', driver_id = NULL, assigned_by = NULL, claimed_at = NULL, cancel_reason = ?
         WHERE id = ? AND driver_id = ? AND status IN ('assigned', 'in_progress')`
      )
      .run(reason, requestId, driver.id);
    if (upd.changes === 0) return null;
    syncDriverStatus(db, driver.id);
    db.prepare(`INSERT INTO request_status_history (request_id, status, changed_by) VALUES (?, 'pending_assignment', ?)`)
      .run(requestId, userId);
    logEvent(db, { requestId, type: 'driver_declined', actorUserId: userId, payload: { driverId: driver.id, reason } });
    return getRow(db, requestId);
  })();

  if (!result) return { error: 'Не удалось отказаться — заказ уже не ваш или сменил статус', status: 409 };

  // Если на заказе висели попутные (влитые) заявки — расформировываем: их
  // точки вынимаются из маршрута, сами они возвращаются в пул.
  const restoredB = dissolveMergesForA(db, requestId, 'Водитель отказался от заказа', userId);
  if (restoredB.length) {
    await recomputeRequestEstimate(requestId, { actorUserId: userId }).catch(() => {});
    emitDissolvedB(db, restoredB);
  }

  const fresh = getRow(db, requestId);
  emitToDriver(driver.id, 'request:status', serializeForDriver(fresh));
  emitToDrivers('request:new', serializeForDriver(fresh));
  emitToDispatcher('request:updated', serializeForDispatcher(fresh, staleThreshold()));
  emitToEmployee(fresh.employee_id, 'request:status', serializeForEmployee(fresh));
  return { request: fresh };
}

// На линию / с линии. Пока водитель на заказе прямо сейчас — нельзя.
function setLineStatus({ userId, status }) {
  const db = getWriteDb();
  const driver = driverByUserId(db, userId);
  if (!driver) return notDriver;
  if (driver.status === 'busy') {
    return { error: 'Нельзя менять статус, пока не закрыт текущий заказ', status: 409 };
  }
  db.prepare('UPDATE drivers SET status = ? WHERE id = ?').run(status, driver.id);
  // Вышел на линию, а подача закреплённого заказа уже наступила — сразу «занят».
  syncDriverStatus(db, driver.id);
  const fresh = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driver.id);
  emitToDriver(driver.id, 'driver:status', { status: fresh.status });
  return { driver: fresh };
}

module.exports = { claimRequest, changeRequestStatus, declineRequest, setLineStatus };
