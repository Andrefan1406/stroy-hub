// Назначение/взятие заявки с учётом времени и снятие водителя без отмены
// заявки — через HTTP-эндпоинты requestsRouter.js / driversRouter.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople, insertRequest } = require('./helpers');

const { app, db, emitted } = setupRidesTestApp();
const { employeeId, driver1, driver2 } = seedPeople(db);
const row = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
const driverStatus = (id) => db.prepare('SELECT status FROM drivers WHERE id = ?').get(id).status;

let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => server && server.close());

test('водитель с заказом на 7-е 17:00 может взять заявку на 6-е', async () => {
  await ready;
  const on7th = insertRequest(db, { employeeId, requestedAt: '2030-02-07T17:00' });
  const on6th = insertRequest(db, { employeeId, requestedAt: '2030-02-06T10:00' });

  assert.equal((await call('driver1@test', 'POST', `/api/v1/requests/${on7th}/claim`)).status, 200);
  assert.equal(driverStatus(driver1), 'available', 'заказ на будущее не делает водителя «занятым» сейчас');

  const res = await call('driver1@test', 'POST', `/api/v1/requests/${on6th}/claim`);
  assert.equal(res.status, 200, res.body.error);
  assert.equal(row(on6th).driver_id, driver1);
});

test('пересечение по времени по-прежнему не даёт взять заявку', async () => {
  await ready;
  const first = insertRequest(db, { employeeId, requestedAt: '2030-02-10T09:00', durationMin: 90 });
  const overlapping = insertRequest(db, { employeeId, requestedAt: '2030-02-10T10:00' });
  assert.equal((await call('driver1@test', 'POST', `/api/v1/requests/${first}/claim`)).status, 200);

  const res = await call('driver1@test', 'POST', `/api/v1/requests/${overlapping}/claim`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, new RegExp(`#${first}`));
  assert.equal(row(overlapping).status, 'pending_assignment');
});

test('диспетчер назначает водителя на более раннюю дату, но не на пересекающееся время', async () => {
  await ready;
  const later = insertRequest(db, { employeeId, requestedAt: '2030-03-07T17:00', status: 'assigned', driverId: driver2 });
  const earlier = insertRequest(db, { employeeId, requestedAt: '2030-03-06T11:00' });
  const overlapping = insertRequest(db, { employeeId, requestedAt: '2030-03-07T17:15' });

  // В списке кандидатов на раннюю заявку водитель есть, на пересекающуюся — нет.
  const forEarlier = await call('dispatcher@test', 'GET', `/api/v1/drivers/available?requestId=${earlier}`);
  assert.ok(forEarlier.body.drivers.some((d) => d.id === driver2));
  const forOverlapping = await call('dispatcher@test', 'GET', `/api/v1/drivers/available?requestId=${overlapping}`);
  assert.ok(!forOverlapping.body.drivers.some((d) => d.id === driver2));

  const ok = await call('dispatcher@test', 'POST', `/api/v1/requests/${earlier}/assign`, { driverId: driver2 });
  assert.equal(ok.status, 200, ok.body.error);

  const blocked = await call('dispatcher@test', 'POST', `/api/v1/requests/${overlapping}/assign`, { driverId: driver2 });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, new RegExp(`#${later}`));
  assert.equal(row(overlapping).driver_id, null);
});

test('снятие водителя возвращает заявку в пул и не отменяет её', async () => {
  await ready;
  const id = insertRequest(db, { employeeId, requestedAt: '2030-04-01T12:00', status: 'assigned', driverId: driver1 });
  emitted.length = 0;

  const res = await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/unassign`, { reason: 'Перестановка' });
  assert.equal(res.status, 200, res.body.error);

  const after = row(id);
  assert.ok(after, 'заявка не удалена');
  assert.equal(after.status, 'pending_assignment');
  assert.equal(after.driver_id, null);
  assert.equal(after.on_hold, 0, 'сразу в общий пул, без ожидания решения заказчика');
  assert.equal(after.cancel_reason, null);

  const history = db.prepare('SELECT status FROM request_status_history WHERE request_id = ?').all(id).map((h) => h.status);
  assert.ok(!history.includes('cancelled'));
  const event = db.prepare("SELECT payload_json FROM request_events WHERE request_id = ? AND event_type = 'driver_unassigned'").get(id);
  assert.match(event.payload_json, /Перестановка/);

  // Водитель узнаёт, что заказ снят; заявка снова в пуле у водителей.
  assert.ok(emitted.some((e) => e.to === `driver:${driver1}` && e.event === 'request:pulled'));
  assert.ok(emitted.some((e) => e.to === 'drivers' && e.event === 'request:new' && e.payload.id === id));

  // Её можно сразу назначить заново.
  const again = await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/assign`, { driverId: driver2 });
  assert.equal(again.status, 200, again.body.error);
});

test('снять водителя с начатой поездки нельзя (для этого — переброска)', async () => {
  await ready;
  const id = insertRequest(db, { employeeId, requestedAt: '2030-04-02T12:00', status: 'in_progress', driverId: driver1 });
  const res = await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/unassign`, {});
  assert.equal(res.status, 409);
  assert.equal(row(id).status, 'in_progress');
});

test('отмена заявки по-прежнему отменяет её целиком', async () => {
  await ready;
  const id = insertRequest(db, { employeeId, requestedAt: '2030-04-03T12:00', status: 'assigned', driverId: driver1 });
  const res = await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/cancel`, { reason: 'Не нужна' });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(row(id).status, 'cancelled');
});
