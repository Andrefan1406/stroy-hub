// Раздел КЖ (конструкции железобетонные): сводная ведомость расхода стали +
// спецификации элементов + блоки (секции) здания из чертежей. Каждая страница
// разбирается независимо — сбой одного листа попадает в отчёт и не мешает остальным.
//
// Блок строки определяется так (пользователь блок не выбирает):
//  1. стены — по перечням «Спецификация к схемам расположения монолитных стен
//     между осями 1-11 / 12-22»: у каждой марки (См 1 т, См 1 н, См 4…) в перечне
//     блока указано количество; расход из спецификации (на одну стену) умножается
//     на это количество, и строка раскладывается по блокам;
//  2. остальное — по осям, указанным на листе («в осях 1-11» → Блок 1);
//  3. нет осей, на листе несколько блоков или блоков в здании нет — блок пустой.
// Сводная «Ведомость расхода стали» даётся на всё здание — без блока.
const { parseSteelSummary } = require('./steelSummary');
const { parseSpecifications, markKeys } = require('./specification');
const { axesRanges, detectBlocks, blockOfRanges } = require('./blocks');
const { round } = require('../layout');

// Число стен каждой марки в каждом блоке: Map(марка -> Map(блок -> количество)) и листы-источники.
function wallCounts(lists) {
  const counts = new Map();
  const pages = new Map();
  for (const l of lists) {
    if (!l.block) continue;
    for (const e of l.entries) {
      if (!counts.has(e.key)) counts.set(e.key, new Map());
      const byBlock = counts.get(e.key);
      byBlock.set(l.block, (byBlock.get(l.block) || 0) + e.count);
      if (!pages.has(e.key)) pages.set(e.key, new Set());
      pages.get(e.key).add(l.page);
    }
  }
  return { counts, pages };
}

// Назначает блоки строкам спецификаций (раскладывает стены по блокам).
function assignBlocks(rows, { blocks, pageRanges, lists }) {
  if (!blocks.length) return { rows, issues: [] };
  const { counts, pages } = wallCounts(lists);
  const issues = [];
  const out = [];
  const reported = new Set();
  const report = (page, message, level) => {
    const key = `${page}|${message}`;
    if (!reported.has(key)) { reported.add(key); issues.push({ page, message, level }); }
  };
  for (const r of rows) {
    if (r.basis !== 'spec') { out.push(r); continue; }
    const keys = markKeys(r.sheetTitle);
    if (keys.length && /стен/i.test(r.sheetTitle || '')) {
      const perBlock = new Map();
      const srcPages = new Set();
      for (const k of keys) {
        for (const [bl, n] of counts.get(k) || []) perBlock.set(bl, (perBlock.get(bl) || 0) + n);
        for (const p of pages.get(k) || []) srcPages.add(p);
      }
      if (perBlock.size) {
        for (const [bl, n] of [...perBlock].sort((a, b) => a[0].localeCompare(b[0], 'ru', { numeric: true }))) {
          out.push({
            ...r, block: bl, quantity: round(r.quantity * n, 3),
            note: `Стен в блоке: ${n} × расход на одну стену (перечень на листах ${[...srcPages].sort((a, b) => a - b).join(', ')})`,
          });
        }
        continue;
      }
      report(r.page, `Стена «${r.sheetTitle}» не найдена в перечнях расположения — блок и количество стен не определены, проверьте вручную`);
    }
    const block = blockOfRanges(blocks, pageRanges.get(r.page) || []);
    if (!block) report(r.page, `Лист ${r.page}: блок не определён по осям — укажите блок у строк вручную`, 'info');
    out.push({ ...r, block: block || null });
  }
  return { rows: out, issues };
}

// Марки стен из перечней, для которых нет спецификации (в названиях спецификаций их нет): расход этих
// стен в ведомость не вошёл. Заодно ловит опечатки в самих чертежах (две спецификации «См 6 т» вместо «См 6» и «См 6.1»).
function missingSpecs(lists, specTitles) {
  const covered = new Set(specTitles.flatMap((title) => markKeys(title)));
  const missing = new Map();
  for (const l of lists) for (const e of l.entries) if (!covered.has(e.key)) missing.set(e.key, e.label || e.key);
  if (!missing.size) return [];
  return [{ page: null, message: `Стены из перечней без спецификации: ${[...missing.values()].join(', ')} — их расход в ведомость не вошёл (проверьте чертежи)` }];
}

// Возвращает { rows, issues, sheets, blocks }:
//   rows   — сырые строки (kind, element, name, markClass, unit, quantity, page, basis, note, block);
//   issues — [{ page, message, level? }] (level: 'info' — не ошибка, а заметка);
//   sheets — [{ page, kind: 'steel_summary' | 'specification', title?, rows }] — какие листы распознаны;
//   blocks — найденные в чертежах блоки: [{ name, from, to }] (оси), пусто — блоков нет.
function parseKzh(pages) {
  const issues = [];
  const sheets = [];
  const summaryRows = [];
  const specRows = [];
  const lists = [];
  const specTitles = [];

  const texts = pages.map((p) => (Array.isArray(p.items) ? p.items.map((i) => i.s).join(' ') : ''));
  const blocks = detectBlocks(texts);
  const pageRanges = new Map(pages.map((p, i) => [p.page, axesRanges(texts[i])]));

  for (const page of pages) {
    try {
      const summary = parseSteelSummary(page);
      if (summary) {
        summaryRows.push(...summary.rows);
        issues.push(...summary.issues);
        sheets.push({ page: page.page, kind: 'steel_summary', title: 'Ведомость расхода стали', rows: summary.rows.length });
      }
      const spec = parseSpecifications(page);
      if (spec.tables) {
        specRows.push(...spec.rows);
        specTitles.push(...spec.titles);
        issues.push(...spec.issues);
        for (const l of spec.lists) {
          const ranges = axesRanges(l.title);
          lists.push({ ...l, block: blockOfRanges(blocks, ranges.length ? ranges : pageRanges.get(page.page) || []) });
        }
        sheets.push({ page: page.page, kind: 'specification', title: spec.titles.filter(Boolean).join('; '), rows: spec.rows.length });
      }
    } catch (err) {
      issues.push({ page: page.page, message: `Не удалось разобрать лист: ${err.message}` });
    }
  }

  const assigned = assignBlocks(specRows, { blocks, pageRanges, lists });
  issues.push(...assigned.issues);
  issues.push(...missingSpecs(lists, specTitles));
  const rows = [...summaryRows.map((r) => ({ ...r, block: null })), ...assigned.rows.map((r) => ({ block: null, ...r }))];
  if (!rows.length) {
    issues.push({ page: null, message: 'В документе не найдено ни сводной ведомости расхода стали, ни спецификаций элементов — проверьте, что загружен раздел КЖ' });
  }
  return { rows, issues, sheets, blocks };
}

module.exports = { parseKzh, assignBlocks };
