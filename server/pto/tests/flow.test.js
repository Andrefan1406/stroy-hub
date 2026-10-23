// Полный цикл модуля ПТО через HTTP: загрузка PDF → разбор в фоне → ведомость
// и виды работ (черновик) → правки → расценки (предложение, подтверждение,
// запоминание) → стоимость → Excel. Чтение PDF подменено заготовленными
// страницами (настоящее чтение — в pdf.test.js), авторизация — заглушкой
// (настоящая — в access.test.js).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');
const { setupPtoEnv, stubRates, listen, until } = require('./helpers');

setupPtoEnv();

const { initSchema } = require('../db');
const { createPtoService } = require('../service');
const { createPtoRouter } = require('../router');
const { PdfError } = require('../pdf');
const { it, steelSummaryPage, specPage, multiElementPage } = require('./fixtures');

const db = initSchema();
const rates = stubRates();
let pages = [steelSummaryPage(), specPage(), multiElementPage()];
let extractError = null;
const extract = async () => {
  if (extractError) throw extractError;
  return { pageCount: pages.length, pages };
};
const service = createPtoService({ db, rates, extract });

const app = express();
app.use(express.json());
app.use('/api/pto', createPtoRouter({ requireAccess: (req, res, next) => { req.userEmail = 'admin@vkdev.kz'; next(); }, service }));
let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => server && server.close());

const PDF = Buffer.from('%PDF-1.4\nfake');
const HIER = 'section=КЖ&category=' + encodeURIComponent('Строительство жилых домов') + '&object=' + encodeURIComponent('Брик таун 1');
const upload = (extra = '', body = PDF, name = 'KZh.pdf') => call('POST', `/api/pto/documents?${HIER}${extra}&fileName=${encodeURIComponent(name)}`, body, { raw: true, headers: { 'content-type': 'application/pdf' } });
const finished = (id) => until(async () => {
  const r = await call('GET', `/api/pto/documents/${id}`);
  return r.body.document.status !== 'parsing' ? r.body.document : null;
});

test('загрузка принимает только PDF и только объекты из справочника', async () => {
  await ready;
  assert.equal((await upload('', Buffer.from('просто текст'))).status, 400);
  assert.equal((await upload('', Buffer.alloc(0))).status, 400);
  const bad = await call('POST', '/api/pto/documents?section=КЖ&object=' + encodeURIComponent('Несуществующий объект'), PDF, { raw: true, headers: { 'content-type': 'application/pdf' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /нет в справочнике объектов/);
  const wrongSection = await call('POST', '/api/pto/documents?section=АР&object=' + encodeURIComponent('Брик таун 1'), PDF, { raw: true, headers: { 'content-type': 'application/pdf' } });
  assert.match(wrongSection.body.error, /пока не поддерживается/);
  const wrongPos = await upload('&position=' + encodeURIComponent('нет такой позиции'));
  assert.match(wrongPos.body.error, /Позиции/);
});

let docId;

test('загрузка: 202 сразу, разбор в фоне, строки — «черновик», расценки предложены', async () => {
  await ready;
  // Блок при загрузке не выбирается (даже если пришёл в запросе — игнорируется): он определяется по чертежам.
  const res = await upload('&position=' + encodeURIComponent('3') + '&block=' + encodeURIComponent('Блок 1'));
  assert.equal(res.status, 202, JSON.stringify(res.body));
  docId = res.body.id;
  const doc = await finished(docId);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.object, 'Брик таун 1');
  assert.equal(doc.pageCount, 3);
  assert.equal(doc.fileName, 'KZh.pdf');
  assert.ok(!('block' in doc), 'у документа блока нет — он у строк');
  // Файл сохранён — по нему открываются листы из таблиц.
  assert.equal(doc.hasFile, true);
  const pdf = await call('GET', `/api/pto/documents/${docId}/pdf`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.deepEqual(pdf.body, PDF);
  assert.deepEqual(doc.report.blocks, [], 'в этих листах осей блоков нет — здание без блоков');
  assert.deepEqual(doc.report.sheets.map((s) => `${s.page}:${s.kind}`), ['4:steel_summary', '23:specification', '63:specification']);

  const items = (await call('GET', `/api/pto/documents/${docId}/items`)).body.items;
  assert.equal(doc.report.stats.items, items.length);
  assert.ok(items.length > 5);
  assert.ok(items.every((i) => i.status === 'draft'), 'всё извлечённое — черновик');
  assert.ok(items.every((i) => !i.edited && !i.manual));
  const fl = items.find((i) => i.element === 'Фундамент ФЛм 1' && i.name === 'Арматура ∅12');
  assert.equal(fl.quantity, 37223);
  assert.equal(fl.markClass, 'А400');
  assert.deepEqual(fl.sources, [{ page: 4, quantity: 37223 }]);

  const works = (await call('GET', `/api/pto/documents/${docId}/works`)).body.works;
  assert.ok(works.length >= 3);
  // Армирование отдельной работой не выводится: оно входит в стоимость бетонирования.
  assert.ok(!works.some((w) => /Армирование/.test(w.name)), 'работы «Армирование» нет');
  assert.ok(!works.some((w) => w.element === 'Фундамент ФЛм 1'), 'у элемента только с арматурой работ нет — арматура в материалах');
  const wall = works.find((w) => w.name === 'Бетонирование монолитных конструкций' && w.element === 'Стен монолитных См 1 т, См 1 н');
  assert.equal(wall.quantity, 92);
  assert.deepEqual(wall.pages, [23], 'у работы — лист PDF, с которого взят объём');
  assert.match(wall.basisNote, /армирование и закладные входят в стоимость бетонирования/);
  assert.equal(wall.rate.status, 'suggested');
  assert.equal(wall.rate.name, 'Бетонирование открытых площадок');
  assert.equal(wall.rate.class, 'Расценки из ЕНиР для фирм', 'категория расценки сохранена');
  assert.equal(wall.rate.price, 15772);
  assert.equal(wall.rate.confidence, 0.58);
  const prep = works.find((w) => w.name === 'Устройство бетонной подготовки');
  assert.equal(prep.rate.price, 14268);
  assert.equal(prep.rate.class, 'Расценки утверждённые в ТОО VK development group');
});

test('правка строки: помечается как ручная, работы устаревают, проверенный документ становится черновиком', async () => {
  await ready;
  const items = (await call('GET', `/api/pto/documents/${docId}/items`)).body.items;
  const fl = items.find((i) => i.element === 'Фундамент ФЛм 1' && i.name === 'Арматура ∅12');
  const bad = await call('PATCH', `/api/pto/items/${fl.id}`, { quantity: 'abc' });
  assert.equal(bad.status, 400);
  const upd = await call('PATCH', `/api/pto/items/${fl.id}`, { quantity: '37 300,5'.replace(' ', '') });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.item.quantity, 37300.5);
  assert.equal(upd.body.item.edited, true);
  assert.equal((await call('GET', `/api/pto/documents/${docId}`)).body.document.worksStale, true);

  // статус сам по себе — не «правка»
  const other = items.find((i) => i.id !== fl.id && !i.edited);
  const st = await call('PATCH', `/api/pto/items/${other.id}`, { status: 'confirmed' });
  assert.equal(st.body.item.edited, false);
  assert.equal(st.body.item.status, 'confirmed');

  const conf = await call('POST', `/api/pto/documents/${docId}/confirm`, {});
  assert.equal(conf.body.document.status, 'confirmed');
  await call('PATCH', `/api/pto/items/${fl.id}`, { note: 'проверено по чертежу' });
  assert.equal((await call('GET', `/api/pto/documents/${docId}`)).body.document.status, 'draft');
});

test('своя строка и пересчёт видов работ: ручные работы остаются, выведенные пересоздаются', async () => {
  await ready;
  const add = await call('POST', `/api/pto/documents/${docId}/items`, { kind: 'steel', element: 'Фундамент ФЛм 1', name: 'Арматура ∅14', markClass: 'А500С', unit: 'кг', quantity: 1000 });
  assert.equal(add.status, 201);
  assert.equal(add.body.item.manual, true);
  const work = await call('POST', `/api/pto/documents/${docId}/works`, { element: 'Фундамент ФЛм 1', name: 'Устройство опалубки', unit: 'м²', quantity: 120 });
  assert.equal(work.status, 201);
  assert.equal(work.body.work.manual, true);

  rates.calls.suggest.length = 0;
  const rebuilt = await call('POST', `/api/pto/documents/${docId}/works/rebuild`, {});
  const works = rebuilt.body.works;
  assert.ok(works.filter((w) => w.name === 'Бетонирование монолитных конструкций').every((w) => w.rate && w.rate.status === 'suggested'), 'предложенные расценки сохранились при пересчёте');
  assert.ok(!rates.calls.suggest.some(([q]) => /Бетонирование монолитных|бетонной подготовки/.test(q)), 'уже подобранные расценки не искали заново (искали только для работ без расценки)');
  assert.ok(!works.some((w) => /Армирование/.test(w.name)), 'добавленная строка арматуры работ не порождает');
  assert.ok(works.some((w) => w.name === 'Устройство опалубки' && w.manual), 'ручная работа осталась');
  assert.equal((await call('GET', `/api/pto/documents/${docId}`)).body.document.worksStale, false);
});

test('расценка: подтверждение берёт данные из свода, запоминается и применяется ко всем элементам и к следующим документам', async () => {
  await ready;
  const works = (await call('GET', `/api/pto/documents/${docId}/works`)).body.works;
  const concretes = works.filter((w) => w.name === 'Бетонирование монолитных конструкций');
  assert.ok(concretes.length >= 2);
  const wrong = await call('POST', `/api/pto/works/${concretes[0].id}/rate`, { rateId: 999999 });
  assert.equal(wrong.status, 404);

  rates.calls.get.length = 0;
  const ok = await call('POST', `/api/pto/works/${concretes[0].id}/rate`, { rateId: 102 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(rates.calls.get, [102], 'расценка перечитана из свода, а не взята у клиента');
  const after = (await call('GET', `/api/pto/documents/${docId}/works`)).body.works.filter((w) => w.name === 'Бетонирование монолитных конструкций');
  assert.ok(after.every((w) => w.rate.status === 'confirmed' && w.rate.price === 15772), 'та же работа на других элементах получила ту же расценку');

  // следующий документ: расценка приходит из запомненных, без обращения к своду
  rates.calls.suggest.length = 0;
  const second = await upload();
  const doc2 = await finished(second.body.id);
  assert.equal(doc2.status, 'draft');
  const works2 = (await call('GET', `/api/pto/documents/${doc2.id}/works`)).body.works;
  const concrete2 = works2.find((w) => w.name === 'Бетонирование монолитных конструкций');
  assert.equal(concrete2.rate.status, 'confirmed');
  assert.equal(concrete2.rate.id, 102);
  assert.ok(!rates.calls.suggest.some(([q]) => /Бетонирование монолитных/.test(q)), 'подтверждённое соответствие своду не переспрашивали');
  const prep2 = works2.find((w) => w.name === 'Устройство бетонной подготовки');
  assert.equal(prep2.rate.status, 'suggested', 'а неподтверждённое — только предложено');

  // свою расценку можно ввести вручную
  const manual = await call('POST', `/api/pto/works/${prep2.id}/rate`, { manual: { name: 'Подготовка по договору', unit: 'м³', price: '20 000'.replace(' ', '') } });
  assert.equal(manual.body.work.rate.manual, true);
  assert.equal(manual.body.work.rate.price, 20000);
  const cleared = await call('DELETE', `/api/pto/works/${prep2.id}/rate`);
  assert.equal(cleared.body.work.rate, null);
});

test('стоимость: материалы по ориентировочным ценам + работы по расценкам с НДС, с разбивкой по элементам', async () => {
  await ready;
  const prices = (await call('GET', '/api/pto/material-prices')).body.prices;
  assert.deepEqual(prices.map((p) => [p.kind, p.price, p.unit]), [['concrete', 40000, 'м³'], ['steel', 400000, 'тн']]);

  const t = (await call('GET', `/api/pto/documents/${docId}/totals`)).body;
  const fl = t.rows.find((r) => r.element === 'Фундамент ФЛм 1');
  // арматура 37300,5 + 678 + 1000 = 38978,5 кг = 38,979 тн × 400 000 ₸ — в материалах
  assert.equal(fl.steelT, 38.979);
  assert.equal(fl.steelCost, Math.round(38.9785 * 400000));
  // армирование отдельно не оплачивается: работ по арматуре нет; опалубка без расценки — не в сумме
  assert.equal(fl.works, 0);
  assert.equal(fl.missing, 1);
  assert.equal(fl.total, fl.materials + fl.works);
  // стена: бетон 92 м³ (расценка подтверждена, 15 772 ₸) + подготовка 29,3 м³ (предложена, 14 268 ₸);
  // армирование и закладные входят в стоимость бетонирования
  const wall = t.rows.find((r) => r.element === 'Стен монолитных См 1 т, См 1 н');
  assert.equal(wall.concreteM3, 121.3);
  assert.equal(wall.materials, Math.round(121.3 * 40000));
  assert.equal(wall.works, Math.round(92 * 15772 + 29.3 * 14268));
  const sum = (k) => t.rows.reduce((s, r) => s + r[k], 0);
  assert.equal(t.totals.total, sum('total'));
  assert.ok(t.totals.concreteM3 > 0);
  assert.ok(t.totals.missing >= 1);

  const changed = await call('PUT', '/api/pto/material-prices/steel', { price: 450000 });
  assert.equal(changed.body.prices.find((p) => p.kind === 'steel').price, 450000);
  const t2 = (await call('GET', `/api/pto/documents/${docId}/totals`)).body;
  assert.equal(t2.rows.find((r) => r.element === 'Фундамент ФЛм 1').steelCost, Math.round(38.9785 * 450000));
  await call('PUT', '/api/pto/material-prices/steel', { price: 400000 });
  assert.equal((await call('PUT', '/api/pto/material-prices/unknown', { price: 1 })).status, 404);
  assert.equal((await call('PUT', '/api/pto/material-prices/steel', { price: -5 })).status, 400);
});

test('сверка со сводной ведомостью: предложен коэффициент для стен, применяется по кнопке один раз', async () => {
  await ready;
  // Сводная ведомость: стены 312 247 кг; спецификации стен: одна стена 154 700 кг — отношение ≈ 2,02.
  const wallsSummary = { page: 4, items: steelSummaryPage().items.concat([]) };
  const rows = [
    { kind: 'steel', element: 'Монолитные стены См', name: 'Арматура ∅12', markClass: 'А400', unit: 'кг', quantity: 312247, page: 4, basis: 'summary' },
    { kind: 'steel', element: 'Стены монолитной См 1 т', name: 'Арматура ∅12', markClass: 'А400', unit: 'кг', quantity: 154704, page: 23, basis: 'spec', note: 'Расход в спецификации дан на один элемент — количество элементов смотрите на листах расположения' },
    { kind: 'concrete', element: 'Стены монолитной См 1 т', name: 'Бетон С20/25', markClass: 'С20/25', unit: 'м³', quantity: 92, page: 23, basis: 'spec', note: 'Расход в спецификации дан на один элемент — количество элементов смотрите на листах расположения' },
    // лист стены без сноски «на одну стену» — коэффициент группы всё равно относится и к нему
    { kind: 'concrete', element: 'Стены монолитной См 5', name: 'Бетон С20/25', markClass: 'С20/25', unit: 'м³', quantity: 10, page: 35, basis: 'spec', note: null },
    // строка, уже умноженная на явное число элементов, коэффициент не трогает
    { kind: 'concrete', element: 'Стены монолитной См 6 (2 шт.)', name: 'Бетон С20/25', markClass: 'С20/25', unit: 'м³', quantity: 20, page: 38, basis: 'spec', note: 'Элементов: 2 × расход на один элемент' },
  ];
  void wallsSummary;
  const { reconcileKzh } = require('../reconcile');
  const rec = reconcileKzh(rows);
  assert.equal(rec[0].id, 'walls');
  assert.equal(rec[0].factor, 2);
  assert.equal(rec[0].status, 'factor');

  // через сервис: подставляем эти строки в документ
  pages = [{ page: 4, items: [] }];
  const origParse = require('../sections').SECTIONS['КЖ'].parse;
  require('../sections').SECTIONS['КЖ'].parse = () => ({ rows, issues: [], sheets: [] });
  try {
    const id = (await upload()).body.id;
    const doc = await finished(id);
    assert.deepEqual(doc.report.reconciliation.map((r) => [r.id, r.factor, r.applied]), [['walls', 2, null]]);
    const concreteOf = async (element) => (await call('GET', `/api/pto/documents/${id}/items`)).body.items.find((i) => i.kind === 'concrete' && i.element === element);
    assert.equal((await concreteOf('Стены монолитной См 1 т')).quantity, 92);

    assert.equal((await call('POST', `/api/pto/documents/${id}/apply-multiplier`, { group: 'walls', factor: 1 })).status, 400);
    assert.equal((await call('POST', `/api/pto/documents/${id}/apply-multiplier`, { group: 'nope', factor: 2 })).status, 400);
    const ok = await call('POST', `/api/pto/documents/${id}/apply-multiplier`, { group: 'walls', factor: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.changedItems, 3, 'бетон двух листов стен и справочная арматура; строка с явным числом элементов не тронута');
    const after = await concreteOf('Стены монолитной См 1 т');
    assert.equal(after.quantity, 184);
    assert.equal((await concreteOf('Стены монолитной См 5')).quantity, 20, 'лист без сноски тоже умножен');
    const explicit = await concreteOf('Стены монолитной См 6 (2 шт.)');
    assert.equal(explicit.quantity, 20, 'уже умноженное на число элементов не трогаем');
    assert.equal(explicit.edited, false);
    assert.equal(after.edited, true);
    assert.match(after.note, /×2 по сверке/);
    assert.deepEqual(after.sources, [{ page: 23, quantity: 184 }]);
    const works = (await call('GET', `/api/pto/documents/${id}/works`)).body.works;
    assert.equal(works.filter((w) => w.name === 'Бетонирование монолитных конструкций').reduce((s, w) => s + w.quantity, 0), 224, 'виды работ пересчитаны: 184 + 20 + 20');
    assert.equal((await call('POST', `/api/pto/documents/${id}/apply-multiplier`, { group: 'walls', factor: 2 })).status, 400, 'второй раз нельзя');
  } finally {
    require('../sections').SECTIONS['КЖ'].parse = origParse;
    pages = [steelSummaryPage(), specPage(), multiElementPage()];
  }
});

test('блок строки правится вручную (ведомость и работы), можно указать при добавлении', async () => {
  await ready;
  const items = (await call('GET', `/api/pto/documents/${docId}/items`)).body.items;
  const fl = items.find((i) => i.element === 'Фундамент ФЛм 1' && i.name === 'Арматура ∅12');
  assert.equal(fl.block, null);
  const upd = await call('PATCH', `/api/pto/items/${fl.id}`, { block: 'Блок 1' });
  assert.equal(upd.body.item.block, 'Блок 1');
  assert.equal(upd.body.item.edited, true, 'правка блока — ручная правка');
  const works = (await call('GET', `/api/pto/documents/${docId}/works`)).body.works;
  const wall = works.find((w) => w.name === 'Бетонирование монолитных конструкций' && w.element === 'Стен монолитных См 1 т, См 1 н');
  assert.equal((await call('PATCH', `/api/pto/works/${wall.id}`, { block: 'Блок 2' })).body.work.block, 'Блок 2');
  const added = await call('POST', `/api/pto/documents/${docId}/items`, { kind: 'concrete', block: 'Блок 2', element: 'Лестница', name: 'Бетон С20/25', unit: 'м³', quantity: 3 });
  assert.equal(added.body.item.block, 'Блок 2');
  await call('DELETE', `/api/pto/items/${added.body.item.id}`);
  // итоги — по блокам и элементам
  const t = (await call('GET', `/api/pto/documents/${docId}/totals`)).body;
  assert.ok(t.rows.some((r) => r.block === 'Блок 1' && r.element === 'Фундамент ФЛм 1'));
  assert.ok(t.rows.some((r) => r.block === 'Блок 2' && r.element === 'Стен монолитных См 1 т, См 1 н'));
});

test('Excel: листы, итоги, листы-источники, пометки ручных правок, столбец «Блок»', async () => {
  await ready;
  const res = await call('GET', `/api/pto/documents/${docId}/export.xlsx`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const book = XLSX.read(res.body, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['Ведомость материалов', 'Виды работ', 'Итого', 'Отчёт разбора']);
  const mat = XLSX.utils.sheet_to_json(book.Sheets['Ведомость материалов'], { header: 1 });
  const head = mat.findIndex((r) => r[0] === '№');
  // У строк есть блок — после «№» столбец «Блок».
  assert.deepEqual(mat[head].slice(0, 8), ['№', 'Блок', 'Конструктивный элемент', 'Наименование', 'Марка / класс', 'Ед. изм.', 'Количество', 'Листы-источники']);
  const row = mat.find((r) => r[2] === 'Фундамент ФЛм 1' && r[3] === 'Арматура ∅12');
  assert.equal(row[1], 'Блок 1');
  assert.equal(row[6], 37300.5);
  assert.equal(String(row[7]), '4');
  assert.match(row.join('|'), /изменена вручную/);
  assert.ok(mat.some((r) => r[2] === 'Фундамент ФЛм 1' && r[3] === 'Арматура ∅14' && /вручную/.test(r.join('|'))), 'добавленная строка помечена');
  const wk = XLSX.utils.sheet_to_json(book.Sheets['Виды работ'], { header: 1 });
  assert.deepEqual(wk[wk.findIndex((r) => r[0] === '№')].slice(0, 4), ['№', 'Блок', 'Конструктивный элемент', 'Вид работ']);
  const sums = XLSX.utils.sheet_to_json(book.Sheets['Итого'], { header: 1 });
  const sumHead = sums.find((r) => r[1] === 'Конструктивный элемент');
  assert.equal(sumHead[0], 'Блок', 'в итогах «Блок» — первый столбец');
  assert.ok(sums.some((r) => r[1] === 'ИТОГО'));
  assert.ok(sums.some((r) => r[0] === 'Блок 1' && r[1] === 'Фундамент ФЛм 1'));
});

test('Excel: у здания без блоков столбца «Блок» нет', async () => {
  await ready;
  const { buildWorkbook } = require('../excel');
  const doc = service.getDocument(docId);
  const noBlock = (list) => list.map((x) => ({ ...x, block: null }));
  const totals = service.totals(docId);
  const book = buildWorkbook({
    doc, items: noBlock(service.listItems(docId)), works: noBlock(service.listWorks(docId)), totals: { ...totals, rows: noBlock(totals.rows) },
  });
  const mat = XLSX.utils.sheet_to_json(book.Sheets['Ведомость материалов'], { header: 1 });
  assert.deepEqual(mat[mat.findIndex((r) => r[0] === '№')].slice(0, 3), ['№', 'Конструктивный элемент', 'Наименование']);
  const sums = XLSX.utils.sheet_to_json(book.Sheets['Итого'], { header: 1 });
  assert.ok(sums.some((r) => r[0] === 'Конструктивный элемент') && sums.some((r) => r[0] === 'ИТОГО'));
});

test('скан без текстового слоя: понятное сообщение, документ в статусе «ошибка», сервер жив', async () => {
  await ready;
  extractError = new PdfError('В PDF нет текстового слоя — это скан. Загрузите векторный PDF.', 'no-text-layer');
  try {
    const id = (await upload('', PDF, 'scan.pdf')).body.id;
    const doc = await finished(id);
    assert.equal(doc.status, 'error');
    assert.match(doc.error, /нет текстового слоя/);
    assert.equal((await call('GET', `/api/pto/documents/${id}/items`)).body.items.length, 0);
  } finally { extractError = null; }
  extractError = new Error('неожиданный сбой');
  try {
    const id = (await upload()).body.id;
    const doc = await finished(id);
    assert.equal(doc.status, 'error');
    assert.match(doc.error, /Не удалось разобрать документ: неожиданный сбой/);
  } finally { extractError = null; }
});

test('PDF не того раздела (нет КЖ): не падаем, замечание в отчёте', async () => {
  await ready;
  pages = [{ page: 1, items: [it('Общие данные по проекту', 100, 100, 150)] }];
  try {
    const id = (await upload()).body.id;
    const doc = await finished(id);
    assert.equal(doc.status, 'draft');
    assert.match(doc.report.issues[0].message, /не найдено ни сводной ведомости/);
    assert.equal((await call('GET', `/api/pto/documents/${id}/items`)).body.items.length, 0);
  } finally { pages = [steelSummaryPage(), specPage(), multiElementPage()]; }
});

test('листы PDF: у итогов по элементу они есть; документ без сохранённого файла — 404 и hasFile = false', async () => {
  await ready;
  const t = (await call('GET', `/api/pto/documents/${docId}/totals`)).body;
  assert.deepEqual(t.rows.find((r) => r.element === 'Стен монолитных См 1 т, См 1 н').pages, [23]);
  assert.deepEqual(t.rows.find((r) => r.element === 'Фундамент ФЛм 1').pages, [4]);

  const id = (await upload('', PDF, 'old.pdf')).body.id;
  await finished(id);
  const { DATA_DIR } = require('../db');
  fs.rmSync(path.join(DATA_DIR, 'files', `${id}.pdf`)); // как у документа, загруженного до появления хранения файлов
  const res = await call('GET', `/api/pto/documents/${id}/pdf`);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /не сохранён — загрузите его заново/);
  const listed = (await call('GET', '/api/pto/documents')).body.documents.find((d) => d.id === id);
  assert.equal(listed.hasFile, false);
});

test('список документов с фильтром по иерархии и удаление', async () => {
  await ready;
  const all = (await call('GET', '/api/pto/documents')).body.documents;
  assert.ok(all.length >= 4);
  const byPosition = (await call('GET', '/api/pto/documents?position=' + encodeURIComponent('3'))).body.documents;
  assert.ok(byPosition.length >= 1 && byPosition.every((d) => d.position === '3'));
  const del = await call('DELETE', `/api/pto/documents/${docId}`);
  assert.equal(del.status, 200);
  assert.equal((await call('GET', `/api/pto/documents/${docId}`)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pto_items WHERE document_id = ?').get(docId).n, 0, 'строки удалены каскадом');
  assert.equal(fs.existsSync(path.join(require('../db').DATA_DIR, 'files', `${docId}.pdf`)), false, 'файл удалён вместе с документом');
});
