// Заявки на бурение и резку: валидация чисел, путь согласования (главный инженер →
// линия 1 → линия 2), «первый среагировал», круги, выполнение по строкам, права
// подачи, реестр и Word (server/drilling/). Люди — роли и карточки в rides.users.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drilling-'));
process.env.CONCRETE_DATA_DIR = dir;
process.env.RIDES_DATA_DIR = path.join(dir, 'rides');
const { initSchema } = require('../../db');
const rides = require('../../rides/db');
initSchema();
rides.initSchema();
const svc = require('../service');
const { parseNumber, validateItems } = require('../validation');
const { buildDocx } = require('../docx');
svc.seedDefaults();

const OWN = 1; // Пром Альянс (линия 1)
const SUB = 2; // Жеңіс групп (линия 2)

function addUser(email, role, { name = 'Тест', phone = '', position = '', companyId = null } = {}) {
  rides.getWriteDb().prepare(
    'INSERT INTO users (email, name, phone, position, company_id, role, full_site_access) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(email, name, phone, position, companyId, role, role === 'driller' ? 0 : 1);
}
const setRole = (email, role) => rides.getWriteDb().prepare('UPDATE users SET role = ? WHERE email = ?').run(role, email);

addUser('chief@x.kz', 'chief_engineer', { name: 'Титаренко В.С.', position: 'Главный инженер ТОО «VK development group»' });
addUser('a1@x.kz', 'prom_alyans', { name: 'Пром Один' });
addUser('a2@x.kz', 'prom_alyans', { name: 'Пром Два' });
addUser('s1@x.kz', 'driller', { name: 'Бурильщик Жеңіс', companyId: SUB });
addUser('init@x.kz', 'staff', { name: 'Макажанов Е.С.', position: 'Начальник строительного участка ТОО "VK INVEST COMPANY"' });
addUser('reg@x.kz', 'staff', { name: 'Регистратор Р.Р.', position: 'Инженер' });
addUser('other@x.kz', 'staff', { name: 'Другой Д.Д.', position: 'Прораб' });

const drill = { object: 'Брик таун 2', position: 'пятно I', workType: 'drill', material: 'кирпич', diameterMm: '100', quantity: '5', reason: 'под ОВ' };
const cut = { object: 'Брик таун 2', position: 'пятно I', workType: 'cut', material: 'бетон', thicknessCm: '20,5', quantity: '11.5', reason: 'проём' };
const make = (items = [drill, cut], by = 'init@x.kz') => svc.createRequest(by, items);
const view = (id, email = 'init@x.kz') => svc.getRequestView(id, email, false);
const fails = (fn, re) => assert.throws(fn, (e) => e instanceof svc.DrillingError && (!re || re.test(e.message)));
// заявка доведена до линии 1 (главный инженер согласовал)
const approved = (items, by) => { const id = make(items, by); svc.respond(id, 'chief@x.kz', 'accept'); return id; };

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

test('поток: главный инженер → линия 1 → отказ → линия 2 → принятие → выполнение по строкам', () => {
  const id = make();
  assert.equal(view(id).status, 'engineer');
  assert.equal(svc.counters('chief@x.kz').items.find((i) => i.id === id).kind, 'respond');
  assert.equal(svc.counters('a1@x.kz').inbox, 0, 'линия 1 пока не видит');
  fails(() => svc.respond(id, 'a1@x.kz', 'accept'), /ждёт согласования главного инженера/);

  svc.respond(id, 'chief@x.kz', 'accept');
  assert.equal(view(id).status, 'line1');
  assert.equal(svc.counters('a1@x.kz').items.some((i) => i.id === id), true);
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

test('главный инженер отклонил: заявка сразу у автора; перезапуск снова начинается с главного инженера', () => {
  const id = make([drill]);
  fails(() => svc.respond(id, 'chief@x.kz', 'reject', ''), /причину/);
  svc.respond(id, 'chief@x.kz', 'reject', 'не по проекту');
  let v = view(id);
  assert.equal(v.status, 'returned');
  assert.deepEqual(v.events.filter((e) => e.type === 'engineer_rejected').map((e) => e.reason), ['не по проекту']);
  assert.equal(svc.counters('a1@x.kz').items.some((i) => i.id === id), false, 'до исполнителей не дошла');

  svc.updateRequest(id, 'init@x.kz', [{ ...drill, quantity: '3' }]);
  svc.restartRequest(id, 'init@x.kz');
  v = view(id);
  assert.equal(v.status, 'engineer', 'новый круг — снова к главному инженеру');
  assert.equal(v.round, 2);
});

test('первый принявший фиксируется: второй из той же линии опоздал', () => {
  const id = approved([drill]);
  svc.respond(id, 'a2@x.kz', 'accept');
  assert.equal(view(id).acceptedBy, 'a2@x.kz');
  fails(() => svc.respond(id, 'a1@x.kz', 'accept'), /уже обработана/);
});

test('отказали обе линии: возврат автору, правка, перезапуск — новый круг, отметки только текущего круга', () => {
  const id = approved([drill]);
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
  assert.equal(v.status, 'engineer');
  assert.equal(v.round, 2);

  svc.respond(id, 'chief@x.kz', 'accept');
  svc.respond(id, 'a1@x.kz', 'accept');
  const data = svc.getDocData(id);
  assert.deepEqual(data.stamps.map((s) => `${s.company}:${s.type}`), ['Главный инженер:engineer_approved', 'Пром Альянс:accepted'], 'отметки прошлого круга не попадают');
  assert.equal(svc.listRequests('init@x.kz', 'mine', false).some((r) => r.id === id), true);
});

test('несколько субподрядчиков: возврат автору только когда отказали ВСЕ', () => {
  const sub2 = svc.saveCompany({ name: 'Субпод 2', addressee: 'Директору ТОО "Субпод 2"', line: 2 });
  addUser('p1@x.kz', 'driller', { name: 'Бур П1', companyId: sub2 });
  addUser('p2@x.kz', 'driller', { name: 'Бур П2', companyId: sub2 });

  const id = approved([drill]);
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

  const id2 = approved([drill]);
  svc.respond(id2, 'a1@x.kz', 'reject', 'x');
  svc.respond(id2, 's1@x.kz', 'reject', 'y');
  svc.respond(id2, 'p1@x.kz', 'reject', 'z');
  assert.equal(view(id2).status, 'returned');
});

test('линия 1 — одна компания; бурильщик привязан к субподрядчику', () => {
  fails(() => svc.saveCompany({ name: 'Ещё одна', addressee: 'Директору', line: 1 }), /одна компания/);
  assert.equal(svc.isSubcontractor(SUB), true);
  assert.equal(svc.isSubcontractor(OWN), false);
  const companies = svc.listCompanies();
  assert.deepEqual(companies.find((c) => c.id === OWN).users.sort(), ['a1@x.kz', 'a2@x.kz']);
  assert.deepEqual(companies.find((c) => c.id === SUB).users, ['s1@x.kz']);
});

test('права подачи: исполнителям нельзя, без карточки нельзя, админу можно; главный инженер пропускает свой этап', () => {
  fails(() => svc.createRequest('a1@x.kz', [drill]), /недоступна подача/);
  fails(() => svc.createRequest('s1@x.kz', [drill]), /недоступна подача/);
  fails(() => svc.createRequest('nobody@x.kz', [drill]), /ФИО и должность/);
  addUser('nopos@x.kz', 'staff', { name: 'Без Должности' });
  fails(() => svc.createRequest('nopos@x.kz', [drill]), /ФИО и должность/);
  assert.equal(svc.profile('a1@x.kz', false).canSubmit, false);
  assert.equal(svc.profile('init@x.kz', false).canSubmit, true);

  const adminId = svc.createRequest('admin@vkdev.kz', [drill], { isAdmin: true });
  assert.equal(view(adminId, 'chief@x.kz').status, 'engineer', 'заявка админа тоже идёт к главному инженеру');

  const own = svc.createRequest('chief@x.kz', [drill]);
  const v = view(own, 'chief@x.kz');
  assert.equal(v.status, 'line1', 'собственная заявка главного инженера идёт сразу в линию 1');
  assert.equal(v.events.some((e) => e.type === 'engineer_approved'), false);
  assert.deepEqual(svc.getDocData(own).stamps, []);
});

test('без главного инженера подача блокируется', () => {
  setRole('chief@x.kz', 'staff');
  try {
    fails(() => make([drill]), /Главный инженер не назначен/);
  } finally {
    setRole('chief@x.kz', 'chief_engineer');
  }
});

test('отмена и доступ: чужой не видит, главный инженер видит всё, отмена только до принятия', () => {
  const id = make([drill]);
  fails(() => view(id, 'stranger@x.kz'), /Нет доступа/);
  fails(() => view(id, 'a1@x.kz'), /Нет доступа/); // линия 1 заявку ещё не получила
  assert.equal(view(id, 'chief@x.kz').id, id);
  fails(() => svc.cancelRequest(id, 'a1@x.kz'), /только её автор/);
  svc.cancelRequest(id, 'init@x.kz');
  assert.equal(view(id).status, 'cancelled');
  const id2 = approved([drill]);
  svc.respond(id2, 'a1@x.kz', 'accept');
  fails(() => svc.cancelRequest(id2, 'init@x.kz'), /нельзя отменить/);
});

test('Word: адресат, подписи из карточек, таблица и колонтитул с отметками текущего круга', async () => {
  const id = approved();
  svc.respond(id, 'a1@x.kz', 'reject', 'нет бригады');
  svc.respond(id, 's1@x.kz', 'accept');
  assert.equal(view(id).permissions.download, true);
  assert.equal(view(id, 'a1@x.kz').permissions.download, true, 'ответственный тоже скачивает');
  assert.equal(view(id, 'chief@x.kz').permissions.download, true);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(await buildDocx(svc.getDocData(id)));
  const doc = await zip.file('word/document.xml').async('string');
  const footerName = Object.keys(zip.files).find((n) => /word\/footer\d*\.xml/.test(n));
  const footer = await zip.file(footerName).async('string');
  const text = (x) => x.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.match(text(doc), /Директору ТОО "Жеңіс групп"/);
  assert.match(text(doc), /Наряд задание/);
  assert.match(text(doc), /Макажанов Е\.С\./);
  assert.match(text(doc), /Начальник строительного участка/);
  assert.match(text(doc), /Титаренко В\.С\./, 'подпись «Согласовано» — из карточки главного инженера');
  assert.match(text(doc), /Ø 100 мм/);
  assert.match(text(doc), /толщина 20,5 см/);
  assert.match(text(doc), /11,5 м\.п\./);
  const lines = text(footer).replace(/\s+/g, ' ');
  assert.match(lines, /Создана: \d\d\.\d\d\.\d{4} \d\d:\d\d/);
  assert.match(lines, /Главный инженер — согласована/);
  assert.match(lines, /Пром Альянс — отклонена/);
  assert.match(lines, /Жеңіс групп — принята/);
  assert.ok(lines.indexOf('Создана') < lines.indexOf('Главный инженер') && lines.indexOf('Главный инженер') < lines.indexOf('Пром Альянс'));

  const id2 = make([drill]);
  assert.equal(view(id2).permissions.download, false, 'до принятия нельзя');
});

test('счётчик: список заявок, требующих действия, по ролям', () => {
  const id = make([drill]);
  assert.equal(svc.counters('chief@x.kz').items.find((i) => i.id === id).kind, 'respond');
  svc.respond(id, 'chief@x.kz', 'accept');
  assert.equal(svc.counters('chief@x.kz').items.some((i) => i.id === id), false);
  const resp = svc.counters('a1@x.kz');
  assert.equal(resp.items.find((i) => i.id === id).kind, 'respond');
  assert.equal(resp.total, resp.items.length);
  svc.respond(id, 'a1@x.kz', 'accept');
  assert.equal(svc.counters('a1@x.kz').items.some((i) => i.id === id), false, 'принявшему уже не нужно отвечать');
  assert.equal(svc.counters('init@x.kz').items.find((i) => i.id === id).kind, 'mark');
  const id2 = approved([drill]);
  svc.respond(id2, 'a1@x.kz', 'reject', 'x');
  svc.respond(id2, 's1@x.kz', 'reject', 'y');
  svc.respond(id2, 'p1@x.kz', 'reject', 'z');
  assert.equal(svc.counters('init@x.kz').items.find((i) => i.id === id2).kind, 'returned');
});

test('реестр: свой срез по ролям, фильтры, итоги и Excel', async () => {
  const mine = make([drill, cut], 'reg@x.kz');
  const other = make([{ ...drill, quantity: '7' }], 'other@x.kz');
  svc.respond(mine, 'chief@x.kz', 'accept');
  svc.respond(mine, 'a1@x.kz', 'accept');
  const v = svc.getRequestView(mine, 'reg@x.kz', false);
  svc.markItemDone(mine, v.items[0].id, 'reg@x.kz', '4');

  const own = svc.registry('reg@x.kz', false);
  assert.equal(own.scope, 'own');
  assert.deepEqual([...new Set(own.rows.map((r) => r.requestId))], [mine], 'автор видит только свои');
  assert.equal(own.rows.length, 2, 'по строке работ — отдельная строка реестра');
  const d = own.rows.find((r) => r.workType === 'drill');
  assert.equal(d.factQuantity, 4);
  assert.equal(d.company, 'Пром Альянс');
  assert.equal(own.rows.find((r) => r.workType === 'cut').doneAt, null);

  const admin = svc.registry('admin@vkdev.kz', true);
  assert.equal(admin.scope, 'all');
  assert.equal(admin.rows.some((r) => r.requestId === other), true, 'админ видит все');
  const chief = svc.registry('chief@x.kz', false);
  assert.equal(chief.scope, 'all');
  assert.equal(chief.rows.some((r) => r.requestId === other), true, 'главный инженер видит все: все проходят через него');

  const prom = svc.registry('a1@x.kz', false);
  assert.equal(prom.scope, 'company');
  assert.equal(prom.rows.some((r) => r.requestId === mine), true, 'исполнитель видит принятые его компанией');
  assert.equal(prom.rows.some((r) => r.requestId === other), false, 'заявка у главного инженера до него не дошла');
  const drl = svc.registry('s1@x.kz', false);
  assert.equal(drl.rows.some((r) => r.requestId === mine), false, 'бурильщик не видит принятую Пром Альянс');
  svc.respond(other, 'chief@x.kz', 'accept');
  assert.equal(svc.registry('a1@x.kz', false).rows.some((r) => r.requestId === other), false, 'ждущая ответа заявка — во «Входящих», а не в реестре');
  // заявка, отклонённая Пром Альянс и выполненная субподрядчиком, в реестре Пром Альянс не появляется
  svc.respond(other, 'a1@x.kz', 'reject', 'нет бригады');
  svc.respond(other, 's1@x.kz', 'accept');
  assert.equal(svc.registry('a1@x.kz', false).rows.some((r) => r.requestId === other), false, 'итоги не смешиваются с работами субподрядчика');
  assert.equal(svc.registry('s1@x.kz', false).rows.some((r) => r.requestId === other), true);
  assert.equal(svc.registry('stranger@x.kz', false).rows.length, 0, 'чужой не видит ничего');

  assert.ok(svc.registry('admin@vkdev.kz', true, { workType: 'cut' }).rows.every((r) => r.workType === 'cut'));
  assert.ok(svc.registry('admin@vkdev.kz', true, { status: ['accepted'] }).rows.every((r) => r.status === 'accepted'));
  assert.ok(svc.registry('admin@vkdev.kz', true, { company: 'Пром Альянс' }).rows.every((r) => r.company === 'Пром Альянс'));
  assert.equal(svc.registry('admin@vkdev.kz', true, { from: '2999-01-01' }).rows.length, 0);
  assert.ok(svc.registry('admin@vkdev.kz', true, { onlyMine: true }).rows.every((r) => r.authorEmail === 'admin@vkdev.kz'));
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

test('списки по ролям: «Все» — админу и главному инженеру, «Входящие» — исполнителям', () => {
  fails(() => svc.listRequests('init@x.kz', 'all', false), /Только для администратора и главного инженера/);
  assert.ok(svc.listRequests('chief@x.kz', 'all', false).length > 0);
  assert.ok(svc.listRequests('admin@vkdev.kz', 'all', true).length > 0);
  const id = approved([drill]);
  assert.equal(svc.listRequests('a1@x.kz', 'inbox', false).some((r) => r.id === id), true);
  assert.equal(svc.listRequests('s1@x.kz', 'inbox', false).some((r) => r.id === id), false);
});

test('выполнение: сразу несколько строк, комментарий, всё-или-ничего', () => {
  const id = approved([drill, cut, { ...drill, quantity: '2' }]);
  svc.respond(id, 'a1@x.kz', 'accept');
  const items = view(id).items;

  // одна строка с ошибкой — не записывается ничего
  fails(() => svc.markItemsDone(id, 'init@x.kz', [
    { itemId: items[0].id, factQuantity: '5' },
    { itemId: items[1].id, factQuantity: '99' },
  ]), /Строка 2: Не больше/);
  assert.equal(view(id).items.every((i) => !i.doneAt), true);

  svc.markItemsDone(id, 'init@x.kz', [
    { itemId: items[0].id, factQuantity: '3', comment: 'часть отверстий не пробили' },
    { itemId: items[1].id, factQuantity: '11,5' },
  ]);
  const v = view(id);
  assert.equal(v.status, 'accepted');
  assert.equal(v.items[0].factComment, 'часть отверстий не пробили');
  assert.equal(v.items[0].factQuantity, 3);
  fails(() => svc.markItemsDone(id, 'init@x.kz', [{ itemId: items[0].id, factQuantity: '1' }]), /уже отмечена/);
  fails(() => svc.markItemsDone(id, 'a1@x.kz', [{ itemId: items[2].id, factQuantity: '1' }]), /только её автор/);
  svc.markItemsDone(id, 'init@x.kz', [{ itemId: items[2].id, factQuantity: '2' }]);
  assert.equal(view(id).status, 'completed');
  assert.equal(svc.registry('init@x.kz', false).rows.find((r) => r.itemId === items[0].id).factComment, 'часть отверстий не пробили');
});

test('список: признак «ждёт вас» для действий прямо из списка', () => {
  const id = make([drill]);
  assert.equal(svc.listRequests('chief@x.kz', 'inbox', false).find((r) => r.id === id).waitingForMe, true);
  assert.equal(svc.listRequests('init@x.kz', 'mine', false).find((r) => r.id === id).waitingForMe, false);
  svc.respond(id, 'chief@x.kz', 'accept');
  assert.equal(svc.listRequests('a1@x.kz', 'inbox', false).find((r) => r.id === id).waitingForMe, true);
  assert.equal(svc.listRequests('chief@x.kz', 'all', false).find((r) => r.id === id).waitingForMe, false);
});

test('«поз.» не дублируется: «поз.56» остаётся «поз.56», «пятно I» → «поз. пятно I»', () => {
  const { positionLabel } = require('../validation');
  assert.equal(positionLabel('поз.56'), 'поз.56');
  assert.equal(positionLabel('Поз. 7'), 'Поз. 7');
  assert.equal(positionLabel('пятно I'), 'поз. пятно I');
  assert.equal(positionLabel('12'), 'поз. 12');
});

test('список: коротко показывает состав работ (чтобы не открывать каждую заявку)', () => {
  const id = make([drill, cut]);
  const row = svc.listRequests('init@x.kz', 'mine', false).find((r) => r.id === id);
  assert.deepEqual(row.works, ['Сверление Ø 100 мм — 5 шт, кирпич', 'Резка, толщина 20,5 см — 11,5 м.п., бетон']);
  assert.equal(row.itemsCount, 2);
});
