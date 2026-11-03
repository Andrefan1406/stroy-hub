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

test('ВДЦ другой раскладки: «Наименование видов работ, затрат», «Объем работ», строки-разделы «поз.»', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Подрядчик: ИП «Qaz Stroy»', '', '', '', '', '', 'Приложение №8 от 08.10.2026 г.']);
  ws.addRow(['', '', '', '', '', '', 'к Договору подряда №П-26-210 от 16.09.2026 г.']);
  ws.addRow(['Ведомость договорной цены']);
  ws.addRow(['Наименование объекта: "Строительство комплекса многоэтажных жилых домов по пр. К. Сатпаева"']);
  ws.addRow(['№ п/п', 'Этаж', 'Наименование видов работ, затрат', 'Ед. изм', 'Обьем работ, колво', 'Стоимость единицы', 'Сумма']);
  ws.addRow([1, '', 'поз. 73,75', '', '', '', '']);
  ws.addRow([2, '1 этаж, 1 блок', 'Устройство кирпичных вентшахт', 'м3', 1.13, 29000, 32770]);
  ws.addRow([3, '1 блок вх.группа', 'Устройство стен из кирпича толщиной 250 мм.', 'м3', 4.55, 23200, 105583.2]);
  ws.addRow([4, '', 'поз. 93', '', '', '', '']);
  ws.addRow([5, '2 блок вх.группа', 'Устройство стен из кирпича толщиной 250 мм.', 'м3', 4.55, 23200, 105583.2]);
  ws.addRow(['', '', 'Всего с НДС 16%', '', '', '', 2936876.4]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.rows, 3); // строки «поз.» не считаются работами
  assert.equal(summary.unmatched.length, 0);
  const byName = Object.fromEntries(summary.works.map((w) => [w.name, w.qty]));
  assert.equal(byName['Устройство стен из кирпича толщиной 250 мм.'], 9.1); // точка в конце не мешает
  assert.equal(byName['Устройство кирпичных вентшахт'], 1.13);
  assert.equal(summary.meta.recipient, 'ИП «Qaz Stroy»');
  assert.match(summary.meta.basis, /П-26-210 от 16\.09\.2026г\., прил\.8/);
  assert.match(summary.meta.object, /^Строительство комплекса/);
});

test('ВДЦ П-26-174: пять договоров, второй график под таблицей, хвост «(ДО-ДО).» у объекта', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['', '', '', '', '', '', 'Приложение №7 от 29.07.2026 года']);
  ws.addRow(['Субподрячик:ИП Сабир', '', '', '', '', '', 'К договору субподряда № П-26-174 от 29.07.2026 года']);
  ws.addRow(['Ведомость договорой цены']);
  ws.addRow(['"Строительство здания с  коммерческими помещениями по ул.Базовая в г.Усть-Каменогорске." (ДО-ДО).']);
  ws.addRow(['№ п/п', '№ договора', 'Субподрячик', 'Наименование работ', 'Ед. изм.', 'Кол-во', 'Стоимость за ед.изм. С НДС', 'Всего,тг НДС 16%']);
  const W = 'Устройство наружных стен из кирпича толщиной 250 мм';
  ws.addRow([1, 'П-26-174', 'ИП Сабир', W, 'м3', 14.82, 25520, 378206.4]);
  ws.addRow([2, 'П-26-175', 'ИП Сабир', W, 'м3', 20.5, 25520, 523160]);
  ws.addRow([3, 'П-26-176', 'ИП Сабир', W, 'м3', 22.41, 25520, 571903.2]);
  ws.addRow(['', 'П-26-177', 'ИП Сабир', W + ' (заложить оконные проемы) изм проекта (1-3эт)', 'м3', 2.16, 25520, 55123.2]);
  ws.addRow(['', 'П-26-178', 'ИП Сабир', 'Устройство перегородок из кирпича 0,5кирпича (120мм) 1-3 эт (С/У)', 'м2', 119.7, 6380, 763686]);
  ws.addRow(['', 'Итого,тг:', '', '', '', '', '', 2292078.8]);
  ws.addRow(['', 'АВАНС не предусмотрен']);
  ws.addRow(['График производства работ']);
  ws.addRow(['№ п/п', 'Наименование работ и конструктивных элементов', '2026 год']);
  ws.addRow([1, 'Устройство наружных стен из кирпича толщиной 250 мм']);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.rows, 5);
  assert.equal(summary.unmatched.length, 0);
  assert.equal(summary.works.length, 3); // 250 мм, 250 мм «заложить проемы» и перегородки 120 мм
  assert.equal(summary.meta.recipient, 'ИП Сабир');
  assert.equal(summary.meta.object, 'Строительство здания с коммерческими помещениями по ул.Базовая в г.Усть-Каменогорске.');
});

test('ВДЦ П-25-19: объект без кавычек, «поз.59» разделы, пустая строка итога', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Субподрядчик: "Төлегенова Ғ.С." ИП', '', '', '', '', '', 'Приложение №51 от 28.05.2026 г.']);
  ws.addRow(['', '', '', '', '', '', 'К договору субподряда №П-25-19 от 27.02.2025 года']);
  ws.addRow(['Ведомость договорой цены']);
  ws.addRow(['Строительство многоэтажных жилых домов по проспекту К. Сатпаева в г. Усть-Каменогорске, ВКО (поз 59,69,65).']);
  ws.addRow(['№', 'Блок', 'Этаж', 'Наименование работ', 'Ед. изм.', 'Кол-во', 'Цена за ед.изм.', 'Всего, тг (с НДС)']);
  ws.addRow(['', '', '', 'поз.59']);
  ws.addRow([1, '4 блок', 'этаж', 'Устройство стен и перегородок из газоблока тощ. 200 мм', 'м3', 4.224, 42735, 180512.64]);
  ws.addRow([2, '5 блок', 'этаж', 'Устройство стен и перегородок из газоблока тощ. 200 мм', 'м3', 3.168, 42735, 135384.48]);
  ws.addRow(['', '', '', '', '', '', '', 316000]);
  ws.addRow(['1) ГПР работы выполнены фактически ранее']);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.rows, 2);
  assert.equal(summary.works[0].qty, 7.392);
  assert.equal(summary.unmatched.length, 0);
  assert.match(summary.meta.object, /^Строительство многоэтажных жилых домов/);
  assert.match(summary.meta.recipient, /Төлегенова/);
});

test('скрытые листы не читаются: таблица берётся с видимого листа', async () => {
  const wb = new ExcelJS.Workbook();
  const hidden = wb.addWorksheet('Старая', { state: 'hidden' });
  hidden.addRow(['Наименование работ', 'Ед. изм.', 'Кол-во']);
  hidden.addRow(['Устройство кирпичных вентшахт', 'м3', 100]);
  const visible = wb.addWorksheet('ВДЦ');
  visible.addRow(['Наименование работ', 'Ед. изм.', 'Кол-во']);
  visible.addRow([WALL, 'м3', 2]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });
  assert.equal(summary.rows, 1);
  assert.equal(summary.works[0].qty, 2);

  const onlyHidden = new ExcelJS.Workbook();
  onlyHidden.addWorksheet('x');
  const h = onlyHidden.addWorksheet('Скрытый', { state: 'veryHidden' });
  h.addRow(['Наименование работ', 'Ед. изм.', 'Кол-во']);
  h.addRow([WALL, 'м3', 2]);
  onlyHidden.getWorksheet('x').addRow(['пусто']);
  await assert.rejects(async () => generate(Buffer.from(await onlyHidden.xlsx.writeBuffer())), /не найдена таблица ВДЦ/);
});

test('ВДЦ П-26-144: договор в двух ячейках, объект в «» не со слова «Строительство», разделы «БЛОК», «1-этаж»', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['', '', '', '', 'Приложение №7 от 08.06.2026 г.']);
  ws.addRow(['', '', '', '', 'к Договору субподряда ']);
  ws.addRow(['', '', '', '', '№ П-26-144 от 08.06.2026г.']);
  ws.addRow(['Ведомость договорной цены №1']);
  ws.addRow(['«Завершение строительства общеобразовательной школы вместимостью более 1000 мест в г. Усть-Каменогорске, ВКО».']);
  ws.addRow(['№ п/п', 'Наименование работ', 'Ед.изм.', 'Кол-во', 'Цена за ед., тг (без НДС)', 'Сумма']);
  ws.addRow(['БЛОК №1/3']);
  ws.addRow([1, 'I-этаж']);
  ws.addRow([2, WALL, 'м3', 164, 20000, 3280000]);
  ws.addRow([6, 'Итого (БЕЗ НДС):', '', '', '', 3280000]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.rows, 1);
  assert.equal(summary.works[0].qty, 164);
  assert.equal(summary.meta.basis, 'К договору субподряда № П-26-144 от 08.06.2026г., прил.7');
  assert.match(summary.meta.object, /^Завершение строительства общеобразовательной школы/);
  assert.ok(!summary.meta.object.includes('»'));
});

test('демонтаж пропускается: ни в расчёте, ни в «Не учтено»', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Приложение №7']);
  ws.addRow(['к Договору субподряда ']);
  ws.addRow(['№П-26-77 от 01.02.2026г.']);
  ws.addRow(['«Строительство закрытого ледового катка в г.Усть-Каменогорске»']);
  ws.addRow(['№ п/п', 'Наименование работ', 'Ед.изм.', 'Кол-во', 'Цена', 'Сумма']);
  ws.addRow([1, 'Демонтаж кирпичной кладки', 'м3', 28.9, 11020, 318478]);
  ws.addRow([2, 'Демонтаж кирпичной кладки перегородок', 'м2', 328.5, 2610, 857385]);
  ws.addRow([3, 'Устройство кирпичных перегородок 120 мм', 'м2', 167, 5220, 871740]);
  ws.addRow(['', 'Итого:', '', '', '', 2047603]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.rows, 1);
  assert.equal(summary.unmatched.length, 0);
  assert.equal(summary.works[0].qty, 167);
  assert.equal(summary.meta.basis, 'К договору субподряда № П-26-77 от 01.02.2026г., прил.7');
  assert.equal(summary.meta.object, 'Строительство закрытого ледового катка в г.Усть-Каменогорске');
});

test('субподрядчик из блока подписей, если в шапке его нет', async () => {
  const build = async (signRows) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('ВДЦ');
    ws.addRow(['Приложение №7']);
    ws.addRow(['«Строительство закрытого ледового катка в г.Усть-Каменогорске»']);
    ws.addRow(['№ п/п', 'Наименование работ', 'Ед.изм.', 'Кол-во']);
    ws.addRow([1, WALL, 'м3', 2]);
    ws.addRow(['', 'Итого:']);
    signRows.forEach((r) => ws.addRow(r));
    const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });
    return summary.meta.recipient;
  };

  // подписи в соседних столбцах: слева генподрядчик (не берём), справа субподрядчик
  assert.equal(
    await build([
      ['', 'Генподрядчик', '', 'Субподрядчик'],
      ['', 'Директор', '', 'Руководитель'],
      ['', 'ТОО «VK INVEST COMPANY»', '', 'ИП "САПАРГАЛИЕВА"'],
    ]),
    'ИП "САПАРГАЛИЕВА"',
  );
  // всё в одной ячейке
  assert.equal(await build([['', '', '', 'Субподрядчик\nРуководитель\nИП «Сабир»']]), 'ИП «Сабир»');
  // подписей нет — пусто, без падения
  assert.equal(await build([['Составил:']]), '');
});

test('М-29: работа без норм выводится агрегированной строкой без материалов, остаётся в «Не учтено»', async () => {
  const buf = await makeVdc([
    [WALL, 'м3', 2],
    ['Монтаж плит перекрытия', 'шт', 28],
    ['Монтаж плит перекрытия', 'шт', 28],
  ]);
  const { file, summary } = await generate(buf, { month: '2026-11' });
  assert.equal(summary.unmatched.length, 1);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  const ws = wb.getWorksheet('М-29');
  const rows = [];
  ws.eachRow((row, n) => { if (n > 12) rows.push(row.getCell(1).value); });
  const idx = rows.filter((v) => v === 'работа').length;
  assert.equal(idx, 2); // кладка и монтаж плит

  let mountRow = 0;
  ws.eachRow((row, n) => { if (row.getCell(2).value === 'Монтаж плит перекрытия') mountRow = n; });
  assert.ok(mountRow > 0);
  assert.equal(ws.getCell(mountRow, 5).value, 56); // 28 + 28, сгруппировано
  assert.equal(ws.getCell(mountRow, 4).value, 'шт');
  assert.equal(ws.getCell(mountRow, 6).value, 'нет норм');
  assert.notEqual(ws.getCell(mountRow + 1, 1).value, 'материал'); // материалов под ней нет
});

test('нет нужных столбцов — ошибка называет, чего не хватает, и просит переименовать шапку', async () => {
  const load = async (head) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('ВДЦ');
    ws.addRow(head);
    ws.addRow([WALL, 'м3', 2]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  await assert.rejects(async () => generate(await load(['Вид работ', 'Ед. изм.', 'Кол-во'])), /не найден столбец «Наименование работ».*Переименуйте/);
  await assert.rejects(async () => generate(await load(['Наименование работ', 'Единица', 'Кол-во'])), /не найден столбец «Ед\. изм\.»\. Сейчас в шапке.*Переименуйте/);
  await assert.rejects(async () => generate(await load(['Наименование работ', 'Ед. изм.', 'Сколько'])), /не найден столбец «Кол-во»/);
  await assert.rejects(async () => generate(await load(['Наименование работ', 'Единица', 'Сколько'])), /«Ед\. изм\.» и «Кол-во»/);
  await assert.rejects(async () => generate(await load(['что-то', 'другое', 'третье'])), /не найдена таблица ВДЦ.*Переименуйте/);
});

test('шапка «Наименование» / «Единицы измерения» / «Количество» читается; в ошибке перечислено, что стоит в шапке', async () => {
  const load = async (head) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('ВДЦ');
    ws.addRow(head);
    ws.addRow([1, WALL, 'м3', 2]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const ok = await generate(await load(['№ п/п', 'Наименование', 'Единицы измерения', 'Количество']), { month: '2026-11' });
  assert.equal(ok.summary.works[0].qty, 2);

  await assert.rejects(
    async () => generate(await load(['№ п/п', 'Наименование работ', 'Ед. изм.', 'Сколько'])),
    /не найден столбец «Кол-во»\. Сейчас в шапке: «№ п\/п», «Наименование работ», «Ед\. изм\.», «Сколько»\./,
  );
});
