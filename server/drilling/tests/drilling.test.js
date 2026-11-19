// Заявки на бурение и резку: валидация чисел, согласование в две линии,
// «первый среагировал», круги, выполнение по строкам, Word (server/drilling/).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CONCRETE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drilling-'));
const { initSchema } = require('../../db');
initSchema();
const svc = require('../service');
const { parseNumber, validateItems } = require('../validation');
const { buildDocx } = require('../docx');
svc.seedDefaults();

const OWN = 1; // Пром Альянс (линия 1)
const SUB = 2; // Жеңіс групп (линия 2)
svc.addCompanyUser(OWN, 'a1@x.kz');
svc.addCompanyUser(OWN, 'a2@x.kz');
svc.addCompanyUser(SUB, 's1@x.kz');
svc.saveStaff({ email: 'init@x.kz', fullName: 'Макажанов Е.С.', position: 'Начальник строительного участка', organization: 'ТОО "VK INVEST COMPANY"' });

const drill = { object: 'Брик таун 2', position: 'пятно I', workType: 'drill', material: 'кирпич', diameterMm: '100', quantity: '5', reason: 'под ОВ' };
const cut = { object: 'Брик таун 2', position: 'пятно I', workType: 'cut', material: 'бетон', thicknessCm: '20,5', quantity: '11.5', reason: 'проём' };
const make = (items = [drill, cut]) => svc.createRequest('init@x.kz', items);
const view = (id, email = 'init@x.kz') => svc.getRequestView(id, email, false);
const fails = (fn, re) => assert.throws(fn, (e) => e instanceof svc.DrillingError && (!re || re.test(e.message)));

test('числа: запятая и точка равнозначны, один знак после разделителя, только цифры', () => {
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber('12'), 12);
  assert.equal(parseNumber('12,55'), null);
  assert.equal(parseNumber('1e3'), null);
  assert.equal(parseNumber('-3'), null);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber('5,5', { integer: true }), null);
  assert.equal(parseNumber('5', { integer: true }), 5);
});

test('валидация строк: сверление — целые шт и диаметр, резка — длина и толщина', () => {
  assert.equal(validateItems([drill, cut]).ok, true);
  assert.equal(validateItems([{ ...drill, quantity: '5,5' }]).ok, false);
  assert.equal(validateItems([{ ...drill, diameterMm: '10,5' }]).ok, false);
  assert.equal(validateItems([{ ...cut, quantity: '1,25' }]).ok, false);
  assert.equal(validateItems([{ ...cut, thicknessCm: '' }]).ok, false);
  assert.equal(validateItems([{ ...drill, material: 'дерево' }]).ok, false);
  assert.equal(validateItems([{ ...drill, object: 'Нет такого' }]).ok, false);
  assert.equal(validateItems([{ ...drill, position: 'нет' }]).ok, false);
  assert.equal(validateItems([]).ok, false);
});

test('поток: отказ линии 1 передаёт линии 2, принятие, выполнение по строкам', () => {
  const id = make();
  assert.equal(view(id).status, 'line1');
  assert.equal(svc.counters('a1@x.kz').inbox >= 1, true);
  assert.equal(svc.counters('s1@x.kz').inbox, 0, 'линия 2 пока не видит');

  fails(() => svc.respond(id, 'init@x.kz', 'accept'), /не ждёт/);
  fails(() => svc.respond(id, 'a1@x.kz', 'reject', ''), /причину/);
  svc.respond(id, 'a1@x.kz', 'reject', 'вышло из строя оборудование');
  assert.equal(view(id).status, 'line2');
  fails(() => svc.respond(id, 'a2@x.kz', 'accept'), /не ждёт/); // линия 1 уже отреагировала

  svc.respond(id, 's1@x.kz', 'accept');
  const v = view(id);
  assert.equal(v.status, 'accepted');
  assert.equal(v.acceptedCompany.name, 'Жеңіс групп');

  const [i1, i2] = v.items;
  fails(() => svc.markItemDone(id, i1.id, 'a1@x.kz', '1'), /только её автор/);
  fails(() => svc.markItemDone(id, i1.id, 'init@x.kz', '6'), /Не больше/);
  fails(() => svc.markItemDone(id, i1.id, 'init@x.kz', '4,5'), /целое/);
  fails(() => svc.markItemDone(id, i1.id, 'init@x.kz', 'abc'), /целое/);
  svc.markItemDone(id, i1.id, 'init@x.kz', '4');
  assert.equal(view(id).status, 'accepted');
  fails(() => svc.markItemDone(id, i1.id, 'init@x.kz', '4'), /уже отмечена/);
  fails(() => svc.markItemDone(id, i2.id, 'init@x.kz', '11,6'), /Не больше/);
  svc.markItemDone(id, i2.id, 'init@x.kz', '0'); // 0 допустим
  assert.equal(view(id).status, 'completed');
});

test('первый принявший фиксируется: второй из той же линии опоздал', () => {
  const id = make([drill]);
  svc.respond(id, 'a2@x.kz', 'accept');
  assert.equal(view(id).acceptedBy, 'a2@x.kz');
  fails(() => svc.respond(id, 'a1@x.kz', 'accept'), /уже обработана/);
});

test('отказали обе линии: возврат инициатору, правка, перезапуск — новый круг, отметки только текущего круга', () => {
  const id = make([drill]);
  svc.respond(id, 'a1@x.kz', 'reject', 'нет бригады');
  svc.respond(id, 's1@x.kz', 'reject', 'нет оборудования');
  let v = view(id);
  assert.equal(v.status, 'returned');
  assert.deepEqual(v.events.filter((e) => e.type === 'rejected').map((e) => e.reason), ['нет бригады', 'нет оборудования']);
  assert.equal(v.permissions.restart, true);
  fails(() => svc.respond(id, 's1@x.kz', 'accept'), /уже обработана/);

  svc.updateRequest(id, 'init@x.kz', [{ ...drill, quantity: '3' }]);
  assert.equal(view(id).items[0].quantity, 3);
  svc.restartRequest(id, 'init@x.kz');
  v = view(id);
  assert.equal(v.status, 'line1');
  assert.equal(v.round, 2);

  svc.respond(id, 'a1@x.kz', 'accept');
  const data = svc.getDocData(id);
  assert.deepEqual(data.stamps.map((s) => `${s.company}:${s.type}`), ['Пром Альянс:accepted'], 'отметки прошлого круга не попадают');
  assert.equal(svc.listRequests('init@x.kz', 'mine', false).some((r) => r.id === id), true);
});

test('несколько субподрядчиков: возврат инициатору только когда отказали ВСЕ', () => {
  const sub2 = svc.saveCompany({ name: 'Субпод 2', addressee: 'Директору ТОО "Субпод 2"', line: 2 });
  svc.addCompanyUser(sub2, 'p1@x.kz');
  svc.addCompanyUser(sub2, 'p2@x.kz');

  const id = make([drill]);
  svc.respond(id, 'a1@x.kz', 'reject', 'не можем');
  assert.equal(view(id).status, 'line2');
  svc.respond(id, 's1@x.kz', 'reject', 'занят');
  assert.equal(view(id).status, 'line2', 'второй субподрядчик ещё может принять');
  fails(() => svc.respond(id, 's1@x.kz', 'accept'), /уже отказала/);
  svc.respond(id, 'p2@x.kz', 'accept');
  const v = view(id);
  assert.equal(v.status, 'accepted');
  assert.equal(v.acceptedCompany.name, 'Субпод 2');
  assert.equal(svc.getDocData(id).company.addressee, 'Директору ТОО "Субпод 2"');

  const id2 = make([drill]);
  svc.respond(id2, 'a1@x.kz', 'reject', 'x');
  svc.respond(id2, 's1@x.kz', 'reject', 'y');
  svc.respond(id2, 'p1@x.kz', 'reject', 'z');
  assert.equal(view(id2).status, 'returned');
});

test('отмена и доступ: чужой не видит, отмена только до принятия', () => {
  const id = make([drill]);
  fails(() => view(id, 'stranger@x.kz'), /Нет доступа/);
  fails(() => svc.cancelRequest(id, 'a1@x.kz'), /только её автор/);
  svc.cancelRequest(id, 'init@x.kz');
  assert.equal(view(id).status, 'cancelled');
  const id2 = make([drill]);
  svc.respond(id2, 'a1@x.kz', 'accept');
  fails(() => svc.cancelRequest(id2, 'init@x.kz'), /нельзя отменить/);
});

test('Word: адресат, подписи, таблица и колонтитул с отметками текущего круга', async () => {
  const id = make();
  svc.respond(id, 'a1@x.kz', 'reject', 'нет бригады');
  svc.respond(id, 's1@x.kz', 'accept');
  assert.equal(view(id).permissions.download, true);
  assert.equal(view(id, 'a1@x.kz').permissions.download, true, 'ответственный тоже скачивает');
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(await buildDocx(svc.getDocData(id)));
  const doc = await zip.file('word/document.xml').async('string');
  const footerName = Object.keys(zip.files).find((n) => /word\/footer\d*\.xml/.test(n));
  const footer = await zip.file(footerName).async('string');
  const text = (x) => x.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.match(text(doc), /Директору ТОО "Жеңіс групп"/);
  assert.match(text(doc), /Наряд задание/);
  assert.match(text(doc), /Макажанов Е\.С\./);
  assert.match(text(doc), /Титаренко В\.С\./);
  assert.match(text(doc), /Ø 100 мм/);
  assert.match(text(doc), /толщина 20,5 см/);
  assert.match(text(doc), /11,5 м\.п\./);
  assert.match(text(footer), /Создана: \d\d\.\d\d\.\d{4} \d\d:\d\d/);
  assert.match(text(footer), /Пром Альянс — отклонена/);
  assert.match(text(footer), /Жеңіс групп — принята/);

  const id2 = make([drill]);
  assert.equal(view(id2).permissions.download, false, 'до принятия нельзя');
});

test('счётчик: список заявок, требующих действия, по ролям', () => {
  const id = make([drill]);
  const resp = svc.counters('a1@x.kz');
  assert.equal(resp.items.find((i) => i.id === id).kind, 'respond');
  assert.equal(resp.total, resp.items.length);
  svc.respond(id, 'a1@x.kz', 'accept');
  assert.equal(svc.counters('a1@x.kz').items.some((i) => i.id === id), false, 'принявшему уже не нужно отвечать');
  assert.equal(svc.counters('init@x.kz').items.find((i) => i.id === id).kind, 'mark');
  const id2 = make([drill]);
  svc.respond(id2, 'a1@x.kz', 'reject', 'x');
  svc.respond(id2, 's1@x.kz', 'reject', 'y');
  svc.respond(id2, 'p1@x.kz', 'reject', 'z');
  assert.equal(svc.counters('init@x.kz').items.find((i) => i.id === id2).kind, 'returned');
});

test('реестр: строки по заявкам с правами доступа, фильтры, итоги и Excel', async () => {
  const mine = svc.createRequest('reg@x.kz', [drill, cut]);
  const other = svc.createRequest('other@x.kz', [{ ...drill, quantity: '7' }]);
  svc.respond(mine, 'a1@x.kz', 'accept');
  const v = svc.getRequestView(mine, 'reg@x.kz', false);
  svc.markItemDone(mine, v.items[0].id, 'reg@x.kz', '4');

  const own = svc.registry('reg@x.kz', false);
  assert.deepEqual([...new Set(own.rows.map((r) => r.requestId))], [mine], 'автор видит только свои');
  assert.equal(own.rows.length, 2, 'по строке работ — отдельная строка реестра');
  const d = own.rows.find((r) => r.workType === 'drill');
  assert.equal(d.factQuantity, 4);
  assert.equal(d.company, 'Пром Альянс');
  assert.equal(own.rows.find((r) => r.workType === 'cut').doneAt, null);

  const admin = svc.registry('admin@vkdev.kz', true);
  assert.equal(admin.rows.some((r) => r.requestId === other), true, 'админ видит все');
  const resp = svc.registry('a1@x.kz', false);
  assert.equal(resp.rows.length, 0, 'ответственный в реестре видит только свои поданные заявки');
  assert.equal(resp.scope, 'own');
  assert.equal(admin.scope, 'all');
  assert.equal(svc.listRequests('a1@x.kz', 'inbox', false).some((r) => r.id === mine), true, 'а принятые им — во «Входящих»');
  assert.equal(svc.registry('stranger@x.kz', false).rows.length, 0, 'чужой не видит ничего');

  assert.ok(admin.rows.every((r) => r.workType === 'cut') === false);
  assert.ok(svc.registry('admin@vkdev.kz', true, { workType: 'cut' }).rows.every((r) => r.workType === 'cut'));
  assert.ok(svc.registry('admin@vkdev.kz', true, { status: ['accepted'] }).rows.every((r) => r.status === 'accepted'));
  assert.ok(svc.registry('admin@vkdev.kz', true, { company: 'Пром Альянс' }).rows.every((r) => r.company === 'Пром Альянс'));
  assert.equal(svc.registry('admin@vkdev.kz', true, { from: '2999-01-01' }).rows.length, 0);
  assert.equal(svc.registry('admin@vkdev.kz', true, { onlyMine: true }).rows.length, 0);
  assert.equal(admin.facets.objects.includes('Брик таун 2'), true);

  assert.equal(own.totals['шт'].plan, 5);
  assert.equal(own.totals['шт'].fact, 4);
  assert.equal(own.totals['м.п.'].plan, 11.5);

  const ExcelJS = require('exceljs');
  const { buildRegistryXlsx } = require('../xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildRegistryXlsx(own));
  const ws = wb.getWorksheet('Заявки');
  assert.equal(ws.getRow(1).getCell(1).value, '№ заявки');
  assert.equal(ws.getRow(2).getCell(1).value, mine);
  assert.equal(ws.getRow(2).getCell(4).value, 'Принята в работу');
  const lastRows = [ws.rowCount - 1, ws.rowCount].map((n) => ws.getRow(n).getCell(7).value);
  assert.deepEqual(lastRows, ['ИТОГО', 'ИТОГО']);
});
