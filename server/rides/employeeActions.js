// Действия заказчика над своей заявкой — один код для сайта
// (requestsRouter.js) и Telegram-бота (telegram/bot.js), как и
// driverActions.js для водителя. Возвращает { request } (сырой ряд getRow)
// либо { error, status }.
const { getWriteDb } = require('./db');
const { emitToDrivers, emitToDispatcher, emitToDriver } = require('./socket');
const { logEvent } = require('./events');
const { dissolveMergesForA, emitDissolvedB } = require('./mergeApply');
const { staleThreshold, getRow, serializeForDispatcher } = require('./requestView');
const { syncDriverStatus } = require('./driverAvailability');

// Отменить СВОЮ заявку. Разрешено, пока её ещё не приняли
// (pending_assignment) или водитель уже назначен, но ещё не нажал «В пути»
// (assigned) — та же граница, что и у диспетчерской отмены: как только
// поездка реально началась (in_progress), отменить может только диспетчер.
function cancelOwnRequest({ userId, requestId, reason }) {
  const db = getWriteDb();
  let previousDriverId = null;
  const result = db.transaction(() => {
    const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    if (!row || row.employee_id !== userId) return null;
    if (!['pending_assignment', 'assigned'].includes(row.status)) return null;
    previousDriverId = row.driver_id;
    db.prepare(`UPDATE requests SET status = 'cancelled', on_hold = 0, cancel_reason = ? WHERE id = ?`).run(reason, requestId);
    if (row.driver_id) syncDriverStatus(db, row.driver_id);
    db.prepare(`INSERT INTO request_status_history (request_id, status, changed_by) VALUES (?, 'cancelled', ?)`)
      .run(requestId, userId);
    logEvent(db, { requestId, type: 'cancelled_by_employee', actorUserId: userId, payload: { reason, previousStatus: row.status } });
    return getRow(db, requestId);
  })();

  if (!result) {
    return { error: 'Заявку нельзя отменить — водитель уже в пути, поездка завершена, либо это не ваша заявка', status: 409 };
  }

  const restoredB = dissolveMergesForA(db, requestId, 'Заказчик отменил заявку', userId);
  if (restoredB.length) emitDissolvedB(db, restoredB);

  emitToDrivers('request:removed', { id: requestId });
  emitToDispatcher('request:updated', serializeForDispatcher(result, staleThreshold()));
  if (previousDriverId) emitToDriver(previousDriverId, 'request:removed', { id: requestId });
  return { request: result };
}

module.exports = { cancelOwnRequest };
