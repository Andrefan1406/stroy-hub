// Обмер по плану: подсказки для калибровки листа и пересчёт замеров в количество.
// Сами замеры рисуются на холсте из инструмента подсчёта объёмов (src/takeoff).
import { POINT_M, measurementQuantity, toNumber } from "../takeoff/model";

export const RISER_HEIGHT_M = 0.15; // высота подступенка лестницы, м
export const PLINTH_HEIGHT_M = 0.1; // высота плинтуса, м (прибавляется к длине плинтуса по ступени)
const SCALES =[20, 25, 50, 75, 100, 150, 200, 250, 500];
const MAX_REL_ERROR = 0.03;

// Масштаб листа по размеру между крайними осями: расстояние между подписями осей на плане (пункты PDF) ×
// масштаб должно дать ту же длину, что написана на размерной цепочке («26800»). Берём лучшее совпадение
// (не более 3 %), поэтому «54400» по двум секциям не подменит «26800» по одной.
// Верно, если PDF сохранён в натуральную величину листа — пользователь подтверждает предложение.
export function suggestScale(items, axisLabels) {
  if (!axisLabels || axisLabels.length < 2) return null;
  const span = Math.abs(axisLabels[axisLabels.length - 1].x - axisLabels[0].x); // пункты
  if (!(span > 0)) return null;
  const dims = (items || [])
    .map((i) => String(i.str ?? "").trim())
    .filter((s) => /^\d{4,6}$/.test(s))
    .map(Number)
    .filter((v) => v >= 5000);
  let best = null;
  for (const mm of new Set(dims)) {
    for (const n of SCALES) {
      const expected = span * POINT_M * n * 1000;
      const err = Math.abs(expected - mm) / mm;
      if (err <= MAX_REL_ERROR && (!best || err < best.err)) best = { scale: n, dimensionMm: mm, err };
    }
  }
  return best ? { scale: best.scale, dimensionMm: best.dimensionMm } : null;
}

// «Высота от пола до потолка - 2,72 м» в общих данных → 2.72
export function findCeilingHeight(pages) {
  for (const p of pages || []) {
    const m = String(p.text ?? "").match(/высота\s+от\s+пола\s+до\s+потолка\s*[-–—:]?\s*(\d+(?:[.,]\d+)?)\s*м/i);
    if (m) return { value: Number(m[1].replace(",", ".")), page: p.page };
  }
  return null;
}

// Замеры задачи → количество: сумма длин (м) или площадей стен «длина × высота» (м²) за вычетом проёмов.
// Проём — линия с deduct: для стен площадь проёма = ширина × высота проёма (у каждого своя), для плинтуса — ширина.
// lines — линии на листах; calibrations — { лист: метров в пункте PDF }; height — высота от пола до потолка, м (для задач «стены»).
// → { total (с вычетом), gross, deducted, uncounted }
export function taskTotal(lines, calibrations, { kind, height } = {}) {
  let gross = 0;
  let deducted = 0;
  let uncounted = 0;
  let treadArea = 0;
  let riserArea = 0;
  let plinthLength = 0;
  for (const m of lines || []) {
    if (kind === "platform") {
      // площадка: площадь по контуру; плинтус — две короткие стороны и одна длинная (по габаритам контура)
      const k = calibrations?.[m.page];
      const pts = m.points || [];
      if (!k || pts.length < 3) {
        uncounted += 1;
        continue;
      }
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const sideX = (Math.max(...xs) - Math.min(...xs)) * k;
      const sideY = (Math.max(...ys) - Math.min(...ys)) * k;
      treadArea += measurementQuantity({ ...m, kind: "area", calc: "area", count: 1, deduct: false }, k);
      plinthLength += 2 * Math.min(sideX, sideY) + Math.max(sideX, sideY);
      continue;
    }
    if (kind === "steps") {
      // марш: контур ОДНОЙ ступени (проступь) × число ступеней (count); подступенков столько же, сколько ступеней:
      // площадь подступенков = ширина ступени (большая сторона контура) × 0,15 м × число ступеней
      const k = calibrations?.[m.page];
      const pts = m.points || [];
      if (!k || pts.length < 3) {
        uncounted += 1;
        continue;
      }
      const n = m.count > 0 ? m.count : 1;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const sideX = (Math.max(...xs) - Math.min(...xs)) * k;
      const sideY = (Math.max(...ys) - Math.min(...ys)) * k;
      const width = Math.max(sideX, sideY);
      // плинтус по одной ступени: ширина ступени (малая сторона контура) + 100 мм высоты плинтуса + 150 мм высоты подступенка
      plinthLength += (Math.min(sideX, sideY) + PLINTH_HEIGHT_M + RISER_HEIGHT_M) * n;
      treadArea += measurementQuantity({ ...m, kind: "area", calc: "area", count: 1, deduct: false }, k) * n;
      riserArea += width * RISER_HEIGHT_M * n;
      continue;
    }
    const isRisers = kind === "risers"; // подступенки лестницы: ширина ступени × 0,15 м × число ступеней (count линии)
    const isWalls = kind === "walls" || kind === "box" || isRisers; // короб — тоже «длина × высота»
    // площадь пола лестницы: замкнутые контуры маршей и площадок, площадь считается по контуру
    const q = kind === "stairarea" || kind === "stairunder" ? measurementQuantity({ ...m, kind: "area", calc: "area", count: 1, deduct: false }, calibrations?.[m.page]) : measurementQuantity(
      { ...m, kind: "line", calc: isWalls ? "wall" : "length", height: isRisers ? RISER_HEIGHT_M : isWalls ? (m.deduct ? m.height : height) : undefined, count: isRisers && m.count > 0 ? m.count : 1, deduct: false },
      calibrations?.[m.page],
    );
    if (q === null) uncounted += 1;
    else if (m.deduct) deducted += q;
    else gross += q;
  }
  const round = (v) => Math.round(v * 100) / 100;
  if (kind === "platform") return { total: round(treadArea), gross: round(treadArea), deducted: 0, uncounted, area: round(treadArea), plinth: round(plinthLength) };
  if (kind === "steps") return { total: round(treadArea + riserArea), gross: round(treadArea + riserArea), deducted: 0, uncounted, area: round(treadArea), risers: round(riserArea), plinth: round(plinthLength) };
  return { total: round(Math.max(0, gross - deducted)), gross: round(gross), deducted: round(deducted), uncounted };
}

// Типовые проёмы: тип → название и высота по умолчанию, м (можно исправить: у каждого проёма высота своя)
export const OPENING_TYPES = {
  door: { label: "Дверь", height: "2,1" },
  window: { label: "Окно", height: "1,5" },
  glazing: { label: "Витраж / другой проём", height: "1,82" },
};

// Введено вручную («12,5», «12.5») → число; пусто или не число → null
export function parseManual(value) {
  const t = String(value ?? "").trim();
  if (!t) return null;
  const n = toNumber(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
