// Защита боевого бота: локальный polling не снимает чужой вебхук, а сервер
// в режиме webhook сам восстанавливает снятый вебхук. Telegram API — заглушка.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const calls = [];
let webhookUrl = '';
const apiFile = require.resolve(path.join(__dirname, '..', 'telegram', 'api.js'));
require.cache[apiFile] = {
  id: apiFile, filename: apiFile, loaded: true,
  exports: {
    createApi: () => ({
      async call(method, params) {
        calls.push(method);
        if (method === 'getMe') return { username: 'test_bot' };
        if (method === 'getWebhookInfo') return { url: webhookUrl };
        if (method === 'setWebhook') webhookUrl = params.url;
        if (method === 'deleteWebhook') webhookUrl = '';
        if (method === 'getUpdates') return new Promise(() => {}); // висит, как long polling
        return true;
      },
    }),
  },
};
const { initTelegram } = require('../telegram');

const app = { post() {} };
const getDb = () => ({ prepare: () => ({ get: () => null, run: () => {}, all: () => [] }) });
const flush = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };

test('polling не перехватывает бота, у которого стоит вебхук', async () => {
  webhookUrl = 'https://prod.example.com/api/telegram/webhook';
  calls.length = 0;
  const err = mock.method(console, 'error', () => {});
  initTelegram({ app, getDb, env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_MODE: 'polling' } });
  await settle();
  err.mock.restore();
  assert.ok(!calls.includes('deleteWebhook'), 'вебхук не должен сниматься');
  assert.equal(webhookUrl, 'https://prod.example.com/api/telegram/webhook');
  assert.match(err.mock.calls.map((c) => c.arguments[0]).join('\n'), /Локальный polling не запущен/);
});

test('сервер в режиме webhook возвращает снятый вебхук', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  webhookUrl = '';
  calls.length = 0;
  const log = mock.method(console, 'log', () => {});
  const warn = mock.method(console, 'warn', () => {});
  initTelegram({ app, getDb, env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_WEBHOOK_SECRET: 's', PUBLIC_BASE_URL: 'https://prod.example.com/' } });
  await settle();
  assert.equal(webhookUrl, 'https://prod.example.com/api/telegram/webhook');
  webhookUrl = ''; // кто-то запустил polling с этим токеном
  mock.timers.tick(5 * 60 * 1000);
  await settle();
  assert.equal(webhookUrl, 'https://prod.example.com/api/telegram/webhook');
  assert.match(warn.mock.calls[0].arguments[0], /снят — восстановлен/);
  log.mock.restore();
  warn.mock.restore();
  mock.timers.reset();
});
