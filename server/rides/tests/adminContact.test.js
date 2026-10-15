// Главный админ сам заполняет свои ФИО и телефон для водителя; без
// телефона заявку подать не может. Остальным карточку ведёт диспетчер.
const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople } = require('./helpers');

const { app, db } = setupRidesTestApp();
seedPeople(db);
db.prepare("INSERT INTO users (email, name, phone, role, full_site_access) VALUES ('admin@test', 'Администратор', '', 'admin', 1)").run();

let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => { mock.timers.reset(); if (server) server.close(); });

const order = () => call('admin@test', 'POST', '/api/v1/requests', { fromAddress: 'Базовая 3', toAddress: 'Штабы', requestedAt: '2030-06-04T10:00', purpose: 'тест' });

test('админ без телефона не может подать заявку; после «Мои данные» — может', async () => {
  await ready;
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-06-03T10:00:00+05:00') });
  const blocked = await order();
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /ФИО и телефон/);

  const bad = await call('admin@test', 'PATCH', '/api/v1/users/me', { name: 'Иванов Иван', phone: '123' });
  assert.equal(bad.status, 400);
  const saved = await call('admin@test', 'PATCH', '/api/v1/users/me', { name: 'Иванов Иван', phone: '+7 701 123 45 67' });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.user.phone, '+7 701 123 45 67');

  const ok = await order();
  mock.timers.reset();
  assert.equal(ok.status, 201, ok.body.error);
});

test('обычный пользователь свои ФИО и телефон не меняет — это делает диспетчер', async () => {
  await ready;
  const res = await call('employee@test', 'PATCH', '/api/v1/users/me', { name: 'Кто-то', phone: '+7 701 000 00 00' });
  assert.equal(res.status, 403);
});
