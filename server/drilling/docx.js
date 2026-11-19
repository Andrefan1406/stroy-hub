// Word-документ «Наряд задание» по заявке на бурение и резку. Структура по
// образцу samples/estimate/пример заявки.docx: адресат, «В работу» + дата,
// заголовок, текст, таблица работ, подписи «Составил» / «Согласовано». В нижнем
// колонтитуле — временные отметки ТЕКУЩЕГО круга согласования: «Создана …», «Главный
// инженер — согласована …» и короткие «Пром Альянс — принята/отклонена …» (предыдущие
// круги остаются в базе). «Составил» и «Согласовано» — из карточек людей (ФИО, должность).
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, Footer, BorderStyle, VerticalAlign,
} = require('docx');
const { UNITS, positionLabel } = require('./validation');

const FONT = 'Times New Roman';
const TZ = 'Asia/Almaty';

const pad = (n) => String(n).padStart(2, '0');
function parts(iso) {
  const f = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return o;
}
const fmtDate = (iso) => { const p = parts(iso); return `${p.day}.${p.month}.${p.year}`; };
const fmtDateTime = (iso) => { const p = parts(iso); return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`; };
const fmtNum = (n) => String(n).replace('.', ',');

const run = (text, opts = {}) => new TextRun({ text, font: FONT, size: 24, ...opts });
const para = (children, opts = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], ...opts });

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

function cell(text, { width, bold = false, align = AlignmentType.LEFT, borders } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    borders,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: String(text).split('\n').map((line) => para(run(line, { bold, size: 22 }), { alignment: align })),
  });
}

function sizeText(item) {
  return item.workType === 'drill'
    ? `Ø ${item.diameterMm} мм`
    : `толщина ${fmtNum(item.thicknessCm)} см`;
}

function itemsTable(items) {
  const widths = [500, 2500, 1500, 1700, 1000, 1100, 1900]; // сумма 10200 DXA
  const head = ['№', 'Объект, позиция', 'Вид работ', 'Размер', 'Материал', 'Кол-во', 'Причина / комментарий'];
  const rows = [
    new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, { width: widths[i], bold: true, align: AlignmentType.CENTER })) }),
    ...items.map((it, i) => new TableRow({
      cantSplit: true,
      children: [
        cell(i + 1, { width: widths[0], align: AlignmentType.CENTER }),
        cell(`${it.object}\n${positionLabel(it.position)}`, { width: widths[1] }),
        cell(it.workType === 'drill' ? 'Сверление' : 'Резка', { width: widths[2] }),
        cell(sizeText(it), { width: widths[3] }),
        cell(it.material, { width: widths[4] }),
        cell(`${fmtNum(it.quantity)} ${UNITS[it.workType]}`, { width: widths[5], align: AlignmentType.CENTER }),
        cell(it.reason || '—', { width: widths[6] }),
      ],
    })),
  ];
  return new Table({ width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths, rows });
}

function signatures(data) {
  const ini = data.initiator;
  const left = (title, lines) => [para(run(title, { bold: true })), ...lines.map((l) => para(run(l)))];
  const half = 5100;
  const mk = (children) => new TableCell({ width: { size: half, type: WidthType.DXA }, borders: NO_BORDERS, children });
  const iniPos = ini.position;
  return new Table({
    width: { size: half * 2, type: WidthType.DXA },
    columnWidths: [half, half],
    borders: { ...NO_BORDERS, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
    rows: [new TableRow({
      children: [
        mk(left('Составил:', [iniPos, ini.fullName])),
        mk(left('Согласовано:', [data.approver.position, data.approver.fullName])),
      ],
    })],
  });
}

function footerText(data) {
  const lines = [`Создана: ${fmtDateTime(data.roundStartedAt)}`];
  for (const s of data.stamps) lines.push(`${s.company} — ${s.label} ${fmtDateTime(s.at)}`);
  return lines;
}

async function buildDocx(data) {
  const addressee = data.company?.addressee || 'Директору';
  const dateStr = fmtDate(data.acceptedAt || data.createdAt);

  const body = [
    para(run(addressee), { alignment: AlignmentType.RIGHT }),
    para(run('В работу', { bold: true }), { alignment: AlignmentType.RIGHT }),
    para(run(dateStr), { alignment: AlignmentType.RIGHT, spacing: { after: 240 } }),
    para(run('Наряд задание', { bold: true, size: 28 }), { alignment: AlignmentType.CENTER }),
    para(run(`№ ${data.id} от ${fmtDate(data.createdAt)}`), { alignment: AlignmentType.CENTER, spacing: { after: 240 } }),
    para(run('В связи с производственной необходимостью прошу Вас выполнить работы по технологическому бурению и резке:'), { spacing: { after: 160 } }),
    itemsTable(data.items),
    para(run(''), { spacing: { after: 480 } }),
    signatures(data),
  ];

  const footer = new Footer({
    children: footerText(data).map((t) => para(run(t, { size: 18, color: '555555' }), { alignment: AlignmentType.LEFT })),
  });

  const doc = new Document({
    creator: 'stroy-hub',
    title: `Наряд задание № ${data.id}`,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 850, right: 850 } } },
      footers: { default: footer },
      children: body,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildDocx, fmtDateTime, fmtDate };
