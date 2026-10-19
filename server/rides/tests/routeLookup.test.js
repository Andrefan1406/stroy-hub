// Поиск адреса (routeEstimate.lookupAddress) с подменённым Nominatim:
// дом/здание — «найден», только улица — «street», ничего — «not_found»,
// сервис не ответил — «unavailable»; маршрут считается по сохранённой точке,
// а не по тексту адреса.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RIDES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rides-lookup-'));
const { initSchema, getWriteDb } = require('../db');
initSchema();
const { lookupAddress, recomputeRequestEstimate } = require('../routeEstimate');

const NOMINATIM = {
  'Протозанова 10': [{ lat: '49.95', lon: '82.61', place_rank: 30 }],
  'ул. Базовая': [{ lat: '49.97', lon: '82.55', place_rank: 26 }],
  'Нигде': [],
};
let nominatimCalls = [];
let nominatimDown = false;
mock.method(globalThis, 'fetch', async (url) => {
  const u = new URL(url);
  if (u.hostname.includes('nominatim')) {
    nominatimCalls.push(u.searchParams.get('q'));
    if (nominatimDown) throw new Error('network');
    return { ok: true, json: async () => NOMINATIM[u.searchParams.get('q')] || [] };
  }
  throw new Error('OSRM недоступен'); // маршрут — по прямой
});

test('точность адреса: дом — найден, только улица — на карту, ничего — не найден', async () => {
  assert.deepEqual(await lookupAddress('Протозанова 10'), { status: 'found', lat: 49.95, lng: 82.61 });
  assert.deepEqual(await lookupAddress('ул. Базовая'), { status: 'street', lat: 49.97, lng: 82.55 });
  assert.deepEqual(await lookupAddress('Нигде'), { status: 'not_found' });
  nominatimCalls = [];
  assert.equal((await lookupAddress('ул. Базовая')).status, 'street');
  assert.deepEqual(nominatimCalls, [], 'повторно — из кэша');
});

test('сервис поиска не ответил — «unavailable» (точку нужно отметить на карте)', async () => {
  nominatimDown = true;
  assert.deepEqual(await lookupAddress('Совсем новый адрес'), { status: 'unavailable' });
  nominatimDown = false;
});

test('маршрут — по отмеченной точке, текст адреса не ищется', async () => {
  const db = getWriteDb();
  db.prepare("INSERT INTO users (email, name, phone, role) VALUES ('e@test', 'e', '1', 'employee')").run();
  const id = db.prepare(
    `INSERT INTO requests (employee_id, from_address, to_address, requested_at, purpose, status, from_lat, from_lng, to_lat, to_lng)
     VALUES (1, 'Протозанова 10', 'ул. Базовая, склад №2', '2030-06-04T10:00', 'т', 'pending_assignment', 49.95, 82.61, 49.9712, 82.5531)`
  ).run().lastInsertRowid;
  nominatimCalls = [];
  const est = await recomputeRequestEstimate(id);
  assert.deepEqual(nominatimCalls, [], 'обе точки известны — геокодер не нужен');
  assert.equal(est.distanceKm, 6.1); // 4,7 км по прямой × 1,3 на извилистость дорог
  const r = db.prepare('SELECT to_lat, to_lng FROM requests WHERE id = ?').get(id);
  assert.deepEqual(r, { to_lat: 49.9712, to_lng: 82.5531 }, 'точку с карты пересчёт не перезаписывает');
});
