// /api/v1/requests/... — совместные поездки (объединение заявок).
// Смонтирован на том же префиксе, что и requestsRouter/stopProposalsRouter.
//
// Объединение мгновенное, без согласований (логика — mergeApply.js):
// - водитель добавляет заявку из пула к своей поездке («Подвезти попутно»);
// - диспетчер добавляет заявку без водителя к поездке любого водителя
//   («Добавить попутно»): сначала список подходящих поездок и прогноз.
const express = require('express');
const { getWriteDb } = require('./db');
const { requireRideRole } = require('./auth');
const { validate, z, getRow, serializeForDispatcher, staleThreshold } = require('./requestView');
const { mergeCandidates, previewMerge, mergeError, mergeRequests, driverMerge, MERGE_LEAD_MINUTES } = require('./mergeApply');

const router = express.Router();

const mergeSchema = z.object({ intoRequestId: z.coerce.number().int().positive() });

// Объединить сразу: :id — заявка из пула, intoRequestId — поездка, к
// которой её добавляем. Водитель — только к своей поездке; диспетчер (и
// главный админ) — к любой подходящей.
router.post('/:id/merge', requireRideRole('driver', 'dispatcher'), validate(mergeSchema), async (req, res) => {
  const bId = Number(req.params.id);
  const aId = req.body.intoRequestId;
  const out = req.rideUser.role === 'driver'
    ? await driverMerge({ userId: req.rideUser.id, bId, aId })
    : await mergeRequests({ bId, aId, actorUserId: req.rideUser.id, initiator: 'dispatcher' });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({
    request: serializeForDispatcher(out.request, staleThreshold()),
    merged: serializeForDispatcher(out.merged, staleThreshold()),
    pickupEtaAt: out.pickupEtaAt,
    deltaMin: out.deltaMin,
  });
});

// Диспетчер, окно «Добавить попутно»: заявка (с комментарием пассажира) и
// поездки, к которым её можно добавить по времени, ближайшие — сверху.
router.get('/:id/merge-options', requireRideRole('dispatcher'), (req, res) => {
  const db = getWriteDb();
  const B = getRow(db, Number(req.params.id));
  if (!B) return res.status(404).json({ error: 'Заявка не найдена' });
  const trips = mergeCandidates(db, B).map((A) => serializeForDispatcher(getRow(db, A.id), staleThreshold()));
  res.json({ request: serializeForDispatcher(B, staleThreshold()), trips, leadMinutes: MERGE_LEAD_MINUTES });
});

// Прогноз до объединения: насколько удлинится поездка и время посадки.
router.get('/:id/merge-preview', requireRideRole('dispatcher'), async (req, res) => {
  const db = getWriteDb();
  const B = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(req.params.id));
  const A = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(req.query.into));
  const err = mergeError(A, B);
  if (err) return res.status(409).json({ error: err });
  res.json(await previewMerge(db, A, B));
});

module.exports = router;
