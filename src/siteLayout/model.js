// Модель схемы бытовок: размеры, привязка бытовок к заголовкам и сводная
// таблица. Чистые функции — таблица пересчитывается из объектов схемы при
// каждом изменении (своём или чужом).

export const CABIN_SIZES = {
  "12x2.5": { w: 12, h: 2.5, label: "Бытовка 12×2,5" },
  "6x2.5": { w: 6, h: 2.5, label: "Бытовка 6×2,5" },
};

// Привязка «по соседству»: бытовки, между которыми не больше LINK_DISTANCE_M
// (промежуток между краями), образуют цепочку; цепочка относится к
// заголовку, который не дальше LINK_DISTANCE_M от какой-нибудь её бытовки.
// Если цепочка дотягивается до нескольких заголовков, каждая бытовка
// уходит к тому, до которого путь по цепочке короче. Не дотянулась ни до
// одного — «Без объекта».
export const LINK_DISTANCE_M = 20;
export const NO_OBJECT = "Без объекта";
const UNTITLED = "Без названия";
const EMPTY_CONTENT = "—";

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const titleText = (title) => (title.text || "").trim() || UNTITLED;

// --- геометрия: бытовка — повёрнутый прямоугольник ---

export function cabinCorners(c) {
  const { w, h } = CABIN_SIZES[c.size] || CABIN_SIZES["6x2.5"];
  const a = ((c.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [
    c.x + x * cos - y * sin,
    c.y + x * sin + y * cos,
  ]);
}

function pointSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insidePolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const edges = (poly) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]]);

function segmentsCross([a, b], [c, d]) {
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

// Расстояние от точки (центр заголовка) до бытовки: 0 — внутри.
export function pointToCabin(p, cabin) {
  const poly = cabinCorners(cabin);
  if (insidePolygon(p, poly)) return 0;
  return Math.min(...edges(poly).map(([a, b]) => pointSegment(p, a, b)));
}

// Промежуток между краями двух бытовок: 0 — касаются или перекрываются.
export function cabinGap(c1, c2) {
  const p1 = cabinCorners(c1);
  const p2 = cabinCorners(c2);
  if (p1.some((p) => insidePolygon(p, p2)) || p2.some((p) => insidePolygon(p, p1))) return 0;
  const e1 = edges(p1);
  const e2 = edges(p2);
  if (e1.some((s1) => e2.some((s2) => segmentsCross(s1, s2)))) return 0;
  let best = Infinity;
  for (const [a, b] of e1) for (const p of p2) best = Math.min(best, pointSegment(p, a, b));
  for (const [a, b] of e2) for (const p of p1) best = Math.min(best, pointSegment(p, a, b));
  return best;
}

// { cabinId: { titleId, via } } — via: соседняя бытовка (или заголовок), через
// которую бытовка привязана, — для линий цепочки на схеме. Кратчайший путь
// по цепочке от всех заголовков сразу (Дейкстра); шаг — не больше limit.
export function bindCabinsDetailed(objects, limit = LINK_DISTANCE_M) {
  const titles = objects.filter((o) => o.type === "title");
  const cabins = objects.filter((o) => o.type === "cabin");
  const best = {}; // cabinId -> { dist, titleId, via }
  const better = (cand, cur) => !cur || cand.dist < cur.dist - 1e-9 || (Math.abs(cand.dist - cur.dist) < 1e-9 && cand.titleId < cur.titleId);

  for (const c of cabins) {
    for (const t of titles) {
      const d = pointToCabin([t.x, t.y], c);
      const cand = { dist: d, titleId: t.id, via: t.id };
      if (d <= limit && better(cand, best[c.id])) best[c.id] = cand;
    }
  }
  const done = new Set();
  for (;;) {
    let next = null;
    for (const c of cabins) {
      if (!done.has(c.id) && best[c.id] && (!next || best[c.id].dist < best[next.id].dist)) next = c;
    }
    if (!next) break;
    done.add(next.id);
    for (const c of cabins) {
      if (done.has(c.id)) continue;
      const gap = cabinGap(next, c);
      if (gap > limit) continue;
      const cand = { dist: best[next.id].dist + gap, titleId: best[next.id].titleId, via: next.id };
      if (better(cand, best[c.id])) best[c.id] = cand;
    }
  }
  return Object.fromEntries(cabins.map((c) => [c.id, best[c.id] ? { titleId: best[c.id].titleId, via: best[c.id].via } : null]));
}

// { cabinId: titleId | null }
export function bindCabins(objects, limit = LINK_DISTANCE_M) {
  const detailed = bindCabinsDetailed(objects, limit);
  return Object.fromEntries(Object.entries(detailed).map(([id, b]) => [id, b ? b.titleId : null]));
}

// Подписи бытовки — по порядку.
export function cabinLabels(objects, cabinId) {
  return objects
    .filter((o) => o.type === "label" && o.parentId === cabinId)
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1));
}

// Строки сводной таблицы: { object, cabinType, count, content }.
// Одинаковые бытовки (объект + тип + подпись) складываются в «Кол-во»;
// разные подписи — отдельные строки; несколько подписей у одной бытовки —
// по строке на каждую. Сортировка по алфавиту: объект («Без объекта» —
// в конце), тип бытовки, содержимое.
export function buildSummary(objects, limit = LINK_DISTANCE_M) {
  const binding = bindCabins(objects, limit);
  const titlesById = Object.fromEntries(objects.filter((o) => o.type === "title").map((t) => [t.id, t]));
  const rows = new Map();
  for (const cabin of objects.filter((o) => o.type === "cabin")) {
    const title = titlesById[binding[cabin.id]];
    const object = title ? titleText(title) : NO_OBJECT;
    const cabinType = CABIN_SIZES[cabin.size]?.label || cabin.size;
    const texts = cabinLabels(objects, cabin.id).map((l) => (l.text || "").trim()).filter(Boolean);
    for (const content of texts.length ? texts : [EMPTY_CONTENT]) {
      const key = `${object}\u0000${cabinType}\u0000${content}`;
      const row = rows.get(key) || { object, cabinType, count: 0, content };
      row.count += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      (a.object === NO_OBJECT) - (b.object === NO_OBJECT) ||
      collator.compare(a.object, b.object) ||
      collator.compare(a.cabinType, b.cabinType) ||
      collator.compare(a.content, b.content)
  );
}
