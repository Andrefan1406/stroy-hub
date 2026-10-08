// Вход в Telegram Mini App без пароля.
//
// 1. Telegram открывает страницу /tg и передаёт ей initData — строку с
//    данными пользователя Telegram, подписанную токеном бота. Подделать её,
//    не зная токена, нельзя (проверка — validateInitData, по документации
//    Telegram: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
// 2. Сервер находит пользователя системы поездок по привязке Telegram
//    (telegram_user_links.chat_id = id пользователя Telegram — в личном
//    чате они совпадают) и выдаёт короткоживущий токен сессии.
// 3. Страница шлёт его вместо Firebase ID-токена в Authorization: Bearer —
//    auth.js узнаёт его по префиксу 'tg.' и при КАЖДОМ запросе заново
//    проверяет, что привязка жива (отвязали Telegram — сессия мертва сразу).
//
// Токен сессии подписан ключом, производным от токена бота: сменили токен
// в BotFather — все сессии Mini App недействительны. Действует только для
// API системы поездок (/api/v1/*), остальной сайт его не принимает.
const crypto = require('crypto');

const SESSION_PREFIX = 'tg.';
const SESSION_TTL_MS = 12 * 3600 * 1000;
const INIT_DATA_MAX_AGE_SEC = 24 * 3600;

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Возвращает { telegramUserId, authDate } или null (подпись не сошлась,
// данные устарели, нет пользователя).
function validateInitData(initData, botToken, nowMs = Date.now()) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const secret = hmac('WebAppData', botToken);
  const checkString = (exclude) =>
    [...params.entries()]
      .filter(([key]) => !exclude.includes(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  // Поле signature (подпись для сторонних сервисов) Telegram добавил
  // позже; разные клиенты считают hash с ним и без него — принимаем оба.
  const ok = [['hash'], ['hash', 'signature']].some((exclude) =>
    safeEqualHex(hmac(secret, checkString(exclude)).toString('hex'), hash)
  );
  if (!ok) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowMs / 1000 - authDate > INIT_DATA_MAX_AGE_SEC) return null;
  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !Number.isInteger(user.id)) return null;
  return { telegramUserId: user.id, authDate };
}

const sessionKey = (botToken) => crypto.createHash('sha256').update(`stroy-hub/rides-webapp-session/${botToken}`).digest();

function issueSession(userId, botToken, nowMs = Date.now()) {
  const expiresAt = nowMs + SESSION_TTL_MS;
  const body = Buffer.from(JSON.stringify({ uid: userId, exp: expiresAt })).toString('base64url');
  const sig = hmac(sessionKey(botToken), body).toString('base64url');
  return { token: `${SESSION_PREFIX}${body}.${sig}`, expiresAt: new Date(expiresAt).toISOString() };
}

const isSessionToken = (token) => typeof token === 'string' && token.startsWith(SESSION_PREFIX);

// userId из живого токена сессии или null.
function verifySession(token, botToken, nowMs = Date.now()) {
  if (!isSessionToken(token) || !botToken) return null;
  const [body, sig] = token.slice(SESSION_PREFIX.length).split('.');
  if (!body || !sig) return null;
  const expected = hmac(sessionKey(botToken), body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(data.uid) || !(data.exp > nowMs)) return null;
  return data.uid;
}

module.exports = { validateInitData, issueSession, verifySession, isSessionToken, SESSION_TTL_MS };
