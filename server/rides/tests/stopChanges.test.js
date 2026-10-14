// Точки маршрута: пассажир предлагает точку — она применяется только после
// одобрения диспетчером (и в пуле, и с назначенным водителем); диспетчер
// меняет маршрут сразу; водитель маршрут не меняет.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople, insertRequest } = require('./helpers');

const { app, db, emitted } = setupRidesTestApp();
const { employeeId, driver1 } = seedPeople(db);

let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => server && server.close());

const stopsOf = (id) => db.prepare('SELECT address FROM request_stops WHERE request_id = ? ORDER BY stop_order').all(id).map((s) => s.address);
const eventTypes = (id) => db.prepare('SELECT event_type FROM request_events WHERE request_id = ? ORDER BY id').all(id).map((e) => e.event_type);

test('точка от пассажира — на согласование; после одобрения диспетчером — в маршруте, водителю событие', async () => {
  await ready;
  const id = insertRequest(db, { employeeId, requestedAt: '2030-07-01T10:00', status: 'assigned', driverId: driver1 });
  const res = await call('employee@test', 'POST', `/api/v1/requests/${id}/stop-changes`, { action: 'add', address: 'ЦОН, ул. Казахстан 40' });
  assert.equal(res.status, 201, res.body.error);
  assert.equal(res.body.proposal.status, 'pending');
  assert.deepEqual(stopsOf(id), [], 'пока диспетчер не одобрил — маршрут прежний');

  emitted.length = 0;
  const ok = await call('dispatcher@test', 'POST', `/api/v1/requests/stop-changes/${res.body.proposal.id}/approve`);
  assert.equal(ok.status, 200, ok.body.error);
  assert.deepEqual(stopsOf(id), ['ЦОН, ул. Казахстан 40']);
  assert.deepEqual(eventTypes(id).filter((t) => t.startsWith('stop_')), ['stop_proposed', 'stop_approved']);
  assert.ok(emitted.some((e) => e.to === `driver:${driver1}` && e.event === 'request:updated'), 'водитель видит новый маршрут');
});

test('и в заявке ещё в пуле точка от пассажира ждёт диспетчера; диспетчер добавляет сразу', async () => {
  await ready;
  const id = insertRequest(db, { employeeId, requestedAt: '2030-07-06T10:00' });
  const byPassenger = await call('employee@test', 'POST', `/api/v1/requests/${id}/stop-changes`, { action: 'add', address: 'А' });
  assert.equal(byPassenger.body.proposal.status, 'pending');
  const byDispatcher = await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/stop-changes`, { action: 'add', address: 'Б' });
  assert.equal(byDispatcher.body.proposal.status, 'approved');
  assert.deepEqual(stopsOf(id), ['Б']);
});

test('водитель точку добавить не может', async () => {
  await ready;
  const id = insertRequest(db, { employeeId, requestedAt: '2030-07-02T10:00', status: 'assigned', driverId: driver1 });
  const res = await call('driver1@test', 'POST', `/api/v1/requests/${id}/stop-changes`, { action: 'add', address: 'Где-то' });
  assert.equal(res.status, 403);
  assert.deepEqual(stopsOf(id), []);
});

test('чужую заявку пассажир не меняет; попутную — тоже (её маршрут в чужой поездке)', async () => {
  await ready;
  const other = db.prepare("INSERT INTO users (email, name, phone, role) VALUES ('other@test', 'Другой', '+7703', 'employee')").run().lastInsertRowid;
  const foreign = insertRequest(db, { employeeId: other, requestedAt: '2030-07-03T10:00' });
  const r1 = await call('employee@test', 'POST', `/api/v1/requests/${foreign}/stop-changes`, { action: 'add', address: 'X' });
  assert.equal(r1.status, 403);

  const carrier = insertRequest(db, { employeeId: other, requestedAt: '2030-07-04T10:00', status: 'assigned', driverId: driver1 });
  const merged = insertRequest(db, { employeeId, requestedAt: '2030-07-04T10:05', status: 'assigned', driverId: driver1 });
  db.prepare('UPDATE requests SET merged_into = ? WHERE id = ?').run(carrier, merged);
  const r2 = await call('employee@test', 'POST', `/api/v1/requests/${merged}/stop-changes`, { action: 'add', address: 'Y' });
  assert.equal(r2.status, 409);
  assert.match(r2.body.error, /попутно/);
});

test('правка точки в заказе с водителем — по-прежнему на согласование', async () => {
  await ready;
  const id = insertRequest(db, { employeeId, requestedAt: '2030-07-05T10:00', status: 'assigned', driverId: driver1 });
  await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/stop-changes`, { action: 'add', address: 'Старый адрес' });
  const stopId = db.prepare('SELECT id FROM request_stops WHERE request_id = ?').get(id).id;
  const res = await call('employee@test', 'POST', `/api/v1/requests/${id}/stop-changes`, { action: 'edit', targetStopId: stopId, address: 'Новый адрес' });
  assert.equal(res.status, 201, res.body.error);
  assert.equal(res.body.proposal.status, 'pending');
  assert.deepEqual(stopsOf(id), ['Старый адрес']);
});
