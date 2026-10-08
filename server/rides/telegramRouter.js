// /api/v1/telegram — подключение Telegram-бота к своей странице системы
// поездок (пассажир, диспетчер; у водителя то же самое живёт в
// driversRouter.js /me/telegram*) и вход в Telegram Mini App.
const express = require('express');
const { getWriteDb } = require('./db');
const { requireAnyRideUser } = require('./auth');
const { validate, z } = require('./requestView');
const telegramStore = require('./telegram/store');
const { telegramInfo, botToken } = require('./telegram');
const { validateInitData, issueSession } = require('./telegram/webappAuth');

const router = express.Router();

// Состояние для страницы: включён ли бот на сервере, подключён ли этот
// пользователь, работает ли Mini App.
router.get('/me', requireAnyRideUser, (req, res) => {
  const info = telegramInfo();
  const link = req.rideUser ? telegramStore.getLinkByUser(getWriteDb(), req.rideUser.id) : null;
  res.json({ ...info, linked: !!link && !link.blocked });
});

// Ссылка привязки: t.me/<бот>?start=<одноразовый токен на 15 мин>.
router.post('/link', requireAnyRideUser, (req, res) => {
  const info = telegramInfo();
  if (!info.enabled) return res.status(503).json({ error: 'Telegram-бот сейчас не подключён на сервере' });
  const db = getWriteDb();
  if (!req.rideUser || !telegramStore.canLink(db, req.rideUser.id)) {
    return res.status(403).json({ error: 'Подключить Telegram сейчас нельзя — обратитесь к диспетчеру' });
  }
  const { token, expiresAt } = telegramStore.createLinkToken(db, req.rideUser.id);
  res.json({ url: `https://t.me/${info.username}?start=${token}`, expiresAt });
});

router.delete('/link', requireAnyRideUser, (req, res) => {
  if (req.rideUser) telegramStore.unlinkUser(getWriteDb(), req.rideUser.id);
  res.json({ ok: true });
});

// Вход в Mini App: подписанные Telegram данные -> токен сессии
// (telegram/webappAuth.js). Без Firebase-токена — его внутри Telegram нет;
// личность доказывает подпись Telegram, доступ — привязка на сайте.
const sessionSchema = z.object({ initData: z.string().min(1).max(4096) });

router.post('/webapp-session', validate(sessionSchema), (req, res) => {
  const token = botToken();
  if (!token || !telegramInfo().enabled) return res.status(503).json({ error: 'Telegram-бот сейчас не подключён на сервере' });
  const data = validateInitData(req.body.initData, token);
  if (!data) return res.status(401).json({ error: 'Telegram не подтвердил вход — закройте окно и откройте его из бота ещё раз' });

  const db = getWriteDb();
  const ctx = telegramStore.getChatContext(db, data.telegramUserId);
  if (!ctx || ctx.blocked) {
    return res.status(403).json({
      error: 'Этот Telegram не подключён к системе служебного транспорта. Откройте свою страницу на сайте и нажмите «Подключить Telegram».',
    });
  }
  const session = issueSession(ctx.user_id, token);
  res.json({ ...session, user: { id: ctx.user_id, name: ctx.name, role: ctx.role } });
});

module.exports = router;
