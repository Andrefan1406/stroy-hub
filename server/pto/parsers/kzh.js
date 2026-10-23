// Раздел КЖ (конструкции железобетонные): сводная ведомость расхода стали +
// спецификации элементов. Каждая страница разбирается независимо — сбой
// одного листа попадает в отчёт и не мешает остальным.
const { parseSteelSummary } = require('./steelSummary');
const { parseSpecifications } = require('./specification');

// Возвращает { rows, issues, sheets }:
//   rows   — сырые строки (kind, element, name, markClass, unit, quantity, page, basis, note);
//   issues — [{ page, message, level? }] (level: 'info' — не ошибка, а заметка);
//   sheets — [{ page, kind: 'steel_summary' | 'specification', title?, rows }] — какие листы распознаны.
function parseKzh(pages) {
  const rows = [];
  const issues = [];
  const sheets = [];
  for (const page of pages) {
    try {
      const summary = parseSteelSummary(page);
      if (summary) {
        rows.push(...summary.rows);
        issues.push(...summary.issues);
        sheets.push({ page: page.page, kind: 'steel_summary', title: 'Ведомость расхода стали', rows: summary.rows.length });
      }
      const spec = parseSpecifications(page);
      if (spec.tables) {
        rows.push(...spec.rows);
        issues.push(...spec.issues);
        sheets.push({ page: page.page, kind: 'specification', title: spec.titles.filter(Boolean).join('; '), rows: spec.rows.length });
      }
    } catch (err) {
      issues.push({ page: page.page, message: `Не удалось разобрать лист: ${err.message}` });
    }
  }
  if (!rows.length) {
    issues.push({ page: null, message: 'В документе не найдено ни сводной ведомости расхода стали, ни спецификаций элементов — проверьте, что загружен раздел КЖ' });
  }
  return { rows, issues, sheets };
}

module.exports = { parseKzh };
