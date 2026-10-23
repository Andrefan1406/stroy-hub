// Блоки (секции) из чертежей: диапазоны осей → блоки; стены раскладываются по
// блокам по перечням «Спецификация к схемам расположения монолитных стен…»
// (количество каждой марки в блоке); остальное — по осям на листе.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { axesRanges, detectBlocks, blockOfRange, blockOfRanges } = require('../parsers/blocks');
const { parseKzh } = require('../parsers/kzh');
const { markKeys } = require('../parsers/specification');
const { consolidate } = require('../consolidate');
const { deriveWorks } = require('../works');
const { layoutListPage, elementSpecPage, axesPage } = require('./fixtures');

test('оси из текста листа: «в осях 1-11», «между осями 12-22/Б-К», «оси 14-20»', () => {
  assert.deepEqual(axesRanges('Схема в осях 1-11. Стены между осями 12-22/ Б -К, закладные (оси 14-20)'), [[1, 11], [12, 22], [14, 20]]);
  assert.deepEqual(axesRanges('нет осей, только размер 3200-3500'), []);
  assert.deepEqual(axesRanges('в осях 5-4'), [], 'обратный диапазон — мусор');
});

test('блоки — повторяющиеся на листах диапазоны осей, слева направо; редкие диапазоны блоками не становятся', () => {
  const pages = [
    ...['1-11', '1-11', '1-11', '12-22', '12-22', '12-22'].map((a) => `в осях ${a}`),
    'в осях 5-8', 'в осях 5-8', 'в осях 16-19', // локальные детали — не блоки
  ];
  assert.deepEqual(detectBlocks(pages), [{ name: 'Блок 1', from: 1, to: 11 }, { name: 'Блок 2', from: 12, to: 22 }]);
  assert.deepEqual(detectBlocks(['в осях 1-11', 'в осях 1-11', 'в осях 1-11', 'в осях 12-22']), [], 'второй диапазон встретился один раз — блоков нет');
  assert.deepEqual(detectBlocks(['в осях 1-22', 'в осях 1-22', 'в осях 1-22']), [], 'один блок на всё здание — столбец не нужен');
  assert.deepEqual(detectBlocks([]), []);
});

test('блок по диапазону осей: наибольшее пересечение, стык и неоднозначность не угадываются', () => {
  const blocks = [{ name: 'Блок 1', from: 1, to: 11 }, { name: 'Блок 2', from: 12, to: 22 }];
  assert.equal(blockOfRange(blocks, [1, 11]), 'Блок 1');
  assert.equal(blockOfRange(blocks, [5, 8]), 'Блок 1');
  assert.equal(blockOfRange(blocks, [16, 19]), 'Блок 2');
  assert.equal(blockOfRange(blocks, [11, 22]), 'Блок 2', 'опечатка «11-22» вместо «12-22»: пересечение с блоком 2 больше');
  assert.equal(blockOfRange(blocks, [1, 22]), null, 'поровну — не угадываем');
  assert.equal(blockOfRange(blocks, [30, 40]), null);
  assert.equal(blockOfRanges(blocks, [[5, 8], [16, 19]]), null, 'на листе два блока — блок листа не определён');
  assert.equal(blockOfRanges(blocks, [[1, 11], [3, 4]]), 'Блок 1');
  assert.equal(blockOfRanges([], [[1, 11]]), null);
});

test('марки стен в названиях: «См 1 т, См 1 н», «См 1.1 т (См 1.1 н)», «См 5»', () => {
  assert.deepEqual(markKeys('Стен монолитных См 1 т, См 1 н'), ['см1т', 'см1н']);
  assert.deepEqual(markKeys('Стены монолитной См 1.1 т (См 1.1 н)'), ['см1.1т', 'см1.1н']);
  assert.deepEqual(markKeys('Стены монолитной См 5'), ['см5']);
  assert.deepEqual(markKeys('Плита ППм 1'), []);
});

// Документ: два блока по осям (по три листа на диапазон), перечни стен блоков, спецификации стен и плиты.
function sampleDocument() {
  return [
    layoutListPage(14, '1-11', [['См 1 т', 1], ['См 4', 1], ['См 10 т', 1], ['См 10 н', 1]]),
    layoutListPage(19, '12-22', [['См 1 н', 1], ['См 4', 1]]),
    axesPage(20, '1-11'), axesPage(21, '12-22'), // вместе с перечнями у каждого диапазона набирается по 3 листа
    axesPage(22, '1-11'), axesPage(23, '12-22'),
    elementSpecPage(30, 'стен монолитных См 1 т, См 1 н', 92),
    elementSpecPage(31, 'стены монолитной См 4', 10),
    elementSpecPage(32, 'стены монолитной См 10 т', 5),
    elementSpecPage(33, 'стены монолитной См 9', 7), // в перечнях марки нет
    elementSpecPage(34, 'элементов ППм 1', 40, { text: ['Опалубочный чертёж плиты в осях 12-22'] }),
    elementSpecPage(35, 'элементов лестницы Л1', 3), // осей на листе нет
  ];
}

const concreteBy = (rows, sheetStart) => rows.filter((r) => r.kind === 'concrete' && r.sheetTitle.includes(sheetStart))
  .map((r) => `${r.block || '—'}:${r.quantity}`).sort();

test('стены раскладываются по блокам по перечням: пара «т/н» — по блоку каждой марки, одинаковая марка в двух блоках — в обоих', () => {
  const { rows, blocks } = parseKzh(sampleDocument());
  assert.deepEqual(blocks.map((b) => b.name), ['Блок 1', 'Блок 2']);
  assert.deepEqual(concreteBy(rows, 'См 1 т, См 1 н'), ['Блок 1:92', 'Блок 2:92'], 'См 1 т — в блоке 1, См 1 н — в блоке 2');
  assert.deepEqual(concreteBy(rows, 'См 4'), ['Блок 1:10', 'Блок 2:10'], 'См 4 есть в перечнях обоих блоков');
  assert.deepEqual(concreteBy(rows, 'См 10 т'), ['Блок 1:5'], 'См 10 т — только в блоке 1');
  const wall = rows.find((r) => r.sheetTitle.includes('См 4') && r.block === 'Блок 2');
  assert.match(wall.note, /^Стен в блоке: 1 × расход на одну стену \(перечень на листах 14, 19\)$/);
});

test('марка, которой нет в перечнях, не угадывается: блок пустой, в отчёте — замечание', () => {
  const { rows, issues } = parseKzh(sampleDocument());
  assert.deepEqual(concreteBy(rows, 'См 9'), ['—:7']);
  assert.ok(issues.some((i) => i.page === 33 && /не найдена в перечнях/.test(i.message) && i.level !== 'info'));
});

test('остальное — по осям листа; нет осей — блок пустой с заметкой', () => {
  const { rows, issues } = parseKzh(sampleDocument());
  assert.deepEqual(concreteBy(rows, 'ППм 1'), ['Блок 2:40'], 'в осях 12-22 — Блок 2');
  assert.deepEqual(concreteBy(rows, 'лестницы Л1'), ['—:3']);
  assert.ok(issues.some((i) => i.page === 35 && i.level === 'info' && /блок не определён/.test(i.message)));
});

test('здание без блоков: блоков нет, расход на один элемент остаётся как есть', () => {
  const { rows, blocks, issues } = parseKzh([
    layoutListPage(14, '1-22', [['См 1', 1]]),
    elementSpecPage(30, 'стены монолитной См 1', 92),
  ]);
  assert.deepEqual(blocks, []);
  assert.deepEqual(rows.map((r) => r.block), [null]);
  assert.equal(rows[0].quantity, 92);
  assert.ok(!issues.some((i) => /блок/i.test(i.message)), 'про блоки в отчёте ничего лишнего');
});

test('сводная ведомость стали — на всё здание: у её строк блока нет', () => {
  const { steelSummaryPage } = require('./fixtures');
  const { rows } = parseKzh([steelSummaryPage(), ...sampleDocument()]);
  assert.ok(rows.filter((r) => r.basis === 'summary').length > 0);
  assert.ok(rows.filter((r) => r.basis === 'summary').every((r) => r.block === null));
});

test('сведение и работы: строки разных блоков не складываются, работы считаются по блокам', () => {
  const { rows } = parseKzh(sampleDocument());
  const items = consolidate(rows);
  const wall4 = items.filter((i) => i.kind === 'concrete' && i.element.includes('См 4'));
  assert.deepEqual(wall4.map((i) => `${i.block}:${i.quantity}`).sort(), ['Блок 1:10', 'Блок 2:10']);
  const works = deriveWorks(items).filter((w) => w.name === 'Бетонирование монолитных конструкций' && w.element.includes('См 4'));
  assert.deepEqual(works.map((w) => `${w.block}:${w.quantity}`).sort(), ['Блок 1:10', 'Блок 2:10']);
});
