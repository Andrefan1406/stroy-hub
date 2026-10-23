// Выгрузка ведомости раздела в Excel (xlsx): материалы, виды работ с
// расценками, итоги по элементам, отчёт разбора. Собирается на сервере —
// файл скачивается тем же авторизованным запросом, что и остальные данные.
const XLSX = require('xlsx');

const KIND_TITLE = { steel: 'Арматура', embedded: 'Закладные изделия', concrete: 'Бетон', metal: 'Прочий металл' };
const RATE_STATUS = { none: 'не подобрана', suggested: 'предложена', confirmed: 'подтверждена' };
const STATUS = { draft: 'черновик', confirmed: 'проверено' };

function sheet(rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

// doc — getDocument(), items/works — listItems/listWorks, totals — totals().
function buildWorkbook({ doc, items, works, totals }) {
  const book = XLSX.utils.book_new();
  // Столбец «Блок» — когда блоки найдены в чертежах (хотя бы у одной строки): после «№» в ведомости и работах, первым в итогах.
  const withBlock = items.some((it) => it.block) || works.some((w) => w.block) || totals.rows.some((r) => r.block);
  const afterNo = (row, value) => (withBlock ? [row[0], value, ...row.slice(1)] : row);
  const first = (row, value) => (withBlock ? [value, ...row] : row);
  const widths = (w, at) => (withBlock ? [...w.slice(0, at), 10, ...w.slice(at)] : w);
  const title = [`Раздел ${doc.section}`, `${doc.object}${doc.position ? `, ${doc.position}` : ''}`, `Файл: ${doc.fileName}`];

  const itemRows = [
    ['Ведомость материалов'], [title.join(' · ')], [],
    afterNo(['№', 'Конструктивный элемент', 'Наименование', 'Марка / класс', 'Ед. изм.', 'Количество', 'Листы-источники', 'В расчёте', 'Статус', 'Правка', 'Примечание'], 'Блок'),
  ];
  items.forEach((it, i) => itemRows.push(afterNo([
    i + 1, it.element, it.name, it.markClass, it.unit, it.quantity,
    it.sources.length ? it.sources.map((s) => (it.sources.length > 1 ? `${s.page} (${s.quantity})` : s.page)).join(', ') : (it.manual ? 'вручную' : ''),
    it.counted ? 'да' : 'нет (справочно)', STATUS[it.status] || it.status,
    it.manual ? 'добавлена вручную' : it.edited ? 'изменена вручную' : '', it.note || '',
  ], it.block || '')));
  itemRows.push([], ['Итого по учитываемым строкам']);
  for (const kind of Object.keys(KIND_TITLE)) {
    const rows = items.filter((it) => it.kind === kind && it.counted);
    if (!rows.length) continue;
    const units = [...new Set(rows.map((r) => r.unit))];
    for (const unit of units) {
      itemRows.push(afterNo(['', KIND_TITLE[kind], '', '', unit, Math.round(rows.filter((r) => r.unit === unit).reduce((s, r) => s + r.quantity, 0) * 1000) / 1000], ''));
    }
  }
  XLSX.utils.book_append_sheet(book, sheet(itemRows, widths([5, 34, 40, 14, 9, 13, 24, 16, 12, 18, 50], 1)), 'Ведомость материалов');

  const workRows = [
    ['Виды работ и расценки (цена с НДС)'], [title.join(' · ')], [],
    afterNo(['№', 'Конструктивный элемент', 'Вид работ', 'Ед. изм.', 'Объём', 'Расценка', 'Категория расценки', 'Цена с НДС, ₸', 'Стоимость, ₸', 'Расценка (статус)', 'Уверенность', 'Статус', 'Правка'], 'Блок'),
  ];
  works.forEach((w, i) => {
    const cost = w.quantity != null && w.rate && w.rate.price != null ? Math.round(w.quantity * w.rate.price) : '';
    workRows.push(afterNo([
      i + 1, w.element, w.name, w.unit, w.quantity ?? '', w.rate ? w.rate.name : '', w.rate ? w.rate.class : '',
      w.rate && w.rate.price != null ? w.rate.price : '', cost, RATE_STATUS[w.rateStatus] || w.rateStatus,
      w.rate && w.rate.confidence != null && w.rateStatus === 'suggested' ? `${Math.round(w.rate.confidence * 100)}%` : '',
      STATUS[w.status] || w.status, w.manual ? 'добавлена вручную' : w.edited ? 'изменена вручную' : '',
    ], w.block || ''));
  });
  XLSX.utils.book_append_sheet(book, sheet(workRows, widths([5, 34, 40, 9, 12, 50, 28, 14, 16, 16, 12, 12, 18], 1)), 'Виды работ');

  const t = totals;
  const sumRows = [
    ['Стоимость раздела по конструктивным элементам'], [title.join(' · ')],
    [`Цены на материалы (ориентировочные): арматура ${t.prices.steel} ₸/тн, бетон ${t.prices.concrete} ₸/м³`], [],
    first(['Конструктивный элемент', 'Сталь, тн', 'Сталь, ₸', 'Бетон, м³', 'Бетон, ₸', 'Материалы, ₸', 'Работы, ₸', 'Всего, ₸', 'Работ без расценки'], 'Блок'),
  ];
  for (const r of t.rows) sumRows.push(first([r.element, r.steelT, r.steelCost, r.concreteM3, r.concreteCost, r.materials, r.works, r.total, r.missing || ''], r.block || ''));
  const g = t.totals;
  sumRows.push(first(['ИТОГО', g.steelT, '', g.concreteM3, '', g.materials, g.works, g.total, g.missing || ''], ''));
  if (g.missing) sumRows.push([], [`В итог не вошло работ без расценки: ${g.missing}`]);
  XLSX.utils.book_append_sheet(book, sheet(sumRows, widths([40, 12, 14, 12, 14, 16, 16, 16, 18], 0)), 'Итого');

  const report = doc.report || { issues: [], sheets: [], reconciliation: [] };
  const repRows = [['Отчёт разбора'], [title.join(' · ')], [`Страниц: ${doc.pageCount ?? '—'}`], [], ['Замечания']];
  if (!report.issues.length) repRows.push(['нет']);
  for (const i of report.issues) repRows.push([i.page ? `лист ${i.page}` : '', i.level === 'info' ? 'заметка' : 'проверьте', i.message]);
  if (report.reconciliation && report.reconciliation.length) {
    repRows.push([], ['Сверка спецификаций со сводной ведомостью расхода стали'], ['Группа', 'По спецификациям, кг', 'По ведомости, кг', 'Отношение', 'Коэффициент применён']);
    for (const r of report.reconciliation) repRows.push([r.title, r.specKg, r.summaryKg, r.ratio, r.applied ? `×${r.applied}` : '']);
  }
  XLSX.utils.book_append_sheet(book, sheet(repRows, [18, 22, 90, 12, 20]), 'Отчёт разбора');
  return book;
}

function workbookBuffer(data) {
  return XLSX.write(buildWorkbook(data), { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildWorkbook, workbookBuffer };
