// Telegram-бот для пассажиров и диспетчеров: привязка и меню по роли,
// уведомления по журналу событий заявки, отмена своей заявки из бота,
// предупреждение «никто не взял». Telegram подменён поддельным API.
const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, listen, seedPeople, insertRequest } = require('./helpers');

const { app, db } = setupRidesTestApp({ realSocket: true });
const { requestEvents, logEvent } = require('../events');
const actions = require('../driverActions');
const { createSender } = require('../telegram/sender');
const { createNotifier } = require('../telegram/notifier');
const { createBot } = require('../telegram/bot');
const store = require('../telegram/store');
const fmt = require('../telegram/format');

// --- поддельный Telegram ---
const calls = [];
let nextMessageId = 1;
const api = {
  async call(method, params) {
    calls.push({ method, params });
    return method === 'sendMessage' ? { message_id: nextMessageId++ } : true;
  },
};
const getDb = () => db;
const apps = { newRequest: 'https://app.test/tg?go=new', myRequests: 'https://app.test/tg?go=my', panel: 'https://app.test/tg?go=panel' };
const sender = createSender(api, getDb, { minGapMs: 0 });
const notifier = createNotifier({ getDb, sender, apps });
requestEvents.on('event', notifier.handleRequestEvent);
const bot = createBot({ getDb, sender, apps });

// Дождаться, пока отложенные события журнала разошлись и очередь пуста.
const settle = async () => {
  let stable = 0;
  let last = -1;
  for (let i = 0; i < 100 && stable < 3; i++) {
    await new Promise((r) => setImmediate(r));
    await sender.idle();
    stable = calls.length === last ? stable + 1 : 0;
    last = calls.length;
  }
};
let updateId = 1;
const message = async (chatId, text) => {
  await bot.handleUpdate({ update_id: updateId++, message: { chat: { id: chatId, type: 'private' }, from: {}, text } });
  await settle();
};
const press = async (chatId, data, messageId = 999) => {
  const id = updateId++;
  await bot.handleUpdate({ update_id: id, callback_query: { id: `cb${id}`, data, message: { chat: { id: chatId }, message_id: messageId } } });
  await settle();
};
const sentTo = (since, chatId) =>
  calls.slice(since).filter((c) => c.method === 'sendMessage' && c.params.chat_id === chatId).map((c) => c.params);
const row = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);

const kz = (local) => Date.parse(`${local}:00+05:00`);
const at = (local) => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: kz(local) });
};

// Люди: пассажир (чат 201), диспетчер (чат 301), водитель без Telegram.
const { employeeId, drivers } = seedPeople(db, { driverStatuses: ['available'] });
const [driverId] = drivers;
const driverUserId = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(driverId).user_id;
const dispatcherId = db.prepare("SELECT id FROM users WHERE email = 'dispatcher@test'").get().id;
const PASSENGER = 201;
const DISPATCHER = 301;

let server;
let call;
const ready = listen(app).then((l) => { ({ server, call } = l); });
after(() => {
  mock.timers.reset();
  if (server) server.close();
});

const createRequest = async (requestedAt) => {
  const res = await call('employee@test', 'POST', '/api/v1/requests', { fromAddress: 'Базовая 3', toAddress: 'Штабы', requestedAt, purpose: 'тест' });
  assert.equal(res.status, 201, res.body.error);
  await settle();
  return res.body.request.id;
};

test('пассажир и диспетчер подключаются — меню и кнопка Mini App по роли', async () => {
  const n = calls.length;
  await message(PASSENGER, `/start ${store.createLinkToken(db, employeeId).token}`);
  await message(DISPATCHER, `/start ${store.createLinkToken(db, dispatcherId).token}`);

  const greetPassenger = sentTo(n, PASSENGER).at(-1);
  assert.match(greetPassenger.text, /Telegram подключён/);
  assert.deepEqual(greetPassenger.reply_markup.keyboard[0].map((b) => b.text), [fmt.MENU.newRequest, fmt.MENU.myRequests]);
  assert.equal(sentTo(n, DISPATCHER).at(-1).reply_markup.keyboard[0][0].text, fmt.MENU.panel);

  const menuButtons = calls.slice(n).filter((c) => c.method === 'setChatMenuButton');
  assert.equal(menuButtons.find((c) => c.params.chat_id === PASSENGER).params.menu_button.web_app.url, apps.newRequest);
  assert.equal(menuButtons.find((c) => c.params.chat_id === DISPATCHER).params.menu_button.web_app.url, apps.panel);
});

test('«Новая заявка» в боте — inline-кнопка Mini App (из нижнего меню initData не передаётся)', async () => {
  const n = calls.length;
  await message(PASSENGER, fmt.MENU.newRequest);
  const reply = sentTo(n, PASSENGER)[0];
  assert.equal(reply.reply_markup.inline_keyboard[0][0].web_app.url, apps.newRequest);
});

test('новая заявка: диспетчеру сообщение, самому заказчику — нет', async () => {
  await ready;
  at('2030-06-03T10:00');
  const n = calls.length;
  const id = await createRequest('2030-06-04T09:00');
  mock.timers.reset();
  const toDispatcher = sentTo(n, DISPATCHER);
  assert.equal(toDispatcher.length, 1);
  assert.match(toDispatcher[0].text, new RegExp(`Новая заявка №${id}`));
  assert.equal(toDispatcher[0].reply_markup.inline_keyboard[0][0].web_app.url, apps.panel);
  assert.equal(sentTo(n, PASSENGER).length, 0);
});

test('водитель взял, выехал, завершил — пассажиру три уведомления, телефон водителя после назначения', async () => {
  at('2030-06-03T10:00');
  const id = await createRequest('2030-06-05T09:00');
  mock.timers.reset();

  let n = calls.length;
  assert.ok(actions.claimRequest({ userId: driverUserId, requestId: id }).request);
  await settle();
  const assigned = sentTo(n, PASSENGER);
  assert.equal(assigned.length, 1);
  assert.match(assigned[0].text, /Водитель назначен/);
  assert.match(assigned[0].text, /\+7700/, 'телефон водителя');

  n = calls.length;
  await actions.changeRequestStatus({ userId: driverUserId, requestId: id, status: 'in_progress' });
  await settle();
  assert.match(sentTo(n, PASSENGER)[0].text, /Машина в пути/);

  n = calls.length;
  await actions.changeRequestStatus({ userId: driverUserId, requestId: id, status: 'completed' });
  await settle();
  assert.match(sentTo(n, PASSENGER)[0].text, /завершена/);
  assert.equal(sentTo(n, DISPATCHER).length, 0, 'обычный ход поездки диспетчера не отвлекает');
});

test('водитель отказался: пассажиру «ищем другого», диспетчеру — с причиной', async () => {
  at('2030-06-03T10:00');
  const id = await createRequest('2030-06-06T09:00');
  mock.timers.reset();
  actions.claimRequest({ userId: driverUserId, requestId: id });
  await settle();

  const n = calls.length;
  await actions.declineRequest({ userId: driverUserId, requestId: id, reason: 'Сломалась машина' });
  await settle();
  assert.match(sentTo(n, PASSENGER)[0].text, /Ищем другого водителя/);
  const toDispatcher = sentTo(n, DISPATCHER)[0].text;
  assert.match(toDispatcher, /Водитель отказался от заявки/);
  assert.match(toDispatcher, /Сломалась машина/);
});

test('пассажир отменяет свою заявку в боте: причина, диспетчеру сообщение', async () => {
  at('2030-06-03T10:00');
  const id = await createRequest('2030-06-07T09:00');
  mock.timers.reset();

  let n = calls.length;
  await message(PASSENGER, fmt.MENU.myRequests);
  const card = sentTo(n, PASSENGER).find((m) => m.text.includes(`Заявка №${id}`));
  assert.equal(card.reply_markup.inline_keyboard[0][0].callback_data, `ecan:${id}`);

  await press(PASSENGER, `ecan:${id}`);
  assert.equal(row(id).status, 'pending_assignment', 'без причины не отменяется');
  n = calls.length;
  await press(PASSENGER, `ecr:${id}:1`);
  assert.equal(row(id).status, 'cancelled');
  assert.equal(row(id).cancel_reason, fmt.EMPLOYEE_CANCEL_REASONS[1]);
  assert.match(sentTo(n, DISPATCHER)[0].text, /Заказчик отменил заявку/);
  assert.equal(sentTo(n, PASSENGER).length, 0, 'о своём действии не пишем');
});

test('чужую заявку отменить из бота нельзя; кнопки водителя пассажиру не работают', async () => {
  const otherId = insertRequest(db, { employeeId: dispatcherId, requestedAt: '2030-06-08T09:00' });
  const n = calls.length;
  await press(PASSENGER, `ecr:${otherId}:1`);
  assert.equal(row(otherId).status, 'pending_assignment');
  await press(PASSENGER, `claim:${otherId}`);
  assert.equal(row(otherId).driver_id, null);
  const alerts = calls.slice(n).filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params);
  assert.ok(alerts.every((a) => a.show_alert));
});

test('диспетчер отменил — пассажиру с причиной', async () => {
  at('2030-06-03T10:00');
  const id = await createRequest('2030-06-09T09:00');
  const n = calls.length;
  const res = await call('dispatcher@test', 'POST', `/api/v1/requests/${id}/cancel`, { reason: 'Машин нет' });
  mock.timers.reset();
  assert.equal(res.status, 200, res.body.error);
  await settle();
  const msg = sentTo(n, PASSENGER)[0].text;
  assert.match(msg, /отменена диспетчером/);
  assert.match(msg, /Машин нет/);
});

test('«никто не взял»: диспетчеру один раз, когда до подачи меньше порога', async () => {
  const id = insertRequest(db, { employeeId, requestedAt: '2030-06-10T09:00' });
  let n = calls.length;
  await notifier.checkStale(kz('2030-06-10T08:30'));
  await settle();
  assert.equal(sentTo(n, DISPATCHER).length, 0, 'за 30 минут ещё рано (порог 15)');

  await notifier.checkStale(kz('2030-06-10T08:50'));
  await settle();
  const alert = sentTo(n, DISPATCHER);
  assert.equal(alert.length, 1);
  assert.match(alert[0].text, new RegExp(`Заявку №${id} никто не взял`));

  n = calls.length;
  await notifier.checkStale(kz('2030-06-10T08:55'));
  await settle();
  assert.equal(sentTo(n, DISPATCHER).length, 0, 'повторно не шлём');
});

test('событие из откатившейся транзакции не рассылается', async () => {
  const id = insertRequest(db, { employeeId, requestedAt: '2030-06-11T09:00' });
  const n = calls.length;
  assert.throws(() => db.transaction(() => {
    logEvent(db, { requestId: id, type: 'cancelled_by_dispatcher', actorUserId: dispatcherId, payload: { reason: 'x' } });
    throw new Error('откат');
  })());
  await settle();
  assert.equal(sentTo(n, PASSENGER).length, 0);
});
