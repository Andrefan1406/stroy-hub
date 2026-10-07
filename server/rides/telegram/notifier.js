// Рассылка в Telegram по событиям системы поездок. Подписан на внутреннюю
// шину (socket.js: ridesBus) — те же события, что получают страницы
// водителей через Socket.io, поэтому любая смена (на сайте, в боте, у
// диспетчера) доходит и до Telegram.
//
// | событие (кому)                  | что делает бот                                          |
// |---------------------------------|---------------------------------------------------------|
// | request:new (всем водителям)    | карточка заявки с «Взять» — водителям на линии          |
// | request:removed (всем)          | разосланные карточки: «уже взята / отменена ...»        |
// | request:assigned (водителю)     | карточка заказа с телефоном и кнопками                   |
// | request:pulled (водителю)       | «диспетчер снял с вас заказ» + причина                   |
// | request:updated (водителю)      | маршрут заказа изменился — обновлённая карточка          |
// | request:removed (водителю)      | его заказ отменили                                       |
const { getRow } = require('../requestView');
const store = require('./store');
const fmt = require('./format');

function createNotifier({ getDb, sender }) {
  async function broadcastPoolRequest(id) {
    const db = getDb();
    const row = getRow(db, id);
    if (!store.isInPool(row)) return;
    for (const { chat_id: chatId, driver_id: driverId } of store.onLineChats(db)) {
      if (store.hasPoolMessage(db, id, chatId)) continue; // уже висит у него в чате
      const msg = await sender.send(chatId, fmt.poolCardText(row), fmt.poolKeyboard(row));
      if (msg) store.savePoolMessage(db, { requestId: id, chatId, messageId: msg.message_id, driverId });
    }
  }

  async function retractPoolRequest(id) {
    const db = getDb();
    const row = getRow(db, id);
    // Заявку могли вернуть в пул той же цепочкой событий — тогда карточки
    // не трогаем (их «Взять» снова актуальна).
    if (store.isInPool(row)) return;
    for (const m of store.takePoolMessages(db, id)) {
      const mine = row && row.driver_id === m.driver_id && ['assigned', 'in_progress'].includes(row.status);
      const text = mine ? `✅ Заявка №${id} теперь ваша — карточка заказа ниже.` : fmt.unavailableText(id, row);
      await sender.edit(m.chat_id, m.message_id, text);
    }
  }

  async function notifyDriver(driverId, event, payload) {
    const db = getDb();
    const chatId = store.chatForDriver(db, driverId);
    if (!chatId) return;
    const row = payload?.id ? getRow(db, payload.id) : null;
    switch (event) {
      case 'request:assigned':
        if (row && row.driver_id === driverId && ['assigned', 'in_progress'].includes(row.status)) {
          await sender.send(chatId, fmt.orderCardText(row), fmt.orderKeyboard(row));
        }
        break;
      case 'request:pulled':
        await sender.send(
          chatId,
          `⚠️ Диспетчер снял с вас заказ №${payload.id}.${payload.reason ? `\nПричина: ${fmt.esc(payload.reason)}` : ''}`
        );
        break;
      case 'request:updated':
        if (row && row.driver_id === driverId && ['assigned', 'in_progress'].includes(row.status)) {
          await sender.send(chatId, `🔄 Маршрут заказа №${row.id} изменён.\n\n${fmt.orderCardText(row)}`, fmt.orderKeyboard(row));
        }
        break;
      case 'request:removed':
        if (row && row.status === 'cancelled') await sender.send(chatId, `❌ Заказ №${row.id} отменён.`);
        break;
      default:
        break; // статусы, объединения и т.п. — бот показывает сам по своим действиям / на сайте
    }
  }

  function handle({ to, event, payload }) {
    let job = null;
    if (to === 'drivers' && event === 'request:new') job = broadcastPoolRequest(payload.id);
    else if (to === 'drivers' && event === 'request:removed') job = retractPoolRequest(payload.id);
    else if (to.startsWith('driver:')) job = notifyDriver(Number(to.slice('driver:'.length)), event, payload);
    if (job) job.catch((err) => console.error('[telegram] рассылка не удалась:', err.message));
  }

  return { handle, broadcastPoolRequest, retractPoolRequest };
}

module.exports = { createNotifier };
