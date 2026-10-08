// Вход в Telegram Mini App: проверка подписи initData, токен сессии,
// приём токена настоящим auth.js (без заглушек) и эндпоинт входа.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BOT_TOKEN = '123456:TEST-token';
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.RIDES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rides-webapp-test-'));

// Бот «запущен» — без сети к Telegram.
const telegramIndex = require.resolve('../telegram');
require.cache[telegramIndex] = {
  id: telegramIndex,
  filename: telegramIndex,
  loaded: true,
  exports: { telegramInfo: () => ({ enabled: true, username: 'test_bot', webApp: true }), botToken: () => BOT_TOKEN },
};

const { initSchema, getWriteDb } = require('../db');
initSchema();
const db = getWriteDb();
const { validateInitData, issueSession, verifySession } = require('../telegram/webappAuth');
const { decodeBearerToken } = require('../auth');
const store = require('../telegram/store');
const { listen } = require('./helpers');

// initData так, как его подписывает Telegram.
function signInitData(fields, token = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  const checkString = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(checkString).digest('hex'));
  return params.toString();
}
const nowSec = () => Math.floor(Date.now() / 1000);
const initDataFor = (telegramUserId, extra = {}) =>
  signInitData({ auth_date: String(nowSec()), query_id: 'q1', user: JSON.stringify({ id: telegramUserId, first_name: 'Тест' }), ...extra });

const userId = db.prepare("INSERT INTO users (email, name, phone, role) VALUES ('passenger@test', 'Пассажир', '+7701', 'employee')").run().lastInsertRowid;
const TG_ID = 777001;
db.prepare('INSERT INTO telegram_user_links (user_id, chat_id) VALUES (?, ?)').run(userId, TG_ID);

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/v1/telegram', require('../telegramRouter'));
let server;
let base;
const ready = listen(app).then((l) => { server = l.server; base = `http://127.0.0.1:${server.address().port}`; });
after(() => server && server.close());
const post = async (url, body) => {
  const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('подпись initData: верная принимается, подделка и чужой токен — нет', () => {
  const good = initDataFor(TG_ID);
  assert.equal(validateInitData(good, BOT_TOKEN).telegramUserId, TG_ID);

  const forged = good.replace(encodeURIComponent(`"id":${TG_ID}`), encodeURIComponent('"id":1'));
  assert.notEqual(forged, good);
  assert.equal(validateInitData(forged, BOT_TOKEN), null, 'подменили пользователя');
  assert.equal(validateInitData(signInitData({ auth_date: String(nowSec()), user: JSON.stringify({ id: TG_ID }) }, '999:other'), BOT_TOKEN), null);
});

test('initData с полем signature и устаревший initData', () => {
  const withSignature = signInitData({ auth_date: String(nowSec()), user: JSON.stringify({ id: TG_ID }), signature: 'abc' });
  assert.equal(validateInitData(withSignature, BOT_TOKEN).telegramUserId, TG_ID);
  const old = signInitData({ auth_date: String(nowSec() - 2 * 86400), user: JSON.stringify({ id: TG_ID }) });
  assert.equal(validateInitData(old, BOT_TOKEN), null);
});

test('токен сессии: подпись, срок, смена токена бота', () => {
  const { token } = issueSession(userId, BOT_TOKEN);
  assert.equal(verifySession(token, BOT_TOKEN), userId);
  assert.equal(verifySession(token, '999:other'), null, 'сменили токен бота — сессии недействительны');
  assert.equal(verifySession(token, BOT_TOKEN, Date.now() + 13 * 3600 * 1000), null, 'истёк');
  const [body, sig] = token.slice(3).split('.');
  const otherBody = Buffer.from(JSON.stringify({ uid: 999, exp: Date.now() + 3600e3 })).toString('base64url');
  assert.equal(verifySession(`tg.${otherBody}.${sig}`, BOT_TOKEN), null, 'подменили пользователя');
  assert.ok(body);
});

test('вход в Mini App: привязанный Telegram получает сессию, auth.js её принимает', async () => {
  await ready;
  const res = await post('/api/v1/telegram/webapp-session', { initData: initDataFor(TG_ID) });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.user.role, 'employee');
  const decoded = await decodeBearerToken(res.body.token);
  assert.equal(decoded.email, 'passenger@test');
  await assert.rejects(decodeBearerToken(res.body.token, { allowTelegram: false }), 'управление ролями — только с Firebase-логином');

  store.unlinkUser(db, userId);
  await assert.rejects(decodeBearerToken(res.body.token), 'отвязали Telegram — сессия мертва сразу');
  db.prepare('INSERT INTO telegram_user_links (user_id, chat_id) VALUES (?, ?)').run(userId, TG_ID);
});

test('вход в Mini App: неподключённый Telegram и подделка — отказ', async () => {
  await ready;
  const stranger = await post('/api/v1/telegram/webapp-session', { initData: initDataFor(555) });
  assert.equal(stranger.status, 403);
  assert.match(stranger.body.error, /Подключить Telegram/);
  const forged = await post('/api/v1/telegram/webapp-session', { initData: initDataFor(TG_ID).replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`) });
  assert.equal(forged.status, 401);
});
