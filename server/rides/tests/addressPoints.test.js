// Нераспознанный адрес — точка на карте обязательна: без неё заявку и новую
// точку маршрута не принимаем; с точкой — сохраняем её координаты (по ним
// и считается маршрут), текст адреса остаётся подписью.
const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople, insertRequest } = require('./helpers');

const { app, db } = setupRidesTestApp();
const { employeeId } = seedPeople(db);

// «ул. Базовая» — найдена только улица; «Склад у реки» — не найден вовсе.
globalThis.__unresolvedAddresses = {
  'ул. Базовая': { status: 'street', lat: 49.97, lng: 82.55 },
  'Склад у реки': { status: 'not_found' },
};

let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => { mock.timers.reset(); if (server) server.close(); });

const order = (body) => call('employee@test', 'POST', '/api/v1/requests', {
  fromAddress: 'Штабы', toAddress: 'ул. Базовая', requestedAt: '2030-06-04T10:00', purpose: 'тест', ...body,
});

test('адрес не найден точно — заявка не принимается и называет, что отметить на карте', async () => {
  await ready;
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-06-03T10:00:00+05:00') });
  const res = await order({ extraStops: ['Склад у реки'] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Отметьте на карте: «ул\. Базовая» \(назначение\), «Склад у реки» \(доп\. пункт 1\)/);
  assert.deepEqual(res.body.unresolved.map((u) => [u.index, u.status]), [[1, 'street'], [2, 'not_found']]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('с точками на карте — заявка принята, координаты сохранены, текст адреса как есть', async () => {
  const res = await order({
    toAddress: 'ул. Базовая, склад №2', toLat: 49.9712, toLng: 82.5531,
    extraStops: [{ address: 'Склад у реки', lat: 49.99, lng: 82.61 }],
  });
  // «ул. Базовая, склад №2» в справочнике не помечен — но точка задана, текст не ищется.
  assert.equal(res.status, 201, res.body.error);
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(res.body.request.id);
  assert.deepEqual([r.to_address, r.to_lat, r.to_lng], ['ул. Базовая, склад №2', 49.9712, 82.5531]);
  assert.deepEqual([r.from_lat, r.from_lng], [49.95, 82.6], 'подача найдена точно — координаты из поиска');
  const stop = db.prepare('SELECT address, lat, lng FROM request_stops WHERE request_id = ?').get(r.id);
  assert.deepEqual(stop, { address: 'Склад у реки', lat: 49.99, lng: 82.61 });
});

test('новая точка маршрута: без точки на карте — отказ, с точкой — принята', async () => {
  const id = insertRequest(db, { employeeId, requestedAt: '2030-06-04T12:00' });
  const bad = await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/stop-changes`, { action: 'add', address: 'ул. Базовая' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Отметьте на карте: «ул\. Базовая»/);
  const ok = await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/stop-changes`, { action: 'add', address: 'ул. Базовая', lat: 49.9712, lng: 82.5531 });
  assert.equal(ok.status, 201, ok.body.error);
  assert.deepEqual(db.prepare('SELECT address, lat, lng FROM request_stops WHERE request_id = ?').get(id), { address: 'ул. Базовая', lat: 49.9712, lng: 82.5531 });
});

test('проверка адреса для формы', async () => {
  assert.deepEqual((await call('employee@test', 'GET', '/api/v1/geocode/check?address=' + encodeURIComponent('ул. Базовая'))).body, { status: 'street', lat: 49.97, lng: 82.55 });
  assert.equal((await call('employee@test', 'GET', '/api/v1/geocode/check?address=Штабы')).body.status, 'found');
});
