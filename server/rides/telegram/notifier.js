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
//
// Пассажиру и диспетчерам — по журналу событий заявки (events.js:
// requestEvents): туда пишется каждое действие, с какой бы стороны оно ни
// пришло, а socket-события для их страниц слишком общие («заявка
// обновилась»). Автору действия о нём самом не пишем.
//
// | событие журнала          | пассажиру                        | диспетчерам                  |
// |--------------------------|----------------------------------|------------------------------|
// | request_created          |                                  | новая заявка                 |
// | driver_claimed,          | водитель назначен (телефон,      |                              |
// | dispatcher_assigned      | машина)                          |                              |
// | status_changed           | машина в пути / поездка завершена|                              |
// | driver_declined          | ищем другого водителя            | водитель отказался + причина |
// | driver_unassigned        | ищем другого водителя            |                              |
// | reassigned               | машину сняли, нужно решение      |                              |
// | cancelled_by_dispatcher  | отменена + причина               |                              |
// | cancelled_by_employee    |                                  | заказчик отменил + причина   |
// | merge_proposed/approved/ | попутчик, совместная поездка     |                              |
// | dissolved                |                                  |                              |
//
// Плюс раз в минуту (checkStale): заявку никто не взял, а до подачи меньше
// порога подсветки на сайте — диспетчерам, один раз на заявку.
const { getRow, staleThreshold } = require('../requestView');
const { eventStillLogged } = require('../events');
const { requestedAtMs } = require('../slots');
const store = require('./store');
const fmt = require('./format');

// Заявки, подача которых прошла больше часа назад, предупреждением уже не
// спасти — их помечаем молча (иначе после простоя бота пришла бы пачка).
const STALE_IGNORE_AFTER_MIN = 60;

function createNotifier({ getDb, sender, apps = null }) {
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

  function driverName(db, driverId) {
    const row = driverId
      ? db.prepare('SELECT u.name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(driverId)
      : null;
    return row ? row.name : null;
  }

  function passengerMessage(event, row) {
    const p = event.payload || {};
    const text = fmt.passenger;
    switch (event.type) {
      case 'driver_claimed':
      case 'dispatcher_assigned':
        // Пока событие дошло, заказ могли уже снять или передать.
        return row.status === 'assigned' && row.driver_id === p.driverId ? [text.assigned(row)] : null;
      case 'status_changed':
        if (p.to === 'in_progress' && row.status === 'in_progress') return [text.inProgress(row)];
        if (p.to === 'completed' && row.status === 'completed') return [text.completed(row)];
        return null;
      case 'driver_declined':
        return row.status === 'pending_assignment' ? [text.searching(row, 'Водитель отказался от поездки')] : null;
      case 'driver_unassigned':
        return row.status === 'pending_assignment' ? [text.searching(row, 'Диспетчер снял водителя')] : null;
      case 'reassigned':
        return row.on_hold ? [text.pulled(row, p.reason), fmt.myRequestsKeyboard(apps)] : null;
      case 'cancelled_by_dispatcher':
        return [text.cancelled(row, p.reason)];
      case 'merge_proposed':
        return [text.mergeProposed(row), fmt.myRequestsKeyboard(apps)];
      case 'merge_approved':
        // Пишется и на A, и на B; пассажиру B — что он теперь в чужой поездке.
        return p.mergedIntoRequestId && row.merged_into ? [text.merged(row)] : null;
      case 'merge_dissolved':
        return [text.mergeDissolved(row, p.reason)];
      default:
        return null;
    }
  }

  function dispatcherMessage(db, event, row) {
    const p = event.payload || {};
    switch (event.type) {
      case 'request_created': {
        // Подача уже скоро — предупреждение «никто не взял» встроено сюда,
        // отдельным сообщением через минуту оно не придёт.
        const minutes = Math.round((requestedAtMs(row.requested_at) - Date.now()) / 60000);
        if (minutes <= staleThreshold()) {
          store.markStaleAlerted(db, row.id);
          return `${fmt.dispatcher.created(row)}\n⏰ До подачи ${Math.max(minutes, 0)} мин — водителя пока нет.`;
        }
        return fmt.dispatcher.created(row);
      }
      case 'driver_declined':
        return fmt.dispatcher.declined(row, driverName(db, p.driverId), p.reason);
      case 'cancelled_by_employee':
        return fmt.dispatcher.cancelledByEmployee(row, p.reason);
      default:
        return null;
    }
  }

  async function onRequestEvent(event) {
    const db = getDb();
    if (!eventStillLogged(db, event)) return; // транзакция откатилась
    const row = getRow(db, event.requestId);
    if (!row) return;

    const forPassenger = event.actorUserId === row.employee_id ? null : passengerMessage(event, row);
    const passengerChat = forPassenger ? store.chatForUser(db, row.employee_id) : null;
    if (passengerChat) await sender.send(passengerChat, forPassenger[0], forPassenger[1]);

    const forDispatchers = dispatcherMessage(db, event, row);
    if (forDispatchers) {
      for (const { chat_id: chatId, user_id: userId } of store.dispatcherChats(db)) {
        if (userId !== event.actorUserId) await sender.send(chatId, forDispatchers, fmt.panelKeyboard(apps));
      }
    }
  }

  async function checkStale(nowMs = Date.now()) {
    const db = getDb();
    const threshold = staleThreshold();
    for (const candidate of store.staleCandidates(db)) {
      const minutes = Math.round((requestedAtMs(candidate.requested_at) - nowMs) / 60000);
      if (minutes > threshold) continue;
      if (!store.markStaleAlerted(db, candidate.id)) continue;
      if (minutes < -STALE_IGNORE_AFTER_MIN) continue;
      const row = getRow(db, candidate.id);
      for (const { chat_id: chatId } of store.dispatcherChats(db)) {
        await sender.send(chatId, fmt.dispatcher.stale(row, minutes), fmt.panelKeyboard(apps));
      }
    }
  }

  function handleRequestEvent(event) {
    onRequestEvent(event).catch((err) => console.error('[telegram] уведомление не отправлено:', err.message));
  }

  function handle({ to, event, payload }) {
    let job = null;
    if (to === 'drivers' && event === 'request:new') job = broadcastPoolRequest(payload.id);
    else if (to === 'drivers' && event === 'request:removed') job = retractPoolRequest(payload.id);
    else if (to.startsWith('driver:')) job = notifyDriver(Number(to.slice('driver:'.length)), event, payload);
    if (job) job.catch((err) => console.error('[telegram] рассылка не удалась:', err.message));
  }

  return { handle, handleRequestEvent, onRequestEvent, checkStale, broadcastPoolRequest, retractPoolRequest };
}

module.exports = { createNotifier };
