// Тексты и кнопки бота. Разметка — HTML-режим Telegram (parse_mode: 'HTML'),
// поэтому всё, что пришло от людей (адреса, комментарии, имена), экранируется.
//
// В карточке заявки из пула НЕТ имени и телефона заказчика — сообщения в
// Telegram легко переслать; они появляются только в карточке заказа,
// который водитель уже взял.

const MENU = {
  pool: '📋 Пул заявок',
  orders: '🚗 Мои заказы',
  goOnline: '🟢 Выйти на линию',
  goOffline: '⚪ Уйти с линии',
  help: 'ℹ️ Помощь',
};

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

function mainMenu(driverStatus) {
  return {
    keyboard: [
      [{ text: MENU.pool }, { text: MENU.orders }],
      [{ text: driverStatus === 'offline' ? MENU.goOnline : MENU.goOffline }, { text: MENU.help }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// Почему заявка больше недоступна — для правки разосланных карточек пула.
function unavailableText(id, row) {
  let why = 'больше недоступна';
  if (row?.status === 'assigned' || row?.status === 'in_progress') why = 'уже взята другим водителем';
  else if (row?.status === 'cancelled') why = 'отменена';
  else if (row?.status === 'completed') why = 'уже выполнена';
  else if (row?.on_hold || row?.merge_lock || row?.merged_into) why = 'снята из пула';
  return `<s>Заявка №${id}</s> — ${why}.`;
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
  'Этот чат не подключён к кабинету водителя.',
  'Откройте кабинет водителя на сайте и нажмите «Подключить Telegram» — бот откроется по ссылке и подключится сам.',
].join('\n');

module.exports = {
  MENU,
  DECLINE_REASONS,
  HELP_TEXT,
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
