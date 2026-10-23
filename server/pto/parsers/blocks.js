// Блоки (секции) здания — из чертежей, а не из выбора пользователя. «Секция» и
// «блок» — одно и то же.
//
// В проекте блок виден по осям: «Схема расположения монолитных стен между осями
// 1-11/Б-К» — первый блок, «12-22/Б-К» — второй; на листах плит и деталей —
// «в осях 1-11». Поэтому блоки определяем по диапазонам осей, которые
// повторяются на листах (локальные диапазоны вроде «5-8» у входной группы
// попадают в тот блок, в который входят). Блоки нумеруются слева направо: «Блок 1», «Блок 2».
// Не нашлось хотя бы двух повторяющихся диапазонов — здание считаем без блоков.
const AXES_RE = /(?:в осях|между осями|оси|осях)\s*(\d+)\s*[-–÷]\s*(\d+)/gi;
const MIN_PAGES_PER_BLOCK = 3; // диапазон должен встретиться минимум на стольких листах

// Диапазоны осей из текста: [[1, 11], [12, 22]].
function axesRanges(text) {
  const out = [];
  for (const m of String(text || '').matchAll(AXES_RE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a < b && b - a <= 60) out.push([a, b]);
  }
  return out;
}

// pageTexts — тексты листов. Возвращает [{ name, from, to }] по возрастанию осей.
function detectBlocks(pageTexts) {
  const pagesByRange = new Map();
  pageTexts.forEach((text, i) => {
    for (const key of new Set(axesRanges(text).map(([a, b]) => `${a}-${b}`))) {
      if (!pagesByRange.has(key)) pagesByRange.set(key, new Set());
      pagesByRange.get(key).add(i);
    }
  });
  // Частые диапазоны, самые частые — первыми; берём те, что не пересекаются с уже взятыми.
  const frequent = [...pagesByRange.entries()]
    .map(([key, pages]) => ({ from: Number(key.split('-')[0]), to: Number(key.split('-')[1]), n: pages.size }))
    .filter((r) => r.n >= MIN_PAGES_PER_BLOCK)
    .sort((x, y) => y.n - x.n || (y.to - y.from) - (x.to - x.from));
  const chosen = [];
  for (const r of frequent) {
    if (chosen.every((c) => r.to < c.from || r.from > c.to)) chosen.push(r);
  }
  chosen.sort((a, b) => a.from - b.from);
  return chosen.length >= 2 ? chosen.map((r, i) => ({ name: `Блок ${i + 1}`, from: r.from, to: r.to })) : [];
}

// Блок, в который попадает диапазон осей: с наибольшим пересечением (пересечение
// в одну ось на стыке блоков — не в счёт, если другой пересекается больше).
function blockOfRange(blocks, [a, b]) {
  let best = null;
  let bestOverlap = 0;
  let tie = false;
  for (const bl of blocks) {
    const overlap = Math.min(b, bl.to) - Math.max(a, bl.from) + 1;
    if (overlap > bestOverlap) { best = bl; bestOverlap = overlap; tie = false; }
    else if (overlap === bestOverlap && overlap > 0) tie = true;
  }
  return best && !tie ? best.name : null;
}

// Блок листа: если все диапазоны осей листа указывают на один блок — он; иначе null
// (на листе несколько блоков или осей нет).
function blockOfRanges(blocks, ranges) {
  if (!blocks.length || !ranges.length) return null;
  const names = new Set(ranges.map((r) => blockOfRange(blocks, r)));
  return names.size === 1 && !names.has(null) ? [...names][0] : null;
}

module.exports = { axesRanges, detectBlocks, blockOfRange, blockOfRanges };
