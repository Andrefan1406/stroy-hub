// Справочник работ подсчёта объёмов: начальное наполнение, права (читать —
// любой вошедший, менять — только админ), версии норм, архив вместо удаления
// использованной работы. Авторизация в тестах — заголовок x-test-email.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { createTakeoffCatalog } = require('../takeoffCatalog');

const db = new Database(':memory:');
const auth = (allowed) => (req, res, next) => {
  const email = req.headers['x-test-email'];
  if (!email) return res.status(401).json({ error: 'Не передан токен авторизации' });
  if (allowed && !allowed.includes(email)) return res.status(403).json({ error: 'Доступ запрещён' });
  req.userEmail = email;
  next();
};
const ADMINS = ['admin@vkdev.kz', 'estimator@vkdev.kz'];
const catalog = createTakeoffCatalog({ getDb: () => db, requireUser: auth(null), requireAdmin: auth(ADMINS), adminEmails: ADMINS });
const app = express();
app.use(express.json());
app.use('/api/takeoff', catalog.userRouter);
app.use('/api/admin/takeoff', catalog.adminRouter);

let server;
const ready = new Promise((r) => { server = app.listen(0, r); });
after(() => server.close());
async function call(email, method, path, body) {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { ...(email ? { 'x-test-email': email } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('начальное наполнение: группа «Каменная кладка» и 5 работ; canEdit только у админов', async () => {
  const user = await call('worker@vkdev.kz', 'GET', '/api/takeoff/catalog');
  assert.equal(user.status, 200);
  assert.deepEqual(user.body.groups.map((g) => g.name), ['Каменная кладка']);
  assert.equal(user.body.works.length, 5);
  assert.equal(user.body.canEdit, false);
  const brick = user.body.works.find((w) => w.name.includes('250 мм'));
  assert.deepEqual([brick.unit, brick.method, brick.thickness, brick.materialRate, brick.countOpenings], ['м³', 'wall_length', 0.25, 305, true]);
  const shaft = user.body.works.find((w) => w.name === 'Кладка вентшахт');
  assert.deepEqual([shaft.method, shaft.countOpenings], ['rect_channels', false]);
  assert.equal((await call('estimator@vkdev.kz', 'GET', '/api/takeoff/catalog')).body.canEdit, true);
  assert.equal((await call(null, 'GET', '/api/takeoff/catalog')).status, 401);
});

test('менять справочник может только админ', async () => {
  assert.equal((await call('worker@vkdev.kz', 'POST', '/api/admin/takeoff/groups', { name: 'Хак' })).status, 403);
  assert.equal((await call('worker@vkdev.kz', 'PATCH', '/api/admin/takeoff/works/1', { materialRate: 1 })).status, 403);
  assert.equal((await call('worker@vkdev.kz', 'DELETE', '/api/admin/takeoff/works/1')).status, 403);
  const g = await call('admin@vkdev.kz', 'POST', '/api/admin/takeoff/groups', { name: 'Перегородки ГКЛ', sort: 20 });
  assert.equal(g.status, 201);
  const w = await call('admin@vkdev.kz', 'POST', '/api/admin/takeoff/works', {
    groupId: g.body.group.id, name: 'Перегородка ГКЛ 100 мм', unit: 'м²', method: 'wall_length', thickness: '0,1',
    materialName: 'Лист ГКЛ', materialUnit: 'м²', materialRate: '2,1', workPrice: 3500, countOpenings: true,
  });
  assert.equal(w.status, 201, w.body.error);
  assert.equal(w.body.work.thickness, 0.1);
  assert.equal(w.body.work.materialRate, 2.1);
  assert.equal(w.body.work.version, 1);
});

test('проверка полей работы', async () => {
  const bad = await call('admin@vkdev.kz', 'POST', '/api/admin/takeoff/works', { groupId: 999, name: '', unit: 'кг', method: 'x', materialName: 'Кирпич' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /наименование/);
  assert.match(bad.body.error, /группу/);
  assert.match(bad.body.error, /Единица/);
  assert.match(bad.body.error, /норму расхода/);
});

test('правка нормы повышает версию; только архив — нет', async () => {
  const works = (await call('worker@vkdev.kz', 'GET', '/api/takeoff/catalog')).body.works;
  const brick = works.find((w) => w.name.includes('250 мм'));
  const edited = await call('admin@vkdev.kz', 'PATCH', `/api/admin/takeoff/works/${brick.id}`, { materialRate: 310 });
  assert.equal(edited.body.work.version, brick.version + 1);
  assert.equal(edited.body.work.materialRate, 310);
  const archived = await call('admin@vkdev.kz', 'PATCH', `/api/admin/takeoff/works/${brick.id}`, { archived: true });
  assert.equal(archived.body.work.version, brick.version + 1);
  assert.equal(archived.body.work.archived, true);
});

test('использованная работа не удаляется, а уходит в архив; неиспользованная — удаляется', async () => {
  const works = (await call('worker@vkdev.kz', 'GET', '/api/takeoff/catalog')).body.works;
  const used = works.find((w) => w.name.includes('120 мм'));
  const unused = works.find((w) => w.name.includes('газоблока'));
  assert.equal((await call('worker@vkdev.kz', 'POST', `/api/takeoff/works/${used.id}/used`)).status, 200);
  const r1 = await call('admin@vkdev.kz', 'DELETE', `/api/admin/takeoff/works/${used.id}`);
  assert.deepEqual([r1.body.archived, r1.body.work.archived], [true, true]);
  const r2 = await call('admin@vkdev.kz', 'DELETE', `/api/admin/takeoff/works/${unused.id}`);
  assert.equal(r2.body.deleted, true);
  const after = (await call('worker@vkdev.kz', 'GET', '/api/takeoff/catalog')).body.works;
  assert.ok(after.some((w) => w.id === used.id));
  assert.ok(!after.some((w) => w.id === unused.id));
});

test('группу с работами удалить нельзя — только в архив', async () => {
  const group = (await call('worker@vkdev.kz', 'GET', '/api/takeoff/catalog')).body.groups.find((g) => g.name === 'Каменная кладка');
  assert.equal((await call('admin@vkdev.kz', 'DELETE', `/api/admin/takeoff/groups/${group.id}`)).status, 409);
  const r = await call('admin@vkdev.kz', 'PATCH', `/api/admin/takeoff/groups/${group.id}`, { archived: true });
  assert.equal(r.body.group.archived, true);
});

test('начальное наполнение не возвращается повторно', async () => {
  require('../takeoffCatalog').initCatalogSchema(db);
  const groups = db.prepare("SELECT COUNT(*) AS n FROM takeoff_work_groups WHERE name = 'Каменная кладка'").get();
  assert.equal(groups.n, 1);
});
