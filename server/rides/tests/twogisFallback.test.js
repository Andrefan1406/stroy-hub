// Автоматический возврат на Nominatim, когда демо-ключ 2ГИС кончился (403/429),
// и обратно на 2ГИС после паузы. Пока 2ГИС на паузе, к нему не обращаемся.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RIDES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rides-2gis-fb-'));
process.env.TWOGIS_API_KEY = 'test-key';
const { initSchema } = require('../db');
initSchema();
const { lookupAddress, twogisStatus, twogisState } = require('../routeEstimate');
mock.method(console, 'warn', () => {});

let mode = 'ok'; // ok | quota | network
let twogisCalls = 0;
let nominatimCalls = 0;
mock.method(globalThis, 'fetch', async (url) => {
  const u = new URL(url);
  if (u.hostname.includes('2gis')) {
    twogisCalls++;
    if (mode === 'network') throw new Error('network');
    if (mode === 'quota') return { ok: false, status: 403, json: async () => ({ meta: { code: 403, error: { message: 'Forbidden' } } }) };
    return { ok: true, status: 200, json: async () => ({ meta: { code: 200 }, result: { items: [{ type: 'building', full_name: 'Усть-Каменогорск, Базовая улица, 3', address_name: 'Базовая улица, 3', point: { lat: 49.935, lon: 82.647 } }] } }) };
  }
  if (u.hostname.includes('nominatim')) {
    nominatimCalls++;
    return { ok: true, json: async () => [{ lat: '49.97', lon: '82.55', place_rank: 30, address: { road: 'Базовая улица', house_number: String(u.searchParams.get('q')).match(/\d+/)?.[0] } }] };
  }
  throw new Error('нет сети');
});

test('ключ работает — ответ 2ГИС', async () => {
  const r = await lookupAddress('Базовая 3');
  assert.equal(r.status, 'found');
  assert.equal(r.lat, 49.935);
  assert.equal(twogisStatus().active, true);
});

test('демо-ключ закончился (403): ответ берётся из Nominatim, 2ГИС уходит на паузу', async () => {
  mode = 'quota';
  twogisCalls = 0;
  const r = await lookupAddress('Базовая 5');
  assert.equal(r.status, 'found');
  assert.equal(r.lat, 49.97, 'координаты от Nominatim');
  assert.equal(twogisCalls, 1);
  assert.equal(twogisStatus().active, false);
  assert.match(twogisStatus().reason, /403/);
});

test('пока 2ГИС на паузе, новые адреса идут сразу в Nominatim — без обращений к 2ГИС', async () => {
  twogisCalls = 0;
  nominatimCalls = 0;
  assert.equal((await lookupAddress('Базовая 7')).status, 'found');
  assert.equal(twogisCalls, 0);
  assert.ok(nominatimCalls > 0);
});

test('адреса, найденные 2ГИС раньше, продолжают отдаваться из кэша во время паузы', async () => {
  twogisCalls = 0;
  const r = await lookupAddress('Базовая 3');
  assert.equal(r.lat, 49.935, 'ответ 2ГИС из кэша');
  assert.equal(twogisCalls, 0);
});

test('после паузы 2ГИС пробуется снова; новый ключ — возврат на 2ГИС', async () => {
  mode = 'ok';
  twogisState.blockedUntil = Date.now() - 1; // пауза истекла
  const r = await lookupAddress('Базовая 9');
  assert.equal(r.lat, 49.935, 'снова ответ 2ГИС');
  assert.equal(twogisStatus().active, true);
});

test('единичные сетевые сбои не отключают 2ГИС, три подряд — на 2 минуты', async () => {
  mode = 'network';
  twogisCalls = 0;
  await lookupAddress('Базовая 11');
  await lookupAddress('Базовая 12');
  assert.equal(twogisStatus().active, true, 'после двух сбоев ещё включён');
  await lookupAddress('Базовая 13');
  assert.equal(twogisStatus().active, false, 'после трёх — пауза');
  assert.equal(twogisCalls, 3);
  mode = 'ok';
});

test('ключ не задан — работает только Nominatim', async () => {
  delete process.env.TWOGIS_API_KEY;
  twogisCalls = 0;
  const r = await lookupAddress('Базовая 21');
  assert.equal(r.status, 'found');
  assert.equal(twogisCalls, 0);
  assert.equal(twogisStatus().enabled, false);
  process.env.TWOGIS_API_KEY = 'test-key';
});
