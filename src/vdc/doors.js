// Двери по чертежам АР: справочник марок из «Спецификации элементов заполнения проёмов», подсчёт меток на планах
// этажей и проверка по количеству из спецификации. Категория двери (межкомнатная, входная квартирная, входной группы,
// противопожарная) определяется по стандарту в спецификации и размеру, но это только предложение — пользователь правит.
//
// Элементы листа: { str, x, y, w, h }, y растёт вниз (как в pdf.js после преобразования).
const MARK = /^Д\s?-\s?(\d{1,2})$/;
const STANDARD = /^(ГОСТ|СТ\s*РК)/;
const SIZE = /(\d{3,4})\s*[хxХX×]\s*(\d{3,4})/;
const INT = /^\d+$/;

export const DOOR_CATEGORIES = {
  interior: "Межкомнатная",
  entrance: "Входная квартирная",
  group: "Входной группы (наружная)",
  fire: "Противопожарная",
  other: "Прочая",
};

export const markKey = (s) => `Д-${String(s).match(/(\d+)/)[1]}`;

const sameRow = (a, b, tol) => Math.abs(a.y - b.y) <= tol;

// Предложение категории: по стандарту из спецификации (ГОСТ 6629 — деревянные внутренние, ГОСТ 31173 — стальные,
// СТ РК 2110 / «ДПС» — противопожарные) и по ширине проёма в названии. widthOnPlans — стальная дверь стоит на типовых
// этажах (иначе это дверь подвала, чердака, технического помещения).
export function suggestCategory({ standard, name, width, onPlans }) {
  const std = String(standard || "");
  const text = String(name || "");
  if (/ДПС/i.test(text) || /СТ\s*РК\s*2110/i.test(std)) return "fire";
  if (/6629/.test(std)) return "interior";
  if (/31173/.test(std)) {
    if (!onPlans) return "other";
    return width && width > 1100 ? "group" : "entrance";
  }
  return "other";
}

// → [{ mark: 'Д-1', no: 1, standard, name, width, height, qtyPerSection, qtyTotal }]
// Строка спецификации — метка «Д-N», у которой в той же строке справа стоит стандарт (ГОСТ…/СТ РК…); одноимённые метки в
// «Ведомости проёмов» ниже стандарта не имеют и пропускаются.
export function parseDoorSpec(items) {
  const list = (items || []).filter((i) => String(i.str ?? "").trim());
  const specs = [];
  for (const m of list) {
    const mm = m.str.trim().match(MARK);
    if (!mm) continue;
    const std = list.find((i) => STANDARD.test(i.str.trim()) && sameRow(i, m, 4) && i.x > m.x + 20 && i.x < m.x + 120);
    if (!std) continue;
    // колонка «Наименование» — правее стандарта; название может быть на соседних строках (многострочная ячейка)
    const nameParts = list
      .filter((i) => i !== std && i.x > m.x + 150 && i.x < m.x + 340 && Math.abs(i.y - m.y) <= 14 && !MARK.test(i.str.trim()))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const name = nameParts.map((i) => i.str.trim()).join(" ").replace(/\s+/g, " ");
    const size = nameParts.map((i) => i.str.match(SIZE)).find(Boolean);
    // створки: у деревянных дверей ширина зашифрована в названии («ДГ 21-9» — 900 мм, «ДО 21-13» — 1300 мм), у остальных — в размере
    const code = name.match(/(\d{2})\s*-\s*(\d{1,2})(?!\d)/);
    const widthMm = size ? Number(size[2]) : code ? Number(code[2]) * 100 : null;
    // количество: целые числа справа от названия (блок «с-я №2», «с-я №1», «итого на дом»)
    const qty = list
      .filter((i) => INT.test(i.str.trim()) && sameRow(i, m, 5) && i.x > m.x + 330 && i.x < m.x + 470)
      .sort((a, b) => a.x - b.x)
      .map((i) => Number(i.str.trim()));
    specs.push({
      mark: markKey(mm[1]),
      no: Number(mm[1]),
      standard: std.str.trim(),
      name,
      height: size ? Number(size[1]) : null,
      width: size ? Number(size[2]) : null,
      leaves: widthMm && widthMm >= 1200 ? 2 : 1, // двупольная — от 1200 мм; правится вручную
      qtyPerSection: qty.length ? qty[0] : null,
      qtyTotal: qty.length ? qty[qty.length - 1] : null,
    });
  }
  // у одной марки (например «Д-9» левая / «Д-10» правая) — свои строки; повторы одной марки — берём первую
  const seen = new Set();
  return specs.filter((s) => (seen.has(s.mark) ? false : seen.add(s.mark))).sort((a, b) => a.no - b.no);
}

// Сколько раз каждая метка стоит на плане этажа: { 'Д-1': 6, … }
export function countPlanMarks(items) {
  const out = {};
  for (const i of items || []) {
    const m = String(i.str ?? "").trim().match(MARK);
    if (m) out[markKey(m[1])] = (out[markKey(m[1])] || 0) + 1;
  }
  return out;
}

// plans: [{ page, floors: [1] | [2..6], items }] — планы типовых этажей.
// → { 'Д-1': { perFloor: { [page]: n }, total: сумма по этажам } }
export function countDoorsOnPlans(plans) {
  const out = {};
  for (const p of plans || []) {
    const counts = countPlanMarks(p.items);
    for (const [mark, n] of Object.entries(counts)) {
      const cur = out[mark] || { perFloor: {}, total: 0 };
      cur.perFloor[p.page] = n;
      cur.total += n * (p.floors?.length || 1);
      out[mark] = cur;
    }
  }
  return out;
}

// Справочник дверей с предложенными категориями и проверкой по спецификации.
// → [{ …spec, category, planQty|null, status: 'ok' | 'mismatch' | 'off-plan' }]
export function buildDoorDirectory(spec, plans) {
  const onPlan = countDoorsOnPlans(plans);
  return spec.map((s) => {
    const p = onPlan[s.mark];
    const planQty = p ? p.total : null;
    let status = "off-plan"; // метки нет на типовых этажах: подвал, чердак, технические помещения
    if (p) status = s.qtyPerSection !== null && p.total === s.qtyPerSection ? "ok" : "mismatch";
    return { ...s, planQty, perFloor: p?.perFloor || {}, leaves: s.leaves, category: suggestCategory({ standard: s.standard, name: s.name, width: s.width, onPlans: !!p }), status };
  });
}

// Итог по категориям на этаж: { entrance: { 'Д-9': 2, 'Д-10': 2 }, … } по плану одного этажа — для сверки «входных = квартир».
export function perFloorByCategory(directory, page) {
  const out = {};
  for (const d of directory) {
    const n = d.perFloor[page];
    if (!n) continue;
    out[d.category] = out[d.category] || {};
    out[d.category][d.mark] = n;
  }
  return out;
}

// ---------- Подсчёт дверей по контуру квартиры ----------
// Пользователь обводит контур квартиры на плане; двери — это метки «Д-N» внутри контура. Их положение берём из текста PDF
// (центр надписи), поэтому в тексте листа ничего размечать не нужно.
export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if (((a.y > pt.y) !== (b.y > pt.y)) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// items — текст листа; points — контур; directory — справочник дверей (с категорией и числом створок).
// → [{ mark, x, y, category, leaves }] — метки дверей внутри контура (метки, которых нет в справочнике, пропускаются)
export function doorsInContour(items, points, directory) {
  if (!points || points.length < 3) return [];
  const byMark = new Map((directory || []).map((d) => [d.mark, d]));
  const out = [];
  for (const i of items || []) {
    const m = String(i.str ?? "").trim().match(MARK);
    if (!m) continue;
    const mark = markKey(m[1]);
    const d = byMark.get(mark);
    if (!d) continue;
    const c = { x: i.x + (i.w || 0) / 2, y: i.y - (i.h || 0) / 2 };
    if (pointInPolygon(c, points)) out.push({ mark, x: c.x, y: c.y, category: d.category, leaves: d.leaves || 1 });
  }
  return out;
}

// Итог по найденным дверям: { entrance, single, double } (межкомнатные — по числу створок); прочие категории не считаются
export function summarizeDoors(found) {
  const out = { entrance: 0, single: 0, double: 0 };
  for (const d of found || []) {
    if (d.category === "entrance") out.entrance += 1;
    else if (d.category === "interior") out[d.leaves === 2 ? "double" : "single"] += 1;
  }
  return out;
}

// Сверка по этажам: межкомнатных дверей на плане и сколько получается из чисел по типам квартир.
// perType: { 'тип': { single, double } } (строки или числа). → [{ page, floors, onPlan, byInput }]
export function interiorCheck(plans, marks, perType) {
  const wanted = new Set(marks);
  return (plans || []).map((p) => {
    let onPlan = 0;
    for (const i of p.items || []) {
      const m = String(i.str ?? "").trim().match(MARK);
      if (m && wanted.has(markKey(m[1]))) onPlan += 1;
    }
    const byInput = (p.flats || []).reduce((acc, f) => acc + (Number(perType?.[f.code]?.single) || 0) + (Number(perType?.[f.code]?.double) || 0), 0);
    return { page: p.page, floors: p.floors, onPlan, byInput };
  });
}

// ---------- Работы по дверям для ВДЦ ----------
// Расценка «Установка двери (монтаж замков, защелок, ручек, устройство дверных откосов)» — поз. 2.7 прайса.
// Входная дверь — одна строка по полной расценке; межкомнатные — расценка делится в процентах (по умолчанию 60/20/20):
// устройство дверей, устройство откосов, монтаж замков, защёлок, ручек — каждая работа отдельно для однопольных и двупольных.
export const DEFAULT_DOOR_SPLIT = { door: "60", slopes: "20", locks: "20" };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const pct = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const int = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function splitIsValid(split) {
  return Math.abs(pct(split?.door) + pct(split?.slopes) + pct(split?.locks) - 100) < 1e-9;
}

// row — квартира { code }; settings: { entrance: число на квартиру (по умолчанию), entranceByType?: { тип: число },
// interior: { тип: { single, double } }, split, threshold: м.п порожка на дверь }; rate — расценка 2.7; thresholdRate — расценка
// «Устройство декоративных порожков» (на каждую дверь — входную и межкомнатную — по settings.threshold м.п). → строки в формате worksForFlat
export function doorWorkLines(row, settings, rate, thresholdRate = null) {
  if (!rate || !settings) return [];
  const make = (work, qty, share, note) => {
    const priceVat = round2(rate.priceVat * share);
    const priceNoVat = round2(rate.priceNoVat * share);
    return {
      roomNo: "Д", roomName: "Двери", work, rateNo: rate.no, rateName: rate.name, unit: rate.unit, qty,
      priceVat, priceNoVat, sum: round2(qty * priceVat), sumNoVat: round2(qty * priceNoVat), note, need: null, door: true,
    };
  };
  const lines = [];
  const entrance = settings.entranceByType?.[row.code] !== undefined ? int(settings.entranceByType[row.code]) : int(settings.entrance);
  if (entrance > 0) lines.push(make("Установка входной двери", entrance, 1, "входная дверь: полная расценка"));
  const single = int(settings.interior?.[row.code]?.single);
  const double = int(settings.interior?.[row.code]?.double);
  if (single + double > 0 && splitIsValid(settings.split)) {
    const sp = settings.split;
    const share = (key) => pct(sp[key]) / 100;
    const note = (key) => `межкомнатная: ${pct(sp[key])} % расценки`;
    // каждая из трёх работ — отдельно для однопольных и двупольных дверей
    const kinds = [
      ["door", (t) => `Устройство ${t} межкомнатных дверей`],
      ["slopes", (t) => `Устройство дверных откосов ${t} межкомнатных дверей`],
      ["locks", (t) => `Монтаж замков, защёлок, ручек ${t} межкомнатных дверей`],
    ];
    for (const [key, title] of kinds) {
      if (single > 0) lines.push(make(title("однопольных"), single, share(key), note(key)));
      if (double > 0) lines.push(make(title("двупольных"), double, share(key), note(key)));
    }
  }
  // декоративные порожки: на каждую дверь квартиры (входную, одно- и двупольные межкомнатные)
  const perDoor = pct(settings.threshold);
  const doorsTotal = entrance + single + double;
  if (thresholdRate && perDoor > 0 && doorsTotal > 0) {
    const qty = round2(doorsTotal * perDoor);
    lines.push({
      roomNo: "Д", roomName: "Двери", work: "Устройство декоративных порожков", rateNo: thresholdRate.no, rateName: thresholdRate.name, unit: thresholdRate.unit,
      qty, priceVat: thresholdRate.priceVat, priceNoVat: thresholdRate.priceNoVat, sum: round2(qty * thresholdRate.priceVat), sumNoVat: round2(qty * thresholdRate.priceNoVat),
      note: `по ${perDoor} м.п на каждую дверь (${doorsTotal} шт.)`, need: null, door: true,
    });
  }
  return lines;
}
