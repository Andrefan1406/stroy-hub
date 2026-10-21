// Совместная поездка: пассажиров высаживают по одному («Высадил»), поездка
// завершается после высадки последнего. Раньше «Завершить» закрывало сразу
// всю поездку — водитель «освобождался», хотя ещё вёз попутчика.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople, insertRequest } = require('./helpers');

const { app, db, emitted } = setupRidesTestApp();
const { employeeId, driver1 } = seedPeople(db);
const employee2 = db.prepare("INSERT INTO users (email, name, phone, role) VALUES ('employee2@test', 'Попутчик', '+7702', 'employee')").run().lastInsertRowid;
const { getRow } = require('../requestView');
const fmt = require('../telegram/format');

let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => server && server.close());

const row = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
const events = (id, type) => db.prepare('SELECT * FROM request_events WHERE request_id = ? AND event_type = ?').all(id, type);

// Поездка водителя 1 в пути с попутной заявкой B.
async function sharedTrip(day) {
  const A = insertRequest(db, { employeeId, requestedAt: `2030-07-${day}T10:00`, status: 'assigned', driverId: driver1 });
  const B = insertRequest(db, { employeeId: employee2, requestedAt: `2030-07-${day}T10:10` });
  const merged = await call('driver1@test', 'POST', `/api/v1/requests/${B}/merge`, { intoRequestId: A });
  assert.equal(merged.status, 200, merged.body.error);
  const go = await call('driver1@test', 'POST', `/api/v1/requests/${A}/status`, { status: 'in_progress' });
  assert.equal(go.status, 200, go.body.error);
  return { A, B };
}

test('сначала высадили попутчика: закрыта только его заявка, поездка у водителя', async () => {
  await ready;
  const { A, B } = await sharedTrip('01');
  const res = await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: B });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.tripCompleted, false);
  assert.equal(row(B).status, 'completed');
  assert.equal(row(A).status, 'in_progress', 'заказчика A ещё везут');
  assert.equal(res.body.request.mergedRequests.find((m) => m.id === B).status, 'completed');

  const last = await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: A });
  assert.equal(last.status, 200, last.body.error);
  assert.equal(last.body.tripCompleted, true);
  assert.equal(row(A).status, 'completed');
  assert.equal(row(A).dropped_off_at, null, 'A высадили последней — обычное завершение');
});

test('сначала высадили заказчика: поездка в пути до высадки попутчика, затем завершается сама', async () => {
  await ready;
  const { A, B } = await sharedTrip('02');
  emitted.length = 0;
  const res = await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: A });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.tripCompleted, false);
  assert.equal(row(A).status, 'in_progress', 'водитель занят — везёт попутчика');
  assert.ok(row(A).dropped_off_at);
  assert.equal(row(B).status, 'assigned');
  assert.equal(events(A, 'passenger_dropped_off').length, 1);
  assert.ok(emitted.some((e) => e.to === `employee:${employeeId}` && e.event === 'request:status' && e.payload.droppedOffAt));

  const again = await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: A });
  assert.equal(again.status, 409);

  const last = await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: B });
  assert.equal(last.status, 200, last.body.error);
  assert.equal(last.body.tripCompleted, true);
  assert.equal(row(A).status, 'completed');
  assert.equal(row(B).status, 'completed');
});

test('окончание поездки заказчика A в истории — момент его высадки', async () => {
  await ready;
  const { A } = await sharedTrip('03');
  await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: A });
  db.prepare("UPDATE requests SET dropped_off_at = '2030-07-03 05:30:00' WHERE id = ?").run(A);
  assert.equal(getRow(db, A).timing.finishedAt, '2030-07-03 05:30:00');
});

test('«Завершить» при попутчике в машине не закрывает поездку — высажен только заказчик', async () => {
  await ready;
  const { A, B } = await sharedTrip('04');
  const res = await call('driver1@test', 'POST', `/api/v1/requests/${A}/status`, { status: 'completed' });
  assert.equal(res.status, 200, res.body.error);
  assert.match(res.body.notice, /попутные пассажиры/);
  assert.equal(row(A).status, 'in_progress');
  assert.ok(row(A).dropped_off_at);
  assert.equal(row(B).status, 'assigned', 'попутчик не «завершился» вместе с поездкой');

  const twice = await call('driver1@test', 'POST', `/api/v1/requests/${A}/status`, { status: 'completed' });
  assert.equal(twice.status, 409);
  assert.equal(row(B).status, 'assigned');
});

test('диспетчер отмечает высадку за водителя; чужой водитель — нельзя', async () => {
  await ready;
  const { A, B } = await sharedTrip('05');
  const foreign = await call('driver2@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: B });
  assert.equal(foreign.status, 404);
  assert.equal(row(B).status, 'assigned');

  const res = await call('dispatcher@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: B });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(row(B).status, 'completed');
  const [ev] = events(B, 'status_changed').map((e) => JSON.parse(e.payload_json)).filter((p) => p.to === 'completed');
  assert.equal(ev.viaDropOff, A);
});

test('до начала поездки высаживать нельзя', async () => {
  await ready;
  const A = insertRequest(db, { employeeId, requestedAt: '2030-07-06T10:00', status: 'assigned', driverId: driver1 });
  const B = insertRequest(db, { employeeId: employee2, requestedAt: '2030-07-06T10:10' });
  await call('driver1@test', 'POST', `/api/v1/requests/${B}/merge`, { intoRequestId: A });
  const res = await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: B });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /не начата/);
});

test('переброска машины после высадки попутчика: высаженный не возвращается в пул', async () => {
  await ready;
  const { A, B } = await sharedTrip('07');
  await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: B });
  const pull = await call('dispatcher@test', 'POST', `/api/v1/requests/${A}/pull`, { reason: 'срочный вызов' });
  assert.equal(pull.status, 200, pull.body.error);
  assert.equal(row(B).status, 'completed');
  assert.equal(row(B).merged_into, A);
});

test('Telegram: в совместной поездке «Высадил» на каждого пассажира вместо «Завершить»', async () => {
  await ready;
  const { A, B } = await sharedTrip('08');
  const buttons = (id) => fmt.orderKeyboard(getRow(db, id)).inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
  assert.deepEqual(buttons(A), [`drop:${A}:${A}`, `drop:${A}:${B}`]);
  await call('driver1@test', 'POST', `/api/v1/requests/${A}/drop-off`, { passengerId: A });
  assert.deepEqual(buttons(A), [`drop:${A}:${B}`]);
  assert.match(fmt.orderCardText(getRow(db, A)), /высажен/);

  const single = insertRequest(db, { employeeId, requestedAt: '2030-07-09T10:00', status: 'in_progress', driverId: driver1 });
  assert.deepEqual(buttons(single), [`done:${single}`], 'один пассажир — как раньше');
});
