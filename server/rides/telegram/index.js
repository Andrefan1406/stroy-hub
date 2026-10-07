// Telegram-бот для водителей. Включается переменными окружения; без
// TELEGRAM_BOT_TOKEN не запускается вовсе — сайт работает как раньше.
//
//   TELEGRAM_BOT_TOKEN       — токен от @BotFather
//   TELEGRAM_MODE            — webhook (по умолчанию, для хостинга) | polling (локальная проверка)
//   TELEGRAM_WEBHOOK_SECRET  — для webhook: случайная строка, Telegram присылает её в заголовке
//   PUBLIC_BASE_URL          — для webhook: внешний адрес сервера, например https://xxx.onrender.com
//
// Один токен нельзя одновременно использовать в webhook и polling: для
// локальной проверки заведите отдельного тестового бота.
const { ridesBus, emitToDriver } = require('../socket');
const { createApi } = require('./api');
const { createSender } = require('./sender');
const { createNotifier } = require('./notifier');
const { createBot } = require('./bot');
const store = require('./store');

const WEBHOOK_PATH = '/api/telegram/webhook';
const COMMANDS = [
  { command: 'pool', description: 'Пул свободных заявок' },
  { command: 'my', description: 'Мои заказы' },
  { command: 'help', description: 'Как пользоваться ботом' },
  { command: 'stop', description: 'Отключить Telegram от кабинета' },
];

const state = { enabled: false, username: null };

// Для сайта: подключён ли бот и как называется (ссылка привязки t.me/<имя>).
function telegramInfo() {
  return { enabled: state.enabled && !!state.username, username: state.username };
}

async function pollLoop(api, bot) {
  let offset = 0;
  for (;;) {
    try {
      const updates = await api.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        await bot.handleUpdate(update).catch((err) => console.error('[telegram] обновление не обработано:', err.message));
      }
    } catch (err) {
      console.error('[telegram] getUpdates:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function initTelegram({ app, getDb, env = process.env }) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN не задан — бот выключен');
    return null;
  }
  const mode = env.TELEGRAM_MODE === 'polling' ? 'polling' : 'webhook';
  const api = createApi(token);
  const sender = createSender(api, getDb);
  const notifier = createNotifier({ getDb, sender });
  const bot = createBot({
    getDb,
    sender,
    // Привязали/отвязали в боте — кабинет водителя на сайте обновится сам.
    emitLinked: (driverId) => emitToDriver(driverId, 'driver:telegram', { linked: !!store.getLinkByDriver(getDb(), driverId) }),
  });
  ridesBus.on('message', notifier.handle);
  state.enabled = true;

  if (mode === 'webhook') {
    const secret = env.TELEGRAM_WEBHOOK_SECRET;
    const base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (!secret || !base) {
      console.error('[telegram] для webhook нужны TELEGRAM_WEBHOOK_SECRET и PUBLIC_BASE_URL — бот выключен');
      state.enabled = false;
      return null;
    }
    // Тело уже разобрано общим express.json() в server/index.js.
    app.post(WEBHOOK_PATH, (req, res) => {
      if (req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return res.sendStatus(401);
      res.sendStatus(200); // отвечаем сразу, обрабатываем следом — иначе Telegram повторит доставку
      bot.handleUpdate(req.body).catch((err) => console.error('[telegram] обновление не обработано:', err.message));
    });
  }

  (async () => {
    try {
      state.username = (await api.call('getMe')).username;
      await api.call('setMyCommands', { commands: COMMANDS });
      if (mode === 'webhook') {
        await api.call('setWebhook', {
          url: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query'],
        });
      } else {
        await api.call('deleteWebhook', { drop_pending_updates: false });
        pollLoop(api, bot);
      }
      console.log(`[telegram] бот @${state.username} запущен (${mode})`);
    } catch (err) {
      state.enabled = false;
      ridesBus.off('message', notifier.handle); // не слать в Telegram, который нас не пустил
      console.error('[telegram] запуск бота не удался:', err.message);
    }
  })();

  setInterval(() => {
    try { store.pruneOldUpdates(getDb()); } catch (err) { console.error('[telegram] очистка:', err.message); }
  }, 6 * 3600 * 1000).unref();

  return { bot, notifier, sender };
}

module.exports = { initTelegram, telegramInfo, WEBHOOK_PATH };
