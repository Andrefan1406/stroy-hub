// Черновик лимитно-заборной карты (ЛЗК) по ведомости договорной цены (ВДЦ).
//
// Вход — Excel с ВДЦ: из столбцов «Наименование работ», «Ед. изм.», «Кол-во»
// строки с одной работой группируются и суммируются (в ВДЦ одна и та же работа
// идёт отдельной строкой на каждый этаж). Название работы приводится к
// наименованию по расценкам через словарь (norms.json → dictionary), по нему
// берутся нормы расхода материалов на единицу работы (norms.json → works).
// Лимит материала = сумма по работам (объём × норма).
//
// Выход — Excel: лист «ЛЗК» (лимиты + пустые столбцы по дням на год вперёд от
// первого числа месяца, формулы итогов и остатка) и лист «Расчёт» (откуда
// взялся каждый лимит, плюс работы, которые не удалось сопоставить).
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const NORMS = require('./norms.json');

const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_COUNT = 12;

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[ \s]+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, ''); // «…250 мм.» = «…250 мм»

// Единицы в файлах бывают «м3», «м³», «М3», «мп», «м.п.», «м.пог.» — сравниваем в одном виде.
const normUnit = (s) =>
  norm(s)
    .replace(/³/g, '3')
    .replace(/²/g, '2')
    .replace(/[.\s]/g, '')
    .replace(/^(м|мпог|погм)$/, 'мп'); // «м», «пог.м.», «м.пог.» = погонные метры

const toNumber = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
};

// Норма «blank» в norms.json: материал выводится в М-29, но лимит и норма — пустые ячейки (заполняет участок)
const BLANK = 'blank';
const dictionary = new Map(Object.entries(NORMS.dictionary).map(([k, v]) => [norm(k), v]));
const worksByName = new Map(NORMS.works.map((w) => [norm(w.name), w]));
const materialsById = new Map(NORMS.materials.map((m) => [m.id, m]));

// Название из ВДЦ → норма расхода (или null). Подходят и название «из отчётов»
// (словарь), и сразу название по расценкам.
function lookupWork(name) {
  const key = norm(name);
  const priceName = dictionary.get(key);
  return worksByName.get(priceName ? norm(priceName) : key) || null;
}

// Сначала название как есть; если не нашлось — без пояснения в скобках в конце
// («Облицовка фартука … плиткой (кухня)», «…слой(короб возле лифта)»).
function findWork(name) {
  const direct = lookupWork(name);
  if (direct) return direct;
  const stripped = String(name).replace(/\s*\([^)]*\)\s*$/, '');
  return stripped !== String(name) ? lookupWork(stripped) : null;
}

// --- Разбор ВДЦ -----------------------------------------------------------

// Заголовки столбцов в разных формах ВДЦ: «Наименование работ», «Наименование видов
// работ, затрат»; «Кол-во», «Количество», «Объем работ, кол-во» (бывает «Обьем»).
const NAME_HEADER = /^наименование(\s+(видов\s+)?работ|$)/;
const UNIT_HEADER = /^(ед\.?\s*из\s*м|единиц\S*\s+из\s*м)/; // «Ед. изм.», «Ед.из м.» (перенос в шапке), «Единицы измерения»
const QTY_HEADER = /^(кол-?во|кол\.|количество|об[ъь]?[её]м)/;

// Что в шапке есть из нужных трёх столбцов (для ошибки: показать, что нашли, а чего нет).
const headerCells = (row) => row.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);

function parseContractPrice(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  // скрытые листы (Hidden: 1 — скрыт, 2 — «очень скрыт») не читаем
  const hidden = new Set(
    (wb.Workbook?.Sheets || []).filter((s) => s.Hidden).map((s) => s.name),
  );
  let problem = null; // каких столбцов не хватило в шапке — для подсказки в ошибке
  for (const sheetName of wb.SheetNames) {
    if (hidden.has(sheetName)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const headerIdx = rows.findIndex((r) => r.some((c) => NAME_HEADER.test(norm(c))));
    if (headerIdx === -1) {
      // «Ед. изм.» и «Кол-во» есть, а названия работ называются иначе — подскажем, что переименовать
      const unitQtyRow = rows.find((r) => r.some((c) => UNIT_HEADER.test(norm(c))) && r.some((c) => QTY_HEADER.test(norm(c))));
      if (!problem && unitQtyRow) problem = { missing: ['«Наименование работ»'], cells: headerCells(unitQtyRow) };
      continue;
    }

    const header = rows[headerIdx].map(norm);
    const nameCol = header.findIndex((c) => NAME_HEADER.test(c));
    const unitCol = header.findIndex((c) => UNIT_HEADER.test(c));
    const qtyCol = header.findIndex((c) => QTY_HEADER.test(c));
    if (unitCol === -1 || qtyCol === -1) {
      problem = {
        missing: [unitCol === -1 && '«Ед. изм.»', qtyCol === -1 && '«Кол-во»'].filter(Boolean),
        cells: headerCells(rows[headerIdx]),
      };
      continue;
    }

    const items = [];
    for (const row of rows.slice(headerIdx + 1)) {
      const name = String(row[nameCol] ?? '').trim();
      if (!name) {
        // пустая строка названия: либо итог/подписи (конец таблицы), либо шум
        if (items.length) break;
        continue;
      }
      if (/^(итого|всего)/.test(norm(name))) break;
      const unit = String(row[unitCol] ?? '').trim();
      // строки-разделы («поз. 73,75») — без единицы и количества, это не работа
      if (!unit && String(row[qtyCol] ?? '').trim() === '') continue;
      // демонтаж — материалы на него не нужны, в лимиты не попадает (и в «Не учтено» тоже)
      if (/^демонтаж/.test(norm(name))) continue;
      // поставка материала («Декоративная окраска (материал)», «Поставка …») — не работа, убираем совсем
      if (/\(материал\)|^поставка\s/.test(norm(name))) continue;
      const sanitary = /сан\.?\s*узел/i.test(row.map((c) => String(c ?? '')).join(' '));
      items.push({ name, unit, qty: toNumber(row[qtyCol]), sanitary });
    }
    return { items, meta: parseMeta(rows.slice(0, headerIdx), rows.slice(headerIdx + 1)) };
  }
  const fix = 'Переименуйте названия в шапке таблицы на «Наименование работ», «Ед. изм.», «Кол-во» и загрузите файл снова.';
  throw new Error(
    problem
      ? `В шапке таблицы ВДЦ не найден столбец ${problem.missing.join(' и ')}. Сейчас в шапке: ${problem.cells.map((c) => `«${c}»`).join(', ')}. ${fix}`
      : `В файле не найдена таблица ВДЦ (столбцы «Наименование работ», «Ед. изм.», «Кол-во»). ${fix}`,
  );
}

// Шапка ВДЦ: приложение, договор, субподрядчик, объект. Всё необязательное —
// чего не нашли, то оставим пустым в карте.
// Субподрядчик из блока подписей под таблицей, если в шапке его нет:
//   Генподрядчик          Субподрядчик          (подпись «Субподрядчик» — своя ячейка,
//   Директор              Руководитель           под ней в том же столбце должность
//   ТОО «VK INVEST …»     ИП "САПАРГАЛИЕВА"      и организация; либо всё в одной ячейке
//                                                 через перенос строки)
// «Генподрядчик» не подходит — это мы сами.
const ORG_LINE = /^(ип|тоо|ао|тко|ккп|гкп|кх|к\/х|ооо)[\s«"]/i;
const SUB_LABEL = /^(суб)?подр[яа]д?чик:?$/i;

function subcontractorFromSignatures(rows) {
  const cellText = (r, c) => String(rows[r]?.[c] ?? '').trim();
  const orgIn = (lines) => lines.map((l) => l.trim()).find((l) => ORG_LINE.test(l)) || '';

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < (rows[r]?.length || 0); c++) {
      const lines = cellText(r, c).split(/\r?\n/);
      if (!SUB_LABEL.test(lines[0].trim())) continue;
      const org = orgIn(lines.slice(1)) || orgIn(Array.from({ length: 5 }, (_, i) => cellText(r + 1 + i, c)));
      if (org) return org;
    }
  }
  return '';
}

function parseMeta(rows, tailRows = []) {
  const texts = rows.flat().map((c) => String(c ?? '').trim()).filter(Boolean);
  const find = (re) => texts.find((t) => re.test(t));

  // договор и приложение ищем по всему тексту шапки: «к Договору субподряда» и
  // «№ П-26-144 от 08.06.2026г.» бывают в одной ячейке, в двух или вместе с «Приложение №7…»
  const all = texts.join(' ').replace(/\s+/g, ' ');
  const contractMatch = all.match(/к\s+договору\s+([^№]*?)\s*№\s*([^\s]+)\s+от\s+(\d{2}\.\d{2}\.\d{4})/i);
  const contract = contractMatch ? `К договору ${contractMatch[1]} № ${contractMatch[2]} от ${contractMatch[3]}` : '';
  const annex = all.match(/приложение\s*№\s*([\w./-]+)/i);
  let sub = (find(/^(суб)?подр[яа]д?чик/i) || '').replace(/^(суб)?подр[яа]д?чик\s*:?\s*/i, '');
  // название объекта — текст в кавычках; после закрывающей может идти хвост «(ДО-ДО).»
  // (бывает и без кавычек — «Строительство многоэтажных … (поз 59,69,65).»; кавычки
  // вокруг фамилии субподрядчика за объект не принимаем)
  const objectCell = find(/[«"]\s*строительство/i) || find(/^строительство/i) || find(/^[«"][^«»"]{15,}[»"]\.?$/) || '';
  const quoted = objectCell.match(/[«"]\s*([^«»"]+?)\s*[»"]/);
  const objectTail = quoted ? objectCell.slice(objectCell.indexOf(quoted[0]) + quoted[0].length).trim() : '';
  const object = ((quoted ? quoted[1] : objectCell) + (/^(поз|блок)/i.test(objectTail) ? ` ${objectTail}` : '')).replace(/\s+/g, ' ').replace(/^наименование объекта\s*:\s*/i, '').replace(/^[«"]\s*|\s*[»"]$/g, '');

  let basis = contract.replace(/\s+года$/i, '').replace(/(\d{4})\s*г\.?$/i, '$1г.');
  if (basis && !/г\.?$/.test(basis)) basis += 'г.';
  if (basis && annex) basis += `, прил.${annex[1]}`;

  if (!sub) sub = subcontractorFromSignatures(tailRows);

  return { basis, recipient: sub, object };
}

// --- Расчёт ---------------------------------------------------------------

function calculate(items) {
  const groups = new Map(); // ключ работа+ед → { name, unit, qty }
  for (const it of items) {
    const key = `${norm(it.name)}|${normUnit(it.unit)}`;
    const g = groups.get(key) || { name: it.name, unit: it.unit, qty: 0, rows: 0, bad: false, idx: groups.size, sanQty: 0 };
    if (Number.isFinite(it.qty)) g.qty += it.qty;
    else g.bad = true;
    if (it.sanitary && Number.isFinite(it.qty)) g.sanQty += it.qty;
    g.rows += 1;
    groups.set(key, g);
  }

  const works = [];
  const unmatched = [];
  const totals = new Map(); // id материала → количество
  const noLimit = new Set(); // материалы без нормы у работ с lzkAll: попадают в ЛЗК строкой без лимита
  const breakdown = []; // строки листа «Расчёт»

  for (const g of groups.values()) {
    const qty = Math.round(g.qty * 1e6) / 1e6;
    const work = findWork(g.name);
    if (!work) {
      unmatched.push({ ...g, qty, reason: 'нет в словаре расценок / нормах расхода' });
      continue;
    }
    if (normUnit(work.unit) !== normUnit(g.unit)) {
      unmatched.push({ ...g, qty, reason: `единица в ВДЦ «${g.unit}», в нормах «${work.unit}»` });
      continue;
    }
    if (g.bad) {
      unmatched.push({ ...g, qty, reason: 'в части строк не число в «Кол-во»' });
      continue;
    }
    const extraNorms = g.sanQty > 0 ? work.extras?.sanitary || null : null;
    const extraQty = Math.round(g.sanQty * 1e6) / 1e6;
    works.push({ ...g, qty, priceName: work.name, norms: work.norms, extraNorms, extraQty });
    for (const [id, perUnit] of Object.entries(extraNorms || {})) {
      const amount = extraQty * perUnit;
      totals.set(id, (totals.get(id) || 0) + amount);
      breakdown.push({ work: `${work.name} (санузлы)`, material: materialsById.get(id), perUnit, qty: extraQty, unit: work.unit, amount });
    }
    for (const [id, perUnit] of Object.entries(work.norms)) {
      if (perUnit === null || perUnit === BLANK) {
        if (work.lzkAll) noLimit.add(id); // у остальных работ «факт»-материалы в ЛЗК не выводятся
        breakdown.push({ work: work.name, material: materialsById.get(id), perUnit, qty, unit: work.unit, amount: null });
        continue;
      }
      const amount = qty * perUnit;
      totals.set(id, (totals.get(id) || 0) + amount);
      breakdown.push({ work: work.name, material: materialsById.get(id), perUnit, qty, unit: work.unit, amount });
    }
  }

  // Порядок материалов — как в таблице норм; штучные округляем вверх (дробную
  // деталь со склада не выдают), остальные — до сотых.
  const materials = NORMS.materials
    .filter((m) => totals.has(m.id) || noLimit.has(m.id))
    .map((m) => {
      if (!totals.has(m.id)) return { ...m, limit: null };
      const raw = totals.get(m.id);
      const limit = m.unit === 'шт' ? Math.ceil(raw - 1e-9) : Math.round(raw * 100) / 100;
      return { ...m, limit };
    });

  return { works, unmatched, materials, breakdown };
}

// --- Excel ----------------------------------------------------------------

const THIN = { style: 'thin', color: { argb: 'FF000000' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };

function startOfMonth(monthStr) {
  // monthStr — 'YYYY-MM'; по умолчанию текущий месяц по Алматы
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr || '');
  if (m) return { year: Number(m[1]), month: Number(m[2]) - 1 };
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Almaty' }));
  return { year: now.getFullYear(), month: now.getMonth() };
}

const pad = (n) => String(n).padStart(2, '0');

async function buildWorkbook({ meta, result, monthStr }) {
  const start = startOfMonth(monthStr);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'stroy-hub';
  const ws = wb.addWorksheet('ЛЗК', { views: [{ state: 'frozen', xSplit: 4, ySplit: 8 }] });

  const FIRST_ROW = 9;
  const lastRow = FIRST_ROW + result.materials.length - 1;

  // Колонки: A №, B материал, C ед., D лимит, дальше месяцы.
  const months = [];
  let col = 5;
  for (let i = 0; i < MONTHS_COUNT; i++) {
    const d = new Date(Date.UTC(start.year, start.month + i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    months.push({ year, month, days, firstCol: col, totalCol: col + days });
    col += days + 1;
  }
  const issuedCol = col;
  const remainCol = col + 1;
  const colL = (n) => ws.getColumn(n).letter;

  const first = months[0];
  const last = months[months.length - 1];
  ws.getCell('B1').value = 'Лимитно-заборная карта';
  ws.getCell('B2').value = `на период ${pad(1)}.${pad(first.month + 1)}.${first.year} – ${pad(last.days)}.${pad(last.month + 1)}.${last.year}`;
  ws.getCell('B3').value = `Основание: ${meta.basis}`.trim();
  ws.getCell('B4').value = `МОЛ-получатель ТМЗ: ${meta.recipient}`.trim();
  ws.getCell('B5').value = `Наименование объекта: "${meta.object}"`;
  ws.getCell('B1').font = { bold: true, size: 14 };
  ws.getCell('B2').font = { italic: true };
  for (const r of [3, 4, 5]) ws.getCell(`B${r}`).font = { bold: true };
  ws.getCell('B6').value = 'ЧЕРНОВИК: лимиты рассчитаны автоматически по ВДЦ и нормам расхода — проверьте перед использованием';
  ws.getCell('B6').font = { italic: true, color: { argb: 'FFC00000' } };

  // Шапка: строка 7 — подписи месяцев, строка 8 — столбцы.
  ws.mergeCells('A7:A8');
  ws.mergeCells('B7:B8');
  ws.mergeCells('C7:C8');
  ws.mergeCells('D7:D8');
  ws.getCell('A7').value = '№ п/п';
  ws.getCell('B7').value = 'Наименование материала';
  ws.getCell('C7').value = 'Ед.изм.';
  ws.getCell('D7').value = 'Лимит';

  for (const m of months) {
    ws.mergeCells(7, m.firstCol, 7, m.firstCol + m.days - 1);
    ws.getCell(7, m.firstCol).value = `Выдано в течение ${MONTHS_GEN[m.month]} ${m.year} года`;
    for (let d = 1; d <= m.days; d++) ws.getCell(8, m.firstCol + d - 1).value = `${pad(d)}.${pad(m.month + 1)}`;
    ws.mergeCells(7, m.totalCol, 8, m.totalCol);
    ws.getCell(7, m.totalCol).value = `Итого выдано за ${MONTHS_NOM[m.month]} ${m.year} года`;
  }
  ws.mergeCells(7, issuedCol, 8, issuedCol);
  ws.getCell(7, issuedCol).value = 'Выдано за период';
  ws.mergeCells(7, remainCol, 8, remainCol);
  ws.getCell(7, remainCol).value = 'Остаток лимита';

  for (let r = 7; r <= 8; r++) {
    for (let c = 1; c < remainCol + 1; c++) {
      const cell = ws.getCell(r, c);
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = HEAD_FILL;
      cell.border = BORDER;
    }
  }
  ws.getRow(8).height = 34;

  // Данные.
  const numFmt = '#,##0.00;[Red]-#,##0.00';
  result.materials.forEach((mat, i) => {
    const r = FIRST_ROW + i;
    ws.getCell(r, 1).value = i + 1;
    ws.getCell(r, 2).value = mat.name.charAt(0).toUpperCase() + mat.name.slice(1);
    ws.getCell(r, 3).value = mat.unit;
    ws.getCell(r, 4).value = mat.limit; // null — лимита нет (норма «факт»): ячейка пустая
    ws.getCell(r, 4).numFmt = mat.unit === 'шт' ? '#,##0' : '#,##0.00';

    const totalRefs = [];
    for (const m of months) {
      const from = `${colL(m.firstCol)}${r}`;
      const to = `${colL(m.firstCol + m.days - 1)}${r}`;
      ws.getCell(r, m.totalCol).value = { formula: `SUM(${from}:${to})`, result: 0 };
      ws.getCell(r, m.totalCol).numFmt = numFmt;
      totalRefs.push(`${colL(m.totalCol)}${r}`);
    }
    ws.getCell(r, issuedCol).value = { formula: totalRefs.join('+'), result: 0 };
    if (mat.limit !== null) ws.getCell(r, remainCol).value = { formula: `D${r}-${colL(issuedCol)}${r}`, result: mat.limit };
    ws.getCell(r, issuedCol).numFmt = numFmt;
    ws.getCell(r, remainCol).numFmt = numFmt;

    for (let c = 1; c <= remainCol; c++) {
      const cell = ws.getCell(r, c);
      cell.border = BORDER;
      if (c === 2) cell.alignment = { wrapText: true, vertical: 'middle' };
      else if (c <= 4) cell.alignment = { horizontal: 'center', vertical: 'middle' };
      if (c === 4 || months.some((m) => m.totalCol === c) || c >= issuedCol) {
        cell.font = { bold: true };
        cell.fill = TOTAL_FILL;
      }
    }
  });

  ws.getColumn(1).width = 6;
  ws.getColumn(2).width = 46;
  ws.getColumn(3).width = 8;
  ws.getColumn(4).width = 11;
  for (const m of months) {
    for (let d = 0; d < m.days; d++) ws.getColumn(m.firstCol + d).width = 7;
    ws.getColumn(m.totalCol).width = 14;
  }
  ws.getColumn(issuedCol).width = 14;
  ws.getColumn(remainCol).width = 14;
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  void lastRow;

  addM29Sheet(wb, meta, result, start);
  addCalcSheet(wb, result);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Черновик отчёта М-29 «о расходе основных материалов в соответствии с
// производственными нормами». Заполнены только лимиты и нормы: объёмы работ
// и фактическое списание вносят на участке. Блок из четырёх столбцов на каждый
// месяц (норма, факт, эконом/перерасход, списать на себестоимость), в конце — «Остаток лимита».
function addM29Sheet(wb, meta, result, start) {
  const ws = wb.addWorksheet('М-29');
  const rnd = (n) => Math.round(n * 100) / 100;

  const months = [];
  for (let i = 0; i < MONTHS_COUNT; i++) {
    const d = new Date(Date.UTC(start.year, start.month + i, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
  }
  const FIXED = 6; // работа/материал, наименование, код, ед. изм., лимит, норма
  const colOf = (i, k) => FIXED + 1 + i * 4 + k; // k: 0 по норме, 1 по факту, 2 эконом/перерасход, 3 списать
  const remainCol = FIXED + 1 + months.length * 4;
  const L = (n) => ws.getColumn(n).letter;

  ws.getCell('A1').value = `Субподрядчик: ${meta.recipient}`;
  ws.getCell('A2').value = `Договор: ${meta.basis}`;
  ws.getCell('A1').font = ws.getCell('A2').font = { bold: true };
  ws.getCell('E1').value = 'Утверждаю';
  ws.getCell('E2').value = 'Директор ТОО "VK INVEST COMPANY"';
  ws.getCell('E3').value = 'Шкибаев Р.К. ________________';
  ws.getCell('E1').font = { bold: true };
  ws.getCell('A5').value = 'Отчёт';
  ws.getCell('A6').value = 'о расходе основных материалов в соответствии с производственными нормами';
  ws.getCell('A8').value = `Объект: ${meta.object}`;
  ws.getCell('A5').font = ws.getCell('A6').font = ws.getCell('A8').font = { bold: true };
  ws.getCell('A9').value = 'ЧЕРНОВИК: заполнены лимиты и нормы. Объём выполненных работ (строка «работа», «расход по норме») и расход по факту вносятся на участке';
  ws.getCell('A9').font = { italic: true, color: { argb: 'FFC00000' } };

  const H1 = 11;
  const H2 = 12;
  const fixedHead = ['работа/ материал', 'Наименование работ/материалов', 'Код.', 'Ед. изм.', 'Лимит', 'Норма расхода'];
  fixedHead.forEach((t, i) => {
    ws.mergeCells(H1, i + 1, H2, i + 1);
    ws.getCell(H1, i + 1).value = t;
  });
  months.forEach((m, i) => {
    ws.mergeCells(H1, colOf(i, 0), H1, colOf(i, 3));
    ws.getCell(H1, colOf(i, 0)).value = `${MONTHS_NOM[m.month]} ${m.year}`;
    ['расход по норме', 'расход по факту', 'эконом/ перерасход (+/-)', 'списать на себестоимость'].forEach((t, k) => {
      ws.getCell(H2, colOf(i, k)).value = t;
    });
  });
  ws.mergeCells(H1, remainCol, H2, remainCol);
  ws.getCell(H1, remainCol).value = 'Остаток лимита';
  for (let r = H1; r <= H2; r++) {
    for (let c = 1; c <= remainCol; c++) {
      const cell = ws.getCell(r, c);
      cell.font = { bold: true };
      cell.fill = HEAD_FILL;
      cell.border = BORDER;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }
  }
  ws.getRow(H2).height = 32;

  const NUM = '#,##0.00;[Red]-#,##0.00';
  let r = H2 + 1;
  // работы без норм (нет в словаре, другая единица) тоже идут строкой «работа» без материалов,
  // в порядке ВДЦ — нормы добавят позже; со сломанным количеством строку не выводим
  const m29Works = [...result.works, ...result.unmatched.filter((u) => !u.bad)].sort((a, b) => a.idx - b.idx);
  for (const w of m29Works) {
    const workRow = r;
    ws.getCell(r, 1).value = 'работа';
    ws.getCell(r, 2).value = w.name;
    ws.getCell(r, 4).value = w.unit;
    ws.getCell(r, 5).value = rnd(w.qty);
    if (!w.norms) ws.getCell(r, 6).value = 'нет норм';
    const matRows = [];
    const factRows = new Set(); // материалы с нормой «факт»: лимита нет, считает участок
    const manualRows = new Set(); // материалы только для санузлов: лимит есть, «по норме» вносит участок
    r += 1;
    for (const [id, perUnit] of Object.entries(w.norms || {})) {
      const mat = materialsById.get(id);
      const isBlank = perUnit === BLANK;
      const isFact = perUnit === null || isBlank;
      const limit = isFact ? null : mat.unit === 'шт' ? Math.ceil(w.qty * perUnit - 1e-9) : rnd(w.qty * perUnit);
      ws.getCell(r, 1).value = 'материал';
      ws.getCell(r, 2).value = mat.name.charAt(0).toUpperCase() + mat.name.slice(1);
      ws.getCell(r, 4).value = mat.unit;
      if (!isFact) ws.getCell(r, 5).value = limit;
      ws.getCell(r, 6).value = isBlank ? null : isFact ? 'факт' : perUnit;
      if (isFact) factRows.add(r);
      matRows.push(r);
      r += 1;
    }

    for (const [id, perUnit] of Object.entries(w.extraNorms || {})) {
      const mat = materialsById.get(id);
      const amount = w.extraQty * perUnit;
      ws.getCell(r, 1).value = 'материал';
      ws.getCell(r, 2).value = `${mat.name.charAt(0).toUpperCase()}${mat.name.slice(1)} (санузлы)`;
      ws.getCell(r, 4).value = mat.unit;
      ws.getCell(r, 5).value = mat.unit === 'шт' ? Math.ceil(amount - 1e-9) : rnd(amount);
      ws.getCell(r, 6).value = perUnit;
      manualRows.add(r);
      matRows.push(r);
      r += 1;
    }

    // формулы: по норме материала = объём работы × норма; эконом/перерасход
    // считается только когда внесён факт; «списать на себестоимость» за месяц —
    // объём работы (у строки «работа») или факт (у материала); остаток —
    // лимит минус всё списанное за год
    months.forEach((_, i) => {
      const cN = colOf(i, 0);
      const cF = colOf(i, 1);
      const cD = colOf(i, 2);
      const cW = colOf(i, 3);
      const N = L(cN);
      const F = L(cF);
      ws.getCell(workRow, cW).value = { formula: `IF(${N}${workRow}="","",${N}${workRow})` };
      for (const mr of matRows) {
        if (!factRows.has(mr) && !manualRows.has(mr)) ws.getCell(mr, cN).value = { formula: `IF(${N}${workRow}="","",${N}${workRow}*$F${mr})` };
        ws.getCell(mr, cD).value = { formula: `IF(OR(${F}${mr}="",${N}${mr}=""),"",${N}${mr}-${F}${mr})` };
        ws.getCell(mr, cW).value = { formula: `IF(${F}${mr}="","",${F}${mr})` };
      }
    });
    const writeOffs = (row) => months.map((_, i) => `${L(colOf(i, 3))}${row}`).join(',');
    for (const row of [workRow, ...matRows].filter((x) => !factRows.has(x))) {
      ws.getCell(row, remainCol).value = { formula: `E${row}-SUM(${writeOffs(row)})` };
    }

    for (let rr = workRow; rr < r; rr++) {
      const isWork = rr === workRow;
      for (let c = 1; c <= remainCol; c++) {
        const cell = ws.getCell(rr, c);
        cell.border = BORDER;
        if (c >= 5) cell.numFmt = NUM;
        if (isWork) cell.font = { bold: true };
        else if (c <= 2 || c === 4) cell.font = { italic: true };
        if (c === 2) cell.alignment = { wrapText: true, vertical: 'middle', horizontal: isWork ? 'left' : 'right' };
        else if (c <= 4) cell.alignment = { horizontal: 'center', vertical: 'middle' };
        // подсветка того, что считается формулой или уже заполнено нами
        if (c === 5 || c === 6) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
        if (c === remainCol || (c > FIXED && (c - FIXED - 1) % 4 === 3)) { cell.fill = TOTAL_FILL; cell.font = { bold: true }; }
      }
    }
  }

  r += 1;
  ['Составил:', 'Начальник участка ______________', 'Проверил:', 'Инженер ПТО ______________', 'Согласовал:', 'Начальник ПТО ______________']
    .forEach((t) => { ws.getCell(r++, 1).value = t; });

  ws.getColumn(1).width = 11;
  ws.getColumn(2).width = 52;
  ws.getColumn(3).width = 7;
  ws.getColumn(4).width = 8;
  ws.getColumn(5).width = 12;
  ws.getColumn(6).width = 10;
  for (let c = FIXED + 1; c < remainCol; c++) ws.getColumn(c).width = 13;
  ws.getColumn(remainCol).width = 14;
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: H2 }];
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function addCalcSheet(wb, result) {
  const ws = wb.addWorksheet('Расчёт');
  ws.columns = [{ width: 6 }, { width: 58 }, { width: 52 }, { width: 8 }, { width: 14 }, { width: 14 }];
  const head = (row) => {
    row.font = { bold: true };
    row.fill = HEAD_FILL;
    row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    row.eachCell((c) => { c.border = BORDER; });
  };
  const body = (row) => row.eachCell({ includeEmpty: true }, (c) => { c.border = BORDER; c.alignment = { wrapText: true, vertical: 'middle' }; });

  ws.addRow(['Объёмы работ (строки ВДЦ сгруппированы и просуммированы)']).font = { bold: true, size: 12 };
  head(ws.addRow(['№', 'Наименование в ВДЦ', 'Наименование по расценкам', 'Ед.', 'Кол-во', 'Строк в ВДЦ']));
  result.works.forEach((w, i) => body(ws.addRow([i + 1, w.name, w.priceName, w.unit, w.qty, w.rows])));
  if (!result.works.length) ws.addRow(['', 'нет распознанных работ']);

  if (result.unmatched.length) {
    ws.addRow([]);
    const t = ws.addRow(['Не учтено в лимитах — работы без норм расхода']);
    t.font = { bold: true, size: 12, color: { argb: 'FFC00000' } };
    head(ws.addRow(['№', 'Наименование в ВДЦ', 'Причина', 'Ед.', 'Кол-во', 'Строк в ВДЦ']));
    result.unmatched.forEach((w, i) => body(ws.addRow([i + 1, w.name, w.reason, w.unit, w.qty, w.rows])));
  }

  ws.addRow([]);
  ws.addRow(['Расход материалов по видам работ']).font = { bold: true, size: 12 };
  head(ws.addRow(['№', 'Работа (по расценкам)', 'Материал', 'Ед.', 'Норма на ед. работы', 'Расход']));
  result.breakdown.forEach((b, i) => {
    const row = ws.addRow([i + 1, b.work, b.material.name, b.material.unit, b.perUnit === BLANK ? '' : b.perUnit ?? 'по факту', b.amount === null ? '' : Math.round(b.amount * 1000) / 1000]);
    body(row);
  });
}

async function generate(buffer, { month } = {}) {
  const { items, meta } = parseContractPrice(buffer);
  if (!items.length) throw new Error('В таблице ВДЦ нет строк с работами');
  const result = calculate(items);
  if (!result.materials.length) {
    const names = result.unmatched.slice(0, 5).map((u) => `«${u.name}»`).join(', ');
    throw new Error(`Ни для одной работы не найдены нормы расхода: ${names}`);
  }
  const file = await buildWorkbook({ meta, result, monthStr: month });
  return {
    file,
    summary: {
      meta,
      rows: items.length,
      works: result.works.map((w) => ({ name: w.name, priceName: w.priceName, unit: w.unit, qty: w.qty, rows: w.rows })),
      unmatched: result.unmatched.map((u) => ({ name: u.name, unit: u.unit, qty: u.qty, reason: u.reason })),
      materials: result.materials.map((m) => ({ name: m.name, unit: m.unit, limit: m.limit })),
    },
  };
}

module.exports = { generate, parseContractPrice, calculate, findWork, norm };
