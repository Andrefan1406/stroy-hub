// Оценка расстояния/времени в пути.
//
// Пайплайн: геокодируем каждый адрес (Nominatim, с кэшем в таблице
// geocode_cache — см. db.js), затем строим маршрут через публичный
// демо-сервер OSRM. Оба — бесплатные OSM-сервисы без API-ключа, но по их
// же политике использования рассчитаны на невысокую нагрузку (см.
// https://operations.osmfoundation.org/policies/nominatim/,
// https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server). Кэш
// геокодера снимает основную часть повторных запросов (один и тот же
// адрес подачи/назначения встречается постоянно).
//
// Когда OSRM недоступен или часть координат не определилась — считаем по
// эвристике: расстояние по прямой (гаверсинус) × коэффициент извилистости
// дорог, делённое на среднюю городскую скорость. Оценка загрубляется, но
// заявка и пересчёт при добавлении точки от этого не ломаются.
//
// OSRM считает время по трассовой модели скоростей (без городских пробок и
// светофоров) — для внутригородских служебных поездок это заметно
// оптимистичнее реальности, поэтому время считаем сами: расстояние (из
// фактической геометрии маршрута, ему доверяем) делим на среднюю скорость
// по городу с поправкой на пробки (на длинных участках между населёнными
// пунктами — на скорость по трассе, см. legDriveMinutes) и добавляем буфер
// на посадку/высадку.
const { getWriteDb } = require('./db');
const { logEvent } = require('./events');
const { KNOWN, splitSettlement, normalize } = require('./settlements');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

// Без подсказки о регионе геокодер ищет по всему миру, а одинаковые
// названия улиц встречаются в разных городах Казахстана (например,
// "Крылова" есть и в Усть-Каменогорске, и в Алматы) — Nominatim иногда
// выбирал совсем не тот город, и маршрут "разъезжался" на сотни-тысячи км
// вместо пары километров внутри города. Поэтому улица ищется только внутри
// населённого пункта, указанного в начале адреса («г. Семей, ул. Ленина,
// 5», см. settlements.js): viewbox+bounded=1 — его граница. Адрес без
// населённого пункта (старые заявки) — в окрестностях Усть-Каменогорска.
// Не нашлось — null: безопаснее, чем тихо посчитать маршрут до другого города.
const GEOCODE_COUNTRY_CODES = process.env.RIDES_GEOCODE_COUNTRY_CODES || 'kz';

const AVERAGE_SPEED_KMH = 40;   // средняя по городу с поправкой на пробки
// Между населёнными пунктами (Семей, Риддер, Новая Бухтарма) — трасса.
// Город от трассы по координатам не отличаем, поэтому по длине участка:
// первые CITY_PART_KM каждого участка — по городу (выезд/въезд), остальное —
// по трассе. Поездка по городу (участки до 10 км) считается как раньше.
const HIGHWAY_SPEED_KMH = 80;
const CITY_PART_KM = 10;
const WAIT_MINUTES = 10;        // посадка/высадка на конечной точке
const PER_STOP_MINUTES = 5;     // остановка на каждом промежуточном пункте
const ROAD_FACTOR = 1.3;        // расстояние по прямой → примерная длина по дорогам
const GEOCODE_TTL_DAYS = 30;
// place_rank Nominatim: 26–27 — улица, 28 — дом с номером, 30 — здание,
// организация. Ниже 28 — найдена только улица (а она бывает в километры
// длиной), район или город: такую точку для маршрута не берём.
const PRECISE_PLACE_RANK = 28;

// Время в пути по одному участку маршрута, минуты (без ожидания).
function legDriveMinutes(km) {
  const city = Math.min(km, CITY_PART_KM);
  return (city / AVERAGE_SPEED_KMH) * 60 + ((km - city) / HIGHWAY_SPEED_KMH) * 60;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function geocodeRaw(address, viewbox) {
  const params = new URLSearchParams({
    q: address,
    format: 'jsonv2',
    limit: '1',
    countrycodes: GEOCODE_COUNTRY_CODES,
    viewbox,
    bounded: '1',
  });
  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, { headers: { 'User-Agent': 'my-first-site-rides/1.0' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), precise: Number(data[0].place_rank) >= PRECISE_PLACE_RANK };
}

// Кэш geocode_cache: свежую запись (в пределах TTL) отдаём сразу, включая
// «отрицательную» (found = 0) — чтобы не долбить Nominatim повторно тем же
// неразбираемым адресом. Сетевую ошибку не кэшируем; если есть протухшая
// запись с координатами — на время недоступности сервиса отдаём её.
async function geocodeAddress(address) {
  const key = String(address || '').trim();
  if (!key) return null;
  const db = getWriteDb();
  const r = await lookupAddress(key);
  return r.status === 'found' || r.status === 'street' ? { lat: r.lat, lng: r.lng } : null;
}

// Что и где искать по тексту адреса: { cacheKey, queries, viewbox } либо
// { status } — населённый пункт не найден / карта не ответила.
//   «г. Семей, ул. Ленина, 5» — улица в границах Семея: сначала вместе с
//   названием города (точнее), затем без него (в сёлах дома на карте часто
//   без привязки к селу);
//   без населённого пункта (старые заявки) — как раньше, в Усть-Каменогорске.
// Ключ кэша — с населённым пунктом: та же улица в другом городе — другая
// точка, а записи до появления поля (искались в Усть-Каменогорске, в том
// числе ошибочно — «г. Шемонаиха, ...») не подхватываются.
async function searchPlan(address) {
  const split = await splitSettlement(address);
  if (!split) return { cacheKey: address, queries: [address], viewbox: KNOWN[0].box };
  const s = split.settlement;
  if (s.status !== 'found') return { status: s.status === 'unavailable' ? 'unavailable' : 'not_found' };
  return { cacheKey: `${normalize(s.name)}|${split.rest}`, queries: [`${split.rest}, ${s.query}`, split.rest], viewbox: s.box };
}

// Поиск адреса с кэшем и оценкой точности:
//   found       — конкретное место (дом, здание, организация);
//   street      — только улица/район/город — точку нужно отметить на карте;
//   not_found   — не найдено в окрестностях города;
//   unavailable — геокодер не ответил (и в кэше ничего) — тоже на карту.
// lat/lng есть у found и street (street — чтобы открыть карту на этой улице).
async function lookupAddress(address) {
  const text = String(address || '').trim();
  if (!text) return { status: 'not_found' };
  const plan = await searchPlan(text);
  if (plan.status) return { status: plan.status };
  const key = plan.cacheKey;
  const db = getWriteDb();
  const row = db.prepare('SELECT lat, lng, found, precise, fetched_at FROM geocode_cache WHERE address = ?').get(key);
  const fromRow = (r) => (r.found ? { status: r.precise ? 'found' : 'street', lat: r.lat, lng: r.lng } : { status: 'not_found' });
  if (row) {
    const ageDays = (Date.now() - new Date(row.fetched_at + 'Z').getTime()) / 86400000;
    // Записи без точности (из кэша до её появления) — переспрашиваем.
    if (ageDays < GEOCODE_TTL_DAYS && (!row.found || row.precise != null)) return fromRow(row);
  }
  let result = null;
  try {
    // До первого точного (дом, здание); иначе — первое неточное (улица).
    for (const q of plan.queries) {
      const r = await geocodeRaw(q, plan.viewbox); // последовательно — щадим лимит Nominatim
      if (r && (r.precise || !result)) result = r;
      if (result?.precise) break;
    }
  } catch (err) {
    if (row && row.found && row.precise != null) return fromRow(row);
    return row && row.found ? { status: 'street', lat: row.lat, lng: row.lng } : { status: 'unavailable' };
  }
  db.prepare(
    `INSERT INTO geocode_cache (address, lat, lng, found, precise, fetched_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(address) DO UPDATE SET
       lat = excluded.lat, lng = excluded.lng, found = excluded.found, precise = excluded.precise, fetched_at = excluded.fetched_at`
  ).run(key, result ? result.lat : null, result ? result.lng : null, result ? 1 : 0, result ? (result.precise ? 1 : 0) : null);
  return result ? { status: result.precise ? 'found' : 'street', lat: result.lat, lng: result.lng } : { status: 'not_found' };
}

async function osrmLegKm(points) {
  const coordsParam = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`${OSRM_URL}/${coordsParam}?overview=false`);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route || !route.legs) throw new Error('OSRM: маршрут не построен');
  return route.legs.map((l) => l.distance / 1000);
}

// coords — массив ({ lat, lng } | null) по порядку: подача, назначение,
// доп. пункты. withReturn достраивает обратный путь до первой точки.
// Возвращает { distanceKm, durationMin, perPoint, source } или null, если
// известных точек меньше двух.
//   perPoint[i] = { index, etaMinutes } — накопительное время от старта до
//   прибытия в i-ю точку прямого маршрута (index 0 — старт, eta 0).
//   source: 'osrm' | 'heuristic' | 'heuristic-partial'.
async function estimateFromPoints(coords, withReturn) {
  if (coords.filter(Boolean).length < 2) return null;

  const forward = coords.slice();
  const forwardLegCount = forward.length - 1;
  const allKnown = forward.every(Boolean);

  let legKm = null;
  let source = 'heuristic';

  if (allKnown) {
    const routePoints = withReturn ? forward.concat([...forward].reverse().slice(1)) : forward;
    try {
      legKm = await osrmLegKm(routePoints);
      source = 'osrm';
    } catch (err) {
      legKm = null;
    }
  }

  if (!legKm) {
    const fwdLegs = [];
    for (let i = 1; i < forward.length; i++) {
      const a = forward[i - 1];
      const b = forward[i];
      fwdLegs.push(a && b ? haversineKm(a, b) * ROAD_FACTOR : null);
    }
    const knownLegs = fwdLegs.filter((x) => x != null);
    const avgLeg = knownLegs.length ? knownLegs.reduce((s, x) => s + x, 0) / knownLegs.length : 5;
    let legs = fwdLegs.map((x) => (x == null ? avgLeg : x));
    if (withReturn) legs = legs.concat([...legs].reverse());
    legKm = legs;
    source = knownLegs.length === fwdLegs.length ? 'heuristic' : 'heuristic-partial';
  }

  const totalKm = legKm.reduce((s, x) => s + x, 0);
  const distanceKm = Math.round(totalKm * 10) / 10;

  const perPoint = [{ index: 0, etaMinutes: 0 }];
  let cumMin = 0;
  for (let i = 0; i < forwardLegCount; i++) {
    cumMin += legDriveMinutes(legKm[i]);
    const wait = WAIT_MINUTES + PER_STOP_MINUTES * i;
    perPoint.push({ index: i + 1, etaMinutes: Math.round(cumMin + wait) });
  }

  const durationMin =
    Math.round(legKm.reduce((s, km) => s + legDriveMinutes(km), 0)) +
    WAIT_MINUTES +
    PER_STOP_MINUTES * Math.max(0, forwardLegCount - 1);

  return { distanceKm, durationMin, perPoint, source };
}

// Единая точка пересчёта оценки для заявки: геокодирует все её точки (с
// кэшем), строит маршрут, сохраняет координаты и оценку в БД, пишет
// событие route_recomputed в журнал. Асинхронная и делает запись в БД
// (маленькую синхронную транзакцию в конце) — вызывать вне
// db.transaction(...) вызывающей стороны. Возвращает
// { distanceKm, durationMin, expectedCompletionAt, perPoint, source } либо null.
async function recomputeRequestEstimate(requestId, { actorUserId = null } = {}) {
  const db = getWriteDb();
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
  if (!request) return null;
  const stops = db
    .prepare('SELECT * FROM request_stops WHERE request_id = ? ORDER BY stop_order ASC')
    .all(requestId);

  const addrList = [request.from_address, request.to_address, ...stops.map((st) => st.address)];
  // Координаты точки, если уже известны (отмечена на карте или найдена при
  // подаче заявки), — главнее текста адреса: текст — подпись для водителя
  // («ул. Базовая, склад №2»), а считаем по точке. Нет — ищем по тексту.
  const stored = [
    [request.from_lat, request.from_lng],
    [request.to_lat, request.to_lng],
    ...stops.map((st) => [st.lat, st.lng]),
  ];
  const coords = [];
  for (let i = 0; i < addrList.length; i++) {
    const [lat, lng] = stored[i];
    coords.push(lat != null && lng != null ? { lat, lng } : await geocodeAddress(addrList[i])); // последовательно — щадим лимит Nominatim
  }

  const estimate = await estimateFromPoints(coords, !!request.with_return);

  let expectedCompletionAt = null;
  if (estimate) {
    // База отсчёта: для уже начатой поездки — «сейчас», иначе — желаемое
    // время подачи (если оно в будущем).
    let base = Date.now();
    if (request.status !== 'in_progress' && request.requested_at) {
      const t = new Date(request.requested_at).getTime();
      if (!Number.isNaN(t) && t > base) base = t;
    }
    expectedCompletionAt = new Date(base + estimate.durationMin * 60000).toISOString();
  }

  const write = db.transaction(() => {
    db.prepare(
      `UPDATE requests SET
         distance_km = ?, duration_min = ?,
         from_lat = ?, from_lng = ?, to_lat = ?, to_lng = ?,
         expected_completion_at = ?
       WHERE id = ?`
    ).run(
      estimate ? estimate.distanceKm : null,
      estimate ? estimate.durationMin : null,
      coords[0] ? coords[0].lat : null,
      coords[0] ? coords[0].lng : null,
      coords[1] ? coords[1].lat : null,
      coords[1] ? coords[1].lng : null,
      expectedCompletionAt,
      requestId
    );
    const updStop = db.prepare('UPDATE request_stops SET lat = ?, lng = ? WHERE id = ?');
    stops.forEach((st, i) => {
      const c = coords[2 + i];
      updStop.run(c ? c.lat : null, c ? c.lng : null, st.id);
    });
    logEvent(db, {
      requestId,
      type: 'route_recomputed',
      actorUserId,
      payload: estimate
        ? {
            distanceKm: estimate.distanceKm,
            durationMin: estimate.durationMin,
            expectedCompletionAt,
            source: estimate.source,
            points: addrList.length,
          }
        : { ok: false, reason: 'не удалось определить координаты маршрута' },
    });
  });
  write();

  if (!estimate) return null;
  return {
    ...estimate,
    expectedCompletionAt,
    perPoint: estimate.perPoint.map((p) => ({ ...p, address: addrList[p.index] })),
  };
}

// Обратная совместимость: разовая оценка по списку адресов, без записи в
// БД. Использует тот же кэш геокодера и тот же расчёт.
async function estimateRoute(addresses, withReturn) {
  try {
    const coords = [];
    for (const a of addresses) coords.push(await geocodeAddress(a));
    const est = await estimateFromPoints(coords, withReturn);
    return est ? { distanceKm: est.distanceKm, durationMin: est.durationMin } : null;
  } catch (err) {
    return null;
  }
}

// Куда вставить новую точку, чтобы крюк был минимальным («ближайший
// участок маршрута», П.1 ТЗ). chain — координаты узлов ПОСЛЕ точки подачи:
// chain[0] — адрес назначения (to), chain[1..] — существующие доп. пункты
// по порядку; элементы могут быть null (координата не определилась).
// Возвращает stop_order для новой точки (0..N): существующие пункты с
// order >= результата сдвигаются на +1. Нет координат — в конец.
function chooseInsertIndex(chain, newC) {
  const n = chain.length - 1; // число доп. пунктов (chain[0] — это to)
  if (!newC) return n;
  let best = n;
  let bestCost = Infinity;
  for (let k = 0; k <= n; k++) {
    const a = chain[k];
    if (!a) continue;
    const b = chain[k + 1] || null;
    const cost = haversineKm(a, newC) + (b ? haversineKm(newC, b) - haversineKm(a, b) : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = k;
    }
  }
  return best;
}

// Ориентировочная разница во времени поездки от предлагаемого изменения
// маршрута — «≈ +X мин», которую видит диспетчер в очереди на модерацию.
// За «до» берём уже посчитанное requests.duration_min (не гоняем маршрут
// повторно), «после» считаем на лету. Для add точка добавляется в конец —
// это верхняя оценка (реальная вставка «по ближайшему участку» короче).
async function estimateProposalImpact(requestId, { action, targetStopId, address }) {
  const db = getWriteDb();
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
  if (!request || request.duration_min == null) return null;
  const stops = db
    .prepare('SELECT * FROM request_stops WHERE request_id = ? ORDER BY stop_order ASC')
    .all(requestId);
  const baseAddrs = [request.from_address, request.to_address, ...stops.map((s) => s.address)];
  const idx = stops.findIndex((s) => s.id === targetStopId);

  let nextAddrs;
  if (action === 'add') {
    nextAddrs = [...baseAddrs, address];
  } else if (action === 'remove') {
    if (idx < 0) return null;
    nextAddrs = baseAddrs.filter((_, i) => i !== idx + 2);
  } else {
    if (idx < 0) return null;
    nextAddrs = baseAddrs.map((a, i) => (i === idx + 2 ? address : a));
  }

  const after = await estimateRoute(nextAddrs, !!request.with_return);
  if (!after) return null;
  return after.durationMin - request.duration_min;
}

module.exports = {
  estimateRoute,
  estimateFromPoints,
  recomputeRequestEstimate,
  geocodeAddress,
  lookupAddress,
  chooseInsertIndex,
  estimateProposalImpact,
};
