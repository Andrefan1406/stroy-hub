// Новая редакция чертежа: перенос замеров со старого PDF на новый без
// пересчёта вручную. Чистые функции.
//
// Совмещение листа — преобразование подобия (сдвиг + поворот + единый
// масштаб) из старых единиц PDF в новые, по двум парам точек «было → стало»
// (например, пересечения осей А/1 и Г/5). Метры при этом не меняются:
// калибровка нового листа = старая / масштаб.
//
// Преобразование: x' = a·x − b·y + tx, y' = b·x + a·y + ty, где
// a = s·cos φ, b = s·sin φ. В CSS — matrix(a, b, −b, a, tx, ty).
import { rectOf } from "./masonry";

export const IDENTITY = { a: 1, b: 0, tx: 0, ty: 0 };

export const scaleOf = (t) => Math.hypot(t.a, t.b);
export const angleOf = (t) => (Math.atan2(t.b, t.a) * 180) / Math.PI;
export const isIdentity = (t) => !t || (Math.abs(t.a - 1) < 1e-9 && Math.abs(t.b) < 1e-9 && Math.abs(t.tx) < 1e-9 && Math.abs(t.ty) < 1e-9);

export const applyT = (t, p) => (t ? { x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty } : p);

export function invertT(t) {
  const d = t.a * t.a + t.b * t.b;
  const a = t.a / d;
  const b = -t.b / d;
  return { a, b, tx: -(a * t.tx - b * t.ty), ty: -(b * t.tx + a * t.ty) };
}

// По двум парам точек: a1 -> b1, a2 -> b2. null — точки слишком близко.
export function similarityFromPairs(a1, b1, a2, b2) {
  const va = { x: a2.x - a1.x, y: a2.y - a1.y };
  const vb = { x: b2.x - b1.x, y: b2.y - b1.y };
  const la = va.x * va.x + va.y * va.y;
  if (la < 1e-6 || vb.x * vb.x + vb.y * vb.y < 1e-6) return null;
  // Комплексное деление vb / va = s·e^{iφ}.
  const a = (vb.x * va.x + vb.y * va.y) / la;
  const b = (vb.y * va.x - vb.x * va.y) / la;
  return { a, b, tx: b1.x - (a * a1.x - b * a1.y), ty: b1.y - (b * a1.x + a * a1.y) };
}

// Прямоугольник (две точки по диагонали, оси параллельны листу) после
// поворота остаётся прямоугольником с осями по листу: центр переносим,
// размеры × масштаб, при повороте ближе к 90° — стороны меняются местами.
export function transformRect(points, t) {
  const r = rectOf(points);
  const c = applyT(t, { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
  const s = scaleOf(t);
  let w = (r.x1 - r.x0) * s;
  let h = (r.y1 - r.y0) * s;
  if (Math.abs(t.b) > Math.abs(t.a)) [w, h] = [h, w];
  return [{ x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 }];
}

export function transformMeasurement(m, t) {
  if (!t || isIdentity(t)) return m;
  if (m.kind === "rect") return { ...m, points: transformRect(m.points, t), channels: (m.channels || []).map((c) => transformRect(c, t)) };
  return { ...m, points: m.points.map((p) => applyT(t, p)) };
}

// Перенос проекта на новую редакцию.
//   pageMap: старый лист -> новый лист (null — не переносить);
//   transforms: старый лист -> совмещение (нет — без сдвига).
// Возвращает новые measurements и calibrations, и список непереносимых замеров.
export function transferProject({ measurements, calibrations }, { pageMap, transforms = {} }) {
  const out = [];
  const dropped = [];
  for (const m of measurements) {
    const page = pageMap[m.page];
    if (page == null) {
      dropped.push(m);
      continue;
    }
    out.push({ ...transformMeasurement(m, transforms[m.page]), page });
  }
  // Проёмы на плане без стены (стена не перенесена) — тоже не переносим.
  const ids = new Set(out.map((m) => m.id));
  const kept = out.filter((m) => !(m.role === "opening" && !ids.has(m.wallId)));
  dropped.push(...out.filter((m) => !kept.includes(m)));
  const cal = {};
  for (const [oldPage, mpu] of Object.entries(calibrations)) {
    const page = pageMap[oldPage];
    if (page == null || !mpu) continue;
    cal[page] = mpu / scaleOf(transforms[oldPage] || IDENTITY);
  }
  return { measurements: kept, calibrations: cal, dropped };
}

// Листы старой редакции, которые нужно сопоставить: где есть замеры или калибровка.
export function pagesToMap({ measurements, calibrations }) {
  const set = new Set(measurements.map((m) => m.page));
  for (const p of Object.keys(calibrations)) set.add(Number(p));
  return [...set].sort((a, b) => a - b);
}

// Новые листы должны быть разными: два старых листа на один новый — ошибка.
export function pageMapConflicts(pageMap) {
  const seen = {};
  const conflicts = [];
  for (const page of Object.values(pageMap)) {
    if (page == null) continue;
    if (seen[page]) conflicts.push(page);
    seen[page] = true;
  }
  return [...new Set(conflicts)];
}

// Начальное совмещение по размеру листа: тот же чертёж, выгруженный на лист
// другого формата или в другом масштабе, — пропорции листа те же, размеры
// в k раз другие. Тогда старый лист сразу подгоняется × k (от левого
// верхнего угла); дальше при необходимости уточняется по двум точкам.
// null — размеры совпадают или пропорции разные (подгонять нечего / нельзя).
export function guessTransform(oldSize, newSize) {
  if (!oldSize || !newSize) return null;
  const rx = newSize.width / oldSize.width;
  const ry = newSize.height / oldSize.height;
  if (Math.abs(rx / ry - 1) > 0.02 || Math.abs(rx - 1) < 0.005) return null;
  return { a: (rx + ry) / 2, b: 0, tx: 0, ty: 0 };
}

// Габарит листа после совмещения — чтобы на экране был виден весь старый
// чертёж с замерами, а не только новый лист.
export function transformedBounds(size, t) {
  const pts = [{ x: 0, y: 0 }, { x: size.width, y: 0 }, { x: size.width, y: size.height }, { x: 0, y: size.height }].map((p) => applyT(t, p));
  return {
    x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)),
  };
}
