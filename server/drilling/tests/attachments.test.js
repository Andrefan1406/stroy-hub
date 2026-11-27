// Чертежи и фото к заявке на бурение (server/drilling/): загрузка телом запроса, проверка
// типа по содержимому, права, лимиты, удаление файла с диска. Настоящие роутер и auth.js,
// подменён только Firebase (токен = email).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drattach-'));
process.env.CONCRETE_DATA_DIR = dir;
process.env.RIDES_DATA_DIR = path.join(dir, 'rides');

const fbPath = require.resolve('firebase-admin/auth');
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { getAuth: () => ({ verifyIdToken: async (t) => ({ email: t }) }) } };

const { initSchema } = require('../../db');
const rides = require('../../rides/db');
initSchema();
rides.initSchema();
const svc = require('../service');
svc.seedDefaults();

function addUser(email, role, o = {}) {
  rides.getWriteDb().prepare('INSERT INTO users (email, name, phone, position, company_id, role, full_site_access) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(email, o.name || 'Тест', '', o.position || '', o.companyId || null, role);
}
addUser('chief@x.kz', 'chief_engineer', { name: 'Главный', position: 'Главный инженер' });
addUser('prom@x.kz', 'prom_alyans');
addUser('dir@x.kz', 'prom_director', { name: 'Директор', position: 'Директор' });
addUser('author@x.kz', 'staff', { name: 'Автор А.А.', position: 'Прораб' });
addUser('other@x.kz', 'staff', { name: 'Другой Д.Д.', position: 'Инженер' });

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/drilling', require('../router').router);
const server = app.listen(0);
after(() => server.close());
const url = (p) => `http://127.0.0.1:${server.address().port}/api/drilling${p}`;
const auth = (email) => ({ authorization: `Bearer ${email}` });

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(50, 4)]);

const upload = (email, id, name, body) => fetch(url(`/requests/${id}/attachments?name=${encodeURIComponent(name)}`), {
  method: 'POST', headers: { ...auth(email), 'content-type': 'application/octet-stream' }, body,
});
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
const drill = { object: 'Брик таун 2', position: 'пятно I', workType: 'drill', material: 'кирпич', diameterMm: '100', quantity: '5', reason: '' };
const make = (by = 'author@x.kz') => svc.createRequest(by, [drill], { dueDate: '2099-01-31' });
const filesIn = () => (fs.existsSync(path.join(dir, 'drilling-files')) ? fs.readdirSync(path.join(dir, 'drilling-files')) : []);

test('автор прикладывает PDF и картинки: тип по содержимому, имя с кириллицей сохраняется', async () => {
  const id = make();
  for (const [name, buf, mime] of [['Чертёж узла.pdf', PDF, 'application/pdf'], ['фото.jpg', JPG, 'image/jpeg'], ['схема.png', PNG, 'image/png'], ['снимок.webp', WEBP, 'image/webp']]) {
    const r = await json(await upload('author@x.kz', id, name, buf));
    assert.equal(r.status, 201, r.body.error);
    assert.equal(r.body.attachments.at(-1).name, name);
    assert.equal(r.body.attachments.at(-1).mime, mime);
  }
  const v = svc.getRequestView(id, 'author@x.kz', false);
  assert.equal(v.attachments.length, 4);
  assert.equal(v.permissions.attach, true);
  assert.equal(filesIn().length >= 4, true);
  assert.deepEqual(v.events.filter((e) => e.type === 'attached').map((e) => e.reason), ['Чертёж узла.pdf', 'фото.jpg', 'схема.png', 'снимок.webp']);
});

test('тип проверяется по содержимому: переименованный файл и пустой файл не принимаются', async () => {
  const id = make();
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 9)]);
  assert.equal((await upload('author@x.kz', id, 'чертёж.pdf', exe)).status, 415);
  assert.equal((await upload('author@x.kz', id, 'текст.png', Buffer.from('просто текст, не картинка'))).status, 415);
  assert.equal((await upload('author@x.kz', id, 'пусто.pdf', Buffer.alloc(0))).status, 400);
  assert.equal((await upload('author@x.kz', id, 'большой.pdf', Buffer.concat([PDF, Buffer.alloc(15 * 1024 * 1024)]))).status, 413);
  assert.equal(svc.getRequestView(id, 'author@x.kz', false).attachments.length, 0);
});

test('смотреть файл могут те, кто видит заявку; чужой — нет; содержимое и заголовки верные', async () => {
  const id = make();
  const att = (await json(await upload('author@x.kz', id, 'Чертёж 1.pdf', PDF))).body.attachments[0];
  const get = (email) => fetch(url(`/requests/${id}/attachments/${att.id}`), { headers: auth(email) });

  const mine = await get('author@x.kz');
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-type'), 'application/pdf');
  assert.equal(mine.headers.get('x-content-type-options'), 'nosniff');
  assert.match(mine.headers.get('content-disposition'), /^inline; filename\*=UTF-8''/);
  assert.match(decodeURIComponent(mine.headers.get('content-disposition')), /Чертёж 1\.pdf/);
  assert.deepEqual(Buffer.from(await mine.arrayBuffer()), PDF);

  assert.equal((await get('chief@x.kz')).status, 200, 'главный инженер видит все заявки');
  assert.equal((await get('other@x.kz')).status, 403, 'чужой не видит');
  assert.equal((await get('prom@x.kz')).status, 403, 'линия 1 заявку ещё не получила');
  svc.respond(id, 'chief@x.kz', 'accept'); svc.respond(id, 'dir@x.kz', 'accept');
  assert.equal((await get('prom@x.kz')).status, 200, 'после согласования исполнитель видит файлы');
});

test('менять файлы может только автор и только пока заявку не приняли', async () => {
  const id = make();
  const att = (await json(await upload('author@x.kz', id, 'a.pdf', PDF))).body.attachments[0];
  assert.equal((await upload('other@x.kz', id, 'x.pdf', PDF)).status, 403, 'чужой не добавляет');
  assert.equal((await upload('chief@x.kz', id, 'x.pdf', PDF)).status, 403, 'главный инженер не добавляет в чужую');
  const del = (email, aid) => fetch(url(`/requests/${id}/attachments/${aid}`), { method: 'DELETE', headers: auth(email) });
  assert.equal((await del('other@x.kz', att.id)).status, 403);

  svc.respond(id, 'chief@x.kz', 'accept'); svc.respond(id, 'dir@x.kz', 'accept');
  svc.respond(id, 'prom@x.kz', 'accept');
  assert.equal(svc.getRequestView(id, 'author@x.kz', false).permissions.attach, false);
  assert.equal((await upload('author@x.kz', id, 'поздно.pdf', PDF)).status, 409, 'принятая заявка — файлы не меняются');
  assert.equal((await del('author@x.kz', att.id)).status, 409);
});

test('возвращённую заявку автор может дополнить чертежом; удаление убирает файл с диска', async () => {
  const id = make();
  svc.respond(id, 'chief@x.kz', 'reject', 'нужен чертёж');
  assert.equal(svc.getRequestView(id, 'author@x.kz', false).status, 'returned');
  const r = await json(await upload('author@x.kz', id, 'исправленный.pdf', PDF));
  assert.equal(r.status, 201, r.body.error);
  const att = r.body.attachments[0];
  const before = filesIn().length;

  const del = await json(await fetch(url(`/requests/${id}/attachments/${att.id}`), { method: 'DELETE', headers: auth('author@x.kz') }));
  assert.equal(del.status, 200);
  assert.equal(del.body.attachments.length, 0);
  assert.equal(filesIn().length, before - 1, 'файл удалён с диска');
  assert.equal((await fetch(url(`/requests/${id}/attachments/${att.id}`), { headers: auth('author@x.kz') })).status, 404);
  assert.equal(svc.getRequestView(id, 'author@x.kz', false).events.some((e) => e.type === 'detached' && e.reason === 'исправленный.pdf'), true);
});

test('не больше 15 файлов на заявку; в списке видно число вложений', async () => {
  const id = make();
  for (let i = 0; i < 15; i += 1) assert.equal((await upload('author@x.kz', id, `ф${i}.png`, PNG)).status, 201);
  const extra = await json(await upload('author@x.kz', id, 'лишний.png', PNG));
  assert.equal(extra.status, 409);
  assert.match(extra.body.error, /не больше 15/);
  const listed = svc.listRequests('author@x.kz', 'mine', false).find((r) => r.id === id);
  assert.equal(listed.attachmentsCount, 15);
});
