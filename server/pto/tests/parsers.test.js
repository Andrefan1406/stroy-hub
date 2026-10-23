// Разбор раздела КЖ по координатам текста: сводная ведомость расхода стали,
// спецификации элементов, сведение строк с разных листов. Страницы — синтетика
// в формате реальных листов (см. fixtures.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSteelSummary } = require('../parsers/steelSummary');
const { parseSpecifications } = require('../parsers/specification');
const { parseKzh } = require('../parsers/kzh');
const { consolidate } = require('../consolidate');
const { deriveWorks } = require('../works');
const { parseNum, joinText } = require('../layout');
const { steelSummaryPage, specPage, multiElementPage, it } = require('./fixtures');

test('числа в русской записи', () => {
  assert.equal(parseNum('92,0'), 92);
  assert.equal(parseNum('74.7'), 74.7);
  assert.equal(parseNum('46 394,8'), 46394.8);
  assert.equal(parseNum('∅12'), null);
  assert.equal(parseNum('кг'), null);
});

test('склейка фрагментов: пробел только при зазоре', () => {
  assert.equal(joinText([it('Бетон С', 100, 10, 40), it('20/25', 146, 10, 30)]), 'Бетон С 20/25');
  assert.equal(joinText([it('Итого', 100, 10, 30), it(':', 130, 10, 3)]), 'Итого:');
});

test('сводная ведомость стали: значения по классам и диаметрам, названия в несколько строк', () => {
  const r = parseSteelSummary(steelSummaryPage());
  assert.ok(r, 'ведомость найдена');
  assert.deepEqual(r.issues, []);
  const by = (el) => r.rows.filter((x) => x.element === el).map((x) => `${x.name}|${x.markClass}|${x.quantity}`);
  assert.deepEqual(by('Фундамент ФЛм 1'), ['Арматура ∅12|А400|37223', 'Арматура ∅6|А240|678']);
  // «Входные группы» / «по ряду Б» — две строки подписи, значение 1615.40 (с точкой) — 1615,4
  assert.deepEqual(by('Входные группы по ряду Б'), ['Арматура ∅10|А400|1615.4', 'Арматура ∅6|А240|15']);
  assert.ok(r.rows.every((x) => x.unit === 'кг' && x.basis === 'summary' && x.page === 4));
});

test('сводная ведомость: таблица «на элемент» не принимается за сводную', () => {
  const page = steelSummaryPage();
  for (const i of page.items) if (i.s === 'Ведомость расхода стали') i.s = 'Ведомость расхода стали на элемент';
  assert.equal(parseSteelSummary(page), null);
});

test('сводной ведомости на листе нет — null', () => {
  assert.equal(parseSteelSummary(specPage()), null);
});

test('спецификация: бетон, арматура по «Итого» и по сумме позиций, сноска «на одну стену»', () => {
  const r = parseSpecifications(specPage());
  assert.equal(r.tables, 1);
  assert.deepEqual(r.titles, ['Стен монолитных См 1 т, См 1 н']);
  const rows = r.rows.map((x) => `${x.kind}|${x.name}|${x.markClass}|${x.quantity}|${x.unit}`);
  assert.deepEqual(rows, [
    'steel|Арматура ∅12|А400|1495.6|кг', // «Итого» группы (в позициях 573,0 + 922,6 = 1495,6)
    'steel|Арматура ∅6|А240|307.2|кг', // группа без «Итого»: сумма позиций, масса подписана «мм»
    'concrete|Бетон С20/25|С20/25|92|м³',
    'concrete|Бетонная подготовка, бетон С8/10|С8/10|29.3|м³',
  ]);
  assert.ok(r.rows.every((x) => /один элемент/.test(x.note)), 'сноска о расходе на один элемент попала в заметку');
  assert.deepEqual(r.issues, []);
});

test('спецификация: несколько элементов подряд, количество элементов умножает расход, объём в «Примечании»', () => {
  const r = parseSpecifications(multiElementPage());
  const rows = r.rows.map((x) => `${x.element}|${x.name}|${x.quantity}${x.unit}`);
  assert.deepEqual(rows, [
    'Плита монолитная ППдм 1|Арматура ∅10|70.2кг', // 35,1 кг × 2 плиты
    'Плита монолитная ППдм 1|Бетон С20/25|2м³', // 1,0 м³ × 2
    'Приямок П 1|Бетон С12/15|0.6м³', // 0,30 м³ × 2, объём из «Примечания»
  ]);
  assert.match(r.rows[0].note, /Элементов: 2/);
});

test('спецификация: таблица без «Кол.» (перечень документов) не принимается', () => {
  const page = { page: 3, items: [it('Обозначение', 113, 466, 60), it('Наименование', 329, 466, 70), it('Примечание', 511, 466, 70), it('СП РК EN 1992-1-1', 113, 440, 90)] };
  assert.equal(parseSpecifications(page).tables, 0);
});

test('parseKzh: сбой одного листа не роняет остальные, пустой документ — понятное замечание', () => {
  const broken = { page: 9, items: null };
  const ok = parseKzh([steelSummaryPage(), broken, specPage()]);
  assert.ok(ok.rows.length > 0);
  assert.ok(ok.issues.some((i) => i.page === 9 && /Не удалось разобрать лист/.test(i.message)));
  assert.deepEqual(ok.sheets.map((s) => `${s.page}:${s.kind}`), ['4:steel_summary', '23:specification']);

  const empty = parseKzh([{ page: 1, items: [it('Общие данные', 100, 100, 70)] }]);
  assert.equal(empty.rows.length, 0);
  assert.match(empty.issues[0].message, /не найдено ни сводной ведомости/);
});

test('сведение: одинаковые позиции с разных листов складываются, листы-источники видны', () => {
  const base = { kind: 'concrete', element: 'Плита ППм 1', name: 'Бетон С20/25', markClass: 'С20/25', unit: 'м³', basis: 'spec' };
  const items = consolidate([
    { ...base, quantity: 43.9, page: 61 },
    { ...base, quantity: 40.1, page: 62 },
    { ...base, element: 'Плита ППм 2', quantity: 5, page: 65 },
  ]);
  assert.equal(items.length, 2);
  const a = items.find((x) => x.element === 'Плита ППм 1');
  assert.equal(a.quantity, 84);
  assert.deepEqual(a.sources, [{ page: 61, quantity: 43.9 }, { page: 62, quantity: 40.1 }]);
});

test('сведение: спецификационная арматура — справочно, пока есть сводная ведомость; без неё — считается', () => {
  const steelSpec = { kind: 'steel', element: 'Плита монолитная ППдм 1', name: 'Арматура ∅10', markClass: 'А400', unit: 'кг', quantity: 70.2, page: 63, basis: 'spec' };
  const steelSum = { ...steelSpec, element: 'ППдм 1', quantity: 70.2, page: 4, basis: 'summary' };
  const withSummary = consolidate([steelSum, steelSpec]);
  assert.deepEqual(withSummary.map((x) => `${x.basis}:${x.counted}`).sort(), ['spec:0', 'summary:1']);
  assert.equal(withSummary.find((x) => x.basis === 'spec').element, 'ППдм 1', 'название элемента приведено к названию сводной ведомости');
  assert.deepEqual(consolidate([steelSpec]).map((x) => x.counted), [1]);
  const metal = consolidate([{ ...steelSpec, kind: 'metal', name: 'Труба' }]);
  assert.equal(metal[0].counted, 0, 'прочий металл в расчёт не входит');
});

test('сведение: «ППм 1» не путается с «ППм 1.1» (берётся самое длинное совпадение)', () => {
  const sum = (el) => ({ kind: 'steel', element: el, name: 'Арматура ∅10', markClass: 'А400', unit: 'кг', quantity: 1, page: 4, basis: 'summary' });
  const spec = (el) => ({ kind: 'concrete', element: el, name: 'Бетон С20/25', markClass: 'С20/25', unit: 'м³', quantity: 2, page: 66, basis: 'spec' });
  const items = consolidate([sum('ППм 1'), sum('ППм 1.1'), spec('Плита ППм 1.1'), spec('Плита ППм 1')]);
  assert.deepEqual(items.filter((x) => x.kind === 'concrete').map((x) => x.element).sort(), ['ППм 1', 'ППм 1.1']);
});

test('виды работ: закладные в тоннах, бетон и подготовка отдельно; армирование отдельной работой не выводится, справочное не считается', () => {
  const items = consolidate([
    { kind: 'steel', element: 'ППм 1', name: 'Арматура ∅10', markClass: 'А400', unit: 'кг', quantity: 18598, page: 4, basis: 'summary' },
    { kind: 'steel', element: 'ППм 1', name: 'Арматура ∅6', markClass: 'А240', unit: 'кг', quantity: 297, page: 4, basis: 'summary' },
    { kind: 'steel', element: 'ППм 1', name: 'Арматура ∅10', markClass: 'А400', unit: 'кг', quantity: 5000, page: 65, basis: 'spec' },
    { kind: 'embedded', element: 'Стены', name: 'Закладные изделия: прокат t=8', markClass: 'С245', unit: 'кг', quantity: 538, page: 4, basis: 'summary' },
    { kind: 'concrete', element: 'ППм 1', name: 'Бетон С20/25', markClass: 'С20/25', unit: 'м³', quantity: 40, page: 65, basis: 'spec' },
    { kind: 'concrete', element: 'ППм 1', name: 'Бетонная подготовка, бетон С8/10', markClass: 'С8/10', unit: 'м³', quantity: 12, page: 65, basis: 'spec' },
    { kind: 'metal', element: 'ППм 1', name: 'Труба', markClass: '', unit: 'кг', quantity: 99, page: 65, basis: 'spec' },
  ]);
  const works = deriveWorks(items).map((w) => `${w.element}|${w.name}|${w.quantity}${w.unit}`);
  // Арматура (18 598 + 297 кг у ППм 1) в работах не фигурирует: армирование входит в стоимость бетонирования.
  assert.deepEqual(works, [
    'Стены|Установка закладных изделий|0.538тн',
    'ППм 1|Бетонирование монолитных конструкций|40м³',
    'ППм 1|Устройство бетонной подготовки|12м³',
  ]);
});
