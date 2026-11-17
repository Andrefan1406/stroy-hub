// Вкладки «Титульный» и «Сводная» в выгрузке замечаний PlanRadar (planradarExport.js).
// Оформлены по образцу ежемесячного отчёта технадзора «10 ТН VK Development — за октябрь №6.docx»:
// титульный лист с теми же тремя картинками и «Сводная таблица» (№ / Наименование объекта /
// Всего / Открыто / Закрыто). Картинки лежат в server/assets/planradar-report/.
'use strict';

const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, 'assets', 'planradar-report');
const FONT = 'Times New Roman';
const EMU = 9525; // EMU в пикселе

// Полные названия объектов — из реестра «объекты.xlsx». Ключ — название объекта в PlanRadar.
// Объекты, у которых в реестре несколько разных названий (Нурлы Жол 4 и 5, Спорт 2, Лицей) или
// нет названия (Благоустройство 12-16 этажей, Приёмка-передача квартир, Хоккейный модуль),
// в сводной остаются с коротким названием PlanRadar — так решил заказчик отчёта.
const OBJECT_NAMES = {
  'Brick Town 2': 'Многоквартирный жилой комплекс со встроенными и пристроенными помещениями общественного назначения и многофункциональным комплексом, расположенный по пр. И. Есенберлина в г. Усть-Каменогорск',
  'Brick Town 3': 'Строительство многоквартирных жилых домов с коммерческими помещениями и паркингом, с инженерными сетями и благоустройством, по проспекту И. Есенберлина в г. Усть-Каменогорске, ВКО. 1 очередь строительства',
  'Бизнес центр пр.Победы': 'Строительство административно-торгового центра с подземным паркингом по пр. Победы в г. Усть-Каменогорск, ВКО',
  'Жилой дом поз.56': 'Строительство многоэтажных жилых домов со встроенными коммерческими помещениями поз.56,60,64,72 по проспекту К. Сатпаева в г. Усть-Каменогорске. Поз.56 (без наружных инженерных сетей и благоустройства)',
  'Жилой дом поз.59': 'Строительство многоэтажных жилых домов с коммерческими помещениями (с детским садом) поз.59 по проспекту К.Сатпаева в г. Усть-Каменогорске (без наружных сетей, благоустройства)',
  'Жилой дом поз.63': 'Строительство многоэтажных жилых домов с коммерческими помещениями (с детским садом) поз.63 по проспекту К.Сатпаева в г. Усть-Каменогорске (без наружных сетей, благоустройства)',
  'Жилой дом поз.64': 'Строительство многоэтажных жилых домов со встроенными коммерческими помещениями поз. 56,60,64,72 по проспекту К. Сатпаева в г. Усть-Каменогорске. Поз. 64',
  'Жилой дом поз.65': 'Строительство многоэтажных жилых домов с коммерческими помещениями (поз.65, 69) по проспекту К.Сатпаева в г. Усть-Каменогорске (без наружных сетей, благоустройства)',
  'Жилой дом поз.69': 'Строительство многоэтажных жилых домов с коммерческими помещениями поз.69 по проспекту К. Сатпаева в г. Усть-Каменогорске (без наружных инженерных сетей и благоустройства)',
  'Жилой дом поз.72': 'Строительство многоэтажных жилых домов со встроенными коммерческими помещениями поз. 56, 60, 64, 72 по проспекту К. Сатпаева в г. Усть-Каменогорске. Поз. 72 (без наружных инженерных сетей и благоустройства)',
  'КОС': 'Строительство очистных сооружений в п.Новая Согра, г.Усть-Каменогорска, ВКО',
  'Транспортная развязка': 'Строительство транспортной развязки на пересечении пр. Сатпаева и ул. Жибек Жолы в городе Усть-Каменогорске, ВКО. Корректировка',
  'Экополис': 'Строительство многоэтажных жилых домов с подземным паркингом, с благоустройством и инженерными сетями по проспекту К. Сатпаева в г. Усть-Каменогорске, ВКО (поз 103,104,105)',
};
const fullObjectName = (shortName) => (OBJECT_NAMES[shortName] ? `«${OBJECT_NAMES[shortName]}»` : shortName);

// ---------- период ----------
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const dmy = (iso) => iso.split('-').reverse().join('.');

// Период выгрузки: календарный месяц целиком («За Октябрь») или произвольный («За период с … по …»).
function describePeriod(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const monthly = fy === ty && fm === tm && fd === 1 && td === lastDay;
  return {
    monthly,
    year: ty,
    title: monthly ? `За ${MONTHS[fm - 1]}` : `За период с ${dmy(from)} по ${dmy(to)}`,
    date: `от ${dmy(to)} года.`,
    heading: monthly ? `${MONTHS[fm - 1]} ${fy} год` : `период с ${dmy(from)} по ${dmy(to)}`,
    sentencePeriod: monthly ? `За ${MONTHS[fm - 1]} месяц` : `За период с ${dmy(from)} по ${dmy(to)}`,
    totalHeader: monthly ? 'Всего за месяц' : 'Всего за период',
  };
}
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};

// ---------- картинки ----------
function loadImage(name) {
  const buffer = fs.readFileSync(path.join(ASSETS, name));
  return { buffer, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }; // PNG: IHDR
}
const COL_WIDTH = 14; // символов; столбцов на титульном листе — 6
const COL_PX = Math.round(COL_WIDTH * 7 + 5);
const TITLE_COLS = 6;
const PAGE_PX = COL_PX * TITLE_COLS;

// Вписывает картинку по ширине width и ставит по центру (или со сдвигом x) в строку row (с 1).
function placeImage(wb, ws, image, { row, width, x }) {
  const height = Math.round((image.height * width) / image.width);
  const left = x == null ? Math.round((PAGE_PX - width) / 2) : x;
  const id = wb.addImage({ buffer: image.buffer, extension: 'png' });
  ws.addImage(id, {
    tl: { nativeCol: Math.floor(left / COL_PX), nativeColOff: (left % COL_PX) * EMU, nativeRow: row - 1, nativeRowOff: 0 },
    ext: { width, height },
    editAs: 'oneCell',
  });
  return height;
}
const pt = (px) => Math.ceil(px * 0.75);

// ---------- титульный лист ----------
function addTitleSheet(wb, { period, reportNumber }) {
  const ws = wb.addWorksheet('Титульный');
  ws.views = [{ showGridLines: false }];
  ws.columns = Array.from({ length: TITLE_COLS }, () => ({ width: COL_WIDTH }));
  ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, horizontalCentered: true, margins: { left: 0.6, right: 0.6, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } };

  const logo = loadImage('logo.png');
  const cover = loadImage('cover.png');
  const sign = loadImage('signature.png');

  const line = (text, { size = 14, bold = true, align = 'center', height } = {}) => {
    const row = ws.addRow([text]);
    ws.mergeCells(row.number, 1, row.number, TITLE_COLS);
    const cell = row.getCell(1);
    cell.font = { name: FONT, size, bold };
    cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true };
    row.height = height || Math.round(size * 1.7);
    return row;
  };
  const gap = (h) => { ws.addRow([]).height = h; };

  gap(12);
  const logoRow = ws.addRow([]);
  const logoW = 330;
  logoRow.height = pt(placeImage(wb, ws, logo, { row: logoRow.number, width: logoW })) + 4;
  gap(16);
  line(`ЕЖЕМЕСЯЧНЫЙ ОТЧЕТ${reportNumber ? ` № ${reportNumber}` : ''}`, { size: 18 });
  line(period.title, { size: 18 });
  line(period.date, { size: 18 });
  gap(16);
  line('По оказанию инжиниринговых услуг по техническому надзору за строительством объектов', { size: 14, height: 40 });
  gap(10);
  const coverRow = ws.addRow([]);
  coverRow.height = pt(placeImage(wb, ws, cover, { row: coverRow.number, width: 400 })) + 4;
  gap(18);

  // подпись: слева должность, справа фамилия, между ними картинка подписи
  const signRow = ws.addRow(['Руководитель группы технического надзора', null, null, null, 'Я.Ю. Коротков']);
  ws.mergeCells(signRow.number, 1, signRow.number, 3);
  ws.mergeCells(signRow.number, 5, signRow.number, 6);
  signRow.getCell(1).font = { name: FONT, size: 11, bold: true };
  signRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  signRow.getCell(5).font = { name: FONT, size: 11, bold: true };
  signRow.getCell(5).alignment = { horizontal: 'right', vertical: 'middle' };
  signRow.height = pt(placeImage(wb, ws, sign, { row: signRow.number, width: 150, x: COL_PX * 3 - 25 })) + 6;

  gap(30);
  line('Юридический адрес, фактический адрес: 071303, Республика Казахстан, Восточно-Казахстанская область, город Риддер, улица Тохтарова 10', { size: 11, bold: false, align: 'left', height: 32 });
  gap(6);
  line('Почтовый адрес (для документов и корреспонденции): 070002, Республика Казахстан, Восточно-Казахстанская область, город Усть-Каменогорск, улица Промышленная, 2', { size: 11, bold: false, align: 'left', height: 32 });
  gap(36);
  line(`Усть-Каменогорск ${period.year} г.`, { size: 14 });
  return ws;
}

// ---------- сводная таблица ----------
// rows — строки замечаний (по одной на замечание): { project, status }. «Закрыто» — только статус «Закрыто».
function summarize(rows) {
  const byProject = new Map();
  for (const r of rows) {
    const e = byProject.get(r.project) || { project: r.project, total: 0, closed: 0 };
    e.total += 1;
    if (r.status === 'Закрыто') e.closed += 1;
    byProject.set(r.project, e);
  }
  return [...byProject.values()]
    .map((e) => ({ ...e, open: e.total - e.closed, name: fullObjectName(e.project) }))
    .sort((a, b) => a.project.localeCompare(b.project, 'ru'));
}

function addSummarySheet(wb, rows, { period }) {
  const ws = wb.addWorksheet('Сводная');
  ws.views = [{ showGridLines: false }];
  ws.columns = [{ width: 6 }, { width: 78 }, { width: 14 }, { width: 12 }, { width: 12 }];
  ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.6, right: 0.6, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } };
  const data = summarize(rows);
  const total = data.reduce((s, e) => s + e.total, 0);
  const closed = data.reduce((s, e) => s + e.closed, 0);

  const text = (value, { size = 12, bold = false, align = 'left', height } = {}) => {
    const row = ws.addRow([value]);
    ws.mergeCells(row.number, 1, row.number, 5);
    row.getCell(1).font = { name: FONT, size, bold };
    row.getCell(1).alignment = { horizontal: align, vertical: 'middle', wrapText: true };
    if (height) row.height = height;
  };
  text(`Выявленные замечания и их устранения за ${period.heading}:`, { size: 14, bold: true, align: 'center', height: 26 });
  ws.addRow([]).height = 6;
  text(
    total
      ? `${period.sentencePeriod} экспертами ТН было выявлено ${total} ${plural(total, 'замечание', 'замечания', 'замечаний')} по объектам`
      : `${period.sentencePeriod} замечаний не выявлено`,
    { size: 12, height: 22 }
  );
  ws.addRow([]).height = 6;
  text('Сводная таблица:', { size: 12, bold: true, height: 22 });

  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const head = ws.addRow(['№', 'Наименование объекта', period.totalHeader, 'Открыто', 'Закрыто']);
  head.height = 32;
  head.eachCell((cell) => {
    cell.font = { name: FONT, size: 12, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = border;
  });
  data.forEach((e, i) => {
    const row = ws.addRow([i + 1, e.name, e.total, e.open, e.closed]);
    row.height = Math.max(20, Math.ceil(e.name.length / 70) * 16 + 6);
    row.eachCell((cell, n) => {
      cell.font = { name: FONT, size: 12 };
      cell.border = border;
      cell.alignment = n === 2 ? { horizontal: 'left', vertical: 'middle', wrapText: true } : { horizontal: 'center', vertical: 'middle' };
    });
  });
  if (data.length) {
    const row = ws.addRow(['Итого', null, total, total - closed, closed]);
    ws.mergeCells(row.number, 1, row.number, 2);
    row.height = 22;
    row.eachCell({ includeEmpty: true }, (cell, n) => {
      cell.font = { name: FONT, size: 12, bold: true };
      cell.border = border;
      cell.alignment = { horizontal: n <= 2 ? 'right' : 'center', vertical: 'middle' };
    });
  }
  return ws;
}

module.exports = { addTitleSheet, addSummarySheet, summarize, describePeriod, fullObjectName, OBJECT_NAMES };
