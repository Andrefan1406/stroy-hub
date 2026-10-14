// История поездок: фактические начало, окончание и длительность — по смене
// статусов («в пути» -> «завершена»); у попутной заявки начало — от основной.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople, insertRequest } = require('./helpers');

const { app, db } = setupRidesTestApp();
const { employeeId, driver1 } = seedPeople(db);
let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => server && server.close());

const status = (id, st, at) =>
  db.prepare('INSERT INTO request_status_history (request_id, status, changed_at) VALUES (?, ?, ?)').run(id, st, at);

test('начало, окончание и длительность в истории пассажира', async () => {
  await ready;
  const A = insertRequest(db, { employeeId, requestedAt: '2030-08-01T10:00', status: 'completed', driverId: driver1 });
  db.prepare("UPDATE requests SET comment = 'с чемоданом' WHERE id = ?").run(A);
  status(A, 'assigned', '2030-08-01 04:40:00');
  status(A, 'in_progress', '2030-08-01 05:02:00');
  status(A, 'completed', '2030-08-01 06:15:30');
  const B = insertRequest(db, { employeeId, requestedAt: '2030-08-01T10:10', status: 'completed', driverId: driver1 });
  db.prepare('UPDATE requests SET merged_into = ? WHERE id = ?').run(A, B);
  status(B, 'completed', '2030-08-01 06:15:30');
  const cancelled = insertRequest(db, { employeeId, requestedAt: '2030-08-02T10:00', status: 'cancelled' });

  const res = await call('employee@test', 'GET', '/api/v1/requests/mine');
  assert.equal(res.status, 200, res.body.error);
  const byId = Object.fromEntries(res.body.requests.map((r) => [r.id, r]));
  assert.equal(byId[A].startedAt, '2030-08-01 05:02:00');
  assert.equal(byId[A].finishedAt, '2030-08-01 06:15:30');
  assert.equal(byId[A].actualMinutes, 74);
  assert.equal(byId[A].comment, 'с чемоданом');
  assert.equal(byId[A].employeeName, 'employee@test');
  assert.equal(byId[B].startedAt, '2030-08-01 05:02:00', 'попутная — от начала основной');
  assert.equal(byId[B].actualMinutes, 74);
  assert.equal(byId[cancelled].startedAt, null);
  assert.equal(byId[cancelled].actualMinutes, null);
});
