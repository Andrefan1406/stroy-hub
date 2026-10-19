// Обязательная точка на карте для нераспознанного адреса.
//
// Время в пути и километраж считаются по координатам точек маршрута. Если
// адрес не найден точно (не найден вовсе, найдена только улица — «ул.
// Базовая» — или сервис поиска не ответил), точку обязательно отмечают на
// карте; без неё заявку (и новую точку маршрута) не принимаем. Текст адреса
// при этом остаётся подписью для водителя, считаем по отмеченной точке.
// Форма проверяет то же заранее (GET /api/v1/geocode/check) — здесь
// повторная проверка, чтобы её нельзя было обойти.
const { lookupAddress } = require('./routeEstimate');

const isCoord = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// points: [{ address, lat?, lng?, label }] -> { points: [{ address, lat, lng }], unresolved }
// unresolved: [{ index, address, label, status }] — адреса, которые нужно отметить на карте.
async function resolvePoints(points) {
  const out = [];
  const unresolved = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const lat = p.lat == null ? NaN : Number(p.lat);
    const lng = p.lng == null ? NaN : Number(p.lng);
    if (isCoord(lat, lng)) {
      out.push({ address: p.address, lat, lng });
      continue;
    }
    const r = await lookupAddress(p.address); // последовательно — щадим лимит Nominatim
    if (r.status === 'found') {
      out.push({ address: p.address, lat: r.lat, lng: r.lng });
    } else {
      out.push({ address: p.address, lat: null, lng: null });
      unresolved.push({ index: i, address: p.address, label: p.label, status: r.status });
    }
  }
  return { points: out, unresolved };
}

function unresolvedMessage(unresolved) {
  const list = unresolved.map((u) => `«${u.address}»${u.label ? ` (${u.label})` : ''}`).join(', ');
  return `Отметьте на карте: ${list}. Адрес не найден точно — без точки на карте нельзя рассчитать время в пути и километраж.`;
}

module.exports = { resolvePoints, unresolvedMessage, isCoord };
