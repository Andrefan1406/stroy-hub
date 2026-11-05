// План этажа: где стоят квартиры и в каких осях. Квартиры находим по выноскам с жилой площадью
// (число из строки «Жилая площадь квартиры» экспликации стоит на плане внутри контура квартиры),
// оси — по подписям цифровых осей в кружках у нижнего края плана. У каждой секции своя линия осей
// (1…11, 12…22), поэтому подпись «в/о 1-6» для секции 2 станет «в/о 12-17».
import { groupRows } from "./tepParser";

const INT = /^\d{1,2}$/;
const cx = (i) => i.x + (i.w || 0) / 2;

// Самая длинная цепочка подписей +1 слева направо (посторонние числа в строке пропускаем).
function longestChain(tokens) {
  let best = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const chain = [tokens[start]];
    for (let k = start + 1; k < tokens.length; k += 1) {
      if (tokens[k].value === chain[chain.length - 1].value + 1) chain.push(tokens[k]);
    }
    if (chain.length > best.length) best = chain;
  }
  return best;
}

// → [{ y, labels: [{ value, x }] }] — линии цифровых осей ниже всех квартир, сверху вниз.
export function findAxisRows(items, belowY = 0) {
  const nums = (items || [])
    .filter((i) => INT.test(String(i.str ?? "").trim()) && i.y > belowY)
    .map((i) => ({ value: Number(i.str.trim()), x: cx(i), y: i.y, str: i.str.trim() }));
  const rows = groupRows(nums, 3)
    .map((r) => ({ y: r.y, labels: longestChain(r.tokens).map((t) => ({ value: t.value, x: t.x })) }))
    .filter((r) => r.labels.length >= 4)
    .sort((a, b) => a.y - b.y);
  // «12» в конце первой линии — это ось соседней секции, она же начинает вторую линию
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const last = rows[i].labels[rows[i].labels.length - 1];
      if (rows[j].labels[0].value === last.value && rows[i].labels.length > 1) {
        rows[i].labels = rows[i].labels.slice(0, -1);
        break;
      }
    }
  }
  return rows;
}

// Выноски квартир: числа, равные жилой площади типа, левее таблицы экспликации.
export function findFlats(items, types, limitX) {
  const flats = [];
  const warnings = [];
  const byLiving = new Map();
  for (const t of types) {
    if (!t.living) continue;
    if (byLiving.has(t.living)) warnings.push(`Типы ${byLiving.get(t.living)} и ${t.code} имеют одинаковую жилую площадь ${t.living}: квартиры на плане не различить.`);
    else byLiving.set(t.living, t.code);
  }
  for (const i of items || []) {
    const code = byLiving.get(String(i.str ?? "").trim());
    if (code && cx(i) < limitX) flats.push({ code, x: cx(i), y: i.y });
  }
  for (const t of types) {
    const found = flats.filter((f) => f.code === t.code).length;
    if (found !== t.qty) {
      warnings.push(`Тип ${t.code}: на плане найдено выносок ${found}, а в экспликации квартир на этаже ${t.qty} — оси этих квартир определить не удалось, проверьте вручную.`);
    }
  }
  return { flats, warnings };
}

// Разбиение квартир плана на группы вдоль осей: «левая половина» и «правая половина» секции.
// → { cuts: [x…] } — границы между группами (по оси, ближайшей к середине разрыва).
function groupBoundaries(flats, axisXs) {
  const xs = flats.map((f) => f.x).sort((a, b) => a - b);
  if (xs.length < 2 || axisXs.length < 2) return [];
  const span = axisXs[axisXs.length - 1] - axisXs[0];
  const gaps = xs.slice(1).map((x, i) => ({ i, g: x - xs[i] }));
  const maxGap = Math.max(...gaps.map((g) => g.g));
  if (maxGap < 0.15 * span) return []; // квартиры идут сплошной полосой — одна группа
  const cuts = [];
  for (const { i, g } of gaps) {
    if (g < 0.5 * maxGap) continue;
    const mid = (xs[i] + xs[i + 1]) / 2;
    const axisX = axisXs.reduce((best, x) => (Math.abs(x - mid) < Math.abs(best - mid) ? x : best), axisXs[0]);
    if (!cuts.includes(axisX)) cuts.push(axisX);
  }
  return cuts.sort((a, b) => a - b);
}

const axisLabel = (row, fromX, toX) => {
  const nearest = (x) => row.labels.reduce((best, l) => (Math.abs(l.x - x) < Math.abs(best.x - x) ? l : best), row.labels[0]);
  return `в/о ${nearest(fromX).value}-${nearest(toX).value}`;
};

// Если на плане нашли не столько выносок, сколько квартир по экспликации — для такого типа оси неизвестны:
// ставим пустые квартиры (их можно подписать вручную).
function withPlaceholders(flats, types) {
  const out = [];
  for (const t of types) {
    const own = flats.filter((f) => f.code === t.code);
    if (own.length === t.qty) out.push(...own);
    else for (let i = 0; i < t.qty; i += 1) out.push({ code: t.code, x: null, y: null, group: 0, labels: {} });
  }
  return out.sort((a, b) => a.group - b.group || (a.y ?? 0) - (b.y ?? 0));
}

// items — текст листа с планом; explication — результат parseExplication; sections — ['1','2'].
// → { flats: [{ code, x, y, group, labels: { '1': 'в/о 1-6', '2': 'в/о 12-17' } }], warnings }
export function planFlats({ items, explication, sections }) {
  const found = findFlats(items, explication.types, explication.planLimitX ?? Infinity);
  const warnings = [...found.warnings];
  if (!found.flats.length) return { flats: withPlaceholders([], explication.types), warnings };

  const maxFlatY = Math.max(...found.flats.map((f) => f.y));
  const rows = findAxisRows(items, maxFlatY + 30);
  if (!rows.length) {
    warnings.push("Подписи цифровых осей на плане не найдены — укажите «в/о» вручную.");
    return { flats: withPlaceholders(found.flats.map((f) => ({ ...f, group: 0, labels: {} })), explication.types), warnings };
  }
  if (rows.length < sections.length) {
    warnings.push(`Линий осей на плане ${rows.length}, а секций ${sections.length} — оси для части секций укажите вручную.`);
  }

  const cuts = groupBoundaries(found.flats, rows[0].labels.map((l) => l.x));
  const firstX = rows[0].labels[0].x;
  const lastX = rows[0].labels[rows[0].labels.length - 1].x;
  const flats = found.flats.map((f) => {
    const group = cuts.filter((c) => c < f.x).length;
    const fromX = group === 0 ? firstX : cuts[group - 1];
    const toX = group === cuts.length ? lastX : cuts[group];
    const labels = {};
    sections.forEach((id, idx) => {
      if (rows[idx]) labels[id] = axisLabel(rows[idx], fromX, toX);
    });
    return { ...f, group, labels };
  });
  flats.sort((a, b) => a.group - b.group || a.y - b.y);
  return { flats: withPlaceholders(flats, explication.types), warnings };
}
