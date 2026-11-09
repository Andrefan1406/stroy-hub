// Выгрузка ВДЦ в Excel по образцу «ВДЦ 2 пто-26-35.xlsx»: для каждого блока (секции) две вкладки —
// «ВДЦ БЛОК N» (работы по квартирам без разбивки на помещения) и «ГПР БЛОК N» (график с сеткой по неделям
// или по 3 дня и диаграммой Ганта, которая закрашивается условным форматированием по датам начала и окончания).
//
// Цены в ВДЦ — расценка прайса с НДС за вычетом 10 % (на уборку мусора), округлённая до целого. «Уборка мусора» — те самые
// 10 % от каждой расценки (сумма по строкам = 90 %, значит 10 % = сумма / 9). Суммы, «Уборка мусора» и «Итого» — формулы Excel.
// График (ГПР) — по блоку целиком, без разбивки по этажам.
const DAY = 86400000;
const FONT = { name: "Times New Roman", size: 12 };
const THIN = { style: "thin" };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
export const GARBAGE_PERCENT = 10;
export const OBJECT_PLACEHOLDER = "Наименование объекта: ______________________________";
// «Строительство …» с титульного листа или штампа → строка для шапки
export const objectLine = (name) => (name ? `Наименование объекта: «${name}»` : OBJECT_PLACEHOLDER);

// «2026-03-05» → Date (UTC, полночь); неверная дата → null
export function parseIsoDate(s) {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
}

const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const diffDays = (a, b) => Math.round((b.getTime() - a.getTime()) / DAY);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Период короче месяца — сетка по 3 дня, иначе по неделе; первый столбец начинается с даты начала графика
// (не с понедельника: иначе закрашивается день до начала). → { step, starts: [Date] }
export function buildGrid(start, end) {
  const days = diffDays(start, end) + 1;
  const step = days < 30 ? 3 : 7;
  const first = start;
  const starts = [];
  for (let d = first; d <= end; d = addDays(d, step)) starts.push(d);
  return { step, starts };
}

// Цена в ВДЦ: расценка с НДС минус 10 %, округлённая до целого
export const priceAfterGarbage = (priceVat) => Math.round(priceVat * (1 - GARBAGE_PERCENT / 100));

// Работы квартиры без разбивки по помещениям: одинаковые работы складываются.
// → { items: [{ work, rateNo, unit, qty, priceVat }], skipped }  (без объёма или цены — пропущены и посчитаны)
export function aggregateFlat(row) {
  const acc = new Map();
  let skipped = 0;
  for (const l of row.works?.lines || []) {
    if (l.qty === null || l.qty === undefined || !(l.qty > 0) || l.priceVat === null || l.priceVat === undefined) {
      skipped += 1;
      continue;
    }
    const key = `${l.work}|${l.rateNo}`;
    const cur = acc.get(key) || { work: l.work, rateNo: l.rateNo, unit: l.unit, qty: 0, priceVat: l.priceVat };
    cur.qty += l.qty;
    acc.set(key, cur);
  }
  return { items: [...acc.values()].map((x) => ({ ...x, qty: round2(x.qty) })), skipped };
}

// Блоки: [{ id, rows }] в порядке секций
export function groupBlocks(rows, sections) {
  return sections.map((id) => ({ id, rows: rows.filter((r) => r.section === id) })).filter((b) => b.rows.length);
}

// Равномерно делит [start, end] на n долей: [{ start, end }] (у каждой не меньше одного дня)
export function splitPeriod(start, end, n) {
  const days = diffDays(start, end) + 1;
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * days) / n);
    const b = Math.max(a, Math.floor(((i + 1) * days) / n) - 1);
    return { start: addDays(start, Math.min(a, days - 1)), end: addDays(start, Math.min(b, days - 1)) };
  });
}

const colLetter = (n) => {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

function styleCell(cell, { bold, align = "left", wrap = false, fmt, fill } = {}) {
  cell.font = { ...FONT, bold: !!bold };
  cell.border = BORDER;
  cell.alignment = { vertical: "middle", horizontal: align, wrapText: wrap };
  if (fmt) cell.numFmt = fmt;
  if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
}

function header(ws, titleCols, title, objectName, lastCol, position) {
  ws.getCell(`${colLetter(lastCol)}2`).value = "Приложение №          от                          ";
  ws.getCell(`${colLetter(lastCol)}3`).value = "к Договору субподряда ";
  ws.getCell(`${colLetter(lastCol)}4`).value = "№                  от                             г.";
  [2, 3, 4].forEach((r) => {
    const c = ws.getCell(`${colLetter(lastCol)}${r}`);
    c.font = { ...FONT, size: 10 };
    c.alignment = { horizontal: "right" };
  });
  ws.mergeCells(`A5:${colLetter(titleCols)}5`);
  ws.getCell("A5").value = title;
  ws.getCell("A5").font = { ...FONT, bold: true, size: 14 };
  ws.getCell("A5").alignment = { horizontal: "center", vertical: "middle" };
  ws.mergeCells(`A6:${colLetter(titleCols)}6`);
  ws.getCell("A6").value = objectName;
  ws.getCell("A6").font = FONT;
  ws.getCell("A6").alignment = { wrapText: true, vertical: "middle" };
  ws.getRow(6).height = 52;
  if (position) {
    ws.mergeCells(`A7:${colLetter(titleCols)}7`);
    ws.getCell("A7").value = `Позиция: ${position}`;
    ws.getCell("A7").font = { ...FONT, bold: true };
    ws.getCell("A7").alignment = { vertical: "middle" };
  }
}

function signatures(ws, row, leftCol, rightCol) {
  ws.getCell(`${leftCol}${row}`).value = "Генподрядчик";
  ws.getCell(`${rightCol}${row}`).value = "Субподрядчик";
  ws.getCell(`${leftCol}${row + 3}`).value = "ТОО ";
  ws.getCell(`${rightCol}${row + 3}`).value = "ТОО ";
  ws.getCell(`${leftCol}${row + 6}`).value = "Составил:";
  ws.getCell(`${rightCol}${row + 6}`).value = "Составил:";
  for (const r of [row, row + 3, row + 6]) {
    for (const c of [leftCol, rightCol]) {
      ws.getCell(`${c}${r}`).font = { ...FONT, bold: r === row };
    }
  }
}

// Вкладка ВДЦ блока. → { skipped } (строк без объёма или цены)
function addVdcSheet(wb, block, objectName, position) {
  const ws = wb.addWorksheet(`ВДЦ БЛОК ${block.id}`, { views: [{ state: "frozen", ySplit: 8 }] });
  [8, 8, 8, 24, 70, 9, 12, 16, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  header(ws, 9, "Ведомость договорной цены", objectName, 9, position);

  const heads = ["№ п/п", "Блок", "Этаж", "Тип квартиры (помещения)", "Наименование работ", "Ед.изм.", "Кол-во",
    "Цена за ед., тг (с НДС)", "Сумма, тг (с НДС)"];
  heads.forEach((h, i) => {
    const c = ws.getCell(8, i + 1);
    c.value = h;
    styleCell(c, { bold: true, align: "center", wrap: true });
  });
  ws.getRow(8).height = 56;

  let r = 9;
  let n = 0;
  let skipped = 0;
  let sumRes = 0;
  for (const row of block.rows) {
    const { items, skipped: sk } = aggregateFlat(row);
    skipped += sk;
    for (const it of items) {
      n += 1;
      const price = priceAfterGarbage(it.priceVat);
      ws.getCell(r, 1).value = n;
      ws.getCell(r, 2).value = block.id;
      ws.getCell(r, 3).value = row.levelLabel || row.floor;
      ws.getCell(r, 4).value = row.label;
      ws.getCell(r, 5).value = it.work;
      ws.getCell(r, 6).value = it.unit;
      ws.getCell(r, 7).value = it.qty;
      ws.getCell(r, 8).value = price;
      ws.getCell(r, 9).value = { formula: `G${r}*H${r}`, result: round2(it.qty * price) };
      sumRes += it.qty * price;
      for (const c of [1, 2, 3, 6]) styleCell(ws.getCell(r, c), { align: "center" });
      styleCell(ws.getCell(r, 4), { wrap: true });
      styleCell(ws.getCell(r, 5), { wrap: true });
      styleCell(ws.getCell(r, 7), { align: "right", fmt: "#,##0.00" });
      styleCell(ws.getCell(r, 8), { align: "right", fmt: "#,##0" });
      styleCell(ws.getCell(r, 9), { align: "right", fmt: "#,##0.00" });
      r += 1;
    }
  }
  const first = 9;
  const last = Math.max(first, r - 1);
  const garbageRow = r;
  const totalRow = r + 1;
  const garbage = Math.round((sumRes * GARBAGE_PERCENT) / (100 - GARBAGE_PERCENT));
  ws.getCell(garbageRow, 5).value = `Уборка мусора ${GARBAGE_PERCENT}%`;
  ws.getCell(garbageRow, 9).value = n
    ? { formula: `ROUND(SUM(I${first}:I${last})*${GARBAGE_PERCENT}/${100 - GARBAGE_PERCENT},0)`, result: garbage }
    : 0;
  ws.getCell(totalRow, 5).value = "Итого:";
  ws.getCell(totalRow, 9).value = { formula: `SUM(I${first}:I${last})+I${garbageRow}`, result: round2(sumRes + garbage) };
  for (const rr of [garbageRow, totalRow]) {
    for (let c = 1; c <= 9; c += 1) styleCell(ws.getCell(rr, c), { bold: true });
    ws.getCell(rr, 5).alignment = { horizontal: "right", vertical: "middle" };
    ws.getCell(rr, 9).numFmt = "#,##0.00";
    ws.getCell(rr, 9).alignment = { horizontal: "right", vertical: "middle" };
  }
  signatures(ws, totalRow + 3, "E", "G");
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return { skipped };
}

// Вкладка ГПР блока: этажи, под каждым — работы этажа; сетка по неделям или по 3 дня; Гант — условное форматирование.
function addGprSheet(wb, block, schedule, objectName, position) {
  const { start, end } = schedule;
  const { step, starts } = buildGrid(start, end);
  const ws = wb.addWorksheet(`ГПР БЛОК ${block.id}`, { views: [{ state: "frozen", xSplit: 4, ySplit: 9 }] });
  const GRID0 = 5; // первая колонка сетки (E)
  const lastCol = GRID0 + starts.length - 1;
  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 62;
  ws.getColumn(3).width = 13;
  ws.getColumn(4).width = 13;
  for (let c = GRID0; c <= lastCol; c += 1) ws.getColumn(c).width = step === 7 ? 6.5 : 5.5;
  header(ws, Math.max(lastCol, 6), `График производства работ — блок №${block.id}`, objectName, lastCol, position);

  // шапка: № / работы / начало / окончание, над сеткой — месяцы, под ними — даты начала периодов
  ["№ п/п", "Наименование работ", "Начало", "Окончание"].forEach((h, i) => {
    ws.mergeCells(8, i + 1, 9, i + 1);
    const c = ws.getCell(8, i + 1);
    c.value = h;
    styleCell(c, { bold: true, align: "center", wrap: true });
    styleCell(ws.getCell(9, i + 1), { bold: true });
  });
  let from = 0;
  for (let i = 0; i <= starts.length; i += 1) {
    const key = i < starts.length ? `${starts[i].getUTCFullYear()}-${starts[i].getUTCMonth()}` : null;
    const prev = `${starts[from].getUTCFullYear()}-${starts[from].getUTCMonth()}`;
    if (key !== prev) {
      const a = GRID0 + from;
      const b = GRID0 + i - 1;
      if (b > a) ws.mergeCells(8, a, 8, b);
      const c = ws.getCell(8, a);
      c.value = `${MONTHS[starts[from].getUTCMonth()]} ${starts[from].getUTCFullYear()}`;
      for (let x = a; x <= b; x += 1) styleCell(ws.getCell(8, x), { bold: true, align: "center" });
      from = i;
    }
  }
  starts.forEach((d, i) => {
    const c = ws.getCell(9, GRID0 + i);
    c.value = d;
    styleCell(c, { bold: true, align: "center", fmt: "dd.mm" });
    c.alignment = { horizontal: "center", vertical: "middle", textRotation: 90 };
  });
  ws.getRow(9).height = 40;

  // работы блока (виды работ по всем квартирам блока, в порядке появления); период делится между ними по очереди
  const works = [];
  for (const row of block.rows) for (const it of aggregateFlat(row).items) if (!works.includes(it.work)) works.push(it.work);
  const periods = splitPeriod(start, end, works.length);
  let r = 10;
  works.forEach((w, i) => {
    ws.getCell(r, 1).value = i + 1;
    ws.getCell(r, 2).value = w;
    ws.getCell(r, 3).value = periods[i].start;
    ws.getCell(r, 4).value = periods[i].end;
    styleCell(ws.getCell(r, 1), { align: "center" });
    styleCell(ws.getCell(r, 2), { wrap: true });
    styleCell(ws.getCell(r, 3), { align: "center", fmt: "dd.mm.yyyy" });
    styleCell(ws.getCell(r, 4), { align: "center", fmt: "dd.mm.yyyy" });
    for (let c = GRID0; c <= lastCol; c += 1) styleCell(ws.getCell(r, c), {});
    r += 1;
  });
  const lastRow = Math.max(10, r - 1);

  // диаграмма Ганта: период сетки пересекается с [Начало; Окончание] строки
  const range = `${colLetter(GRID0)}10:${colLetter(lastCol)}${lastRow}`;
  const cell = `${colLetter(GRID0)}$9`;
  const formula = `AND(ISNUMBER($C10),ISNUMBER($D10),${cell}<=$D10,${cell}+${step - 1}>=$C10)`;
  ws.addConditionalFormatting({
    ref: range,
    rules: [{ type: "expression", priority: 1, formulae: [formula], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF4F9DDE" } } } }],
  });

  const sigRow = lastRow + 3;
  signatures(ws, sigRow, "B", "D");
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return { step, columns: starts.length, works: works.length };
}

// rows — квартиры с посчитанными работами (row.works.lines); sections — идентификаторы секций по порядку;
// schedule: { start: Date, end: Date }. → { workbook, skipped, grid: { step, columns } }
export async function buildVdcWorkbook({ rows, sections, schedule, objectName = OBJECT_PLACEHOLDER, position = "" }) {
  const ExcelJS = (await import("exceljs")).default || (await import("exceljs"));
  const wb = new ExcelJS.Workbook();
  wb.creator = "stroy-hub";
  wb.calcProperties = { fullCalcOnLoad: true };
  let skipped = 0;
  let grid = null;
  for (const block of groupBlocks(rows, sections)) {
    skipped += addVdcSheet(wb, block, objectName, position).skipped;
    grid = addGprSheet(wb, block, schedule, objectName, position);
  }
  return { workbook: wb, skipped, grid };
}
