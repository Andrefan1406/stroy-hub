// Telegram-бот для водителей: привязка, рассылка пула, взятие заказа,
// статусы, отказ, защита от повторной доставки. Telegram подменён
// поддельным API, которое записывает вызовы.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupRidesTestApp, seedPeople, insertRequest } = require('./helpers');

const { db } = setupRidesTestApp({ realSocket: true });
const { ridesBus, emitToDrivers } = require('../socket');
const { TelegramError } = require('../telegram/api');
const { createSender } = require('../telegram/sender');
const { createNotifier } = require('../telegram/notifier');
const { createBot } = require('../telegram/bot');
const store = require('../telegram/store');
const fmt = require('../telegram/format');

// --- поддельный Telegram ---
const calls = [];
const blockedChats = new Set();
let nextMessageId = 1;
const api = {
  async call(method, params) {
    calls.push({ method, params });
    if (blockedChats.has(params.chat_id)) throw new TelegramError(method, 403, 'Forbidden: bot was blocked by the user');
    return method === 'sendMessage' ? { message_id: nextMessageId++ } : true;
  },
};
const getDb = () => db;
const sender = createSender(api, getDb, { minGapMs: 0 });
const notifier = createNotifier({ getDb, sender });
ridesBus.on('message', notifier.handle);
const bot = createBot({ getDb, sender });

let updateId = 1;
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setImmediate(r));
    await sender.idle();
  }
};
const message = async (chatId, text) => {
  await bot.handleUpdate({ update_id: updateId++, message: { chat: { id: chatId, type: 'private' }, from: { username: `u${chatId}` }, text } });
  await settle();
};
const press = async (chatId, data, messageId = 999, id = updateId++) => {
  await bot.handleUpdate({ update_id: id, callback_query: { id: `cb${id}`, data, message: { chat: { id: chatId }, message_id: messageId } } });
  await settle();
};
const callsSince = (n) => calls.slice(n);
const sentTo = (since, chatId) => callsSince(since).filter((c) => c.method === 'sendMessage' && c.params.chat_id === chatId);
const answers = (since) => callsSince(since).filter((c) => c.method === 'answerCallbackQuery');
const row = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);

// Водители: 1 и 2 на линии, 3 не на линии. Чаты 101, 102, 103.
const { employeeId, drivers } = seedPeople(db, { driverStatuses: ['available', 'available', 'offline'] });
const [d1, d2, d3] = drivers;
const CHAT = { [d1]: 101, [d2]: 102, [d3]: 103 };
const userOf = (driverId) => db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(driverId).user_id;
const newPoolRequest = (requestedAt) => {
  const id = insertRequest(db, { employeeId, requestedAt });
  emitToDrivers('request:new', { id });
  return id;
};

test('привязка по одноразовой ссылке, повторно ссылка не работает', async () => {
  for (const driverId of drivers) {
    const { token } = store.createLinkToken(db, userOf(driverId));
    await message(CHAT[driverId], `/start ${token}`);
    assert.equal(store.getLinkByDriver(db, driverId)?.chat_id, CHAT[driverId]);
  }
  const { token } = store.createLinkToken(db, userOf(d1));
  await message(555, `/start ${token}`);
  const n = calls.length;
  await message(556, `/start ${token}`); // та же ссылка из другого чата
  assert.match(sentTo(n, 556)[0].params.text, /устарела или уже использована/);
  assert.equal(store.getChatContext(db, 556), null);
  // 555 перепривязал водителя 1 — возвращаем как было, чат 101.
  const again = store.createLinkToken(db, userOf(d1));
  await message(101, `/start ${again.token}`);
  assert.equal(store.getLinkByDriver(db, d1).chat_id, 101);
});

test('новая заявка приходит только водителям на линии и без телефона заказчика', async () => {
  const n = calls.length;
  const id = newPoolRequest('2030-05-06T10:00');
  await settle();
  const toD1 = sentTo(n, 101);
  assert.equal(toD1.length, 1);
  assert.equal(sentTo(n, 102).length, 1);
  assert.equal(sentTo(n, 103).length, 0, 'водитель не на линии рассылку не получает');
  assert.match(toD1[0].params.text, new RegExp(`Заявка №${id}`));
  assert.doesNotMatch(toD1[0].params.text, /\+7700|employee@test/, 'ни телефона, ни имени до взятия');
  assert.equal(toD1[0].params.reply_markup.inline_keyboard[0][0].callback_data, `claim:${id}`);
});

test('«Взять» в боте: заказ водителя, у остальных карточка исправлена, телефон — только взявшему', async () => {
  const id = newPoolRequest('2030-05-07T11:00');
  await settle();
  const msgD2 = store.takePoolMessages(db, id).find((m) => m.chat_id === 102);
  store.savePoolMessage(db, { requestId: id, chatId: 102, messageId: msgD2.message_id, driverId: d2 });
  store.savePoolMessage(db, { requestId: id, chatId: 101, messageId: 4242, driverId: d1 });

  const n = calls.length;
  await press(101, `claim:${id}`, 4242);
  assert.equal(row(id).driver_id, d1);
  assert.equal(row(id).status, 'assigned');
  assert.match(answers(n)[0].params.text, /Заказ ваш/);

  const edits = callsSince(n).filter((c) => c.method === 'editMessageText');
  assert.match(edits.find((e) => e.params.chat_id === 102).params.text, /уже взята другим водителем/);
  assert.match(edits.find((e) => e.params.chat_id === 101).params.text, /теперь ваша/);

  const card = sentTo(n, 101).find((c) => c.params.text.includes(`Заказ №${id}`));
  assert.ok(card, 'карточка заказа пришла взявшему');
  assert.match(card.params.text, /\+7700/);
  assert.equal(sentTo(n, 102).length, 0, 'второму водителю телефон не отправлялся');
});

test('второй водитель нажимает «Взять» на уже взятую заявку — отказ, заказ не меняется', async () => {
  const id = newPoolRequest('2030-05-08T12:00');
  await settle();
  await press(101, `claim:${id}`);
  const n = calls.length;
  await press(102, `claim:${id}`);
  const answer = answers(n)[0].params;
  assert.match(answer.text, /уже взят/);
  assert.equal(answer.show_alert, true);
  assert.equal(row(id).driver_id, d1);
});

test('повторная доставка того же нажатия не выполняется второй раз', async () => {
  const id = newPoolRequest('2030-05-09T13:00');
  await settle();
  await press(102, `claim:${id}`, 1, 9000);
  const n = calls.length;
  await press(102, `claim:${id}`, 1, 9000); // тот же update_id
  assert.equal(callsSince(n).length, 0);
  assert.equal(row(id).driver_id, d2);
});

test('«Выехал» и «Завершить» с подтверждением', async () => {
  const id = newPoolRequest('2030-05-10T14:00');
  await settle();
  await press(101, `claim:${id}`);
  await press(101, `go:${id}`);
  assert.equal(row(id).status, 'in_progress');
  await press(101, `done:${id}`);
  assert.equal(row(id).status, 'in_progress', 'без подтверждения не завершается');
  await press(101, `doneY:${id}`);
  assert.equal(row(id).status, 'completed');
});

test('отказ с причиной: заявка в пуле, причина записана, рассылка повторяется', async () => {
  const id = newPoolRequest('2030-05-11T15:00');
  await settle();
  await press(101, `claim:${id}`);
  const n = calls.length;
  await press(101, `rsn:${id}:1`);
  assert.equal(row(id).status, 'pending_assignment');
  assert.equal(row(id).driver_id, null);
  assert.equal(row(id).cancel_reason, fmt.DECLINE_REASONS[1]);
  assert.ok(sentTo(n, 102).some((c) => c.params.text.includes(`Заявка №${id}`)), 'заявка снова ушла водителям');
});

test('непривязанный чат ничего не может', async () => {
  const id = newPoolRequest('2030-05-12T09:00');
  await settle();
  const n = calls.length;
  await message(777, fmt.MENU.pool);
  assert.equal(sentTo(n, 777)[0].params.text, fmt.NOT_LINKED_TEXT);
  await press(777, `claim:${id}`);
  assert.equal(answers(n)[0].params.show_alert, true);
  assert.equal(row(id).status, 'pending_assignment');
});

test('водитель заблокировал бота — рассылка ему прекращается', async () => {
  blockedChats.add(102);
  newPoolRequest('2030-05-13T10:00');
  await settle();
  blockedChats.delete(102);
  assert.equal(db.prepare('SELECT blocked FROM telegram_user_links WHERE chat_id = 102').get().blocked, 1);
  const n = calls.length;
  newPoolRequest('2030-05-13T12:00');
  await settle();
  assert.equal(sentTo(n, 102).length, 0);
  assert.equal(sentTo(n, 101).length, 1);
});

test('«Уйти с линии» в боте — заявки перестают приходить; /stop отвязывает', async () => {
  await message(101, fmt.MENU.goOffline);
  assert.equal(db.prepare('SELECT status FROM drivers WHERE id = ?').get(d1).status, 'offline');
  const n = calls.length;
  newPoolRequest('2030-05-14T10:00');
  await settle();
  assert.equal(sentTo(n, 101).length, 0);

  await message(101, '/stop');
  assert.equal(store.getLinkByDriver(db, d1), null);
});
