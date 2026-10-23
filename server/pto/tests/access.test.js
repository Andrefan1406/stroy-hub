// Доступ к /api/pto/*: настоящий requirePto (проверка Firebase-токена по списку
// из access.js) с подменённым firebase-admin — токен «admin-token» принадлежит
// admin@vkdev.kz, «other-token» — обычному пользователю.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupPtoEnv, listen } = require('./helpers');

setupPtoEnv();

const authFile = require.resolve('firebase-admin/auth');
const TOKENS = { 'admin-token': 'admin@vkdev.kz', 'other-token': 'someone@vkdev.kz', 'upper-token': 'ADMIN@VKDEV.KZ' };
require.cache[authFile] = {
  id: authFile, filename: authFile, loaded: true,
  exports: {
    getAuth: () => ({
      verifyIdToken: async (t) => {
        if (!TOKENS[t]) throw new Error('bad token');
        return { email: TOKENS[t] };
      },
    }),
  },
};

const { createDefaultPtoRouter } = require('../router');
const { PTO_ALLOWED_EMAILS } = require('../access');

const app = express();
app.use(express.json());
app.use('/api/pto', createDefaultPtoRouter());
let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => server && server.close());

const auth = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
const ENDPOINTS = [
  ['GET', '/api/pto/sections'],
  ['GET', '/api/pto/documents'],
  ['GET', '/api/pto/documents/1'],
  ['GET', '/api/pto/documents/1/items'],
  ['GET', '/api/pto/documents/1/works'],
  ['GET', '/api/pto/documents/1/totals'],
  ['GET', '/api/pto/documents/1/export.xlsx'],
  ['GET', '/api/pto/material-prices'],
  ['PUT', '/api/pto/material-prices/steel', { price: 1 }],
  ['GET', '/api/pto/rates/search?q=x'],
  ['POST', '/api/pto/documents/1/confirm', {}],
  ['PATCH', '/api/pto/items/1', { quantity: 1 }],
  ['DELETE', '/api/pto/documents/1'],
];

test('доступ задан одним списком: только admin@vkdev.kz', () => {
  assert.deepEqual(PTO_ALLOWED_EMAILS, ['admin@vkdev.kz']);
});

test('без токена — 401, с токеном обычного пользователя — 403 на каждом эндпоинте', async () => {
  await ready;
  for (const [method, url, body] of ENDPOINTS) {
    const none = await call(method, url, body, auth(null));
    assert.equal(none.status, 401, `${method} ${url} без токена`);
    const other = await call(method, url, body, auth('other-token'));
    assert.equal(other.status, 403, `${method} ${url} для постороннего`);
  }
});

test('загрузка PDF тоже закрыта: посторонний получает 403 до чтения файла', async () => {
  await ready;
  const res = await call('POST', '/api/pto/documents?section=КЖ&object=x', Buffer.from('%PDF-1.4'), { raw: true, headers: { 'content-type': 'application/pdf', ...auth('other-token').headers } });
  assert.equal(res.status, 403);
});

test('admin@vkdev.kz проходит (регистр email не важен)', async () => {
  await ready;
  for (const token of ['admin-token', 'upper-token']) {
    const res = await call('GET', '/api/pto/sections', undefined, auth(token));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.sections.map((s) => s.code), ['КЖ']);
  }
});

test('модуль подключён в сервере по /api/pto (и больше нигде)', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  assert.match(src, /app\.use\('\/api\/pto', require\('\.\/pto\/router'\)\.createDefaultPtoRouter\(\)\)/);
});
