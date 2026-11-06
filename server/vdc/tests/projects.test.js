const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandlers, docIdOf, serializeState, MAX_STATE_BYTES } = require('../projects');

// Хранилище в памяти вместо Firestore
function memoryStore() {
  const docs = new Map();
  return { docs, async get(id) { return docs.get(id) ?? null; }, async set(id, data) { docs.set(id, data); } };
}

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const KEY = 'АВ/24-11/187-1.6-АР';
const state = {
  version: 1,
  numPages: 26,
  sections: '1, 2',
  loggias: [{ key: '11|Лоджия (к=0,5)', k: '0,5' }],
  loggiasConfirmed: true,
  wallHeight: '2,72',
  calibrations: { 11: 0.0352778 },
  measureLines: { '1|1|plinth': [{ id: 'a', page: 11, kind: 'line', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }] },
  manualValues: { '1|3|plinth': '9,5' },
  лишнее: 'не сохраняется',
};

test('ключ проекта со слэшами и точками превращается в безопасный идентификатор документа', () => {
  const { key, id } = docIdOf(KEY);
  assert.equal(key, KEY);
  assert.ok(!id.includes('/'));
  assert.ok(!id.includes('.'));
  assert.equal(decodeURIComponent(id.replace(/%2E/g, '.')), KEY);
  assert.throws(() => docIdOf('   '), /Не указан проект/);
  assert.throws(() => docIdOf('x'.repeat(201)), /Слишком длинный/);
});

test('сохраняются только разрешённые поля; слишком большое состояние отклоняется', () => {
  const parsed = JSON.parse(serializeState(state));
  assert.equal(parsed.wallHeight, '2,72');
  assert.equal(parsed.лишнее, undefined);
  assert.throws(() => serializeState(null), /объектом/);
  assert.throws(() => serializeState([]), /объектом/);
  const huge = { measureLines: { a: [{ points: Array.from({ length: 60000 }, (_, i) => ({ x: i * 1.123456, y: i * 2.654321 })) }] } };
  assert.ok(JSON.stringify(huge).length > MAX_STATE_BYTES);
  assert.throws(() => serializeState(huge), (e) => e.status === 413);
});

test('сохранённый проект читается обратно целиком; у нового проекта found: false', async () => {
  const store = memoryStore();
  const h = createHandlers({ store, verify: async () => ({ email: 'a@vkdev.kz' }) });

  const none = mockRes();
  await h.getProject({ params: { key: KEY } }, none);
  assert.deepEqual(none.body, { found: false });

  const put = mockRes();
  await h.putProject({ params: { key: KEY }, body: { state }, userEmail: 'a@vkdev.kz' }, put);
  assert.equal(put.body.ok, true);
  assert.ok(put.body.updatedAt);

  const got = mockRes();
  await h.getProject({ params: { key: KEY } }, got);
  assert.equal(got.body.found, true);
  assert.equal(got.body.updatedBy, 'a@vkdev.kz');
  assert.deepEqual(got.body.state.measureLines, state.measureLines);
  assert.deepEqual(got.body.state.calibrations, { 11: 0.0352778 });
  assert.equal(got.body.state.лишнее, undefined);
});

test('повторное сохранение перезаписывает проект; разные проекты не смешиваются', async () => {
  const store = memoryStore();
  const h = createHandlers({ store, verify: async () => ({ email: 'a@vkdev.kz' }) });
  await h.putProject({ params: { key: KEY }, body: { state: { ...state, wallHeight: '2,72' } }, userEmail: 'a@vkdev.kz' }, mockRes());
  await h.putProject({ params: { key: KEY }, body: { state: { ...state, wallHeight: '2,8' } }, userEmail: 'b@vkdev.kz' }, mockRes());
  await h.putProject({ params: { key: 'АВ/24-11/187-1.7-АР' }, body: { state: { wallHeight: '3' } }, userEmail: 'a@vkdev.kz' }, mockRes());
  assert.equal(store.docs.size, 2);
  const got = mockRes();
  await h.getProject({ params: { key: KEY } }, got);
  assert.equal(got.body.state.wallHeight, '2,8');
  assert.equal(got.body.updatedBy, 'b@vkdev.kz');
});

test('неверное тело — 400, слишком большое — 413, без токена — 401', async () => {
  const h = createHandlers({ store: memoryStore(), verify: async () => ({ email: 'a@vkdev.kz' }) });
  const bad = mockRes();
  await h.putProject({ params: { key: KEY }, body: {}, userEmail: 'a@vkdev.kz' }, bad);
  assert.equal(bad.statusCode, 400);

  const noKey = mockRes();
  await h.getProject({ params: { key: '' } }, noKey);
  assert.equal(noKey.statusCode, 400);

  const noToken = mockRes();
  let nextCalled = false;
  await h.requireUser({ headers: {} }, noToken, () => { nextCalled = true; });
  assert.equal(noToken.statusCode, 401);
  assert.equal(nextCalled, false);

  const badToken = createHandlers({ store: memoryStore(), verify: async () => { throw new Error('bad'); } });
  const res = mockRes();
  await badToken.requireUser({ headers: { authorization: 'Bearer abc' } }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
});

test('токен проверяется, email пользователя попадает в запрос', async () => {
  const h = createHandlers({ store: memoryStore(), verify: async (t) => ({ email: `${t}@vkdev.kz` }) });
  const req = { headers: { authorization: 'Bearer ivan' } };
  let nextCalled = false;
  await h.requireUser(req, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.userEmail, 'ivan@vkdev.kz');
});

test('Firestore недоступен (нет ключа) — понятная ошибка 503, а не падение', async () => {
  const broken = { async get() { throw new Error('Could not load the default credentials'); }, async set() { throw new Error('Could not load the default credentials'); } };
  const h = createHandlers({ store: broken, verify: async () => ({ email: 'a@vkdev.kz' }) });
  const g = mockRes();
  await h.getProject({ params: { key: KEY } }, g);
  assert.equal(g.statusCode, 503);
  assert.match(g.body.error, /Хранилище недоступно/);
  const p = mockRes();
  await h.putProject({ params: { key: KEY }, body: { state }, userEmail: 'a@vkdev.kz' }, p);
  assert.equal(p.statusCode, 503);
});
