// Тексты и кнопки бота. Разметка — HTML-режим Telegram (parse_mode: 'HTML'),
// поэтому всё, что пришло от людей (адреса, комментарии, имена), экранируется.
//
// В карточке заявки из пула НЕТ имени и телефона заказчика — сообщения в
// Telegram легко переслать; они появляются только в карточке заказа,
// который водитель уже взял. Пассажир, наоборот, видит телефон водителя
// только после назначения.
//
// Mini App (форма заявки, панель диспетчера) открывается только
// inline-кнопкой web_app под сообщением: из кнопок нижнего меню Telegram не
// передаёт странице подписанные данные пользователя (initData), без них
// вход без пароля невозможен. Поэтому кнопка меню «📝 Новая заявка»
// отвечает сообщением с такой inline-кнопкой. apps — ссылки Mini App
// (index.js: appLinks), null — Mini App не настроен, кнопок нет.

const MENU = {
  pool: '📋 Пул заявок',
  orders: '🚗 Мои заказы',
  goOnline: '🟢 Выйти на линию',
  goOffline: '⚪ Уйти с линии',
  help: 'ℹ️ Помощь',
  newRequest: '📝 Новая заявка',
  myRequests: '🧾 Мои заявки',
  panel: '🖥 Панель диспетчера',
};

const EMPLOYEE_CANCEL_REASONS = {
  1: 'Планы изменились',
  2: 'Доберусь сам',
  3: 'Другая причина',
};

const isDispatcherRole = (role) => role === 'dispatcher' || role === 'admin';

const DECLINE_REASONS = {
  1: 'Сломалась машина',
  2: 'Не успеваю к времени подачи',
  3: 'Другая причина',
};

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// "2026-10-07T09:00" -> "07.10 в 09:00"
function formatPickup(requestedAt) {
  const [date, time = ''] = String(requestedAt || '').replace(' ', 'T').split('T');
  const [, m, d] = date.split('-');
  return d && m ? `${d}.${m} в ${time.slice(0, 5)}` : esc(requestedAt);
}

function route(row) {
  return [row.from_address, row.to_address, ...(row.stopsFull || []).map((s) => s.address)].map(esc).join(' → ');
}

function estimate(row) {
  if (row.distance_km == null || row.duration_min == null) return null;
  const h = Math.floor(row.duration_min / 60);
  const min = row.duration_min % 60;
  const km = String(row.distance_km).replace('.', ',');
  return `≈ ${km} км, ${h > 0 ? `${h} ч ${min} мин` : `${min} мин`}`;
}

function tripLines(row) {
  const lines = [
    `🕘 Подача: <b>${formatPickup(row.requested_at)}</b>`,
    `📍 ${route(row)}`,
  ];
  if (row.with_return) lines.push('↩️ Туда-обратно, водитель ждёт на месте');
  lines.push(`👥 Пассажиров: ${row.passengers_count || 1}`);
  const est = estimate(row);
  if (est) lines.push(`📏 ${est}`);
  if (row.purpose) lines.push(`🎯 Цель: ${esc(row.purpose)}`);
  if (row.comment) lines.push(`💬 ${esc(row.comment)}`);
  return lines;
}

function poolCardText(row) {
  return [`<b>Заявка №${row.id}</b>`, ...tripLines(row)].join('\n');
}

const ORDER_STATUS = { assigned: 'назначен вам', in_progress: 'в пути' };

function orderCardText(row) {
  return [
    `<b>Заказ №${row.id}</b> — ${ORDER_STATUS[row.status] || esc(row.status)}`,
    ...tripLines(row),
    `👤 Заказчик: ${esc(row.employee_name)}`,
    `📞 ${esc(row.employee_phone)}`,
  ].join('\n');
}

// Яндекс Карты строят маршрут только по координатам; если геокодер точку
// не нашёл — кнопки нет.
function mapUrl(row) {
  if (row.from_lat == null || row.to_lat == null) return null;
  return `https://yandex.kz/maps/?rtext=${row.from_lat},${row.from_lng}~${row.to_lat},${row.to_lng}&rtt=auto`;
}

function withMap(rows, row) {
  const url = mapUrl(row);
  return url ? [...rows, [{ text: '🗺 Маршрут на карте', url }]] : rows;
}

function poolKeyboard(row) {
  return { inline_keyboard: withMap([[{ text: '✅ Взять', callback_data: `claim:${row.id}` }]], row) };
}

function orderKeyboard(row) {
  const rows = row.status === 'assigned'
    ? [[{ text: '🚀 Выехал', callback_data: `go:${row.id}` }], [{ text: '✖ Отказаться', callback_data: `decl:${row.id}` }]]
    : [[{ text: '🏁 Завершить', callback_data: `done:${row.id}` }]];
  return { inline_keyboard: withMap(rows, row) };
}

function confirmDoneKeyboard(id) {
  return {
    inline_keyboard: [
      [{ text: '✅ Да, поездка завершена', callback_data: `doneY:${id}` }],
      [{ text: '← Назад', callback_data: `card:${id}` }],
    ],
  };
}

function declineReasonsKeyboard(id) {
  return {
    inline_keyboard: [
      ...Object.entries(DECLINE_REASONS).map(([key, text]) => [{ text, callback_data: `rsn:${id}:${key}` }]),
      [{ text: '← Назад', callback_data: `card:${id}` }],
    ],
  };
}

// Нижнее меню — по роли. ctx — контекст чата (store.getChatContext).
function mainMenu(ctx) {
  let keyboard;
  if (ctx?.role === 'driver') {
    keyboard = [
      [{ text: MENU.pool }, { text: MENU.orders }],
      [{ text: ctx.driver_status === 'offline' ? MENU.goOnline : MENU.goOffline }, { text: MENU.help }],
    ];
  } else if (isDispatcherRole(ctx?.role)) {
    keyboard = [[{ text: MENU.panel }], [{ text: MENU.newRequest }, { text: MENU.myRequests }], [{ text: MENU.help }]];
  } else {
    keyboard = [[{ text: MENU.newRequest }, { text: MENU.myRequests }], [{ text: MENU.help }]];
  }
  return { keyboard, resize_keyboard: true, is_persistent: true };
}

// Inline-кнопка Mini App; url нет — кнопки нет.
const appRow = (text, url) => (url ? [[{ text, web_app: { url } }]] : []);
const inline = (rows) => (rows.length ? { inline_keyboard: rows } : undefined);

// Почему заявка больше недоступна — для правки разосланных карточек пула.
function unavailableText(id, row) {
  let why = 'больше недоступна';
  if (row?.status === 'assigned' || row?.status === 'in_progress') why = 'уже взята другим водителем';
  else if (row?.status === 'cancelled') why = 'отменена';
  else if (row?.status === 'completed') why = 'уже выполнена';
  else if (row?.on_hold || row?.merge_lock || row?.merged_into) why = 'снята из пула';
  return `<s>Заявка №${id}</s> — ${why}.`;
}

// --- пассажир ---

const EMPLOYEE_STATUS = {
  pending_assignment: '⏳ ищем водителя',
  assigned: '✅ водитель назначен',
  in_progress: '🚗 в пути',
  completed: '🏁 завершена',
  cancelled: '❌ отменена',
};

function driverLines(row) {
  const lines = [`👨‍✈️ Водитель: ${esc(row.driver_name || '—')}`];
  if (row.driver_phone) lines.push(`📞 ${esc(row.driver_phone)}`);
  const car = [row.vehicle_model, row.vehicle_plate].filter(Boolean).map(esc).join(', ');
  if (car) lines.push(`🚘 ${car}`);
  return lines;
}

function myRequestText(row) {
  const status = row.on_hold ? '⚠️ машину сняли — нужно ваше решение' : EMPLOYEE_STATUS[row.status] || esc(row.status);
  const lines = [`<b>Заявка №${row.id}</b> — ${status}`, `🕘 Подача: <b>${formatPickup(row.requested_at)}</b>`, `📍 ${route(row)}`];
  if (row.merged_into) lines.push(`🔗 Едете вместе с заявкой №${row.merged_into}`);
  if (['assigned', 'in_progress'].includes(row.status) && row.driver_id) lines.push(...driverLines(row));
  return lines.join('\n');
}

const canCancelOwn = (row) => ['pending_assignment', 'assigned'].includes(row.status);

function myRequestKeyboard(row, apps) {
  const rows = [];
  if (canCancelOwn(row)) rows.push([{ text: '✖ Отменить заявку', callback_data: `ecan:${row.id}` }]);
  if (row.on_hold || row.pendingMerges?.length) rows.push(...appRow('Открыть заявку', apps?.myRequests));
  return inline(rows);
}

function employeeCancelKeyboard(id) {
  return {
    inline_keyboard: [
      ...Object.entries(EMPLOYEE_CANCEL_REASONS).map(([key, text]) => [{ text, callback_data: `ecr:${id}:${key}` }]),
      [{ text: '← Назад', callback_data: `ecard:${id}` }],
    ],
  };
}

// Уведомления пассажиру о его заявке — по событиям журнала (notifier.js).
const passenger = {
  assigned: (row) => [
    `✅ <b>Водитель назначен</b> — заявка №${row.id}`,
    `🕘 Подача: <b>${formatPickup(row.requested_at)}</b>`,
    `📍 ${route(row)}`,
    ...driverLines(row),
  ].join('\n'),
  inProgress: (row) => [`🚗 <b>Машина в пути</b> — заявка №${row.id}`, ...driverLines(row)].join('\n'),
  completed: (row) => `🏁 Поездка по заявке №${row.id} завершена. Спасибо!`,
  searching: (row, why) => `🔄 ${why} по заявке №${row.id}. Ищем другого водителя — сообщим, когда назначим.`,
  pulled: (row, reason) => [
    `⚠️ <b>Диспетчер снял машину с заявки №${row.id}</b>`,
    reason ? `Причина: ${esc(reason)}` : null,
    'Решите, что дальше: ждать другую машину или отменить заявку.',
  ].filter(Boolean).join('\n'),
  cancelled: (row, reason) => [`❌ Заявка №${row.id} отменена диспетчером.`, reason ? `Причина: ${esc(reason)}` : null]
    .filter(Boolean).join('\n'),
  mergeProposed: (row) =>
    `🔗 Водитель по заявке №${row.id} предлагает взять попутного пассажира. Нужно ваше согласие — откройте заявку.`,
  merged: (row) => [`🔗 Ваша заявка №${row.id} объединена с поездкой №${row.merged_into} — поедете вместе.`, ...driverLines(row)].join('\n'),
  mergeDissolved: (row, reason) => [
    `🔄 Совместная поездка по заявке №${row.id} отменена${reason ? ` (${esc(reason)})` : ''}.`,
    'Ищем вам отдельного водителя.',
  ].join('\n'),
};

// --- диспетчер ---

const dispatcher = {
  created: (row) => [
    `🆕 <b>Новая заявка №${row.id}</b>`,
    `🕘 Подача: <b>${formatPickup(row.requested_at)}</b>`,
    `📍 ${route(row)}`,
    `👤 ${esc(row.employee_name)}`,
  ].join('\n'),
  stale: (row, minutes) => [
    `⏰ <b>Заявку №${row.id} никто не взял</b> — ${minutes > 0 ? `до подачи ${minutes} мин` : 'время подачи уже наступило'}`,
    `🕘 Подача: <b>${formatPickup(row.requested_at)}</b>`,
    `📍 ${route(row)}`,
    `👤 ${esc(row.employee_name)}`,
  ].join('\n'),
  declined: (row, driverName, reason) => [
    `↩️ <b>Водитель отказался от заявки №${row.id}</b>`,
    `Водитель: ${esc(driverName || '—')}`,
    reason ? `Причина: ${esc(reason)}` : null,
    'Заявка вернулась в пул.',
  ].filter(Boolean).join('\n'),
  cancelledByEmployee: (row, reason) => [
    `❌ Заказчик отменил заявку №${row.id}`,
    `👤 ${esc(row.employee_name)}`,
    `🕘 Подача была: ${formatPickup(row.requested_at)}`,
    reason ? `Причина: ${esc(reason)}` : null,
  ].filter(Boolean).join('\n'),
};

const panelKeyboard = (apps) => inline(appRow('🖥 Открыть панель', apps?.panel));
const myRequestsKeyboard = (apps) => inline(appRow('🧾 Мои заявки', apps?.myRequests));

const HELP_TEXT_EMPLOYEE = [
  '<b>Как пользоваться ботом</b>',
  `${MENU.newRequest} — форма заказа машины прямо в Telegram.`,
  `${MENU.myRequests} — ваши активные заявки; пока водитель не выехал, заявку можно отменить.`,
  '',
  'Сюда придут уведомления: водитель назначен (с телефоном и машиной), машина в пути, поездка завершена, заявку отменили.',
  'Отключить бота: /stop',
].join('\n');

const HELP_TEXT_DISPATCHER = [
  '<b>Как пользоваться ботом</b>',
  `${MENU.panel} — текущие заявки: назначить водителя, снять, отменить.`,
  `${MENU.newRequest} / ${MENU.myRequests} — заказать машину себе.`,
  '',
  'Сюда придут уведомления: новая заявка, заявку никто не взял и подача скоро, водитель отказался, заказчик отменил.',
  'Отключить бота: /stop',
].join('\n');

function helpText(role) {
  if (role === 'driver') return HELP_TEXT;
  return isDispatcherRole(role) ? HELP_TEXT_DISPATCHER : HELP_TEXT_EMPLOYEE;
}

const HELP_TEXT = [
  '<b>Как пользоваться ботом</b>',
  `${MENU.goOnline} — новые заявки начнут приходить сюда.`,
  `${MENU.pool} — свободные заявки, ближайшие по времени подачи.`,
  '«✅ Взять» под заявкой — она ваша, если вас никто не опередил. Телефон заказчика появится в карточке заказа.',
  `${MENU.orders} — взятые заказы: «🚀 Выехал», «🏁 Завершить», «✖ Отказаться».`,
  `${MENU.goOffline} — заявки перестанут приходить.`,
  '',
  'Всё то же доступно на сайте в кабинете водителя. Отключить бота: /stop',
].join('\n');

const NOT_LINKED_TEXT = [
  'Этот чат не подключён к системе служебного транспорта.',
  'Откройте на сайте свою страницу (пассажира, диспетчера или водителя) и нажмите «Подключить Telegram» — бот откроется по ссылке и подключится сам.',
].join('\n');

module.exports = {
  MENU,
  DECLINE_REASONS,
  EMPLOYEE_CANCEL_REASONS,
  HELP_TEXT,
  helpText,
  isDispatcherRole,
  myRequestText,
  myRequestKeyboard,
  employeeCancelKeyboard,
  canCancelOwn,
  passenger,
  dispatcher,
  panelKeyboard,
  myRequestsKeyboard,
  appRow,
  NOT_LINKED_TEXT,
  esc,
  formatPickup,
  poolCardText,
  orderCardText,
  poolKeyboard,
  orderKeyboard,
  confirmDoneKeyboard,
  declineReasonsKeyboard,
  mainMenu,
  unavailableText,
};
