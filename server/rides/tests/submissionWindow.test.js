// Приём заявок только с 08:30 до 17:30 (время Казахстана); время подачи
// машины — любое в течение суток, но не в прошлом.
const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople } = require('./helpers');

const { app, db } = setupRidesTestApp();
seedPeople(db);
const { isSubmissionOpen } = require('../slots');

const kz = (localDateTime) => Date.parse(`${localDateTime}:00+05:00`);

let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => {
  mock.timers.reset();
  if (server) server.close();
});

const order = (requestedAt) =>
  call('employee@test', 'POST', '/api/v1/requests', { fromAddress: 'Базовая 3', toAddress: 'Штабы', requestedAt, purpose: 'тест' });
// «Сейчас» = заданное местное время (подменяется только Date).
const at = (localDateTime) => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: kz(localDateTime) });
};

test('окно приёма: с 08:30 включительно до 17:30 (17:30 — уже нельзя)', () => {
  assert.equal(isSubmissionOpen(kz('2030-06-03T08:29')), false);
  assert.equal(isSubmissionOpen(kz('2030-06-03T08:30')), true);
  assert.equal(isSubmissionOpen(kz('2030-06-03T17:29')), true);
  assert.equal(isSubmissionOpen(kz('2030-06-03T17:30')), false);
  assert.equal(isSubmissionOpen(kz('2030-06-03T23:00')), false);
});

test('вне окна заявку не принять — сообщение о часах приёма', async () => {
  await ready;
  at('2030-06-03T18:05');
  const res = await order('2030-06-04T10:00');
  mock.timers.reset();
  assert.equal(res.status, 403);
  assert.match(res.body.error, /с 08:30 до 17:30/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM requests').get().c, 0);
});

test('в окне можно заказать машину на любое время суток, кроме прошедшего', async () => {
  await ready;
  at('2030-06-03T10:07');
  const late = await order('2030-06-03T23:45');
  const night = await order('2030-06-04T02:00');
  const early = await order('2030-06-04T06:15');
  const past = await order('2030-06-03T10:00'); // текущий слот уже наступил
  mock.timers.reset();
  assert.equal(late.status, 201, late.body.error);
  assert.equal(night.status, 201, night.body.error);
  assert.equal(early.status, 201, early.body.error);
  assert.equal(past.status, 400);
  assert.match(past.body.error, /уже прошло/);
});

test('форма узнаёт о закрытом приёме из /requests/slots', async () => {
  await ready;
  at('2030-06-03T07:00');
  const closed = await call('employee@test', 'GET', '/api/v1/requests/slots?date=2030-06-03');
  at('2030-06-03T12:00');
  const open = await call('employee@test', 'GET', '/api/v1/requests/slots?date=2030-06-03');
  mock.timers.reset();
  assert.equal(closed.body.submission.open, false);
  assert.match(closed.body.submission.message, /с 08:30 до 17:30/);
  assert.equal(open.body.submission.open, true);
});
