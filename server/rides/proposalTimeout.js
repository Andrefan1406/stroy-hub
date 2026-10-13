// Таймаут согласований: раз в минуту авто-отклоняет предложения, которые
// провисели pending дольше отведённого времени, и уведомляет участников.
// Порог по умолчанию — 5 минут (ТЗ доработок: «тайм-аут → авто-отклонение»).
// Покрывает предложения по маршруту (stop_proposals, П.5). Объединение
// заявок согласования больше не требует (см. mergeApply.js).
const cron = require('node-cron');
const { getWriteDb } = require('./db');
const { logEvent } = require('./events');
const { emitToDispatcher } = require('./socket');
const { serializeProposal } = require('./stopProposalView');
const { markDecided, notifyProposer } = require('./proposalApply');

const TIMEOUT_MINUTES = Number(process.env.RIDE_PROPOSAL_TIMEOUT_MINUTES || 5);
const AUTO_REASON = 'Диспетчер не рассмотрел предложение за отведённое время';
const OVERDUE = "(julianday('now') - julianday(created_at)) * 24 * 60 >= ?";

function sweepStopProposals(db) {
  const stale = db.prepare(`SELECT id FROM stop_proposals WHERE status = 'pending' AND ${OVERDUE}`).all(TIMEOUT_MINUTES);
  for (const { id } of stale) {
    if (!markDecided(db, id, 'auto_rejected', null, AUTO_REASON)) continue;
    const p = db.prepare('SELECT request_id, action, address FROM stop_proposals WHERE id = ?').get(id);
    logEvent(db, {
      requestId: p.request_id,
      type: 'stop_rejected',
      actorUserId: null,
      payload: { proposalId: id, action: p.action, address: p.address, auto: true, reason: AUTO_REASON },
    });
    const proposal = serializeProposal(db, id);
    emitToDispatcher('proposal:updated', proposal);
    notifyProposer(db, id, 'proposal:updated');
  }
  return stale.length;
}

function sweepOnce() {
  const db = getWriteDb();
  return sweepStopProposals(db);
}

function startProposalTimeoutJob() {
  cron.schedule('* * * * *', () => {
    try {
      sweepOnce();
    } catch (err) {
      console.error('[rides] timeout sweep failed:', err.message);
    }
  });
}

module.exports = { startProposalTimeoutJob, sweepOnce };
