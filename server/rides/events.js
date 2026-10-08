// Единый журнал событий по заявке (таблица request_events, см. db.js).
// Append-only: logEvent только вставляет строки, ничего не обновляет и не
// удаляет. Всё, что меняет заявку — смена статуса, работа с точками
// маршрута, пересчёт оценки времени, модерация и объединение заявок
// (следующие фазы доработок) — оставляет здесь запись «кто / когда / что».
// Отсюда же берёт данные страница «Журнал» у диспетчера/админа и выгрузка
// в Excel (server/rides/eventsRouter.js).

const { EventEmitter } = require('events');

// Типы событий — держим списком в одном месте, чтобы фронт и выгрузка
// показывали человекочитаемые названия, а не сырой код.
const EVENT_TYPES = {
  request_created: 'Заявка создана',
  status_changed: 'Смена статуса',
  driver_claimed: 'Водитель взял заказ',
  driver_declined: 'Водитель отказался от заказа',
  dispatcher_assigned: 'Диспетчер назначил водителя',
  cancelled_by_dispatcher: 'Отменена диспетчером',
  cancelled_by_employee: 'Отменена заказчиком',
  driver_unassigned: 'Диспетчер снял водителя (заявка вернулась в пул)',
  route_recomputed: 'Пересчёт маршрута и времени',
  // Резерв под следующие фазы — уже перечислены, чтобы не забыть завести
  // человекочитаемые подписи, когда дойдут руки до реализации:
  stop_proposed: 'Предложена новая точка маршрута',
  stop_added: 'Добавлена точка маршрута',
  stop_edited: 'Изменена точка маршрута',
  stop_removed: 'Удалена точка маршрута',
  stop_approved: 'Диспетчер одобрил точку',
  stop_rejected: 'Диспетчер отклонил точку',
  reassigned: 'Экстренная переброска машины',
  reassign_resolved: 'Решение заказчика после переброски',
  merge_proposed: 'Предложено объединение заявок',
  merge_approved: 'Объединение заявок подтверждено',
  merge_rejected: 'Объединение заявок отклонено',
  merge_dissolved: 'Объединение заявок расформировано',
};

function eventTypeLabel(type) {
  return EVENT_TYPES[type] || type;
}

// db — write-соединение (getWriteDb). Вызывается как внутри
// db.transaction(...), так и вне её; в обоих случаях это просто
// синхронный INSERT. Ошибку журналирования глотаем — она не должна
// ронять основную операцию с заявкой.
//
// Каждое записанное событие публикуется в requestEvents — на него подписан
// Telegram-бот (уведомления пассажиру и диспетчеру, telegram/notifier.js).
// Публикация отложена (setImmediate): logEvent часто вызывается внутри
// транзакции, и подписчик должен увидеть уже зафиксированные данные. Если
// транзакция откатилась, строки события нет — подписчик это проверяет
// (eventStillLogged) и ничего не шлёт.
const requestEvents = new EventEmitter();

function logEvent(db, { requestId, type, actorUserId = null, payload = null }) {
  try {
    const info = db.prepare(
      `INSERT INTO request_events (request_id, event_type, actor_user_id, payload_json)
       VALUES (?, ?, ?, ?)`
    ).run(requestId, type, actorUserId, payload == null ? null : JSON.stringify(payload));
    const event = { id: Number(info.lastInsertRowid), requestId, type, actorUserId, payload };
    setImmediate(() => {
      try {
        requestEvents.emit('event', event);
      } catch (err) {
        console.error('[rides] подписчик журнала событий упал:', err.message);
      }
    });
  } catch (err) {
    console.error('[rides] logEvent failed:', err.message);
  }
}

function eventStillLogged(db, { id, requestId, type }) {
  return !!db
    .prepare('SELECT 1 FROM request_events WHERE id = ? AND request_id = ? AND event_type = ?')
    .get(id, requestId, type);
}

// Журнал для диспетчера/админа: фильтры по заявке, типу события и периоду
// (from/to — 'YYYY-MM-DD' или полная дата-время). Джойним автора и
// маршрут заявки, чтобы строку журнала можно было прочитать без
// дополнительных запросов.
function listEvents(db, { requestId, type, from, to, limit = 500, offset = 0 } = {}) {
  let sql = `
    SELECT
      e.id,
      e.request_id   AS requestId,
      e.event_type   AS type,
      e.payload_json AS payloadJson,
      e.created_at   AS createdAt,
      u.name         AS actorName,
      u.email        AS actorEmail,
      u.role         AS actorRole,
      r.from_address AS fromAddress,
      r.to_address   AS toAddress,
      r.status       AS requestStatus
    FROM request_events e
    LEFT JOIN users u ON u.id = e.actor_user_id
    LEFT JOIN requests r ON r.id = e.request_id
    WHERE 1 = 1
  `;
  const params = [];
  if (requestId) { sql += ' AND e.request_id = ?'; params.push(Number(requestId)); }
  if (type) { sql += ' AND e.event_type = ?'; params.push(String(type)); }
  if (from) { sql += ' AND e.created_at >= ?'; params.push(String(from)); }
  if (to) { sql += ' AND e.created_at <= ?'; params.push(String(to)); }
  sql += ' ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  return db.prepare(sql).all(...params).map((row) => {
    let payload = null;
    if (row.payloadJson) { try { payload = JSON.parse(row.payloadJson); } catch { payload = null; } }
    const { payloadJson, ...rest } = row;
    return { ...rest, typeLabel: eventTypeLabel(row.type), payload };
  });
}

module.exports = { logEvent, listEvents, eventTypeLabel, EVENT_TYPES, requestEvents, eventStillLogged };
