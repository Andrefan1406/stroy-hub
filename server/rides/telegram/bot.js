// Обработка входящих обновлений Telegram: сообщения (команды и кнопки меню)
// и нажатия inline-кнопок под карточками. Все действия над заявками — через
// driverActions.js, тот же код, что у сайта; бот только переводит нажатия в
// вызовы и показывает результат.
//
// Личность — только chat_id из привязки (telegram_links). Данным из кнопки
// (действие и номер заявки) без проверки не доверяем: каждое действие
// заново проверяет водителя и заявку на сервере.
const store = require('./store');
const fmt = require('./format');
const { getRow } = require('../requestView');
const actions = require('../driverActions');

function createBot({ getDb, sender, emitLinked = () => {} }) {
  async function sendMenu(chatId, driverStatus, text) {
    await sender.send(chatId, text, fmt.mainMenu(driverStatus));
  }

  async function sendPool(ctx) {
    const db = getDb();
    const { requests, total } = store.poolRequests(db);
    if (!requests.length) return sender.send(ctx.chat_id, 'Сейчас в пуле нет свободных заявок.');
    for (const row of requests) {
      const msg = await sender.send(ctx.chat_id, fmt.poolCardText(row), fmt.poolKeyboard(row));
      if (msg) store.savePoolMessage(db, { requestId: row.id, chatId: ctx.chat_id, messageId: msg.message_id, driverId: ctx.driver_id });
    }
    if (total > requests.length) {
      await sender.send(ctx.chat_id, `Показаны ближайшие ${requests.length} из ${total}. Остальные — на сайте в кабинете водителя.`);
    }
    return null;
  }

  async function sendOrders(ctx) {
    const orders = store.driverOrders(getDb(), ctx.driver_id);
    if (!orders.length) return sender.send(ctx.chat_id, 'У вас нет активных заказов.');
    for (const row of orders) await sender.send(ctx.chat_id, fmt.orderCardText(row), fmt.orderKeyboard(row));
    return null;
  }

  async function setLine(ctx, status) {
    const out = actions.setLineStatus({ userId: ctx.user_id, status });
    if (out.error) return sendMenu(ctx.chat_id, ctx.driver_status, out.error);
    if (status === 'offline') {
      return sendMenu(ctx.chat_id, out.driver.status, 'Вы ушли с линии — новые заявки приходить не будут.');
    }
    await sendMenu(ctx.chat_id, out.driver.status, 'Вы на линии — новые заявки будут приходить сюда.');
    return sendPool({ ...ctx, driver_status: out.driver.status });
  }

  async function handleMessage(message) {
    if (message.chat?.type !== 'private') return; // бот работает только в личных чатах
    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const db = getDb();

    const start = text.match(/^\/start(?:\s+(\S+))?$/);
    if (start && start[1]) {
      const driverId = store.consumeLinkToken(db, start[1], chatId, message.from?.username);
      if (!driverId) {
        return sender.send(chatId, 'Ссылка устарела или уже использована. Откройте кабинет водителя на сайте и нажмите «Подключить Telegram» ещё раз.');
      }
      emitLinked(driverId);
      const ctx = store.getChatContext(db, chatId);
      return sendMenu(chatId, ctx?.driver_status, `Готово, ${fmt.esc(ctx?.name || 'водитель')}! Telegram подключён.\n\n${fmt.HELP_TEXT}`);
    }

    if (text === '/stop') {
      const driverId = store.unlinkChat(db, chatId);
      if (driverId) emitLinked(driverId);
      return sender.send(chatId, 'Telegram отключён от кабинета водителя. Подключить снова можно на сайте.', { remove_keyboard: true });
    }

    const ctx = store.getChatContext(db, chatId);
    if (!ctx) return sender.send(chatId, fmt.NOT_LINKED_TEXT, { remove_keyboard: true });

    switch (text) {
      case '/start':
      case '/help':
      case fmt.MENU.help:
        return sendMenu(chatId, ctx.driver_status, fmt.HELP_TEXT);
      case '/pool':
      case fmt.MENU.pool:
        if (ctx.driver_status === 'offline') {
          return sendMenu(chatId, ctx.driver_status, `Вы не на линии. Нажмите «${fmt.MENU.goOnline}», чтобы брать заявки.`);
        }
        return sendPool(ctx);
      case '/my':
      case fmt.MENU.orders:
        return sendOrders(ctx);
      case fmt.MENU.goOnline:
        return setLine(ctx, 'available');
      case fmt.MENU.goOffline:
        return setLine(ctx, 'offline');
      default:
        return sendMenu(chatId, ctx.driver_status, 'Не понял команду — воспользуйтесь кнопками меню.');
    }
  }

  async function handleCallback(cb) {
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const db = getDb();
    const ctx = chatId ? store.getChatContext(db, chatId) : null;
    if (!ctx) return sender.answer(cb.id, 'Чат не подключён к кабинету водителя — подключите его на сайте.', true);

    const [action, rawId, extra] = String(cb.data || '').split(':');
    const requestId = Number(rawId);
    if (!requestId) return sender.answer(cb.id);
    const editCard = (row) => sender.edit(chatId, messageId, fmt.orderCardText(row), fmt.orderKeyboard(row));

    switch (action) {
      case 'claim': {
        const out = actions.claimRequest({ userId: ctx.user_id, requestId });
        if (out.error) {
          // Карточка устарела — сразу показываем почему, кнопку убираем.
          if (!store.isInPool(getRow(db, requestId))) {
            await sender.edit(chatId, messageId, fmt.unavailableText(requestId, getRow(db, requestId)));
          }
          return sender.answer(cb.id, out.error, true);
        }
        // Карточку пула у всех правит рассылка (request:removed), а карточка
        // заказа с телефоном приходит событием request:assigned.
        return sender.answer(cb.id, 'Заказ ваш! Карточка с телефоном заказчика — ниже.');
      }
      case 'go': {
        const out = await actions.changeRequestStatus({ userId: ctx.user_id, requestId, status: 'in_progress' });
        if (out.error) return sender.answer(cb.id, out.error, true);
        await editCard(out.request);
        return sender.answer(cb.id, 'Хорошей дороги!');
      }
      case 'done':
        await sender.edit(chatId, messageId, `Завершить заказ №${requestId}?`, fmt.confirmDoneKeyboard(requestId));
        return sender.answer(cb.id);
      case 'doneY': {
        const out = await actions.changeRequestStatus({ userId: ctx.user_id, requestId, status: 'completed' });
        if (out.error) return sender.answer(cb.id, out.error, true);
        await sender.edit(chatId, messageId, `🏁 Заказ №${requestId} завершён.`);
        return sender.answer(cb.id, 'Заказ завершён');
      }
      case 'decl':
        await sender.edit(chatId, messageId, `Отказаться от заказа №${requestId}? Выберите причину — её увидит диспетчер.`, fmt.declineReasonsKeyboard(requestId));
        return sender.answer(cb.id);
      case 'rsn': {
        const reason = fmt.DECLINE_REASONS[extra];
        if (!reason) return sender.answer(cb.id);
        const out = await actions.declineRequest({ userId: ctx.user_id, requestId, reason });
        if (out.error) return sender.answer(cb.id, out.error, true);
        await sender.edit(chatId, messageId, `Вы отказались от заказа №${requestId}. Причина: ${fmt.esc(reason)}. Заявка вернулась в пул.`);
        return sender.answer(cb.id, 'Отказ принят');
      }
      case 'card': {
        const row = getRow(db, requestId);
        if (!row || row.driver_id !== ctx.driver_id || !['assigned', 'in_progress'].includes(row.status)) {
          await sender.edit(chatId, messageId, `Заказ №${requestId} больше не ваш.`);
          return sender.answer(cb.id);
        }
        await editCard(row);
        return sender.answer(cb.id);
      }
      default:
        return sender.answer(cb.id);
    }
  }

  // Одно обновление Telegram. Повторно доставленное (тот же update_id) —
  // пропускается: иначе одно нажатие выполнилось бы дважды.
  async function handleUpdate(update) {
    if (!update || typeof update.update_id !== 'number') return;
    if (!store.claimUpdate(getDb(), update.update_id)) return;
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  }

  return { handleUpdate };
}

module.exports = { createBot };
