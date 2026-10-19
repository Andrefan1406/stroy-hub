// /api/v1/requests/... — изменение маршрута уже поданной заявки (П.1 + П.5
// ТЗ доработок). Смонтирован на том же префиксе, что и requestsRouter
// (Express перебирает роутеры по очереди — пути не пересекаются).
//
// Модель: заказчик ПРЕДЛАГАЕТ добавить точку — всегда на согласование
// диспетчеру; правку/удаление точки — тоже, кроме заявки ещё в пуле (там
// сразу). Предложение висит pending, пока диспетчер не решит (таймаут
// 5 минут, proposalTimeout.js). Диспетчер применяет любые изменения сразу.
// Водитель маршрут не меняет.
const express = require('express');
const { getWriteDb } = require('./db');
const { requireRideRole } = require('./auth');
const { emitToDispatcher } = require('./socket');
const { logEvent } = require('./events');
const { estimateProposalImpact } = require('./routeEstimate');
const { resolvePoints, unresolvedMessage } = require('./addressCheck');
const { validate, z } = require('./requestView');
const { serializeProposal, listPendingProposals, listProposalsForRequest } = require('./stopProposalView');
const { markDecided, applyApprovedProposal, notifyProposer } = require('./proposalApply');

const router = express.Router();

const MUTABLE_STATUSES = ['pending_assignment', 'assigned', 'in_progress'];

const stopChangeSchema = z
  .object({
    action: z.enum(['add', 'edit', 'remove']),
    targetStopId: z.coerce.number().int().positive().optional(),
    address: z.string().trim().min(1, 'Укажите адрес точки').optional(),
    lat: z.coerce.number().optional(),
    lng: z.coerce.number().optional(),
  })
  .refine((d) => d.action === 'remove' || !!d.address, { message: 'Укажите адрес точки' })
  .refine((d) => d.action === 'add' || !!d.targetStopId, { message: 'Не указана точка маршрута' });

const rejectSchema = z.object({ reason: z.string().trim().min(1, 'Укажите причину отклонения') });

// Кто вправе видеть изменения маршрута этой заявки: диспетчер, её
// заказчик, либо назначенный на неё водитель.
function canActOnRequest(db, request, rideUser) {
  if (rideUser.role === 'dispatcher') return true;
  if (request.employee_id === rideUser.id) return true;
  if (rideUser.role === 'driver' && request.driver_id) {
    const d = db.prepare('SELECT id FROM drivers WHERE user_id = ?').get(rideUser.id);
    return !!d && d.id === request.driver_id;
  }
  return false;
}

// Диспетчер: очередь предложений на модерацию.
router.get('/stop-changes/pending', requireRideRole('dispatcher'), (req, res) => {
  res.json({ proposals: listPendingProposals(getWriteDb()) });
});

// Диспетчер: решение по предложению.
router.post('/stop-changes/:pid/approve', requireRideRole('dispatcher'), async (req, res) => {
  const db = getWriteDb();
  const pid = Number(req.params.pid);
  const p = db.prepare('SELECT * FROM stop_proposals WHERE id = ?').get(pid);
  if (!p) return res.status(404).json({ error: 'Предложение не найдено' });
  if (p.status !== 'pending') return res.status(409).json({ error: 'Это предложение уже обработано' });

  const request = db.prepare('SELECT status FROM requests WHERE id = ?').get(p.request_id);
  if (!request || !MUTABLE_STATUSES.includes(request.status)) {
    return res.status(409).json({ error: 'Заявка уже завершена или отменена — менять маршрут нельзя' });
  }

  if (!markDecided(db, pid, 'approved', req.rideUser.id)) {
    return res.status(409).json({ error: 'Это предложение уже обработано' });
  }
  logEvent(db, {
    requestId: p.request_id,
    type: 'stop_approved',
    actorUserId: req.rideUser.id,
    payload: { proposalId: pid, action: p.action, address: p.address, targetStopId: p.target_stop_id },
  });
  await applyApprovedProposal(db, pid, req.rideUser.id);

  const proposal = serializeProposal(db, pid);
  emitToDispatcher('proposal:updated', proposal);
  notifyProposer(db, pid, 'proposal:updated');
  res.json({ proposal });
});

router.post('/stop-changes/:pid/reject', requireRideRole('dispatcher'), validate(rejectSchema), (req, res) => {
  const db = getWriteDb();
  const pid = Number(req.params.pid);
  const p = db.prepare('SELECT * FROM stop_proposals WHERE id = ?').get(pid);
  if (!p) return res.status(404).json({ error: 'Предложение не найдено' });
  if (p.status !== 'pending') return res.status(409).json({ error: 'Это предложение уже обработано' });

  if (!markDecided(db, pid, 'rejected', req.rideUser.id, req.body.reason)) {
    return res.status(409).json({ error: 'Это предложение уже обработано' });
  }
  logEvent(db, {
    requestId: p.request_id,
    type: 'stop_rejected',
    actorUserId: req.rideUser.id,
    payload: { proposalId: pid, action: p.action, address: p.address, reason: req.body.reason },
  });

  const proposal = serializeProposal(db, pid);
  emitToDispatcher('proposal:updated', proposal);
  notifyProposer(db, pid, 'proposal:updated');
  res.json({ proposal });
});

// Лента предложений по конкретной заявке (для карточки у водителя/заказчика/диспетчера).
router.get('/:id/stop-changes', requireRideRole('employee', 'driver', 'dispatcher'), (req, res) => {
  const db = getWriteDb();
  const requestId = Number(req.params.id);
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
  if (!request) return res.status(404).json({ error: 'Заявка не найдена' });
  if (!canActOnRequest(db, request, req.rideUser)) return res.status(403).json({ error: 'Нет доступа к этой заявке' });
  res.json({ proposals: listProposalsForRequest(db, requestId) });
});

// Изменить маршрут: диспетчер — сразу; заказчик — на согласование
// диспетчеру (правка/удаление в заявке ещё в пуле — сразу).
router.post('/:id/stop-changes', requireRideRole('employee', 'dispatcher'), validate(stopChangeSchema), async (req, res) => {
  const db = getWriteDb();
  const requestId = Number(req.params.id);
  const { action, targetStopId, address } = req.body;

  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
  if (!request) return res.status(404).json({ error: 'Заявка не найдена' });
  if (!MUTABLE_STATUSES.includes(request.status)) {
    return res.status(409).json({ error: 'Маршрут этой заявки уже нельзя менять' });
  }
  const isDispatcher = req.rideUser.role === 'dispatcher' || req.isSiteAdmin;
  if (!isDispatcher && request.employee_id !== req.rideUser.id) {
    return res.status(403).json({ error: 'Менять маршрут может только заказчик заявки или диспетчер' });
  }
  // Попутную заявку везут в чужой поездке — её точки уже в маршруте
  // основной заявки; менять их может только диспетчер.
  if (!isDispatcher && request.merged_into) {
    return res.status(409).json({ error: `Вас везут попутно в поездке #${request.merged_into} — изменить маршрут может диспетчер` });
  }

  if (action !== 'add') {
    const st = db.prepare('SELECT id FROM request_stops WHERE id = ? AND request_id = ?').get(targetStopId, requestId);
    if (!st) return res.status(404).json({ error: 'Точка маршрута не найдена' });
  }

  // Точка новой/изменённой остановки: отмечена на карте или найдена точно
  // (addressCheck.js); иначе не принимаем — без неё не посчитать маршрут.
  // Координаты нужны и для вставки «по ближайшему участку» без ожидания
  // общего пересчёта.
  let lat = null;
  let lng = null;
  if (action !== 'remove' && address) {
    const { points, unresolved } = await resolvePoints([{ address, lat: req.body.lat, lng: req.body.lng }]);
    if (unresolved.length) return res.status(400).json({ error: unresolvedMessage(unresolved), unresolved });
    ({ lat, lng } = points[0]);
  }

  let estDelta = null;
  try {
    estDelta = await estimateProposalImpact(requestId, { action, targetStopId, address });
  } catch (err) {
    estDelta = null;
  }

  // Сразу: диспетчер — всё; заказчик — только правку/удаление, пока заявка
  // ещё в пуле. Новая точка от заказчика — всегда через диспетчера.
  const autoApprove =
    isDispatcher || (action !== 'add' && request.status === 'pending_assignment');

  const pid = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO stop_proposals
           (request_id, action, target_stop_id, address, lat, lng, proposed_by, proposed_by_role, est_delta_min)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(requestId, action, targetStopId ?? null, address ?? null, lat, lng, req.rideUser.id, req.rideUser.role, estDelta);
    // Применённое сразу — одно событие «Добавлена/изменена/удалена точка»;
    // на согласование — «Предложена точка».
    const type = !autoApprove ? 'stop_proposed' : { add: 'stop_added', edit: 'stop_edited', remove: 'stop_removed' }[action];
    logEvent(db, {
      requestId,
      type,
      actorUserId: req.rideUser.id,
      payload: { action, address, targetStopId: targetStopId ?? null, estDeltaMin: estDelta, byRole: req.rideUser.role },
    });
    return info.lastInsertRowid;
  })();

  if (autoApprove) {
    markDecided(db, pid, 'approved', req.rideUser.id);
    await applyApprovedProposal(db, pid, req.rideUser.id);
    const proposal = serializeProposal(db, pid);
    emitToDispatcher('proposal:updated', proposal);
    return res.status(201).json({ proposal });
  }

  const proposal = serializeProposal(db, pid);
  emitToDispatcher('proposal:new', proposal);
  res.status(201).json({ proposal });
});

module.exports = router;
