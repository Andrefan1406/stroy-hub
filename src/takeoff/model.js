// Подсчёт объёмов отделочных работ по PDF-чертежу: геометрия замеров,
// калибровка масштаба и ведомость объёмов. Чистые функции.
//
// Координаты точек — в единицах страницы PDF (пункты, 1/72 дюйма) при
// масштабе 1: от зума и разрешения отрисовки не зависят. Калибровка
// страницы — сколько метров в одной единице (metersPerUnit).

export const POINT_M = 0.0254 / 72; // 1 пункт PDF в метрах на бумаге

// Масштаб листа 1:N -> метров в единице PDF. Верно, только если PDF
// сохранён в натуральную величину листа (обычно так при экспорте из CAD).
export const metersPerUnitFromScale = (n) => POINT_M * n;

// По двум точкам известного размера: расстояние в единицах PDF и
// настоящая длина в метрах.
export const metersPerUnitFromDistance = (units, meters) => (units > 0 && meters > 0 ? meters / units : null);

export const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export function polylineLength(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i]);
  return sum;
}

export function polygonArea(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export const polygonPerimeter = (points) => (points.length > 1 ? polylineLength([...points, points[0]]) : 0);

export function centroid(points) {
  const n = points.length || 1;
  return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
}

// Способы расчёта: что из замера берём в ведомость.
//   area kind (контур):  area — площадь, м²; perimeter — периметр, м;
//                        volume — площадь × толщина, м³.
//   line kind (линия):   length — длина, м; wall — длина × высота, м²
//                        (стены по контуру помещения на плане; с вычетом —
//                        дверь или окно: ширина проёма × его высота).
export const CALCS = {
  area: { kind: "area", unit: "м²", label: "Площадь" },
  perimeter: { kind: "area", unit: "м", label: "Периметр" },
  volume: { kind: "area", unit: "м³", label: "Объём (площадь × толщина)" },
  length: { kind: "line", unit: "м", label: "Длина" },
  wall: { kind: "line", unit: "м²", label: "Площадь стен (длина × высота)" },
};

export const defaultCalc = (kind) => (kind === "area" ? "area" : "length");

// Высота и толщина приходят из поля ввода как есть («2,7», «0.05») —
// в число превращаем здесь.
export const toNumber = (v) => (typeof v === "number" ? v : Number(String(v ?? "").trim().replace(",", ".")));

// Количество по замеру с учётом калибровки, вычета и числа одинаковых
// (например, типовые этажи). null — страница не откалибрована или не
// хватает высоты/толщины.
export function measurementQuantity(m, metersPerUnit) {
  if (!metersPerUnit) return null;
  const calc = CALCS[m.calc] ? m.calc : defaultCalc(m.kind);
  const k = metersPerUnit;
  let q;
  if (calc === "area") q = polygonArea(m.points) * k * k;
  else if (calc === "perimeter") q = polygonPerimeter(m.points) * k;
  else if (calc === "volume") q = toNumber(m.thickness) > 0 ? polygonArea(m.points) * k * k * toNumber(m.thickness) : null;
  else if (calc === "length") q = polylineLength(m.points) * k;
  else if (calc === "wall") q = toNumber(m.height) > 0 ? polylineLength(m.points) * k * toNumber(m.height) : null;
  if (q == null) return null;
  const count = m.count > 0 ? m.count : 1;
  return (m.deduct ? -1 : 1) * q * count;
}

export const unitOf = (m) => (CALCS[m.calc] || CALCS[defaultCalc(m.kind)]).unit;

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const round = (v, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

// Ведомость объёмов: по виду работ и единице — итог (вычеты уже с минусом).
// Подробно — строка на каждый замер. Замеры с неоткалиброванных страниц
// или без высоты/толщины в итог не идут — их список в skipped.
export function buildStatement(measurements, calibrations) {
  const totals = new Map();
  const details = [];
  const skipped = [];
  for (const m of measurements) {
    const q = measurementQuantity(m, calibrations[m.page]);
    const work = (m.work || "").trim() || "Без названия";
    const unit = unitOf(m);
    if (q == null) {
      skipped.push(m);
      continue;
    }
    details.push({ work, unit, room: (m.room || "").trim(), page: m.page, quantity: round(q), deduct: !!m.deduct, count: m.count > 1 ? m.count : 1 });
    const key = `${work}\u0000${unit}`;
    totals.set(key, { work, unit, quantity: (totals.get(key)?.quantity || 0) + q });
  }
  const rows = [...totals.values()]
    .map((r) => ({ ...r, quantity: round(r.quantity) }))
    .sort((a, b) => collator.compare(a.work, b.work) || collator.compare(a.unit, b.unit));
  details.sort((a, b) => collator.compare(a.work, b.work) || collator.compare(a.room, b.room) || a.page - b.page);
  return { rows, details, skipped };
}

// Типовые виды отделочных работ — подсказки в поле «Вид работ».
export const WORK_SUGGESTIONS = [
  { work: "Штукатурка стен", calc: "wall" },
  { work: "Шпатлёвка стен", calc: "wall" },
  { work: "Окраска стен", calc: "wall" },
  { work: "Оклейка стен обоями", calc: "wall" },
  { work: "Облицовка стен плиткой", calc: "wall" },
  { work: "Устройство стяжки пола", calc: "area" },
  { work: "Устройство наливного пола", calc: "area" },
  { work: "Укладка ламината", calc: "area" },
  { work: "Укладка линолеума", calc: "area" },
  { work: "Облицовка пола плиткой", calc: "area" },
  { work: "Устройство подвесного потолка", calc: "area" },
  { work: "Окраска потолка", calc: "area" },
  { work: "Шпатлёвка потолка", calc: "area" },
  { work: "Монтаж плинтуса", calc: "length" },
  { work: "Бетон стяжки", calc: "volume" },
];
