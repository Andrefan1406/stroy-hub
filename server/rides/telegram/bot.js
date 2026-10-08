// Обработка входящих обновлений Telegram: сообщения (команды и кнопки меню)
// и нажатия inline-кнопок под карточками. Все действия над заявками — через
// driverActions.js / employeeActions.js, тот же код, что у сайта; бот только
// переводит нажатия в вызовы и показывает результат.
//
// Личность — только chat_id из привязки (telegram_user_links), роль — из
// users при каждом обновлении. Данным из кнопки (действие и номер заявки)
// без проверки не доверяем: каждое действие заново проверяет человека и
// заявку на сервере.
const store = require('./store');
const fmt = require('./format');
const { getRow } = require('../requestView');
const actions = require('../driverActions');
const { cancelOwnRequest } = require('../employeeActions');

const DRIVER_ACTIONS = new Set(['claim', 'go', 'done', 'doneY', 'decl', 'rsn', 'card']);

// Команды в меню «/» — свои у каждой роли (ставятся чату при привязке).
const COMMANDS = {
  driver: [
    { command: 'pool', description: 'Пул свободных заявок' },
    { command: 'my', description: 'Мои заказы' },
    { command: 'help', description: 'Как пользоваться ботом' },
    { command: 'stop', description: 'Отключить Telegram' },
  ],
  employee: [
    { command: 'new', description: 'Новая заявка' },
    { command: 'my', description: 'Мои заявки' },
    { command: 'help', description: 'Как пользоваться ботом' },
    { command: 'stop', description: 'Отключить Telegram' },
  ],
  dispatcher: [
    { command: 'panel', description: 'Панель диспетчера' },
    { command: 'new', description: 'Заказать машину себе' },
    { command: 'my', description: 'Мои заявки' },
    { command: 'help', description: 'Как пользоваться ботом' },
    { command: 'stop', description: 'Отключить Telegram' },
  ],
};

function createBot({ getDb, sender, apps = null, emitLinked = () => {} }) {
  const commandsFor = (role) => (role === 'driver' ? COMMANDS.driver : fmt.isDispatcherRole(role) ? COMMANDS.dispatcher : COMMANDS.employee);

  // Кнопка слева от поля ввода: у пассажира и диспетчера открывает Mini App
  // (оттуда Telegram передаёт подписанные данные — вход без пароля), у
  // водителя — обычное меню команд.
  function menuButtonFor(role) {
    if (role === 'driver') return { type: 'commands' };
    const url = fmt.isDispatcherRole(role) ? apps?.panel : apps?.newRequest;
    const text = fmt.isDispatcherRole(role) ? 'Панель' : 'Заявка';
    return url ? { type: 'web_app', text, web_app: { url } } : { type: 'commands' };
  }

  async function setupChat(ctx) {
    await sender.call('setMyCommands', { commands: commandsFor(ctx.role), scope: { type: 'chat', chat_id: ctx.chat_id } });
    await sender.call('setChatMenuButton', { chat_id: ctx.chat_id, menu_button: menuButtonFor(ctx.role) });
  }

  async function resetChat(chatId) {
    await sender.call('deleteMyCommands', { scope: { type: 'chat', chat_id: chatId } });
    await sender.call('setChatMenuButton', { chat_id: chatId, menu_button: { type: 'default' } });
  }

  async function sendMenu(ctx, text) {
    await sender.send(ctx.chat_id, text, fmt.mainMenu(ctx));
  }

  // --- водитель ---

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
    if (out.error) return sendMenu(ctx, out.error);
    const next = { ...ctx, driver_status: out.driver.status };
    if (status === 'offline') return sendMenu(next, 'Вы ушли с линии — новые заявки приходить не будут.');
    await sendMenu(next, 'Вы на линии — новые заявки будут приходить сюда.');
    return sendPool(next);
  }

  function handleDriverMessage(ctx, text) {
    switch (text) {
      case '/pool':
      case fmt.MENU.pool:
        if (ctx.driver_status === 'offline') {
          return sendMenu(ctx, `Вы не на линии. Нажмите «${fmt.MENU.goOnline}», чтобы брать заявки.`);
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
        return sendMenu(ctx, 'Не понял команду — воспользуйтесь кнопками меню.');
    }
  }

  // --- пассажир и диспетчер ---

  function sendNewRequest(ctx) {
    if (!apps?.newRequest) return sendMenu(ctx, 'Подать заявку можно на сайте — на странице заказа служебного транспорта.');
    return sender.send(ctx.chat_id, 'Заполните форму — она откроется прямо в Telegram.', {
      inline_keyboard: fmt.appRow('📝 Открыть форму заявки', apps.newRequest),
    });
  }

  async function sendMyRequests(ctx) {
    const rows = store.employeeRequests(getDb(), ctx.user_id);
    if (!rows.length) {
      return sender.send(ctx.chat_id, 'У вас нет активных заявок.', apps?.newRequest
        ? { inline_keyboard: fmt.appRow('📝 Новая заявка', apps.newRequest) }
        : undefined);
    }
    for (const row of rows) await sender.send(ctx.chat_id, fmt.myRequestText(row), fmt.myRequestKeyboard(row, apps));
    return null;
  }

  function sendPanel(ctx) {
    if (!apps?.panel) return sendMenu(ctx, 'Панель диспетчера — на сайте.');
    return sender.send(ctx.chat_id, 'Текущие заявки — в панели диспетчера.', fmt.panelKeyboard(apps));
  }

  function handlePassengerMessage(ctx, text) {
    switch (text) {
      case '/new':
      case fmt.MENU.newRequest:
        return sendNewRequest(ctx);
      case '/my':
      case fmt.MENU.myRequests:
        return sendMyRequests(ctx);
      case '/panel':
      case fmt.MENU.panel:
        if (fmt.isDispatcherRole(ctx.role)) return sendPanel(ctx);
        break;
      default:
        break;
    }
    return sendMenu(ctx, 'Не понял команду — воспользуйтесь кнопками меню.');
  }

  async function handleMessage(message) {
    if (message.chat?.type !== 'private') return; // бот работает только в личных чатах
    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const db = getDb();

    const start = text.match(/^\/start(?:\s+(\S+))?$/);
    if (start && start[1]) {
      const userId = store.consumeLinkToken(db, start[1], chatId, message.from?.username);
      if (!userId) {
        return sender.send(chatId, 'Ссылка устарела или уже использована. Откройте свою страницу на сайте и нажмите «Подключить Telegram» ещё раз.');
      }
      emitLinked(userId);
      const ctx = store.getChatContext(db, chatId);
      if (!ctx) return null;
      await setupChat(ctx);
      return sendMenu(ctx, `Готово, ${fmt.esc(ctx.name || 'коллега')}! Telegram подключён.\n\n${fmt.helpText(ctx.role)}`);
    }

    if (text === '/stop') {
      const userId = store.unlinkChat(db, chatId);
      if (userId) {
        emitLinked(userId);
        await resetChat(chatId);
      }
      return sender.send(chatId, 'Telegram отключён. Подключить снова можно на сайте.', { remove_keyboard: true });
    }

    const ctx = store.getChatContext(db, chatId);
    if (!ctx) return sender.send(chatId, fmt.NOT_LINKED_TEXT, { remove_keyboard: true });

    // /start без ссылки — заодно обновить команды и кнопку меню (роль на
    // сайте могли сменить после привязки).
    if (text === '/start') await setupChat(ctx);
    if (['/start', '/help', fmt.MENU.help].includes(text)) return sendMenu(ctx, fmt.helpText(ctx.role));
    return ctx.role === 'driver' ? handleDriverMessage(ctx, text) : handlePassengerMessage(ctx, text);
  }

  async function handleDriverCallback(cb, ctx, action, requestId, extra) {
    const db = getDb();
    const chatId = ctx.chat_id;
    const messageId = cb.message?.message_id;
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

  // Отмена своей заявки: «Отменить» → причина → отмена. Любая роль — свою
  // заявку проверяет employeeActions (заказчик = этот пользователь).
  async function handleEmployeeCallback(cb, ctx, action, requestId, extra) {
    const db = getDb();
    const chatId = ctx.chat_id;
    const messageId = cb.message?.message_id;
    const row = getRow(db, requestId);
    if (!row || row.employee_id !== ctx.user_id) return sender.answer(cb.id, 'Это не ваша заявка', true);

    switch (action) {
      case 'ecan':
        if (!fmt.canCancelOwn(row)) {
          await sender.edit(chatId, messageId, fmt.myRequestText(row), fmt.myRequestKeyboard(row, apps));
          return sender.answer(cb.id, 'Водитель уже в пути — отменить может только диспетчер.', true);
        }
        await sender.edit(chatId, messageId, `Отменить заявку №${requestId}? Выберите причину.`, fmt.employeeCancelKeyboard(requestId));
        return sender.answer(cb.id);
      case 'ecr': {
        const reason = fmt.EMPLOYEE_CANCEL_REASONS[extra];
        if (!reason) return sender.answer(cb.id);
        const out = cancelOwnRequest({ userId: ctx.user_id, requestId, reason });
        if (out.error) return sender.answer(cb.id, out.error, true);
        await sender.edit(chatId, messageId, `❌ Заявка №${requestId} отменена. Причина: ${fmt.esc(reason)}.`);
        return sender.answer(cb.id, 'Заявка отменена');
      }
      case 'ecard':
        await sender.edit(chatId, messageId, fmt.myRequestText(row), fmt.myRequestKeyboard(row, apps));
        return sender.answer(cb.id);
      default:
        return sender.answer(cb.id);
    }
  }

  async function handleCallback(cb) {
    const chatId = cb.message?.chat?.id;
    const ctx = chatId ? store.getChatContext(getDb(), chatId) : null;
    if (!ctx) return sender.answer(cb.id, 'Чат не подключён — подключите Telegram на сайте.', true);

    const [action, rawId, extra] = String(cb.data || '').split(':');
    const requestId = Number(rawId);
    if (!requestId) return sender.answer(cb.id);

    if (DRIVER_ACTIONS.has(action)) {
      if (ctx.role !== 'driver') return sender.answer(cb.id, 'Это действие — только для водителя.', true);
      return handleDriverCallback(cb, ctx, action, requestId, extra);
    }
    return handleEmployeeCallback(cb, ctx, action, requestId, extra);
  }

  // Одно обновление Telegram. Повторно доставленное (тот же update_id) —
  // пропускается: иначе одно нажатие выполнилось бы дважды.
  async function handleUpdate(update) {
    if (!update || typeof update.update_id !== 'number') return;
    if (!store.claimUpdate(getDb(), update.update_id)) return;
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  }

  return { handleUpdate, setupChat };
}

module.exports = { createBot, COMMANDS };
