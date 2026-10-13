// Время подачи заявки ("YYYY-MM-DDTHH:MM", время Казахстана) -> мс.
export function pickupMs(requestedAt) {
  return Date.parse(`${(requestedAt || "").replace(" ", "T").slice(0, 16)}:00+05:00`);
}

// Можно ли добавить заявку попутно к поездке: подача заявки попадает в окно
// поездки (mergeWindow считает сервер — не раньше чем за 15 мин до её подачи
// и до её окончания). Окончательно проверяет сервер при объединении.
export function fitsMergeWindow(request, trip) {
  if (!trip.mergeWindow) return false;
  const t = pickupMs(request.requestedAt);
  return t >= Date.parse(trip.mergeWindow.from) && t <= Date.parse(trip.mergeWindow.to);
}

// Маршрут заявки — from, to и произвольное число доп. пунктов (r.stops) —
// собирается в одну строку одинаково на всех трёх страницах (сотрудник/
// водитель/диспетчер), поэтому вынесен сюда, а не продублирован трижды.
export function formatRoute(r) {
  return [r.fromAddress, r.toAddress, ...(r.stops || [])].join(" → ");
}

// «+7 мин» / «−4 мин» / «без изменения» — ориентировочное влияние
// предложенной точки на время поездки (stop_proposals.est_delta_min).
export function formatDelta(min) {
  if (min == null) return null;
  if (min === 0) return "почти без изменения времени";
  return `${min > 0 ? "+" : "−"}${Math.abs(min)} мин к поездке`;
}

// «~14:20» / «завтра ~09:05» / «~12.09 08:30» — ориентировочное время
// освобождения машины (expected_completion_at приходит уже в ISO с 'Z').
export function formatClock(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const hhmm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `~${hhmm}`;
  if (d.toDateString() === tomorrow.toDateString()) return `завтра ~${hhmm}`;
  return `~${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${hhmm}`;
}

// Сколько минут назад — для метки возраста предложения. Время с сервера
// приходит в UTC без зоны ('YYYY-MM-DD HH:MM:SS'), дорисовываем 'Z'.
export function minutesSince(ts) {
  if (!ts) return null;
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
}

// distanceKm/durationMin — null, если геокодер/роутер не смогли определить
// хотя бы одну из точек (см. server/rides/routeEstimate.js) — в этом
// случае просто не показываем оценку, а не "0 км, 0 мин".
export function formatEstimate(r) {
  if (r.distanceKm == null || r.durationMin == null) return null;
  const hours = Math.floor(r.durationMin / 60);
  const minutes = r.durationMin % 60;
  const time = hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
  return `≈ ${r.distanceKm} км, ${time}`;
}
