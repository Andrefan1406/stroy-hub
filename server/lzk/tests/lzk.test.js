const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { generate, calculate, findWork } = require('../build');

// ВДЦ как в приложении №7: шапка, таблица по этажам, «Итого» и подписи.
async function makeVdc(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Субподрячик: ИП "Сабир"', '', '', '', '', '', '', 'Приложение №7 от 01.10.2026 г.']);
  ws.addRow(['', '', '', '', '', '', '', 'К договору субподряда № П-26-227 от 01.10.2026 года']);
  ws.addRow(['Ведомость договорой цены №4']);
  ws.addRow(['«Строительство административно-торгового центра с подземным паркингом по пр. Победы в г. Усть-Каменогорск, ВКО»']);
  ws.addRow(['№ п/п', '№ договора', 'СП', '№ этажа', 'Наименование работ', 'Ед. изм.', 'Кол-во', 'Стоимость за ед.изм.', 'Всего,тг (с НДС)']);
  rows.forEach((r, i) => ws.addRow([i + 1, 'П-26-227, прил.7', 'Сабир ИП', `${i + 1} этаж`, ...r, 25520, 0]));
  ws.addRow(['', 'Итого,тг:', '', '', '', '', '', '', 408064.8]);
  ws.addRow(['Генподрядчик']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const WALL = 'Устройство наружных стен из кирпича толщиной 250 мм';
const FLOORS = [1.4, ...Array(12).fill(1.11), 1.27];

test('словарь: название из ВДЦ → норма по расценкам', () => {
  assert.equal(findWork(WALL).name, 'устройство стен из кирпича толщ. 250-380 мм');
  assert.equal(findWork('  УСТРОЙСТВО  кирпичных вентшахт ').name, 'устройство вентиляционных шахт из кирпича');
  assert.equal(findWork('Покраска фасада'), null);
});

test('ВДЦ из приложения №7: 14 этажей группируются в 15,99 м3 кладки', async () => {
  const buf = await makeVdc(FLOORS.map((q) => [WALL, 'м3', q]));
  const { summary } = await generate(buf, { month: '2026-11' });

  assert.equal(summary.rows, 14);
  assert.equal(summary.works.length, 1);
  assert.equal(summary.works[0].qty, 15.99);
  assert.equal(summary.unmatched.length, 0);

  const byName = Object.fromEntries(summary.materials.map((m) => [m.name, m.limit]));
  assert.equal(byName['кирпич м100'], 4877); // 15,99 × 305 = 4876,95 → вверх
  assert.equal(byName['анкер клин'], 180); // 15,99 × 11,2 = 179,088 → вверх
  assert.equal(byName['раствор'], 4);
  assert.equal(byName['сетка кладочная'], 28.4);
  assert.equal(byName['газоблок 600х300х200'], undefined);

  assert.match(summary.meta.basis, /П-26-227 от 01\.10\.2026г\., прил\.7/);
  assert.equal(summary.meta.recipient, 'ИП "Сабир"');
  assert.match(summary.meta.object, /^Строительство административно-торгового центра/);
});

test('ЛЗК: столбцы по дням с 1-го числа выбранного месяца на год, формулы итогов', async () => {
  const buf = await makeVdc([[WALL, 'м3', 2]]);
  const { file } = await generate(buf, { month: '2026-11' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  const ws = wb.getWorksheet('ЛЗК');

  assert.equal(ws.getCell('A7').value, '№ п/п');
  assert.equal(ws.getCell('E8').value, '01.11');
  assert.equal(ws.getCell('E7').value, 'Выдано в течение ноября 2026 года');
  assert.equal(ws.getCell('AI7').value, 'Итого выдано за ноябрь 2026 года'); // 30 дней: E..AH, итог AI
  assert.equal(ws.getCell('AJ8').value, '01.12');

  // 365 дней + 12 итогов + 4 служебных столбца + 2 итоговых в конце
  assert.equal(ws.columnCount, 4 + 365 + 12 + 2);
  const last = ws.getCell(7, ws.columnCount).value;
  assert.equal(last, 'Остаток лимита');

  assert.equal(ws.getCell('D9').value, 23); // анкер клин: 2 × 11,2 = 22,4 шт → вверх
  assert.equal(ws.getCell('AI9').value.formula, 'SUM(E9:AH9)');
});

test('работа без нормы или с другой единицей не попадает в лимиты, а выводится отдельно', () => {
  const r = calculate([
    { name: WALL, unit: 'м3', qty: 1 },
    { name: WALL, unit: 'м2', qty: 5 },
    { name: 'Покраска фасада', unit: 'м2', qty: 10 },
  ]);
  assert.equal(r.works.length, 1);
  assert.equal(r.unmatched.length, 2);
  assert.match(r.unmatched[0].reason, /единица/);
});

test('файл без таблицы ВДЦ — понятная ошибка', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('x').addRow(['что-то', 'другое']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  await assert.rejects(() => generate(buf), /не найдена таблица ВДЦ/);
});

test('М-29: лимиты и нормы заполнены, факт пустой, столбцы на год, списание в конце', async () => {
  const buf = await makeVdc(FLOORS.map((q) => [WALL, 'м3', q]));
  const { file } = await generate(buf, { month: '2026-11' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  const ws = wb.getWorksheet('М-29');

  assert.equal(ws.getCell('A13').value, 'работа');
  assert.equal(ws.getCell('E13').value, 15.99);
  assert.equal(ws.getCell('A14').value, 'материал');
  // 7 материалов кладки 250 мм; анкер клин: 15,99 × 11,2 → 180 шт, норма 11,2
  const anker = [14, 15, 16, 17, 18, 19, 20].find((r) => ws.getCell(r, 2).value === 'Анкер клин');
  assert.equal(ws.getCell(anker, 5).value, 180);
  assert.equal(ws.getCell(anker, 6).value, 11.2);
  // 6 фикс. + 12 мес × 4 + «Остаток лимита»
  assert.equal(ws.getCell(12, 10).value, 'списать на себестоимость'); // конец ноябрьского блока
  assert.equal(ws.getCell(11, ws.columnCount).value, 'Остаток лимита');
  assert.equal(ws.columnCount, 6 + 48 + 1);
  assert.equal(ws.getCell(anker, 8).value, null); // «по факту» ноябрь — пусто
});
