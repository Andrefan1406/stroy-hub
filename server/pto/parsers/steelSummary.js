// Сводная «Ведомость расхода стали, кг» раздела КЖ: по строке на марку
// элемента (фундамент, стены, плиты...), по колонкам — арматура по классам и
// диаметрам, закладные изделия (арматурные и прокат) и итоги.
//
//   Марка элемента | Арматурные изделия                        | Изделия закладные
//                  | класс А-400: ∅8 ∅10 ∅12 ... Итого Всего   | А-400: ∅10 Итого Всего | Прокат С245: t=8 Итого Всего
//
// Колонки определяем по шапке: диаметры (∅12, t=8) и «Итого»/«Всего» — группа
// диаметров закрывается колонкой «Итого». Ячейки в строках всегда заполнены
// (нули тоже печатаются), поэтому значение к колонке привязываем по порядку
// слева направо, а не по расстоянию до шапки — оно плавает из-за выравнивания
// чисел по центру. Совпало число ячеек с числом колонок — порядок надёжен;
// иначе — по ближайшей колонке, с предупреждением.
//
// Таблицы «Ведомость расхода стали НА ЭЛЕМЕНТ» (на листах элементов) — это
// те же данные на один элемент, их тут не берём (см. specification.js).
const { groupRows, joinText, parseNum, round } = require('../layout');

const DIA_RE = /^[∅Ø⌀]\s*(\d+(?:[.,]\d+)?)$/;
const PLATE_RE = /^t\s*=\s*(\d+(?:[.,]\d+)?)$/i;
const CLASS_RE = /^[АA]\s*-?\s*(\d{3})$/;
const GRADE_RE = /^С\s*(\d{3})\b/;
const ITOGO_RE = /^Итого\s*:?$/i;
const VSEGO_RE = /^Всего\s*:?$/i;

const cx = (it) => it.x + it.w / 2;
const nearest = (list, x) => list.reduce((best, c) => (best === null || Math.abs(cx(c) - x) < Math.abs(cx(best) - x) ? c : best), null);

// Возвращает null, если на странице нет сводной ведомости; иначе { rows, issues }.
function parseSteelSummary(page) {
  const items = page.items;
  // Название таблицы встречается и в основной надписи листа (штамп внизу),
  // и в перечне чертежей — берём то, под которым есть шапка «Марка элемента».
  let titleItem = null;
  let markItem = null;
  const titles = items
    .filter((it) => /Ведомость расхода стали/i.test(it.s))
    .sort((a, b) => b.y - a.y);
  for (const it of titles) {
    const row = joinText(items.filter((o) => Math.abs(o.y - it.y) <= 4));
    if (/на элемент/i.test(row)) continue;
    const mark = items
      .filter((o) => /^Марка элемента/i.test(o.s) && o.y < it.y && o.y > it.y - 200)
      .sort((a, b) => b.y - a.y)[0];
    if (mark) { titleItem = it; markItem = mark; break; }
  }
  if (!titleItem) return null;

  const issues = [];
  const below = items.filter((it) => it.y < markItem.y + 2);

  // Первая строка данных — самая верхняя строка с набором чисел правее подписей.
  const numericCount = (row) => row.items.filter((it) => it.x > markItem.x + 20 && parseNum(it.s) !== null).length;
  const dataCandidates = groupRows(below, 3).filter((r) => numericCount(r) >= 5);
  if (!dataCandidates.length) return { rows: [], issues: [{ page: page.page, message: 'Сводная ведомость расхода стали найдена, но строк с числами нет' }] };
  const yFirst = dataCandidates[0].y;

  // Шапка: всё между заголовком и первой строкой данных.
  const header = items.filter((it) => it.y > yFirst + 4 && it.y < titleItem.y && it.x > markItem.x + 20);
  const dia = header.filter((it) => DIA_RE.test(it.s.trim()) || PLATE_RE.test(it.s.trim()));
  if (!dia.length) return { rows: [], issues: [{ page: page.page, message: 'В сводной ведомости расхода стали не найдены колонки диаметров' }] };
  const columns = [
    ...dia.map((it) => ({ type: 'dia', it })),
    ...header.filter((it) => ITOGO_RE.test(it.s.trim())).map((it) => ({ type: 'itogo', it })),
    ...header.filter((it) => VSEGO_RE.test(it.s.trim())).map((it) => ({ type: 'vsego', it })),
  ].sort((a, b) => a.it.x - b.it.x);

  // Группы диаметров: закрываются колонкой «Итого».
  const groups = [];
  let cur = [];
  for (const c of columns) {
    if (c.type === 'dia') cur.push(c);
    else if (c.type === 'itogo' && cur.length) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);

  const classLabels = header.filter((it) => CLASS_RE.test(it.s.trim()) || GRADE_RE.test(it.s.trim()));
  const categoryLabels = header.filter((it) => /^(Арматурные изделия|Изделия закладные)/i.test(it.s.trim()));
  for (const g of groups) {
    const first = g[0].it;
    const last = g[g.length - 1].it;
    const center = (first.x + last.x + last.w) / 2;
    const label = nearest(classLabels, center);
    const text = label ? label.s.trim() : '';
    const m = text.match(CLASS_RE) || text.match(GRADE_RE);
    g.cls = m ? (CLASS_RE.test(text) ? `А${m[1]}` : `С${m[1]}`) : '';
    g.plate = g.every((c) => PLATE_RE.test(c.it.s.trim()));
    const cat = nearest(categoryLabels, center);
    g.embedded = !!cat && /закладные/i.test(cat.s);
  }
  if (groups.some((g) => !g.cls)) issues.push({ page: page.page, message: 'Не определён класс арматуры у одной из групп колонок сводной ведомости' });

  // Строки данных.
  const labelMaxX = columns[0].it.x - 14;
  const need = Math.max(5, Math.ceil(columns.length * 0.6));
  const dataRows = groupRows(below.filter((it) => it.x >= labelMaxX), 3)
    .filter((r) => r.items.filter((it) => parseNum(it.s) !== null).length >= need && r.y <= yFirst + 3);
  const labelItems = below.filter((it) => it.x < labelMaxX && it.y > 150 && it.y <= yFirst + 14);

  // Подписи привязываем к ближайшей строке данных по вертикали.
  const labels = new Map(dataRows.map((r) => [r, []]));
  for (const it of labelItems) {
    let best = null;
    for (const r of dataRows) if (best === null || Math.abs(r.y - it.y) < Math.abs(best.y - it.y)) best = r;
    if (best && Math.abs(best.y - it.y) <= 22) labels.get(best).push(it);
  }

  const rows = [];
  let warnedOrder = false;
  for (const r of dataRows) {
    // Название может быть в несколько строк («Входные группы» / «по ряду Б»).
    const label = groupRows(labels.get(r), 3).map((lr) => joinText(lr.items)).join(' ');
    if (!label) {
      issues.push({ page: page.page, message: 'Строка сводной ведомости без названия элемента — пропущена' });
      continue;
    }
    if (/^(итого|всего)(?![А-Яа-яЁёA-Za-z0-9])/i.test(label)) continue;

    const cells = r.items.filter((it) => parseNum(it.s) !== null);
    let values;
    if (cells.length === columns.length) {
      values = cells.map((c) => parseNum(c.s));
    } else {
      if (!warnedOrder) {
        issues.push({ page: page.page, message: `Число ячеек в строке «${label}» (${cells.length}) не совпало с числом колонок (${columns.length}) — значения привязаны по положению, проверьте строку` });
        warnedOrder = true;
      }
      values = columns.map((col) => {
        const c = nearest(cells, cx(col.it));
        return c && Math.abs(cx(c) - cx(col.it)) < 26 ? parseNum(c.s) : 0;
      });
    }

    columns.forEach((col, i) => {
      if (col.type !== 'dia') return;
      const qty = values[i];
      if (!(qty > 0)) return;
      const g = groups.find((gr) => gr.includes(col));
      const d = col.it.s.trim();
      const diaNum = (d.match(DIA_RE) || d.match(PLATE_RE))[1].replace(',', '.');
      let name;
      let kind;
      if (g.plate) { kind = 'embedded'; name = `Закладные изделия: прокат t=${diaNum}`; }
      else if (g.embedded) { kind = 'embedded'; name = `Закладные изделия: арматура ∅${diaNum}`; }
      else { kind = 'steel'; name = `Арматура ∅${diaNum}`; }
      rows.push({
        kind, element: label, name, markClass: g.cls, unit: 'кг', quantity: round(qty, 1),
        page: page.page, basis: 'summary',
      });
    });
  }
  if (!rows.length) issues.push({ page: page.page, message: 'Сводная ведомость расхода стали найдена, но значений в ней не извлечено' });
  return { rows, issues };
}

module.exports = { parseSteelSummary };
