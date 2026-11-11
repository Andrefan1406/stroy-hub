// Поиск адреса через 2ГИС (routeEstimate.lookupAddress при заданном TWOGIS_API_KEY):
// здание — «найден», улица/город — «street», нет — «not_found»; сервис не ответил —
// запасной Nominatim; повторный адрес — из кэша, без обращения к 2ГИС.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RIDES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rides-2gis-'));
process.env.TWOGIS_API_KEY = 'test-key';
const { initSchema } = require('../db');
initSchema();
const { lookupAddress } = require('../routeEstimate');

const bld = (name, addr, lat, lon, type = 'building') => ({ type, full_name: name, address_name: addr, point: { lat, lon } });
const TWOGIS = {
  'Усть-Каменогорск, Базовая 3': [bld('Усть-Каменогорск, Базовая улица, 3', 'Базовая улица, 3', 49.935, 82.647)],
  'Усть-Каменогорск, Штабы': [{ type: 'adm_div', full_name: 'Усть-Каменогорск', point: { lat: 49.948, lon: 82.628 } }],
  // дом с другим номером — рядом, но не точка для маршрута
  'Усть-Каменогорск, Протозанова 99': [bld('Усть-Каменогорск, улица Протозанова, 10', 'улица Протозанова, 10', 49.95, 82.61)],
  // та же улица в другом городе — вне рамки Усть-Каменогорска
  'Усть-Каменогорск, Крылова 5': [bld('Алматы, улица Крылова, 5', 'улица Крылова, 5', 43.2, 76.9)],
};
let calls = [];
let twogisDown = false;
const NOMINATIM = { 'Базовая 7': [{ lat: '49.97', lon: '82.55', place_rank: 30, address: { road: 'Базовая улица', house_number: '7' } }] };
mock.method(globalThis, 'fetch', async (url) => {
  const u = new URL(url);
  if (u.hostname.includes('2gis')) {
    calls.push(u.searchParams.get('q'));
    if (twogisDown) throw new Error('network');
    const items = TWOGIS[u.searchParams.get('q')];
    if (!items) return { ok: false, status: 404, json: async () => ({ meta: { code: 404, error: { message: 'Results not found' } } }) };
    return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, result: { items } }) };
  }
  if (u.hostname.includes('nominatim')) {
    calls.push(`nominatim:${u.searchParams.get('q')}`);
    return { ok: true, json: async () => NOMINATIM[u.searchParams.get('q')] || [] };
  }
  throw new Error('нет сети');
});

test('здание → found с координатами', async () => {
  assert.deepEqual(await lookupAddress('Базовая 3'), { status: 'found', lat: 49.935, lng: 82.647, matched: 'Усть-Каменогорск, Базовая улица, 3' });
});

test('повторный адрес — из кэша, 2ГИС не спрашиваем', async () => {
  calls = [];
  assert.equal((await lookupAddress('Базовая 3')).status, 'found');
  assert.deepEqual(calls, []);
});

test('«Штабы» — город, не здание: street (точку отметят на карте)', async () => {
  const r = await lookupAddress('Штабы');
  assert.equal(r.status, 'street');
  assert.equal(r.lat, 49.948);
});

test('дом с другим номером не принимается за точный адрес', async () => {
  assert.equal((await lookupAddress('Протозанова 99')).status, 'street');
});

test('результат вне города (та же улица в Алматы) отбрасывается', async () => {
  assert.deepEqual(await lookupAddress('Крылова 5'), { status: 'not_found' });
});

test('2ГИС ничего не нашёл → not_found', async () => {
  assert.deepEqual(await lookupAddress('Нигде'), { status: 'not_found' });
});

test('2ГИС недоступен → запасной Nominatim', async () => {
  twogisDown = true;
  calls = [];
  const r = await lookupAddress('Базовая 7');
  twogisDown = false;
  assert.equal(r.status, 'found');
  assert.ok(calls.some((c) => c.startsWith('nominatim:')));
});

test('запросов к 2ГИС на один адрес не больше двух', async () => {
  calls = [];
  await lookupAddress('Какой-то новый адрес');
  assert.ok(calls.filter((c) => !c.startsWith('nominatim:')).length <= 2);
});

test('название без номера дома («Штабы»): организация вместо штаба не принимается за точку', async () => {
  TWOGIS['Усть-Каменогорск, Штабы 2'] = [];
  TWOGIS['Усть-Каменогорск, Центральный офис'] = [{ type: 'attraction', full_name: 'Усть-Каменогорск, аэропорт', address_name: 'Аэропорт', point: { lat: 50.02, lon: 82.5 } }];
  const r = await lookupAddress('Центральный офис');
  assert.equal(r.status, 'street');
});

test('организация с номером дома, подтверждённым её адресом, — точка', async () => {
  TWOGIS['Усть-Каменогорск, Ленина 5'] = [{ type: 'attraction', full_name: 'Усть-Каменогорск, музей', address_name: 'улица Ленина, 5', point: { lat: 49.95, lon: 82.6 } }];
  assert.equal((await lookupAddress('Ленина 5')).status, 'found');
});
