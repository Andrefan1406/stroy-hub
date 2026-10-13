// Совместные поездки: объединение сразу, без согласования — водителем
// (к своей поездке) и диспетчером (к любой). Окно по времени: подача
// попутной заявки не раньше чем за 15 мин до подачи основной и не позже её
// окончания. Плюс отмена попутной заявки после объединения.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople, insertRequest } = require('./helpers');

const { app, db, emitted } = setupRidesTestApp();
const { employeeId, driver1, driver2 } = seedPeople(db);
const employee2 = db.prepare("INSERT INTO users (email, name, phone, role) VALUES ('employee2@test', 'Попутчик', '+7702', 'employee')").run().lastInsertRowid;
const { cascadeCompleteMergedB } = require('../mergeApply');

let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => server && server.close());

const row = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
const stopsOf = (id) => db.prepare('SELECT * FROM request_stops WHERE request_id = ? ORDER BY stop_order').all(id);
const events = (id, type) => db.prepare('SELECT * FROM request_events WHERE request_id = ? AND event_type = ?').all(id, type)
  .map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));

// Поездка водителя: подача 10:00, 60 мин -> окно для попутной 09:45..11:00.
const trip = (day, driverId = driver1) =>
  insertRequest(db, { employeeId, requestedAt: `2030-06-${day}T10:00`, status: 'assigned', driverId, durationMin: 60 });
const poolRequest = (day, time, emp = employee2) => insertRequest(db, { employeeId: emp, requestedAt: `2030-06-${day}T${time}` });

test('водитель «Подвезти попутно»: сразу объединено, заявка ушла из пула, журнал', async () => {
  await ready;
  const A = trip('03');
  const B = poolRequest('03', '10:15');
  db.prepare("UPDATE requests SET comment = 'с чемоданом' WHERE id = ?").run(B);
  emitted.length = 0;

  const res = await call('driver1@test', 'POST', `/api/v1/requests/${B}/merge`, { intoRequestId: A });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(row(B).merged_into, A);
  assert.equal(row(B).driver_id, driver1);
  assert.equal(row(B).status, 'assigned');
  assert.equal(row(B).assigned_by, 'self');
  assert.equal(row(B).merge_lock, 0, 'никакой блокировки «на согласовании»');
  assert.deepEqual(stopsOf(A).filter((s) => s.merged_from_request_id === B).map((s) => s.address), ['Базовая 3', 'Штабы']);

  const merge = db.prepare('SELECT * FROM request_merges WHERE request_b_id = ?').get(B);
  assert.equal(merge.status, 'approved');
  assert.equal(merge.initiator_role, 'driver');
  const [onA] = events(A, 'requests_merged');
  const [onB] = events(B, 'requests_merged');
  assert.equal(onA.payload.mergedRequestId, B);
  assert.equal(onA.payload.initiator, 'driver');
  assert.equal(onB.payload.mergedIntoRequestId, A);
  assert.ok(onA.actor_user_id, 'кто объединил');

  assert.ok(emitted.some((e) => e.to === 'drivers' && e.event === 'request:removed' && e.payload.id === B));
  assert.ok(emitted.some((e) => e.to === `employee:${employeeId}` && e.event === 'merge:applied'), 'пассажиру основной поездки');
  assert.ok(emitted.some((e) => e.to === `employee:${employee2}` && e.event === 'request:merged'), 'попутному пассажиру');
  assert.ok(emitted.some((e) => e.to === `driver:${driver1}` && e.event === 'merge:applied'), 'водителю');

  const claim = await call('driver2@test', 'POST', `/api/v1/requests/${B}/claim`);
  assert.equal(claim.status, 409, 'объединённую заявку уже не взять');
});

test('окно по времени: не раньше чем за 15 минут до подачи основной и не позже её окончания', async () => {
  await ready;
  const A = trip('04');
  const tooEarly = poolRequest('04', '09:30');
  const edge = poolRequest('04', '09:45');
  const tooLate = poolRequest('04', '11:15');
  const r1 = await call('driver1@test', 'POST', `/api/v1/requests/${tooEarly}/merge`, { intoRequestId: A });
  const r2 = await call('driver1@test', 'POST', `/api/v1/requests/${tooLate}/merge`, { intoRequestId: A });
  assert.equal(r1.status, 409);
  assert.match(r1.body.error, /не совпадает время/);
  assert.equal(r2.status, 409);
  assert.equal(row(tooEarly).merged_into, null);
  const r3 = await call('driver1@test', 'POST', `/api/v1/requests/${edge}/merge`, { intoRequestId: A });
  assert.equal(r3.status, 200, r3.body.error);
});

test('водитель не может добавить попутно к чужой поездке', async () => {
  await ready;
  const A = trip('05', driver2);
  const B = poolRequest('05', '10:00');
  const res = await call('driver1@test', 'POST', `/api/v1/requests/${B}/merge`, { intoRequestId: A });
  assert.equal(res.status, 409);
  assert.equal(row(B).status, 'pending_assignment');
});

test('диспетчер: подходящие поездки по близости, комментарий пассажира, прогноз и объединение', async () => {
  await ready;
  const near = trip('06', driver1); // 10:00
  const far = insertRequest(db, { employeeId, requestedAt: '2030-06-06T09:45', status: 'assigned', driverId: driver2, durationMin: 60 });
  const otherDay = trip('07', driver2);
  const B = poolRequest('06', '10:05');
  db.prepare("UPDATE requests SET comment = 'у шлагбаума' WHERE id = ?").run(B);

  const options = await call('dispatcher@test', 'GET', `/api/v1/requests/${B}/merge-options`);
  assert.equal(options.status, 200, options.body.error);
  assert.equal(options.body.request.comment, 'у шлагбаума');
  const ids = options.body.trips.map((t) => t.id);
  assert.deepEqual(ids, [near, far], 'ближайшая по времени — первой, поездки другого дня нет');
  assert.ok(!ids.includes(otherDay));

  const preview = await call('dispatcher@test', 'GET', `/api/v1/requests/${B}/merge-preview?into=${near}`);
  assert.equal(preview.status, 200, preview.body.error);
  // Заглушка маршрута — 10 мин на отрезок: A.from → A.to → B.from → B.to =
  // 30 мин против 10 без попутчика (+20); посадка B — через 20 мин после подачи 10:00.
  assert.equal(preview.body.deltaMin, 20);
  assert.equal(preview.body.pickupEtaAt, new Date('2030-06-06T10:20:00+05:00').toISOString());
  assert.equal(row(B).merged_into, null, 'прогноз ничего не меняет');

  const res = await call('dispatcher@test', 'POST', `/api/v1/requests/${B}/merge`, { intoRequestId: near });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(row(B).merged_into, near);
  assert.equal(row(B).assigned_by, 'dispatcher');
  assert.equal(db.prepare('SELECT initiator_role FROM request_merges WHERE request_b_id = ?').get(B).initiator_role, 'dispatcher');
  assert.equal(events(near, 'requests_merged')[0].payload.initiator, 'dispatcher');
});

test('пассажир отменил попутную заявку: её точки убраны из маршрута, при завершении поездки она не «завершается»', async () => {
  await ready;
  const A = trip('08');
  const B = poolRequest('08', '10:10');
  await call('driver1@test', 'POST', `/api/v1/requests/${B}/merge`, { intoRequestId: A });
  assert.equal(stopsOf(A).length, 2);

  const res = await call('employee2@test', 'POST', `/api/v1/requests/${B}/cancel-mine`, { reason: 'не нужно' });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(row(B).status, 'cancelled');
  assert.equal(row(B).merged_into, null);
  assert.equal(stopsOf(A).length, 0, 'водитель не поедет за отменившим');
  assert.equal(events(A, 'merged_request_cancelled').length, 1);

  db.transaction(() => cascadeCompleteMergedB(db, A, null))();
  assert.equal(row(B).status, 'cancelled');
});

test('согласования больше нет: старых эндпоинтов нет', async () => {
  await ready;
  const res = await fetch(`${server ? `http://127.0.0.1:${server.address().port}` : ''}/api/v1/requests/merges/pending`, {
    headers: { 'x-test-email': 'dispatcher@test' },
  });
  assert.equal(res.status, 404);
});
