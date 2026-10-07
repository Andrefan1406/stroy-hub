// Время подачи и лимит заявок на один слот.
//
// requested_at хранится строкой местного времени "YYYY-MM-DDTHH:MM" без
// зоны (так её отдаёт форма заказа). Сервер на хостинге живёт в UTC, а
// new Date("YYYY-MM-DDTHH:MM") парсит такую строку в зоне ПРОЦЕССА — поэтому
// здесь она явно трактуется как время Казахстана (единый UTC+5, без
// перехода на летнее время).
//
// Слот — 15 минут (форма даёт выбрать только 00:00, 00:15, ...). На один
// слот принимается не больше заявок, чем водителей на линии: иначе машин
// на всех в это время заведомо не хватит. "На линии" — работающие
// водители в статусе свободен/занят; если на линии никого (например,
// вечером заказывают на завтра) — лимит по всем работающим водителям,
// иначе заказать заранее было бы вообще нельзя. В слот считаются только
// заявки, которым нужна своя машина: активные и не влитые попутно в
// чужую поездку (merged_into).
const KZ_OFFSET = '+05:00';
const SLOT_MINUTES = 15;
// Подать заявку можно только в рабочее время — с 08:30 до 17:30 по времени
// Казахстана (17:30 — уже нельзя). Время ПОДАЧИ машины при этом любое,
// 00:00–23:45, лишь бы не в прошлом. Форма (EmployeeRidesPage.jsx) берёт
// эти границы из /requests/slots и показывает сообщение вне окна.
const SUBMIT_FROM = '08:30';
const SUBMIT_TO = '17:30';
const ACTIVE_STATUSES = ['pending_assignment', 'assigned', 'in_progress'];

function requestedAtMs(requestedAt) {
  if (!requestedAt) return NaN;
  return new Date(`${requestedAt.slice(0, 16).replace(' ', 'T')}:00${KZ_OFFSET}`).getTime();
}

// "YYYY-MM-DD" сегодняшней даты по времени Казахстана.
function todayKz() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Сейчас принимаются заявки? [SUBMIT_FROM, SUBMIT_TO) по времени Казахстана.
function isSubmissionOpen(now = Date.now()) {
  const time = new Date(now + 5 * 3600 * 1000).toISOString().slice(11, 16);
  return time >= SUBMIT_FROM && time < SUBMIT_TO;
}

const SUBMISSION_CLOSED_MESSAGE = `Заявки на легковой транспорт принимаются с ${SUBMIT_FROM} до ${SUBMIT_TO}. Сейчас подать заявку нельзя.`;

// "YYYY-MM-DDTHH:MM", округлённое вниз до слота (старые заявки могли быть
// поданы с произвольными минутами, до выбора времени списком).
function slotKey(requestedAt) {
  const [date, time = '00:00'] = requestedAt.slice(0, 16).replace(' ', 'T').split('T');
  const [h, m] = time.split(':').map(Number);
  const mm = String(Math.floor(m / SLOT_MINUTES) * SLOT_MINUTES).padStart(2, '0');
  return `${date}T${String(h).padStart(2, '0')}:${mm}`;
}

function slotCapacity(db) {
  const onLine = db.prepare("SELECT COUNT(*) AS c FROM drivers WHERE active = 1 AND status IN ('available', 'busy')").get().c;
  const total = db.prepare('SELECT COUNT(*) AS c FROM drivers WHERE active = 1').get().c;
  return { onLine, capacity: Math.max(onLine || total, 1) };
}

// { "HH:MM": число заявок } за дату "YYYY-MM-DD".
function slotCounts(db, date) {
  const rows = db
    .prepare(
      `SELECT requested_at FROM requests
        WHERE substr(requested_at, 1, 10) = ?
          AND status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
          AND merged_into IS NULL`
    )
    .all(date, ...ACTIVE_STATUSES);
  const counts = {};
  for (const { requested_at: at } of rows) {
    const time = slotKey(at).slice(11);
    counts[time] = (counts[time] || 0) + 1;
  }
  return counts;
}

// Ближайший свободный слот той же даты не раньше requestedAt; null — до
// конца дня всё занято.
function nextFreeSlot(db, requestedAt, capacity) {
  const key = slotKey(requestedAt);
  const date = key.slice(0, 10);
  const counts = slotCounts(db, date);
  const [h, m] = key.slice(11).split(':').map(Number);
  for (let minutes = h * 60 + m; minutes < 24 * 60; minutes += SLOT_MINUTES) {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    if ((counts[time] || 0) < capacity) return `${date}T${time}`;
  }
  return null;
}

module.exports = {
  ACTIVE_STATUSES,
  SUBMIT_FROM,
  SUBMIT_TO,
  SUBMISSION_CLOSED_MESSAGE,
  isSubmissionOpen,
  requestedAtMs,
  todayKz,
  slotKey,
  slotCapacity,
  slotCounts,
  nextFreeSlot,
};
