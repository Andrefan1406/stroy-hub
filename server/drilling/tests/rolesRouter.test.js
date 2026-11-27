// Роли и карточки людей (server/rides/usersRouter.js) и доступ к поездкам: настоящие
// auth.js и роутеры, подменён только Firebase (токен = email).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
process.env.CONCRETE_DATA_DIR = dir;
process.env.RIDES_DATA_DIR = path.join(dir, 'rides');

// Firebase: проверка токена — «токен и есть email»; список пользователей — как у главного админа.
const LISTED = ['chief1@x.kz', 'chief2@x.kz', 'dr@x.kz', 'prom@x.kz', 'emp@x.kz', 'staff@x.kz', 'disp@x.kz'];
const fbPath = require.resolve('firebase-admin/auth');
require.cache[fbPath] = {
  id: fbPath, filename: fbPath, loaded: true,
  exports: { getAuth: () => ({ verifyIdToken: async (t) => ({ email: t }), listUsers: async () => ({ users: LISTED.map((email) => ({ email })) }) }) },
};

const { initSchema } = require('../../db');
const rides = require('../../rides/db');
initSchema();
rides.initSchema();
const drilling = require('../service');
drilling.seedDefaults();

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/v1/users', require('../../rides/usersRouter'));
app.use('/api/v1/fleet-status', require('../../rides/fleetRouter'));
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
const call = async (email, method, url, body) => {
  const res = await fetch(base() + url, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${email}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const ADMIN = 'admin@vkdev.kz';
const put = (email, body) => call(ADMIN, 'PUT', `/api/v1/users/${email}`, body);
const SUB = 2;

test('карточка и роль — одной формой; обязательные поля по ролям', async () => {
  assert.equal((await put('emp@x.kz', { role: 'employee', name: '', phone: '+7 701 000 00 00' })).status, 400, 'ФИО нужно всем');
  assert.equal((await put('emp@x.kz', { role: 'employee', name: 'Иван' })).status, 400, 'телефон нужен роли поездок');
  assert.equal((await put('chief1@x.kz', { role: 'chief_engineer', name: 'Титаренко В.С.' })).status, 400, 'главному инженеру нужна должность');
  assert.equal((await put('dr@x.kz', { role: 'driller', name: 'Бур' })).status, 400, 'бурильщику нужна компания');
  assert.equal((await put('dr@x.kz', { role: 'driller', name: 'Бур', companyId: 1 })).status, 400, 'компания линии 1 не подходит');
  assert.equal((await put('dr@x.kz', { role: 'driller', name: 'Бур', companyId: 999 })).status, 400, 'несуществующая компания');

  const emp = await put('emp@x.kz', { role: 'employee', name: 'Иван', phone: '+7 701 000 00 00', fullSiteAccess: true });
  assert.equal(emp.status, 200, emp.body.error);
  assert.equal(emp.body.user.fullSiteAccess, true, 'для ролей поездок флаг выбирает админ');
  assert.equal(emp.body.user.position, '');
});

test('доступ ко всему сайту зашит в роли бурения: бурильщик заперт, остальные свободны', async () => {
  const dr = await put('dr@x.kz', { role: 'driller', name: 'Бур', companyId: SUB, fullSiteAccess: true });
  assert.equal(dr.status, 200, dr.body.error);
  assert.equal(dr.body.user.fullSiteAccess, false);
  assert.equal(dr.body.user.companyId, SUB);

  const prom = await put('prom@x.kz', { role: 'prom_alyans', name: 'Пром', fullSiteAccess: false });
  assert.equal(prom.body.user.fullSiteAccess, true);
  assert.equal(prom.body.user.companyId, null);
  const staff = await put('staff@x.kz', { role: 'staff', name: 'Сотрудник', position: 'Прораб', fullSiteAccess: false });
  assert.equal(staff.body.user.fullSiteAccess, true);
  assert.equal(staff.body.user.position, 'Прораб');

  // смена роли бурильщика на другую убирает привязку к компании
  const moved = await put('dr@x.kz', { role: 'staff', name: 'Бур', position: 'Инженер' });
  assert.equal(moved.body.user.companyId, null);
  await put('dr@x.kz', { role: 'driller', name: 'Бур', companyId: SUB });
});

test('главный инженер — только один', async () => {
  const first = await put('chief1@x.kz', { role: 'chief_engineer', name: 'Титаренко В.С.', position: 'Главный инженер' });
  assert.equal(first.status, 200, first.body.error);
  assert.equal(first.body.user.fullSiteAccess, true);
  const second = await put('chief2@x.kz', { role: 'chief_engineer', name: 'Другой', position: 'Главный инженер' });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /уже назначен Титаренко/);
  assert.equal((await put('chief1@x.kz', { role: 'chief_engineer', name: 'Титаренко В.С.', position: 'Главный инженер (ред.)' })).status, 200, 'правка карточки самого главного инженера');
  await put('chief1@x.kz', { role: 'staff', name: 'Титаренко В.С.' });
  assert.equal((await put('chief2@x.kz', { role: 'chief_engineer', name: 'Другой', position: 'Главный инженер' })).status, 200, 'после снятия роли можно назначить другого');
});

test('назначать роли может только главный админ; диспетчер карточки не правит, а читает людей поездок', async () => {
  await put('disp@x.kz', { role: 'dispatcher', name: 'Анна', phone: '+7 701 000 00 03' });
  assert.equal((await call('disp@x.kz', 'PUT', '/api/v1/users/emp@x.kz', { role: 'employee', name: 'Взлом', phone: '1' })).status, 403);
  assert.equal((await call('emp@x.kz', 'PUT', '/api/v1/users/emp@x.kz', { role: 'dispatcher', name: 'Я', phone: '1' })).status, 403);
  assert.equal((await call('disp@x.kz', 'PATCH', '/api/v1/users/emp@x.kz', { name: 'Новое', phone: '+7 701 111 11 11' })).status, 404, 'правка карточки диспетчером убрана');

  const list = await call('disp@x.kz', 'GET', '/api/v1/users');
  assert.equal(list.status, 200, list.body.error);
  const emails = list.body.users.map((u) => u.email);
  assert.ok(emails.includes('emp@x.kz') && emails.includes('disp@x.kz'));
  assert.ok(!emails.includes('prom@x.kz') && !emails.includes('dr@x.kz') && !emails.includes('staff@x.kz'), 'люди по бурению диспетчеру не показываются');
  assert.ok(list.body.users.every((u) => !('position' in u) && !('companyId' in u) && !('fullSiteAccess' in u)));

  const adminList = await call(ADMIN, 'GET', '/api/v1/users');
  assert.ok(adminList.body.users.find((u) => u.email === 'dr@x.kz').companyId === SUB);
});

test('новые роли не получают доступ к поездкам', async () => {
  assert.equal((await call('emp@x.kz', 'GET', '/api/v1/fleet-status')).status, 200);
  for (const email of ['staff@x.kz', 'prom@x.kz', 'dr@x.kz', 'chief2@x.kz']) {
    assert.equal((await call(email, 'GET', '/api/v1/fleet-status')).status, 403, `${email} не должен видеть транспорт`);
  }
  const me = await call('dr@x.kz', 'GET', '/api/v1/users/me');
  assert.equal(me.body.user.role, 'driller', 'а свою роль для гейта сайта видит');
});

test('директор Пром Альянс — только один, должность не обязательна', async () => {
  assert.equal((await put('prom@x.kz', { role: 'prom_director', name: 'Директор' })).status, 200);
  const second = await put('emp@x.kz', { role: 'prom_director', name: 'Другой', phone: '+7 701 000 00 09' });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /Директором Пром Альянс уже назначен/);
  assert.equal((await put('prom@x.kz', { role: 'prom_alyans', name: 'Директор' })).status, 200);
  assert.equal((await put('emp@x.kz', { role: 'prom_director', name: 'Другой' })).status, 200, 'после снятия роли можно назначить другого');
  await put('emp@x.kz', { role: 'staff', name: 'Другой' });
});
