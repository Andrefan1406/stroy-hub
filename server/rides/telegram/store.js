// Данные бота в базе поездок (таблицы telegram_* в db.js): привязки чатов к
// пользователям системы поездок, одноразовые ссылки привязки, разосланные
// карточки пула, обработанные обновления и разосланные диспетчерам
// предупреждения о заявках без водителя.
const crypto = require('crypto');
const { FULL_SELECT, getRow } = require('../requestView');

const LINK_TOKEN_TTL_MINUTES = 15;
const POOL_LIST_LIMIT = 10;
const ACTIVE_REQUEST_STATUSES = ['pending_assignment', 'assigned', 'in_progress'];

// Привязка чата + пользователь (+ карточка водителя, если он водитель).
// Действовать от имени человека бот может, только если привязка не
// заблокирована, а у водителя ещё и карточка активна — проверяется при
// КАЖДОМ обновлении, поэтому смена роли на сайте сразу меняет меню и права.
function getChatContext(db, chatId) {
  const row = db
    .prepare(
      `SELECT l.chat_id, l.blocked, u.id AS user_id, u.role, u.name, u.email,
              d.id AS driver_id, d.status AS driver_status, d.active AS driver_active
         FROM telegram_user_links l
         JOIN users u ON u.id = l.user_id
         LEFT JOIN drivers d ON d.user_id = u.id
        WHERE l.chat_id = ?`
    )
    .get(chatId);
  if (!row) return null;
  if (row.role === 'driver' && !(row.driver_id && row.driver_active)) return null;
  return row;
}

function getLinkByUser(db, userId) {
  return db.prepare('SELECT * FROM telegram_user_links WHERE user_id = ?').get(userId) || null;
}

function getLinkByDriver(db, driverId) {
  return (
    db
      .prepare('SELECT l.* FROM telegram_user_links l JOIN drivers d ON d.user_id = l.user_id WHERE d.id = ?')
      .get(driverId) || null
  );
}

function createLinkToken(db, userId) {
  const token = crypto.randomBytes(18).toString('base64url'); // ≤ 64 символов, как требует /start
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MINUTES * 60000).toISOString();
  db.prepare('INSERT INTO telegram_user_link_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

// Водитель с уволенной (неактивной) карточкой привязаться не может.
function canLink(db, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (user.role !== 'driver') return true;
  return !!db.prepare('SELECT 1 FROM drivers WHERE user_id = ? AND active = 1').get(userId);
}

// /start <token>: привязать чат к пользователю. Один пользователь — один
// чат, один чат — один пользователь: старые привязки обоих заменяются.
// Возвращает user_id или null (ссылка неизвестна, использована, просрочена
// или привязываться этому пользователю нельзя).
function consumeLinkToken(db, token, chatId, username) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM telegram_user_link_tokens WHERE token = ?').get(token);
    if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return null;
    if (!canLink(db, row.user_id)) return null;
    db.prepare("UPDATE telegram_user_link_tokens SET used_at = datetime('now') WHERE token = ?").run(token);
    const previous = db.prepare('SELECT user_id FROM telegram_user_links WHERE chat_id = ?').get(chatId);
    if (previous) unlinkUser(db, previous.user_id);
    db.prepare('DELETE FROM telegram_user_links WHERE user_id = ?').run(row.user_id);
    db.prepare('INSERT INTO telegram_user_links (user_id, chat_id, username) VALUES (?, ?, ?)').run(row.user_id, chatId, username || null);
    return row.user_id;
  })();
}

function unlinkUser(db, userId) {
  const link = getLinkByUser(db, userId);
  db.prepare('DELETE FROM telegram_user_links WHERE user_id = ?').run(userId);
  if (link) db.prepare('DELETE FROM telegram_pool_messages WHERE chat_id = ?').run(link.chat_id);
}

// Пользователя удаляют из системы поездок — убрать всё, что на него ссылается.
function forgetUser(db, userId) {
  unlinkUser(db, userId);
  db.prepare('DELETE FROM telegram_user_link_tokens WHERE user_id = ?').run(userId);
}

function unlinkDriver(db, driverId) {
  const driver = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(driverId);
  if (driver) unlinkUser(db, driver.user_id);
}

// Возвращает user_id отвязанного или null.
function unlinkChat(db, chatId) {
  const link = db.prepare('SELECT user_id FROM telegram_user_links WHERE chat_id = ?').get(chatId);
  if (link) unlinkUser(db, link.user_id);
  return link ? link.user_id : null;
}

function markChatBlocked(db, chatId) {
  db.prepare('UPDATE telegram_user_links SET blocked = 1 WHERE chat_id = ?').run(chatId);
}

// Кому рассылать новые заявки: привязанные, не заблокировавшие бота,
// работающие водители на линии (свободен или занят).
function onLineChats(db) {
  return db
    .prepare(
      `SELECT l.chat_id, d.id AS driver_id
         FROM telegram_user_links l
         JOIN users u ON u.id = l.user_id
         JOIN drivers d ON d.user_id = u.id
        WHERE l.blocked = 0 AND d.active = 1 AND d.status != 'offline' AND u.role = 'driver'`
    )
    .all();
}

function chatForDriver(db, driverId) {
  const link = db
    .prepare(
      `SELECT l.chat_id FROM telegram_user_links l JOIN drivers d ON d.user_id = l.user_id
        WHERE d.id = ? AND l.blocked = 0 AND d.active = 1`
    )
    .get(driverId);
  return link ? link.chat_id : null;
}

// Чат заказчика (пассажира). Водителю, который сам заказал машину, писать
// тоже можно — роль тут не важна.
function chatForUser(db, userId) {
  const link = db.prepare('SELECT chat_id FROM telegram_user_links WHERE user_id = ? AND blocked = 0').get(userId);
  return link ? link.chat_id : null;
}

// Диспетчеры (и главный админ — он смотрит панель диспетчера) с Telegram.
function dispatcherChats(db) {
  return db
    .prepare(
      `SELECT l.chat_id, u.id AS user_id FROM telegram_user_links l JOIN users u ON u.id = l.user_id
        WHERE l.blocked = 0 AND u.role IN ('dispatcher', 'admin')`
    )
    .all();
}

function savePoolMessage(db, { requestId, chatId, messageId, driverId }) {
  db.prepare(
    `INSERT OR REPLACE INTO telegram_pool_messages (request_id, chat_id, message_id, driver_id) VALUES (?, ?, ?, ?)`
  ).run(requestId, chatId, messageId, driverId);
}

function hasPoolMessage(db, requestId, chatId) {
  return !!db.prepare('SELECT 1 FROM telegram_pool_messages WHERE request_id = ? AND chat_id = ?').get(requestId, chatId);
}

function takePoolMessages(db, requestId) {
  return db.transaction(() => {
    const rows = db.prepare('SELECT * FROM telegram_pool_messages WHERE request_id = ?').all(requestId);
    db.prepare('DELETE FROM telegram_pool_messages WHERE request_id = ?').run(requestId);
    return rows;
  })();
}

// true — обновление новое (и теперь помечено обработанным); false — уже было.
function claimUpdate(db, updateId) {
  const info = db.prepare('INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)').run(updateId);
  return info.changes === 1;
}

function pruneOldUpdates(db) {
  db.prepare("DELETE FROM telegram_updates WHERE received_at < datetime('now', '-2 days')").run();
  db.prepare('DELETE FROM telegram_user_link_tokens WHERE expires_at < ?').run(new Date(Date.now() - 864e5).toISOString());
  db.prepare("DELETE FROM telegram_stale_alerts WHERE sent_at < datetime('now', '-14 days')").run();
}

// Заявки, доступные для взятия, ближайшие по времени подачи — те же
// условия, что у пула на сайте.
function poolRequests(db, limit = POOL_LIST_LIMIT) {
  const ids = db
    .prepare(
      `SELECT id FROM requests
        WHERE status = 'pending_assignment' AND on_hold = 0 AND merge_lock = 0 AND merged_into IS NULL
        ORDER BY requested_at ASC, id ASC`
    )
    .all()
    .map((r) => r.id);
  return { requests: ids.slice(0, limit).map((id) => getRow(db, id)), total: ids.length };
}

function isInPool(row) {
  return !!row && row.status === 'pending_assignment' && !row.on_hold && !row.merge_lock && !row.merged_into;
}

function driverOrders(db, driverId) {
  return db
    .prepare(
      `${FULL_SELECT} WHERE r.driver_id = ? AND r.status IN ('assigned', 'in_progress') AND r.merged_into IS NULL
       ORDER BY r.requested_at ASC`
    )
    .all(driverId)
    .map((row) => getRow(db, row.id));
}

// Активные заявки заказчика, ближайшие по времени подачи сверху.
function employeeRequests(db, userId) {
  return db
    .prepare(
      `${FULL_SELECT} WHERE r.employee_id = ? AND r.status IN (${ACTIVE_REQUEST_STATUSES.map(() => '?').join(', ')})
       ORDER BY r.requested_at ASC, r.id ASC`
    )
    .all(userId, ...ACTIVE_REQUEST_STATUSES)
    .map((row) => getRow(db, row.id));
}

// Заявки-кандидаты на предупреждение «никто не взял»: те же условия, что у
// подсветки на сайте (requestView.isStale — снятые с машины ждут решения
// заказчика и не считаются), о них ещё не сообщали.
function staleCandidates(db) {
  return db
    .prepare(
      `SELECT r.id, r.requested_at FROM requests r
        WHERE r.status = 'pending_assignment' AND r.on_hold = 0 AND r.merged_into IS NULL
          AND r.id NOT IN (SELECT request_id FROM telegram_stale_alerts)`
    )
    .all();
}

// true — отметили впервые (значит, сообщать); false — уже сообщали.
function markStaleAlerted(db, requestId) {
  return db.prepare('INSERT OR IGNORE INTO telegram_stale_alerts (request_id) VALUES (?)').run(requestId).changes === 1;
}

module.exports = {
  LINK_TOKEN_TTL_MINUTES,
  getChatContext,
  getLinkByUser,
  getLinkByDriver,
  createLinkToken,
  canLink,
  consumeLinkToken,
  unlinkUser,
  forgetUser,
  unlinkDriver,
  unlinkChat,
  markChatBlocked,
  onLineChats,
  chatForDriver,
  chatForUser,
  dispatcherChats,
  savePoolMessage,
  hasPoolMessage,
  takePoolMessages,
  claimUpdate,
  pruneOldUpdates,
  poolRequests,
  isInPool,
  driverOrders,
  employeeRequests,
  staleCandidates,
  markStaleAlerted,
};
