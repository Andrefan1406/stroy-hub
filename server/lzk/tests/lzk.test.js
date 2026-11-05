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
  assert.equal(byName['анкер клин 6×40'], 180); // 15,99 × 11,2 = 179,088 → вверх
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
  const anker = [14, 15, 16, 17, 18, 19, 20].find((r) => ws.getCell(r, 2).value === 'Анкер клин 6×40');
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
    ['Устройство кровли из профнастила', 'шт', 28],
    ['Устройство кровли из профнастила', 'шт', 28],
  ]);
  const { file, summary } = await generate(buf, { month: '2026-11' });
  assert.equal(summary.unmatched.length, 1);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  const ws = wb.getWorksheet('М-29');
  const rows = [];
  ws.eachRow((row, n) => { if (n > 12) rows.push(row.getCell(1).value); });
  const idx = rows.filter((v) => v === 'работа').length;
  assert.equal(idx, 2); // кладка и кровля

  let mountRow = 0;
  ws.eachRow((row, n) => { if (row.getCell(2).value === 'Устройство кровли из профнастила') mountRow = n; });
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

test('внутренняя отделка: словарь актов М-29 → группа норм, нормы, «факт» и погонные единицы', async () => {
  const { findWork } = require('../build');
  assert.equal(findWork('Устройство керамогрантиной половой плитки').name, 'облицовка пола керамогранитной плиткой');
  assert.equal(findWork('Этаж улушенная шпаклевка стен, сплошное выравнение: чистовой слой').name,
    'улучшенная шпатлевание стен, сплошное выравнивание: чистовой слой');
  assert.equal(findWork('Устройство дверей однопольных (МОП)'), null); // в словарь не вошло
  assert.equal(findWork('Установка дверей'), null);
  assert.equal(findWork('Установка входных дверей в квартиру'), null);

  const buf = await makeVdc([
    ['Облицовка стен плиткой', 'м2', 100],
    ['Устройство плинтусов из керамогранита', 'м.п.', 50], // «м.п.» = «мп» в нормах
    ['Улучшенная шпаклевка стен и потолков, сплошное выравнение: черновой слой', 'м2', 10], // гипсокартон — «факт»
    ['Устройство дверей в сан узлы', 'шт', 3],
  ]);
  const { file, summary } = await generate(buf, { month: '2026-11' });
  assert.equal(summary.unmatched.length, 0);

  const lim = Object.fromEntries(summary.materials.map((m) => [`${m.name}|${m.unit}`, m.limit]));
  // грунтовка: стены 100×0,12 + плинтус 50×0,12 + шпатлевка 10×0,12 = 19,2
  assert.equal(lim['грунтовка|кг'], 19.2);
  assert.equal(lim['плитка керамическая|м2'], 105 + 0.93); // 100×1,05 + 3×0,31
  assert.equal(lim['керамогранит|м2'], 5.1);
  assert.equal(lim['дверная коробка|шт'], 9);
  assert.equal(lim['гвоздь строительный|шт'], 45); // шт, не путать с кг из кладки
  assert.equal(lim['гипсокартон|лист'], undefined); // норма «факт» — в ЛЗК без лимита

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  const ws = wb.getWorksheet('М-29');
  let gypsumRow = 0;
  ws.eachRow((row, n) => { if (row.getCell(2).value === 'Гипсокартон') gypsumRow = n; });
  assert.ok(gypsumRow > 0);
  assert.equal(ws.getCell(gypsumRow, 6).value, 'факт');
  assert.equal(ws.getCell(gypsumRow, 5).value, null);
  assert.equal(ws.getCell(gypsumRow, 7).value, null); // по норме не считается
});

test('ВДЦ прил.14 (отделка МОП): «Улучшенное шпатлевание», раздел «Блок 4»; поставка материала «(материал)» убирается', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Субподрядчик: ИП "Пинегина Е.В."', '', '', '', '', '', 'Приложение № 14 от 19.10.2026г.']);
  ws.addRow(['', '', '', '', '', '', 'К договору подряда № П-26-31 от 22.01.2026г.']);
  ws.addRow(['Ведомость договорной цены']);
  ws.addRow(['"Строительство многоэтажных жилых домов с коммерческими помещениями поз.65,69 по проспекту К. Сатпаева (без наружных инженерных сетей и благоустройства)"поз.69,блок 4']);
  ws.addRow(['№ п/п', 'Этаж', 'Место', 'Наименование работ', 'Ед.изм.', 'Кол-во', 'Стоимость', 'Сумма']);
  ws.addRow(['Блок 4']);
  ws.addRow([1, '3 эт.', 'МОП', 'Декоративная окраска (материал)', 'кг.', 30.91, 7088.68, 219111.1]);
  ws.addRow([2, '3 эт.', 'МОП', 'Улучшенное шпатлевание стен, сплошное выравнивание: черновой слой', 'м2', 89.57, 1740, 155851.8]);
  ws.addRow([3, '3 эт.', 'МОП', 'Улучшенное шпатлевание стен, сплошное выравнивание: чистовой слой', 'м2', 89.57, 928, 83120.96]);
  ws.addRow(['', '', '', 'Итого', '', '', '', 458083.86]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.rows, 2); // «Декоративная окраска (материал)» — поставка материала, строка убрана
  assert.equal(summary.works.length, 2);
  assert.equal(summary.unmatched.length, 0);
  const lim = Object.fromEntries(summary.materials.map((m) => [m.name, m.limit]));
  assert.equal(lim['штукатурная смесь черновая'], 429.94); // 89,57 × 4,8 = 429,936
  assert.equal(lim['штукатурная смесь чистовая'], 214.97); // 89,57 × 2,4 = 214,968
  assert.equal(lim['грунтовка'], 21.5); // 2 × 89,57 × 0,12 = 21,4968
  assert.equal(summary.meta.recipient, 'ИП "Пинегина Е.В."');
  assert.equal(summary.meta.basis, 'К договору подряда № П-26-31 от 22.01.2026г., прил.14');
});

test('ВДЦ по отделке (прил.10): столбцы «Этаж/Тип квартир/Тип помещения», разделы «4-этаж 2А», «Уборка мусора 10%»', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Подрядчик:ИП "Игілік"', '', '', '', '', '', 'Приложение №10 от 08.10.2026 г.']);
  ws.addRow(['', '', '', '', '', '', 'к Договору подряда №П-26-155 от 03.08.2026 г.']);
  ws.addRow(['Ведомость договорной цены']);
  ws.addRow(['Наименование объекта: "Строительство комплекса многоэтажных жилых домов (поз.73/75,74,76,93,100,101)\nЖилой дом поз. 93, 4-этаж"']);
  ws.addRow(['№П/П', 'Этаж', 'Тип квартир', 'Тип помещения', 'Наименование видов работ, затрат', 'Ед. изм', 'Обьем работ, кол-во', 'Стоимость', 'Сумма']);
  const W = (name, unit, qty) => [1, '4-этаж', '2А (кв.1)', 'Кухня', name, unit, qty, 1, 1];
  ws.addRow([4, '', '', '', '4-этаж 2А (кв.1) (левый)', '', '', '', '']); // раздел: название есть, единицы и объёма нет
  ws.addRow(W('Устройство покрытия стен обоями', 'м2', 33.69));
  ws.addRow(W('Устройство покрытия стен обоями', 'м2', 43.67));
  ws.addRow(W('Улучшенное шпатлевание ПОТОЛКА, сплошное выравнивание: черновой слой', 'м2', 7.06));
  ws.addRow(W('Устройство плинтусов из керамогранита', 'м.п.', 16.73));
  ws.addRow(W('Монтаж замков, защелок, ручек', 'шт', 1));
  ws.addRow([342, '', '', '', 'Уборка мусора 10%', '', '', 1017138.89, 881738.07]);
  ws.addRow([343, '', '', '', 'Итого с НДС:', '', '', 10171388.9, 8817380.71]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.rows, 5);
  const byName = Object.fromEntries(summary.works.map((w) => [w.priceName, w.qty]));
  assert.equal(byName['оклейка стен обоями'], 77.36);
  assert.equal(byName['устройство керамогранитного плинтуса (h=10 см)'], 16.73);
  assert.deepEqual(summary.unmatched, []); // замки теперь с нормой
  assert.match(summary.meta.object, /^Строительство комплекса.*Жилой дом поз\. 93, 4-этаж$/);
  assert.equal(summary.meta.recipient, 'ИП "Игілік"');
  assert.equal(summary.meta.basis, 'К договору подряда № П-26-155 от 03.08.2026г., прил.10');
});

test('двери, откосы, замки, заделка отверстий, порожки: нормы и доп. материалы для санузлов', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Приложение №10']);
  ws.addRow(['«Строительство жилого дома»']);
  ws.addRow(['№', 'Тип помещения', 'Наименование видов работ, затрат', 'Ед. изм', 'Обьем работ, кол-во']);
  ws.addRow([1, 'Кухня', 'Установка дверного блока', 'шт', 1]);
  ws.addRow([2, 'Санузел', 'Установка дверного блока', 'шт', 2]);
  ws.addRow([3, 'Кухня', 'Устройство дверных откосов', 'шт', 1]);
  ws.addRow([4, 'Кухня', 'Монтаж замков, защелок, ручек', 'шт', 1]);
  ws.addRow([5, 'Санузел', 'Монтаж замков, защелок, ручек', 'шт', 2]);
  ws.addRow([6, '', 'Заделка технологических отверстий', 'шт', 166]);
  ws.addRow([7, '', 'Устройтсво декоративных порожков', 'м.п.', 6.32]);
  ws.addRow([8, '', 'Итого']);
  const { file, summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });
  assert.equal(summary.unmatched.length, 0);

  const lim = Object.fromEntries(summary.materials.map((m) => [`${m.name}|${m.unit}`, m.limit]));
  assert.equal(lim['дверное полотно|шт'], undefined);
  assert.equal(lim['полотно дверное|шт'], 3); // 3 блока × 1
  assert.equal(lim['подвес прямой|шт'], 15);
  assert.equal(lim['наличник плоский|шт'], 5); // откосы: 1 × 5
  assert.equal(lim['ручка дверная|шт'], 3); // замки: 1 + 2
  assert.equal(lim['завертка сантехническая|шт'], 2); // только строка «Санузел»
  assert.equal(lim['шпингалет торцевой|шт'], 2);
  assert.equal(lim['пеноплекс|м3'], 1.04); // 166 × 0,00625 = 1,0375
  assert.equal(lim['пена монтажная|балл'], 9.8); // двери 3 × 0,5 + заделка 166 × 0,05 = 1,5 + 8,3
  assert.equal(lim['порожек декоративный 900|шт'], 8); // 6,32 × 1,17 = 7,39
  assert.equal(lim['жидкие гвозди|тюб'], 3.16);

  const wbOut = new ExcelJS.Workbook();
  await wbOut.xlsx.load(file);
  const m29 = wbOut.getWorksheet('М-29');
  let zav = 0;
  m29.eachRow((row, n) => { if (row.getCell(2).value === 'Завертка сантехническая (санузлы)') zav = n; });
  assert.ok(zav > 0);
  assert.equal(m29.getCell(zav, 5).value, 2);
  assert.equal(m29.getCell(zav, 7).value, null); // «по норме» вносит участок
});

test('ВДЦ по лоджиям (BMI): «потолков» без запятой, единица «пог.м.», итог «Уборка мусора 10%»', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Субподрядчик: ТОО «BMI Engineering Company»', '', '', '', '', '', 'Приложение № 7 от 28.09.2026г.']);
  ws.addRow(['', '', '', '', '', '', 'к Договору субподряда № П-26-217 от 28.09.2026г.']);
  ws.addRow(['Ведомость договорной цены']);
  ws.addRow(['"Строительство многоэтажных жилых домов поз.65 (без наружных инженерных сетей и благоустройства)"Поз.65,блок 2']);
  ws.addRow(['№', 'Этаж', 'Тип квартиры', 'Место', 'Наименование работ', 'Ед.изм.', 'Кол-во', 'Стоимость', 'Сумма']);
  const R = (name, unit, qty) => [1, '1 эт.', 'Тип 2', 'Лоджия', name, unit, qty, 1, 1];
  ws.addRow(R('Улучшенное шпатлевание потолков сплошное выравнивание: черновой слой', 'м2', 7.84));
  ws.addRow(R('Улучшенное шпатлевание потолков сплошное выравнивание: черновой слой', 'м2', 10.01));
  ws.addRow(R('Окраска водо-дисперсной краской потолков за 2 раза', 'м2', 7.84));
  ws.addRow(R('Устройство плинтусов ПВХ', 'пог.м.', 12.41));
  ws.addRow(R('Устройство плинтусов ПВХ', 'пог.м.', 18.7));
  ws.addRow(['', '', '', '', 'Уборка мусора 10%', '', '', '', 818324.26]);
  ws.addRow(['', '', '', '', 'Итого', '', '', '', 8183242.63]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.unmatched.length, 0);
  const byName = Object.fromEntries(summary.works.map((w) => [w.priceName, w.qty]));
  assert.equal(byName['улучшенная шпатлевание стен, сплошное выравнивание: черновой слой'], 17.85);
  assert.equal(byName['устройство плинтусов пвх'], 31.11);
  assert.equal(summary.meta.recipient, 'ТОО «BMI Engineering Company»');
  assert.equal(summary.meta.basis, 'К договору субподряда № П-26-217 от 28.09.2026г., прил.7');
});

test('ВДЦ прил.19 (входная группа): заголовок «Ед.из м.», «Облицовка пола тротуарной плиткой»', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Субподрядчик: ИП "Заворуев С.Д."', '', '', '', '', '', 'Приложение № 19 от 28.09.2026г.']);
  ws.addRow(['', '', '', '', '', '', 'К договору подряда № П-26-27 от 22.01.2026г.']);
  ws.addRow(['"Строительство многоэтажных жилых домов (детским садом) поз.59. Поз.59,блок 3 (12 эт.)"']);
  ws.addRow(['№ п/п', 'Этаж', 'Тип', 'Место', 'Наименование работ', 'Ед.из\nм.', 'Кол-во', 'Стоимость', 'Сумма']);
  ws.addRow(['5 блок']);
  ws.addRow([1, '1 эт.', 'Входная группа', 'Входная группа', 'Облицовка пола тротуарной плиткой', 'м2', 24.03, 1, 1]);
  ws.addRow([2, '1 эт.', 'Входная группа', 'Входная группа', 'Устройство плинтусов из керамогранита', 'м.п.', 18.5, 1, 1]);
  ws.addRow(['', '', '', '', 'Уборка мусора 10%', '', '', '', 36363.68]);
  ws.addRow(['', '', '', '', 'Итого', '', '', '', 363636.8]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.rows, 2);
  assert.equal(summary.unmatched.length, 0);
  const lim = Object.fromEntries(summary.materials.map((m) => [m.name, m.limit]));
  assert.equal(lim['тротуарная плитка'], 25.23); // 24,03 × 1,05 = 25,2315
  assert.equal(summary.meta.recipient, 'ИП "Заворуев С.Д."');
  assert.match(summary.meta.object, /Поз\.59,блок 3 \(12 эт\.\)$/);
});

test('ВДЦ поз.63 блок 5 (MK.Invest): единица «м», пояснения в скобках, «Блок 5» в названии объекта', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ВДЦ');
  ws.addRow(['Субподрядчик: ТОО «MK.Invest Project»', '', '', '', '', '', 'Приложение №7 от 23.10.2026г.']);
  ws.addRow(['', '', '', '', '', '', 'к Договору субподряда № П-26-231 от 23.10.2026г.']);
  ws.addRow(['Наименование объекта: "Строительство многоэтажного жилого дома (детским садом) поз.63 (без наружных\nинженерных сетей и благоустройства)" Блок 5']);
  ws.addRow(['№ п/п', 'Этаж', 'Тип помещения', 'Место', 'Наименование работ', 'Ед. Изм.', 'Кол-во', 'Цена без НДС', 'Сумма без НДС']);
  ws.addRow(['5 блок']);
  const R = (name, unit, qty) => [1, '1 эт.', 'МОП', 'МОП', name, unit, qty, 1, 1];
  ws.addRow(R('Устройство плинтусов из керамогранита', 'м', 23.07));
  ws.addRow(R('Устройство плинтусов из керамогранита(короб возле лифта)', 'м.п.', 1.4));
  ws.addRow(R('Облицовка фартука керамической плиткой (кухня)', 'м2', 3.3));
  ws.addRow(R('Устройство откосов дверей', 'шт', 7));
  ws.addRow(R('Установка дверей тепловых узлов', 'шт', 1));
  ws.addRow(['', '', '', '', 'Уборка мусора 10%', '', '', '', 1798961.5]);
  ws.addRow(['', '', '', '', 'Итого', '', '', '', 17989614.96]);
  const { summary } = await generate(Buffer.from(await wb.xlsx.writeBuffer()), { month: '2026-11' });

  assert.equal(summary.unmatched.length, 0);
  const byName = {};
  for (const w of summary.works) byName[w.priceName] = Math.round(((byName[w.priceName] || 0) + w.qty) * 100) / 100;
  assert.equal(byName['устройство керамогранитного плинтуса (h=10 см)'], 24.47); // 23,07 «м» + 1,4 «м.п.» (с пояснением в скобках)
  assert.equal(byName['облицовка стен керамической плиткой'], 3.3);
  assert.equal(byName['устройство откосов межкомнатных дверей'], 7);
  assert.match(summary.meta.object, /благоустройства\) Блок 5$/);
  assert.equal(summary.meta.recipient, 'ТОО «MK.Invest Project»');
});

test('решётка для короба, ревизионный люк, обшивка короба с подрезкой: нормы по указанию ПТО', async () => {
  const { findWork } = require('../build');
  assert.equal(findWork('Устройство решетки для короба').name, 'монтаж решеток вентиляционных');
  assert.equal(findWork('Обшивка короба с подрезкой').name, 'облицовка стен керамической плиткой');
  assert.equal(findWork('Установка ревизионного люка').name, 'установка ревизионного люка');

  const buf = await makeVdc([
    ['Устройство решетки для короба', 'шт', 2],
    ['Установка ревизионного люка', 'шт', 3],
    ['Обшивка короба с подрезкой', 'м2', 10],
  ]);
  const { summary } = await generate(buf, { month: '2026-11' });
  assert.equal(summary.unmatched.length, 0);
  const lim = Object.fromEntries(summary.materials.map((m) => [`${m.name}|${m.unit}`, m.limit]));
  assert.equal(lim['решетка вентиляционная|шт'], 2);
  assert.equal(lim['ревизионный люк|шт'], 3);
  assert.equal(lim['плитка керамическая|м2'], 10.5); // 10 × 1,05, как у облицовки стен
  assert.equal(lim['клей плиточный (кафельный)|кг'], 160); // 10 × 16
});

test('ВДЦ поз.63 (правка): межкомнатные и входные двери, замки межкомнатных, утепление стен (МОП)', async () => {
  const buf = await makeVdc([
    ['Установка межкомнатных дверей', 'шт', 5],
    ['Установка входной двери', 'шт', 1],
    ['Монтаж замков, защелок, ручек межкомнатных дверей', 'шт', 5],
    ['Утепление стен (МОП)', 'м2', 22.1],
  ]);
  const { summary } = await generate(buf, { month: '2026-11' });
  assert.equal(summary.unmatched.length, 0);
  const lim = Object.fromEntries(summary.materials.map((m) => [`${m.name}|${m.unit}`, m.limit]));
  assert.equal(lim['полотно дверное|шт'], 5); // межкомнатные: 5 × 1
  assert.equal(lim['дверь металлическая|шт'], 1); // входная: 1 × 1
  assert.equal(lim['анкер торцевой|шт'], 6); // входная: 1 × 6
  assert.equal(lim['ручка дверная|шт'], 5); // замки межкомнатных: 5 × 1
  assert.equal(lim['держатель теплоизоляции|шт'], 111); // 22,1 × 5 = 110,5 → вверх
  assert.equal(lim['пеноплекс|м3'], 1.86); // 22,1 × 0,084
});

test('«Монтаж замков, защелок, входной двери»: работа без материалов — не в «Не учтено», строкой в М-29', async () => {
  const buf = await makeVdc([
    ['Монтаж замков, защелок, входной двери', 'шт', 3],
    ['Монтаж замков, защелок, входной двери', 'шт', 2],
    [WALL, 'м3', 1],
  ]);
  const { file, summary } = await generate(buf, { month: '2026-11' });
  assert.equal(summary.unmatched.length, 0);
  assert.equal(summary.works.find((w) => w.name === 'Монтаж замков, защелок, входной двери').qty, 5);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  const ws = wb.getWorksheet('М-29');
  let row = 0;
  ws.eachRow((r, n) => { if (r.getCell(2).value === 'Монтаж замков, защелок, входной двери') row = n; });
  assert.ok(row > 0);
  assert.equal(ws.getCell(row, 5).value, 5); // лимит = объём работы
  assert.notEqual(ws.getCell(row + 1, 1).value, 'материал'); // материалов под строкой нет
  assert.equal(ws.getCell(row, 6).value, null); // и пометки «нет норм» нет: так задумано
});

test('ВДЦ №2 блок 3/2 (Сабитов): газоблок «200» по нормам, монтаж плит перекрытия — материалы без лимитов', async () => {
  const buf = await makeVdc([
    ['Устройство кирпичной кладки перегородок', 'м2', 317.72],
    ['Устройство кирпичной кладки стен', 'м3', 209.8],
    ['Устройство кладки из газоблока 200', 'м3', 10.8],
    ['Монтаж плит перекрытия', 'шт', 33],
    ['Устройство кладки из газоблока 200', 'м3', 10.8],
    ['Монтаж плит перекрытия', 'шт', 33],
  ]);
  const { file, summary } = await generate(buf, { month: '2026-11' });
  assert.equal(summary.works.find((w) => w.name === 'Устройство кладки из газоблока 200').qty, 21.6);
  assert.equal(summary.works.find((w) => w.name === 'Монтаж плит перекрытия').qty, 66);
  assert.equal(summary.unmatched.length, 0);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  const ws = wb.getWorksheet('М-29');
  let row = 0;
  ws.eachRow((r, n) => { if (r.getCell(2).value === 'Монтаж плит перекрытия') row = n; });
  assert.ok(row > 0);
  assert.equal(ws.getCell(row, 5).value, 66); // у работы лимит = объём
  const mats = [1, 2, 3, 4].map((i) => ({
    name: ws.getCell(row + i, 2).value, unit: ws.getCell(row + i, 4).value, limit: ws.getCell(row + i, 5).value, norm: ws.getCell(row + i, 6).value, code: ws.getCell(row + i, 3).value,
  }));
  assert.deepEqual(mats.map((m) => m.name), ['ПБ2.72.12-8С (плита перекрытия)', 'ПБ2.72.15-8С (плита перекрытия)', 'Арматура 12', 'Раствор м-100']);
  assert.deepEqual(mats.map((m) => m.unit), ['шт', 'шт', 'тн', 'м3']);
  assert.deepEqual(mats.map((m) => m.limit), [null, null, null, null]); // количество не указываем
  assert.deepEqual(mats.map((m) => m.norm), [null, null, 'факт', 'факт']); // у плит пусто, у арматуры и раствора «факт»
  assert.deepEqual(mats.map((m) => m.code), [null, null, null, null]); // столбец «код» не заполняем

  // в листе «ЛЗК» эти материалы тоже есть — со строкой, но без лимита
  const lzk = wb.getWorksheet('ЛЗК');
  const inLzk = {};
  lzk.eachRow((r, n) => { if (n >= 9) inLzk[String(r.getCell(2).value)] = { limit: r.getCell(4).value, remain: r.getCell(lzk.columnCount).value }; });
  for (const name of ['ПБ2.72.12-8С (плита перекрытия)', 'ПБ2.72.15-8С (плита перекрытия)', 'Арматура 12', 'Раствор м-100']) {
    assert.ok(inLzk[name], `в ЛЗК нет «${name}»`);
    assert.equal(inLzk[name].limit, null);
    assert.equal(inLzk[name].remain, null);
  }
  assert.ok(inLzk['Кирпич м100'].limit > 0); // у остальных материалов лимиты на месте
});
