// Дополнительные работы по квартире типа: вентиляционные решётки, ревизионный люк, заделка технологических отверстий,
// откосы окон и балконных блоков. Расценки заданы заказчиком (с НДС), в общем прайсе их нет.
// Окна («ОК-4», «ОК-4н») можно посчитать по меткам на плане внутри контура квартиры; решётки и технологические отверстия — точками
// на плане; люк — по числу на квартиру; всё это можно ввести и вручную. Балконные блоки бывают с окном и без него, поэтому
// считаются только вручную: блок с окном — своя расценка, блок без окна идёт по расценке окна.
const VAT = 1.16;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const EXTRA_WORKS = [
  { key: "vent", work: "Установка вентиляционных решёток", unit: "шт", priceVat: 696, label: "Вент. решёток" },
  { key: "hatch", work: "Установка ревизионного люка", unit: "шт", priceVat: 2320, label: "Ревизионных люков" },
  { key: "holes", work: "Заделка технологических отверстий", unit: "шт", priceVat: 1160, label: "Техн. отверстий" },
  // окна и балконные блоки без окна — по одной расценке (в количество строки входят и те и другие)
  { key: "windows", also: ["blocksNo"], work: "Устройство оконных откосов, балконных дверей: черновой + чистовой слой", unit: "шт", priceVat: 2000, label: "Окон" },
  { key: "blocks", work: "Устройство откосов балконных блоков (дверь + окно): черновой + чистовой слой", unit: "шт", priceVat: 3000, label: "Балконных блоков с окном" },
];

const WINDOW = /^ОК\s?-\s?\d+[нН]?$/;
const BLOCK = /^ББ\s?-\s?\d+[нН]?$/;

// Метки окон и балконных блоков внутри контура квартиры → { windows, blocks, found: [{ kind, label, x, y }] }
export function elementsInContour(items, points, inside) {
  const out = { windows: 0, blocks: 0, found: [] };
  if (!points || points.length < 3) return out;
  for (const i of items || []) {
    const s = String(i.str ?? "").trim();
    const kind = WINDOW.test(s) ? "windows" : BLOCK.test(s) ? "blocks" : null;
    if (!kind) continue;
    const c = { x: i.x + (i.w || 0) / 2, y: i.y - (i.h || 0) / 2 };
    if (!inside(c, points)) continue;
    out[kind] += 1;
    out.found.push({ kind, label: s.replace(/\s+/g, ""), x: c.x, y: c.y });
  }
  return out;
}

const qtyOf = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// counts: { vent, hatch, holes, windows, blocksNo (блоки без окна — по расценке окна), blocks (блоки с окном) } (числа или строки) → строки в формате worksForFlat; нулевые пропускаются
export function extraWorkLines(counts) {
  const lines = [];
  for (const w of EXTRA_WORKS) {
    const qty = qtyOf(counts?.[w.key]) + (w.also || []).reduce((a, k) => a + qtyOf(counts?.[k]), 0);
    if (!qty) continue;
    const priceNoVat = round2(w.priceVat / VAT);
    lines.push({
      roomNo: "Д", roomName: "Двери и проёмы", work: w.work, rateNo: null, rateName: w.work, unit: w.unit, qty,
      priceVat: w.priceVat, priceNoVat, sum: round2(qty * w.priceVat), sumNoVat: round2(qty * priceNoVat), note: "расценка заказчика", need: null, door: true,
    });
  }
  return lines;
}
