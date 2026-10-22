// Населённый пункт в адресе заявки: список (Усть-Каменогорск первым,
// остальные по алфавиту), проверка вписанного вручную (точное совпадение на
// карте, иначе — подсказки), улица ищется только внутри населённого пункта.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RIDES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rides-settlements-'));
const { initSchema } = require('../db');
initSchema();
const { lookupAddress } = require('../routeEstimate');
const { resolveSettlement, settlementOptions, splitSettlement } = require('../settlements');

const place = (name, type, lat, lon) => ({ category: 'place', type, name, lat: String(lat), lon: String(lon), boundingbox: [String(lat - 0.02), String(lat + 0.02), String(lon - 0.03), String(lon + 0.03)] });
// Поиск населённых пунктов (featureType=settlement) и адресов.
const SETTLEMENTS = {
  'ивановка': [place('Ивановка', 'village', 50.5, 82.0), { category: 'boundary', type: 'administrative', name: 'Ивановский округ' }],
  'ридер': [place('Риддер', 'city', 50.35, 83.52)],
  'зыряновск': [place('Алтай', 'town', 49.72, 84.27)],
};
const ADDRESSES = {
  'ул. Ленина, 5, Семей': [{ lat: '50.41', lon: '80.25', place_rank: 30 }],
  'ул. Мира, 1': [{ lat: '50.51', lon: '82.01', place_rank: 30 }], // в селе — без названия села
};
let calls = [];
mock.method(globalThis, 'fetch', async (url) => {
  const u = new URL(url);
  const q = u.searchParams.get('q');
  calls.push({ q, viewbox: u.searchParams.get('viewbox'), settlement: u.searchParams.get('featureType') === 'settlement' });
  const data = u.searchParams.get('featureType') === 'settlement' ? SETTLEMENTS[q] : ADDRESSES[q];
  return { ok: true, json: async () => data || [] };
});

test('список: Усть-Каменогорск первым, остальные по алфавиту', () => {
  assert.deepEqual(settlementOptions().map((s) => s.name), [
    'г. Усть-Каменогорск', 'г. Алтай', 'с. Глубокое', 'с. Горная Ульбинка', 'пос. Новая Бухтарма',
    'г. Риддер', 'г. Семей', 'г. Шемонаиха',
  ]);
});

test('из списка — без запроса к карте, с приставкой и без', async () => {
  calls = [];
  assert.equal((await resolveSettlement('г. Семей')).name, 'г. Семей');
  assert.equal((await resolveSettlement('семей')).name, 'г. Семей');
  assert.equal((await resolveSettlement('г.Усть-Каменогорск')).name, 'г. Усть-Каменогорск');
  assert.deepEqual(calls, []);
});

test('вписан вручную: точное совпадение на карте — найден, с приставкой по типу места', async () => {
  const r = await resolveSettlement('Ивановка');
  assert.equal(r.status, 'found');
  assert.equal(r.name, 'с. Ивановка');
  assert.equal(calls.at(-1).viewbox, '76.5,46.3,87.5,51.6', 'ищем только в ВКО и Абайской области');
});

test('опечатка или старое название — не найден, с подсказками', async () => {
  assert.deepEqual(await resolveSettlement('Ридер'), { status: 'not_found', suggestions: ['г. Риддер'] });
  assert.deepEqual(await resolveSettlement('Зыряновск'), { status: 'not_found', suggestions: ['г. Алтай'] });
  const typo = await resolveSettlement('Шимонаиха');
  assert.equal(typo.status, 'not_found');
  assert.deepEqual(typo.suggestions, ['г. Шемонаиха'], 'карта не нашла — похожее из списка');
});

test('улица ищется в границах выбранного населённого пункта', async () => {
  calls = [];
  assert.deepEqual(await lookupAddress('г. Семей, ул. Ленина, 5'), { status: 'found', lat: 50.41, lng: 80.25 });
  assert.deepEqual(calls, [{ q: 'ул. Ленина, 5, Семей', viewbox: '80.07,50.30,80.50,50.51', settlement: false }]);
});

test('в селе дом без привязки к селу — второй поиск без названия, в границах села', async () => {
  calls = [];
  assert.equal((await lookupAddress('с. Ивановка, ул. Мира, 1')).status, 'found');
  assert.deepEqual(calls.map((c) => c.q), ['ул. Мира, 1, Ивановка', 'ул. Мира, 1']);
  assert.ok(calls.every((c) => c.viewbox === calls[0].viewbox));
});

test('населённый пункт не найден — адрес тоже не найден (нужна точка на карте)', async () => {
  assert.deepEqual(await lookupAddress('с. Несуществующее, ул. Мира, 1'), { status: 'not_found' });
});

test('адрес без населённого пункта (старые заявки) — как раньше, в Усть-Каменогорске', async () => {
  assert.equal(await splitSettlement('ул. Базовая, склад №2'), null);
  calls = [];
  await lookupAddress('Протозанова 10');
  assert.deepEqual(calls, [{ q: 'Протозанова 10', viewbox: '82.20,49.70,83.05,50.20', settlement: false }]);
});
