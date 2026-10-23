// Каменная кладка и другие работы из справочника: объём по замеру с учётом
// проёмов, вентшахты с каналами, расход материала, ведомость. Чистые
// функции, без UI.
//
// Справочник работ хранится на сервере (server/takeoffCatalog.js). В замер
// кладём id работы и снимок её нормы (workSnapshot) — правка нормы в
// справочнике не меняет задним числом посчитанное; устаревший снимок видно
// по version (isSnapshotStale).
//
// Проект чертежа (в браузере) дополняется общими данными:
//   floors:   [{id, name, height}]              — этажи и их высоты;
//   openings: [{id, mark, type, width, height, qty, source}] — ведомость проёмов.
// Замер кладки:
//   workId, snapshot, floorId, height + heightOverride, thickness + thicknessOverride,
//   openings: [{openingId, qty}] — проёмы из ведомости в этой стене;
//   kind "rect" (вентшахта): points — две точки по диагонали, channels — [[p1, p2], ...].
// Проём, обведённый на плане: kind "line", role "opening", wallId, openingId —
// ширина по линии, высота из марки.
import { polygonArea, polylineLength, toNumber } from "./model";

export const WORK_UNITS = ["м²", "м³", "м", "шт"];

// Способ замера работы -> каким инструментом обводится.
export const METHODS = {
  wall_length: { kind: "line", label: "Стена/перегородка по длине (длина × высота)" },
  rect_channels: { kind: "rect", label: "Прямоугольник с каналами (вентшахта)" },
  area: { kind: "area", label: "Контур площади" },
  length: { kind: "line", label: "Длина" },
};

export const OPENING_TYPES = { door: "Дверь", window: "Окно", opening: "Проём" };

const num = (v) => {
  const n = toNumber(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const EPS = 1e-9;

// --- справочник -> снимок в замере ---

export function workSnapshot(work, group) {
  return {
    version: work.version,
    name: work.name,
    groupId: work.groupId,
    groupName: group?.name || "",
    groupSort: group?.sort ?? 0,
    unit: work.unit,
    method: work.method,
    thickness: work.thickness ?? null,
    materialName: work.materialName || "",
    materialUnit: work.materialUnit || "",
    materialRate: work.materialRate ?? null,
    workPrice: work.workPrice ?? null,
    materialPrice: work.materialPrice ?? null,
    countOpenings: !!work.countOpenings,
  };
}

export const isSnapshotStale = (m, worksById) => {
  const w = m.workId ? worksById[m.workId] : null;
  return !!(w && m.snapshot && w.version !== m.snapshot.version);
};

// Пересчёт по текущим нормам: новый снимок; ручные высота/толщина остаются.
export const refreshSnapshot = (m, work, group) => ({ ...m, snapshot: workSnapshot(work, group) });

// --- высота и толщина ---

// Высота замера: ручная (heightOverride) — как есть; иначе — высота этажа из
// общих данных. Ручная не меняется, когда меняют высоту этажа.
export function effectiveHeight(m, floors = []) {
  if (m.heightOverride) return num(m.height);
  const floor = floors.find((f) => f.id === m.floorId);
  return floor ? num(floor.height) : null;
}

export function effectiveThickness(m) {
  if (m.thicknessOverride) return num(m.thickness);
  return num(m.snapshot?.thickness);
}

// --- расчёты в метрах ---

// Стена/перегородка по длине. openings — [{width, height, qty}].
export function wallQuantity({ length, height, thickness, unit, countOpenings, openings = [] }) {
  const warnings = [];
  if (!(height > 0)) return { quantity: null, warnings: ["Укажите высоту: этаж или вручную"] };
  const gross = length * height;
  const openingsArea = countOpenings ? openings.reduce((s, o) => s + o.width * o.height * (o.qty || 0), 0) : 0;
  let net = gross - openingsArea;
  if (net < -EPS) {
    warnings.push("Проёмов больше, чем площадь стены — объём принят за 0");
    net = 0;
  }
  net = Math.max(0, net);
  let quantity;
  if (unit === "м²") quantity = net;
  else if (unit === "м³") {
    if (!(thickness > 0)) return { gross, openingsArea, net, quantity: null, warnings: [...warnings, "Укажите толщину"] };
    quantity = net * thickness;
  } else if (unit === "м") quantity = length;
  else quantity = 1;
  return { gross, openingsArea, net, quantity, warnings };
}

// Вентшахта: (площадь внешнего − Σ площадей каналов) × высота.
export function rectQuantity({ outer, channels = [], height, unit }) {
  const warnings = [];
  const outerArea = outer.w * outer.h;
  const channelsArea = channels.reduce((s, c) => s + c.w * c.h, 0);
  let net = outerArea - channelsArea;
  if (net < -EPS) {
    warnings.push("Каналы больше шахты — объём принят за 0");
    net = 0;
  }
  net = Math.max(0, net);
  if (unit === "м²") return { outerArea, channelsArea, net, quantity: net, warnings };
  if (unit === "шт") return { outerArea, channelsArea, net, quantity: 1, warnings };
  if (!(height > 0)) return { outerArea, channelsArea, net, quantity: null, warnings: [...warnings, "Укажите высоту: этаж или вручную"] };
  return { outerArea, channelsArea, net, quantity: unit === "м" ? height : net * height, warnings };
}

export function areaQuantity({ area, thickness, unit }) {
  if (unit === "м³") return thickness > 0 ? { quantity: area * thickness, warnings: [] } : { quantity: null, warnings: ["Укажите толщину"] };
  if (unit === "шт") return { quantity: 1, warnings: [] };
  return { quantity: area, warnings: [] };
}

export function lengthQuantity({ length, height, thickness, unit }) {
  if (unit === "м²") return height > 0 ? { quantity: length * height, warnings: [] } : { quantity: null, warnings: ["Укажите высоту: этаж или вручную"] };
  if (unit === "м³") {
    return height > 0 && thickness > 0 ? { quantity: length * height * thickness, warnings: [] } : { quantity: null, warnings: ["Укажите высоту и толщину"] };
  }
  if (unit === "шт") return { quantity: 1, warnings: [] };
  return { quantity: length, warnings: [] };
}

// Расход материала по объёму работы (точное значение, без округления).
export const materialUse = (quantity, snapshot) =>
  quantity != null && snapshot?.materialName && snapshot.materialRate > 0 ? quantity * snapshot.materialRate : null;

// --- прямоугольники (вентшахты и каналы) ---

export const rectOf = ([a, b]) => ({
  x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
});
const rectsIntersect = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const rectInside = (inner, outer) => inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;

// Новый прямоугольник на листе: внутри шахты — канал этой шахты; не задевает
// ни одну — новая шахта; пересекает границу шахты — ошибка.
export function placeRect(points, shafts) {
  const r = rectOf(points);
  for (const s of shafts) {
    const outer = rectOf(s.points);
    if (rectInside(r, outer)) {
      const clash = (s.channels || []).some((c) => rectsIntersect(rectOf(c), r));
      if (clash) return { error: "Канал накладывается на другой канал этой шахты" };
      return { channelOf: s.id };
    }
    if (rectsIntersect(r, outer)) return { error: "Канал выходит за границы шахты — нарисуйте его целиком внутри шахты" };
  }
  return { shaft: true };
}

// --- проёмы ---

const markKey = (mark) => String(mark || "").trim().replace(/\s+/g, " ").toUpperCase();

// Импорт проёмов из нормализованных строк {mark, type, width, height, qty}.
// Существующая марка обновляется (id сохраняется), новая — добавляется.
// Сюда же идёт ручной ввод (source "manual"); парсер спецификации, когда
// появится, будет отдавать строки в этом же виде (source "spec").
export function importOpenings(list, source, rows, makeId = () => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`) {
  const result = [...list];
  const errors = [];
  let added = 0;
  let updated = 0;
  rows.forEach((row, i) => {
    const mark = String(row.mark || "").trim();
    const width = num(row.width);
    const height = num(row.height);
    const qty = row.qty == null || row.qty === "" ? 1 : Math.round(toNumber(row.qty));
    if (!mark || !width || !height || !(qty >= 0)) {
      errors.push({ row: i, mark, error: "Нужны марка, ширина и высота больше нуля" });
      return;
    }
    const type = OPENING_TYPES[row.type] ? row.type : "opening";
    const at = result.findIndex((o) => markKey(o.mark) === markKey(mark));
    if (at >= 0) {
      result[at] = { ...result[at], mark, type, width, height, qty, source };
      updated++;
    } else {
      result.push({ id: makeId(), mark, type, width, height, qty, source });
      added++;
    }
  });
  return { openings: result, added, updated, errors };
}

// Проёмы стены: назначенные из ведомости + обведённые на плане.
function wallOpenings(m, { openings = [], measurements = [], metersPerUnit }) {
  const byId = Object.fromEntries(openings.map((o) => [o.id, o]));
  const warnings = [];
  const list = [];
  for (const a of m.openings || []) {
    const o = byId[a.openingId];
    if (!o) {
      warnings.push("Марка проёма удалена из ведомости");
      continue;
    }
    list.push({ width: o.width, height: o.height, qty: a.qty > 0 ? a.qty : 0 });
  }
  for (const d of measurements) {
    if (d.role !== "opening" || d.wallId !== m.id) continue;
    const o = byId[d.openingId];
    if (!o) {
      warnings.push("У проёма на плане не выбрана марка");
      continue;
    }
    list.push({ width: polylineLength(d.points) * metersPerUnit, height: o.height, qty: 1 });
  }
  return { list, warnings };
}

// Замер работы из справочника: объём (× одинаковых), расход материала,
// предупреждения. ctx: {metersPerUnit, floors, openings, measurements}.
export function masonryMeasure(m, ctx) {
  const w = m.snapshot;
  if (!w) return { quantity: null, material: null, warnings: ["Выберите работу из справочника"] };
  const k = ctx.metersPerUnit;
  if (!k) return { quantity: null, material: null, warnings: ["Лист не откалиброван"] };
  const height = effectiveHeight(m, ctx.floors);
  const thickness = effectiveThickness(m);
  const count = m.count > 0 ? m.count : 1;
  let r;
  if (w.method === "rect_channels" && m.kind === "rect") {
    const size = (pts) => {
      const q = rectOf(pts);
      return { w: (q.x1 - q.x0) * k, h: (q.y1 - q.y0) * k };
    };
    r = rectQuantity({ outer: size(m.points), channels: (m.channels || []).map(size), height, unit: w.unit });
  } else if (w.method === "wall_length" && m.kind === "line") {
    const op = wallOpenings(m, ctx);
    r = wallQuantity({ length: polylineLength(m.points) * k, height, thickness, unit: w.unit, countOpenings: w.countOpenings, openings: op.list });
    r.warnings = [...op.warnings, ...r.warnings];
  } else if (w.method === "area" && m.kind === "area") {
    r = areaQuantity({ area: polygonArea(m.points) * k * k, thickness, unit: w.unit });
  } else if (w.method === "length" && m.kind === "line") {
    r = lengthQuantity({ length: polylineLength(m.points) * k, height, thickness, unit: w.unit });
  } else {
    return { quantity: null, material: null, warnings: ["Способ замера работы не подходит к этому замеру"] };
  }
  const quantity = r.quantity == null ? null : r.quantity * count;
  return { ...r, quantity, material: materialUse(quantity, w), warnings: r.warnings };
}

// --- ведомость ---

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const round = (v, digits = 2) => (v == null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
// Штучное — вверх до целого (погрешность float не должна давать лишнюю штуку).
const ceilPieces = (v) => Math.ceil(Math.round(v * 1e6) / 1e6);
const isPieces = (unit) => /^шт/i.test(String(unit || "").trim());

// Ведомость по работам справочника: группа → работа → ед. → объём →
// материал → расход → суммы. Штучный материал округляется вверх на уровне
// итога по работе. materials — свод по материалам, openingsUsage — где
// использована каждая марка.
export function buildMasonryStatement(measurements, ctx) {
  const { calibrations = {}, floors = [], openings = [] } = ctx;
  const works = new Map();
  const details = [];
  const skipped = [];
  for (const m of measurements) {
    if (!m.workId || m.role === "opening") continue;
    const r = masonryMeasure(m, { metersPerUnit: calibrations[m.page], floors, openings, measurements });
    const w = m.snapshot;
    if (r.quantity == null) {
      skipped.push({ m, warnings: r.warnings });
      continue;
    }
    details.push({ m, ...r });
    const row = works.get(m.workId) || {
      workId: m.workId, groupName: w.groupName || "Без группы", groupSort: w.groupSort ?? 0, work: w.name, unit: w.unit,
      quantity: 0, materialName: w.materialName, materialUnit: w.materialUnit, materialExact: 0, workSum: 0, materialPrice: w.materialPrice,
      hasWorkPrice: false,
    };
    row.quantity += r.quantity;
    if (r.material != null) row.materialExact += r.material;
    if (w.workPrice > 0) {
      row.workSum += r.quantity * w.workPrice;
      row.hasWorkPrice = true;
    }
    works.set(m.workId, row);
  }
  const rows = [...works.values()].map((r) => {
    const material = r.materialName ? (isPieces(r.materialUnit) ? ceilPieces(r.materialExact) : round(r.materialExact, 3)) : null;
    return {
      ...r,
      quantity: round(r.quantity, 4),
      materialExact: r.materialName ? r.materialExact : null,
      material,
      workSum: r.hasWorkPrice ? round(r.workSum) : null,
      materialSum: material != null && r.materialPrice > 0 ? round(material * r.materialPrice) : null,
    };
  }).sort((a, b) => a.groupSort - b.groupSort || collator.compare(a.groupName, b.groupName) || collator.compare(a.work, b.work));

  const mats = new Map();
  for (const r of rows) {
    if (r.material == null) continue;
    const key = `${r.materialName}\u0000${r.materialUnit}`;
    const t = mats.get(key) || { materialName: r.materialName, materialUnit: r.materialUnit, quantity: 0, sum: 0, hasSum: false };
    t.quantity += r.material;
    if (r.materialSum != null) {
      t.sum += r.materialSum;
      t.hasSum = true;
    }
    mats.set(key, t);
  }
  const materials = [...mats.values()]
    .map((t) => ({ materialName: t.materialName, materialUnit: t.materialUnit, quantity: round(t.quantity, 3), sum: t.hasSum ? round(t.sum) : null }))
    .sort((a, b) => collator.compare(a.materialName, b.materialName));

  return { rows, details, skipped, materials, openingsUsage: openingsUsage(measurements, openings) };
}

// Где использована каждая марка: назначения в стенах и проёмы на плане.
export function openingsUsage(measurements, openings) {
  return openings.map((o) => {
    const uses = [];
    for (const m of measurements) {
      const a = (m.openings || []).find((x) => x.openingId === o.id);
      if (a && a.qty > 0) uses.push({ measurementId: m.id, page: m.page, qty: a.qty * (m.count > 0 ? m.count : 1) });
      if (m.role === "opening" && m.openingId === o.id) {
        const wall = measurements.find((x) => x.id === m.wallId);
        uses.push({ measurementId: m.wallId || m.id, page: m.page, qty: wall?.count > 0 ? wall.count : 1 });
      }
    }
    return { ...o, used: uses.reduce((s, u) => s + u.qty, 0), uses };
  });
}
