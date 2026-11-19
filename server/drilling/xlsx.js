// Excel-выгрузка реестра заявок на бурение и резку: одна строка на строку работ,
// с теми же фильтрами, что на странице (см. service.registry), и итогами по
// единицам измерения внизу.
const ExcelJS = require('exceljs');
const { fmtDateTime } = require('./docx');

const STATUS = {
  line1: 'Ждёт ответа исполнителя',
  line2: 'Передана субподрядчику',
  returned: 'Отклонена',
  accepted: 'Принята в работу',
  completed: 'Выполнена',
  cancelled: 'Отменена',
};

const COLUMNS = [
  { header: '№ заявки', key: 'requestId', width: 10 },
  { header: 'Создана', key: 'createdAt', width: 17 },
  { header: 'Автор', key: 'author', width: 24 },
  { header: 'Статус', key: 'status', width: 24 },
  { header: 'Исполнитель', key: 'company', width: 18 },
  { header: 'Принята', key: 'acceptedAt', width: 17 },
  { header: 'Объект', key: 'object', width: 26 },
  { header: 'Позиция', key: 'position', width: 14 },
  { header: 'Вид работ', key: 'work', width: 12 },
  { header: 'Диаметр, мм', key: 'diameterMm', width: 12 },
  { header: 'Толщина реза, см', key: 'thicknessCm', width: 14 },
  { header: 'Материал', key: 'material', width: 11 },
  { header: 'Заявлено', key: 'quantity', width: 11 },
  { header: 'Ед.', key: 'unit', width: 6 },
  { header: 'Выполнено', key: 'factQuantity', width: 11 },
  { header: 'Причина / комментарий', key: 'reason', width: 40 },
];

async function buildRegistryXlsx({ rows, totals }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Заявки');
  ws.columns = COLUMNS;

  for (const r of rows) {
    ws.addRow({
      ...r,
      createdAt: fmtDateTime(r.createdAt),
      acceptedAt: r.acceptedAt ? fmtDateTime(r.acceptedAt) : '',
      status: STATUS[r.status] || r.status,
      work: r.workType === 'drill' ? 'Сверление' : 'Резка',
      diameterMm: r.diameterMm ?? '',
      thicknessCm: r.thicknessCm ?? '',
      factQuantity: r.doneAt ? r.factQuantity : '', // пусто, пока строка не отмечена
    });
  }

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF485875' } };
  head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  head.height = 32;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length) ws.autoFilter = { from: 'A1', to: { row: 1 + rows.length, column: COLUMNS.length } };
  ws.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: 'top', wrapText: true }; });

  // Итоги по единицам измерения (штуки и погонные метры не складываются).
  const units = Object.keys(totals);
  if (units.length) {
    ws.addRow([]);
    for (const unit of units) {
      const row = ws.addRow({ object: 'ИТОГО', unit, quantity: totals[unit].plan, factQuantity: totals[unit].fact });
      row.font = { bold: true };
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildRegistryXlsx };
