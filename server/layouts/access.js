// Доступ к схемам бытовок: главный админ сайта и те, кого он добавил в
// список (layout_editors). Проверка — по Firebase ID-токену, как у
// остальных админ-эндпоинтов (server/adminAuth.js), на каждый REST-запрос
// и на подключение сокета; правки по сокету перепроверяют список — убрали
// человека из списка, и его следующая правка уже не пройдёт.
const { getAuth } = require('firebase-admin/auth');
const { ADMIN_EMAIL } = require('../adminAuth'); // заодно инициализирует firebase-admin
const store = require('./store');

const isSiteAdmin = (email) => !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
const canEditLayouts = (email) => isSiteAdmin(email) || store.isEditor(email);

async function emailFromToken(token) {
  const decoded = await getAuth().verifyIdToken(token);
  return (decoded.email || '').toLowerCase();
}

// req.layoutUser = { email, isAdmin }; без доступа — 403.
function requireLayoutAccess({ adminOnly = false } = {}) {
  return async (req, res, next) => {
    const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: 'Не передан токен авторизации' });
    let email;
    try {
      email = await emailFromToken(match[1]);
    } catch {
      return res.status(401).json({ error: 'Недействительный или просроченный токен авторизации' });
    }
    const allowed = adminOnly ? isSiteAdmin(email) : canEditLayouts(email);
    if (!allowed) {
      return res.status(403).json({
        error: adminOnly ? 'Только главный администратор сайта' : 'Нет доступа к схемам бытовок — попросите администратора добавить вас',
      });
    }
    req.layoutUser = { email, isAdmin: isSiteAdmin(email) };
    next();
  };
}

module.exports = { isSiteAdmin, canEditLayouts, emailFromToken, requireLayoutAccess };
