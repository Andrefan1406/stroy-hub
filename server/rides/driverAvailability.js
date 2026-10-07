// Занятость водителя — по пересечению интервалов времени заявок, а не по
// одному флагу на водителя.
//
// Раньше drivers.status = 'busy' ставился при ЛЮБОМ закреплении заявки и
// снимался только при её завершении/отказе/отмене — водитель, взявший
// заказ на завтра 17:00, считался занятым и для сегодняшних заявок. Теперь:
// - назначить/взять заявку нельзя только если её интервал пересекается с
//   интервалом другой активной заявки этого водителя (findDriverConflict);
// - drivers.status = 'busy' значит «на заказе прямо сейчас» и
//   пересчитывается из заявок (syncDriverStatus) — после каждого изменения
//   и раз в минуту (startDriverStatusJob), когда подходит время подачи уже
//   закреплённого заказа. 'available'/'offline' по-прежнему ставит сам
//   водитель (на линии / не на линии).
//
// Интервал заявки: от времени подачи до подачи + duration_min (оценка
// маршрута уже включает туда-обратно, ожидание и доп. точки, см.
// routeEstimate.js); для начатой поездки — до прогноза окончания
// (expected_completion_at), но не раньше «сейчас». Между заказами — запас
// на дорогу до следующей подачи (DRIVER_BUFFER_MINUTES).
const { requestedAtMs } = require('./slots');

const MINUTE = 60000;
// Длительность поездки, если маршрут не удалось построить (адрес не нашёлся
// на карте) — duration_min = NULL.
const DEFAULT_TRIP_MINUTES = Number(process.env.RIDE_DEFAULT_TRIP_MINUTES || 30);
const DRIVER_BUFFER_MINUTES = Number(process.env.RIDE_DRIVER_BUFFER_MINUTES || 15);
const STATUS_JOB_INTERVAL_MS = MINUTE;

// [начало, конец) заявки в мс; null — время подачи не распознано.
function requestInterval(row, now = Date.now()) {
  const start = requestedAtMs(row.requested_at);
  if (Number.isNaN(start)) return null;
  const end = start + (row.duration_min ?? DEFAULT_TRIP_MINUTES) * MINUTE;
  if (row.status !== 'in_progress') return [start, end];
  const expected = row.expected_completion_at ? Date.parse(row.expected_completion_at) : end;
  return [Math.min(start, now), Math.max(Number.isNaN(expected) ? end : expected, now)];
}

function intervalsOverlap([a1, b1], [a2, b2], bufferMs = DRIVER_BUFFER_MINUTES * MINUTE) {
  return a1 < b2 + bufferMs && a2 < b1 + bufferMs;
}

// Заказы, за которые водитель сейчас отвечает: назначенные и в пути.
// Попутные (merged_into) обслуживаются в рамках своей основной заявки —
// её интервал уже включает их точки.
function driverCommitments(db, driverId, excludeRequestId = null) {
  return db
    .prepare(
      `SELECT * FROM requests
        WHERE driver_id = ? AND status IN ('assigned', 'in_progress') AND merged_into IS NULL AND id != ?`
    )
    .all(driverId, excludeRequestId ?? -1);
}

// Активная заявка водителя, пересекающаяся по времени с candidate, или
// null — водитель свободен на это время. Заявку с нераспознанным временем
// считаем пересекающейся: лучше переспросить, чем дать двойное назначение.
function findDriverConflict(db, driverId, candidate, now = Date.now()) {
  const target = requestInterval(candidate, now);
  for (const other of driverCommitments(db, driverId, candidate.id)) {
    const interval = requestInterval(other, now);
    if (!target || !interval || intervalsOverlap(target, interval)) return other;
  }
  return null;
}

// На заказе прямо сейчас: поездка начата, либо назначенная подача уже
// наступила (с учётом запаса на дорогу).
function isBusyNow(db, driverId, now = Date.now()) {
  return driverCommitments(db, driverId).some((row) => {
    if (row.status === 'in_progress') return true;
    const start = requestedAtMs(row.requested_at);
    return !Number.isNaN(start) && start - DRIVER_BUFFER_MINUTES * MINUTE <= now;
  });
}

// Приводит drivers.status в соответствие с заказами: 'busy' — если на
// заказе сейчас; иначе бывший 'busy' становится 'available' (водитель
// остаётся на линии). 'offline' без текущего заказа не трогаем.
function syncDriverStatus(db, driverId, now = Date.now()) {
  const driver = db.prepare('SELECT id, status FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return null;
  let next = driver.status;
  if (isBusyNow(db, driverId, now)) next = 'busy';
  else if (driver.status === 'busy') next = 'available';
  if (next !== driver.status) db.prepare('UPDATE drivers SET status = ? WHERE id = ?').run(next, driverId);
  return next;
}

function syncAllDriverStatuses(db, now = Date.now()) {
  for (const { id } of db.prepare('SELECT id FROM drivers WHERE active = 1').all()) syncDriverStatus(db, id, now);
}

// «Заявка #12 на 07.10 17:00» — для сообщений о пересечении.
function describeRequest(row) {
  const at = (row.requested_at || '').replace(' ', 'T');
  const [date, time = ''] = at.split('T');
  const [, m, d] = (date || '').split('-');
  return `заявка #${row.id} на ${d}.${m} ${time.slice(0, 5)}`;
}

function startDriverStatusJob(getDb) {
  const tick = () => {
    try {
      syncAllDriverStatuses(getDb());
    } catch (err) {
      console.error('[rides] пересчёт статусов водителей не удался:', err.message);
    }
  };
  tick();
  return setInterval(tick, STATUS_JOB_INTERVAL_MS);
}

module.exports = {
  DEFAULT_TRIP_MINUTES,
  DRIVER_BUFFER_MINUTES,
  requestInterval,
  intervalsOverlap,
  findDriverConflict,
  isBusyNow,
  syncDriverStatus,
  syncAllDriverStatuses,
  describeRequest,
  startDriverStatusJob,
};
