// Чтение и сериализация заявок — общий слой для requestsRouter.js
// (жизненный цикл заявки) и stopProposalsRouter.js (изменение маршрута
// уже поданной заявки). Вынесено сюда, потому что оба роутера отдают
// клиенту заявку в одном и том же формате и одинаково подтягивают к ней
// доп. пункты и открытые предложения по маршруту.
const { z } = require('zod');
const { requestedAtMs } = require('./slots');

const FULL_SELECT = `
  SELECT
    r.*,
    emp.name  AS employee_name,
    emp.phone AS employee_phone,
    du.name   AS driver_name,
    du.phone  AS driver_phone,
    v.plate_number AS vehicle_plate,
    v.model        AS vehicle_model
  FROM requests r
  JOIN users emp ON emp.id = r.employee_id
  LEFT JOIN drivers d ON d.id = r.driver_id
  LEFT JOIN users du ON du.id = d.user_id
  LEFT JOIN vehicles v ON v.id = d.vehicle_id
`;

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Некорректные данные запроса' });
    }
    req.body = result.data;
    next();
  };
}

// За сколько минут до времени подачи заявка без водителя подсвечивается
// диспетчеру (и после этого времени — тем более).
function staleThreshold() {
  return Number(process.env.RIDE_STALE_THRESHOLD_MINUTES || 15);
}

// Доп. пункты назначения (сверх to_address) грузятся отдельным запросом,
// не JOIN'ом в FULL_SELECT — JOIN на request_stops размножил бы строку
// заявки по числу пунктов, что ломает все списки, которым нужна ровно одна
// строка на заявку.
function getStops(db, requestId) {
  return db
    .prepare('SELECT id, address FROM request_stops WHERE request_id = ? ORDER BY stop_order ASC')
    .all(requestId);
}

// Открытые (ещё не решённые) предложения по маршруту — чтобы водитель и
// заказчик видели «точка предложена, ждёт диспетчера», а диспетчер —
// счётчик на заявке. Полную ленту предложений отдаёт stopProposalsRouter.
function getOpenProposals(db, requestId) {
  return db
    .prepare(
      `SELECT sp.id, sp.action, sp.address, sp.target_stop_id AS targetStopId,
              sp.proposed_by_role AS proposedByRole, sp.est_delta_min AS estDeltaMin,
              sp.created_at AS createdAt, u.name AS proposedByName
       FROM stop_proposals sp
       JOIN users u ON u.id = sp.proposed_by
       WHERE sp.request_id = ? AND sp.status = 'pending'
       ORDER BY sp.created_at ASC`
    )
    .all(requestId);
}

// Заявки B, влитые в маршрут этой заявки (A) при объединении (П.6) —
// показываем на карточке водителя и заказчика A как «попутно #B».
function getMergedRequests(db, requestId) {
  return db
    .prepare(
      `SELECT b.id, b.from_address AS fromAddress, b.to_address AS toAddress,
              b.pickup_eta_at AS pickupEtaAt, b.status,
              emp.name AS employeeName, emp.phone AS employeePhone
       FROM requests b
       JOIN users emp ON emp.id = b.employee_id
       WHERE b.merged_into = ?
       ORDER BY b.id ASC`
    )
    .all(requestId);
}

// Незакрытые предложения объединения, где участвует эта заявка (как A или
// как B) — чтобы карточка водителя/заказчика показала «идёт согласование».
function getPendingMerges(db, requestId) {
  return db
    .prepare(
      `SELECT m.id, m.request_a_id AS requestAId, m.request_b_id AS requestBId,
              m.approved_by_a AS approvedByA, m.approved_by_dispatcher AS approvedByDispatcher,
              m.created_at AS createdAt,
              a.from_address AS aFrom, a.to_address AS aTo,
              b.from_address AS bFrom, b.to_address AS bTo,
              du.name AS driverName
       FROM request_merges m
       JOIN requests a ON a.id = m.request_a_id
       JOIN requests b ON b.id = m.request_b_id
       JOIN drivers d ON d.id = m.driver_id
       JOIN users du ON du.id = d.user_id
       WHERE m.status = 'pending' AND (m.request_a_id = ? OR m.request_b_id = ?)`
    )
    .all(requestId, requestId)
    .map((r) => ({ ...r, approvedByA: !!r.approvedByA, approvedByDispatcher: !!r.approvedByDispatcher }));
}

function hydrate(db, row) {
  if (!row) return row;
  row.stopsFull = getStops(db, row.id); // [{ id, address }] по порядку
  row.stopProposals = getOpenProposals(db, row.id);
  row.mergedRequests = getMergedRequests(db, row.id);
  row.pendingMerges = getPendingMerges(db, row.id);
  return row;
}

function hydrateRows(db, rows) {
  return rows.map((row) => hydrate(db, row));
}

function getRow(db, id) {
  return hydrate(db, db.prepare(`${FULL_SELECT} WHERE r.id = ?`).get(id));
}

// Общие поля заявки, без телефона заказчика — для диспетчера и для самого
// заказчика (свой телефон ему очевиден).
function baseFields(row) {
  return {
    id: row.id,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    requestedAt: row.requested_at,
    purpose: row.purpose,
    passengersCount: row.passengers_count,
    comment: row.comment,
    status: row.status,
    assignedBy: row.assigned_by,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    driverName: row.driver_name || null,
    vehiclePlate: row.vehicle_plate || null,
    withReturn: !!row.with_return,
    stops: (row.stopsFull || []).map((s) => s.address),
    stopProposals: row.stopProposals || [],
    distanceKm: row.distance_km ?? null,
    durationMin: row.duration_min ?? null,
    expectedCompletionAt: row.expected_completion_at ?? null,
    onHold: !!row.on_hold,
    pullReason: row.pull_reason || null,
    mergeLock: !!row.merge_lock,
    mergedInto: row.merged_into ?? null,
    pickupEtaAt: row.pickup_eta_at ?? null,
    // телефон пассажира B из mergedRequests — только водителю (см. serializeForDriver)
    mergedRequests: (row.mergedRequests || []).map(({ employeePhone, ...m }) => m),
    pendingMerges: row.pendingMerges || [],
  };
}

// Пул и «мои текущие» у водителя — тут телефон заказчика можно отдавать
// (требование: только водителю, у которого заказ в пуле либо уже назначен).
function serializeForDriver(row) {
  return {
    ...baseFields(row),
    employeeName: row.employee_name,
    employeePhone: row.employee_phone,
    mergedRequests: row.mergedRequests || [], // с телефонами пассажиров B — водителю можно
  };
}

function serializeForEmployee(row) {
  return baseFields(row);
}

function serializeForDispatcher(row, staleThresholdMinutes = staleThreshold()) {
  const minutesToPickup = (requestedAtMs(row.requested_at) - Date.now()) / 60000;
  return {
    ...baseFields(row),
    employeeName: row.employee_name,
    driverPhone: row.driver_phone || null,
    stopsDetailed: row.stopsFull || [], // [{ id, address }] — для управления точками у диспетчера
    // Подсветка — по близости ко времени подачи, а не по возрасту заявки:
    // заказ на завтра, поданный сегодня, ждать водителя может спокойно.
    isStale: row.status === 'pending_assignment' && !row.on_hold && !row.merged_into && minutesToPickup <= staleThresholdMinutes,
  };
}

module.exports = {
  FULL_SELECT,
  validate,
  staleThreshold,
  getStops,
  getOpenProposals,
  hydrate,
  hydrateRows,
  getRow,
  baseFields,
  serializeForDriver,
  serializeForEmployee,
  serializeForDispatcher,
  z,
};
