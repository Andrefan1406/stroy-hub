// Данные бота в базе поездок (таблицы telegram_* в db.js): привязки чатов к
// водителям, одноразовые ссылки привязки, разосланные карточки пула и
// обработанные обновления.
const crypto = require('crypto');
const { FULL_SELECT, getRow } = require('../requestView');

const LINK_TOKEN_TTL_MINUTES = 15;
const POOL_LIST_LIMIT = 10;

// Привязка чата + водитель + пользователь. Действовать от имени водителя
// бот может, только если привязка не заблокирована, карточка активна и у
// пользователя всё ещё роль водителя — проверяется при КАЖДОМ обновлении.
function getChatContext(db, chatId) {
  const row = db
    .prepare(
      `SELECT l.chat_id, l.driver_id, l.blocked, d.status AS driver_status, d.active, d.user_id,
              u.role, u.name
         FROM telegram_links l
         JOIN drivers d ON d.id = l.driver_id
         JOIN users u ON u.id = d.user_id
        WHERE l.chat_id = ?`
    )
    .get(chatId);
  if (!row || !row.active || row.role !== 'driver') return null;
  return row;
}

function getLinkByDriver(db, driverId) {
  return db.prepare('SELECT * FROM telegram_links WHERE driver_id = ?').get(driverId) || null;
}

function createLinkToken(db, driverId) {
  const token = crypto.randomBytes(18).toString('base64url'); // ≤ 64 символов, как требует /start
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MINUTES * 60000).toISOString();
  db.prepare('INSERT INTO telegram_link_tokens (token, driver_id, expires_at) VALUES (?, ?, ?)').run(token, driverId, expiresAt);
  return { token, expiresAt };
}

// /start <token>: привязать чат к водителю. Один водитель — один чат, один
// чат — один водитель: старые привязки обоих заменяются. Возвращает
// driver_id или null (ссылка неизвестна, использована, просрочена или
// водитель уже неактивен).
function consumeLinkToken(db, token, chatId, username) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM telegram_link_tokens WHERE token = ?').get(token);
    if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return null;
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ? AND active = 1').get(row.driver_id);
    if (!driver) return null;
    db.prepare('UPDATE telegram_link_tokens SET used_at = datetime(\'now\') WHERE token = ?').run(token);
    db.prepare('DELETE FROM telegram_links WHERE chat_id = ? OR driver_id = ?').run(chatId, driver.id);
    db.prepare('INSERT INTO telegram_links (driver_id, chat_id, username) VALUES (?, ?, ?)').run(driver.id, chatId, username || null);
    return driver.id;
  })();
}

function unlinkDriver(db, driverId) {
  db.prepare('DELETE FROM telegram_links WHERE driver_id = ?').run(driverId);
  db.prepare('DELETE FROM telegram_pool_messages WHERE driver_id = ?').run(driverId);
}

function unlinkChat(db, chatId) {
  const link = db.prepare('SELECT driver_id FROM telegram_links WHERE chat_id = ?').get(chatId);
  if (link) unlinkDriver(db, link.driver_id);
  return link ? link.driver_id : null;
}

function markChatBlocked(db, chatId) {
  db.prepare('UPDATE telegram_links SET blocked = 1 WHERE chat_id = ?').run(chatId);
}

// Кому рассылать новые заявки: привязанные, не заблокировавшие бота,
// работающие водители на линии (свободен или занят).
function onLineChats(db) {
  return db
    .prepare(
      `SELECT l.chat_id, l.driver_id
         FROM telegram_links l
         JOIN drivers d ON d.id = l.driver_id
         JOIN users u ON u.id = d.user_id
        WHERE l.blocked = 0 AND d.active = 1 AND d.status != 'offline' AND u.role = 'driver'`
    )
    .all();
}

function chatForDriver(db, driverId) {
  const link = db
    .prepare(
      `SELECT l.chat_id FROM telegram_links l JOIN drivers d ON d.id = l.driver_id
        WHERE l.driver_id = ? AND l.blocked = 0 AND d.active = 1`
    )
    .get(driverId);
  return link ? link.chat_id : null;
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
  db.prepare("DELETE FROM telegram_link_tokens WHERE expires_at < ?").run(new Date(Date.now() - 864e5).toISOString());
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

module.exports = {
  LINK_TOKEN_TTL_MINUTES,
  getChatContext,
  getLinkByDriver,
  createLinkToken,
  consumeLinkToken,
  unlinkDriver,
  unlinkChat,
  markChatBlocked,
  onLineChats,
  chatForDriver,
  savePoolMessage,
  hasPoolMessage,
  takePoolMessages,
  claimUpdate,
  pruneOldUpdates,
  poolRequests,
  isInPool,
  driverOrders,
};
