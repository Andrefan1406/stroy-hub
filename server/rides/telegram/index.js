// Telegram-бот «VK Dev · Транспорт» — один на все роли: водителям пул и
// заказы, пассажирам уведомления и форма заявки (Mini App), диспетчерам
// уведомления и панель (Mini App). Включается переменными окружения; без
// TELEGRAM_BOT_TOKEN не запускается вовсе — сайт работает как раньше.
//
//   TELEGRAM_BOT_TOKEN       — токен от @BotFather
//   TELEGRAM_MODE            — webhook (по умолчанию, для хостинга) | polling (локальная проверка)
//   TELEGRAM_WEBHOOK_SECRET  — для webhook: случайная строка, Telegram присылает её в заголовке
//   PUBLIC_BASE_URL          — для webhook: внешний адрес сервера, например https://xxx.onrender.com
//   TELEGRAM_WEBAPP_URL      — адрес фронтенда (Netlify), например https://xxx.netlify.app;
//                              Mini App открывается по /tg. Только https. Не задан —
//                              кнопок Mini App нет, уведомления работают.
//
// Один токен нельзя одновременно использовать в webhook и polling: для
// локальной проверки заведите отдельного тестового бота.
//
// Защита от перехвата: polling снимает вебхук, и боевой бот на хостинге
// замолкает. Поэтому polling не запускается, если у токена уже стоит
// вебхук (значит, этот бот работает на сервере) — разве что явно
// TELEGRAM_FORCE_POLLING=1. А сервер в режиме webhook раз в 5 минут
// проверяет, что вебхук на месте, и ставит его обратно, если его сняли.
const { ridesBus, emitToDriver } = require('../socket');
const { requestEvents } = require('../events');
const { createApi } = require('./api');
const { createSender } = require('./sender');
const { createNotifier } = require('./notifier');
const { createBot } = require('./bot');
const store = require('./store');

const WEBHOOK_PATH = '/api/telegram/webhook';
// Команды по умолчанию — для ещё не подключённых чатов; подключённым
// ставятся команды их роли (bot.js: COMMANDS).
const DEFAULT_COMMANDS = [{ command: 'help', description: 'Как подключить бота' }];
const STALE_CHECK_MS = 60 * 1000;
const WEBHOOK_CHECK_MS = 5 * 60 * 1000;

const state = { enabled: false, username: null, webApp: false };

// Для сайта: подключён ли бот и как называется (ссылка привязки t.me/<имя>).
function telegramInfo() {
  return { enabled: state.enabled && !!state.username, username: state.username, webApp: state.enabled && state.webApp };
}

// Ссылки Mini App для кнопок бота. Параметр go — куда страница /tg
// отправит после входа (src/pages/rides/TelegramMiniApp.jsx).
function appLinks(env) {
  const base = (env.TELEGRAM_WEBAPP_URL || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) {
    if (base) console.error('[telegram] TELEGRAM_WEBAPP_URL должен начинаться с https:// — Mini App выключен');
    return null;
  }
  return { newRequest: `${base}/tg?go=new`, myRequests: `${base}/tg?go=my`, panel: `${base}/tg?go=panel` };
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
  const apps = appLinks(env);
  const api = createApi(token);
  const sender = createSender(api, getDb);
  const notifier = createNotifier({ getDb, sender, apps });
  const bot = createBot({
    getDb,
    sender,
    apps,
    // Привязали/отвязали в боте — кабинет водителя на сайте обновится сам
    // (страницы пассажира и диспетчера узнают это опросом, TelegramConnect.jsx).
    emitLinked: (userId) => {
      const db = getDb();
      const driver = db.prepare('SELECT id FROM drivers WHERE user_id = ?').get(userId);
      if (driver) emitToDriver(driver.id, 'driver:telegram', { linked: !!store.getLinkByUser(db, userId) });
    },
  });
  const subscribe = () => {
    ridesBus.on('message', notifier.handle);
    requestEvents.on('event', notifier.handleRequestEvent);
  };
  const unsubscribe = () => {
    ridesBus.off('message', notifier.handle);
    requestEvents.off('event', notifier.handleRequestEvent);
  };
  subscribe();
  state.enabled = true;
  state.webApp = !!apps;

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

  const webhookUrl = mode === 'webhook' ? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${WEBHOOK_PATH}` : null;
  const setWebhook = () => api.call('setWebhook', {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });

  (async () => {
    try {
      state.username = (await api.call('getMe')).username;
      if (mode === 'polling') {
        const info = await api.call('getWebhookInfo');
        if (info.url && env.TELEGRAM_FORCE_POLLING !== '1') {
          state.enabled = false;
          unsubscribe();
          console.error(`[telegram] у бота @${state.username} стоит вебхук (${info.url.replace(/^(https?:\/\/[^/]+).*/, '$1')}) — он работает на сервере. `
            + 'Локальный polling не запущен, чтобы не отключить его. Для проверки заведите тестового бота '
            + '(или TELEGRAM_FORCE_POLLING=1, если точно нужно перехватить).');
          return;
        }
      }
      await api.call('setMyCommands', { commands: DEFAULT_COMMANDS });
      if (mode === 'webhook') {
        await setWebhook();
      } else {
        await api.call('deleteWebhook', { drop_pending_updates: false });
        pollLoop(api, bot);
      }
      console.log(`[telegram] бот @${state.username} запущен (${mode})`);
    } catch (err) {
      state.enabled = false;
      unsubscribe(); // не слать в Telegram, который нас не пустил
      console.error('[telegram] запуск бота не удался:', err.message);
    }
  })();

  setInterval(() => {
    try { store.pruneOldUpdates(getDb()); } catch (err) { console.error('[telegram] очистка:', err.message); }
  }, 6 * 3600 * 1000).unref();

  // Вебхук сняли (например, кто-то запустил этот токен в polling) — вернуть.
  if (mode === 'webhook') {
    setInterval(async () => {
      if (!state.enabled) return;
      try {
        const info = await api.call('getWebhookInfo');
        if (info.url !== webhookUrl) {
          await setWebhook();
          console.warn(`[telegram] вебхук был ${info.url ? 'изменён' : 'снят'} — восстановлен`);
        }
      } catch (err) {
        console.error('[telegram] проверка вебхука:', err.message);
      }
    }, WEBHOOK_CHECK_MS).unref();
  }

  // «Заявку никто не взял, подача скоро» — диспетчерам.
  setInterval(() => {
    if (!state.enabled) return;
    notifier.checkStale().catch((err) => console.error('[telegram] проверка заявок без водителя:', err.message));
  }, STALE_CHECK_MS).unref();

  return { bot, notifier, sender };
}

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

module.exports = { initTelegram, telegramInfo, botToken, WEBHOOK_PATH };
