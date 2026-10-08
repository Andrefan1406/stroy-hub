// /api/v1/drivers — CRUD карточек водителей ведёт диспетчер (тот же
// человек, что и справочник машин в vehiclesRouter.js) + водитель сам
// переключает себя online/offline (available <-> offline; busy проставляет
// только сервер при взятии заказа, вручную недоступен). Главный админ
// сайта карточки только читает, см. requireRoleOrSiteAdmin ниже.
const express = require('express');
const { z } = require('zod');
const { getWriteDb } = require('./db');
const { requireRideRole, requireRoleOrSiteAdmin } = require('./auth');
const { findDriverConflict } = require('./driverAvailability');
const { setLineStatus } = require('./driverActions');
const telegramStore = require('./telegram/store');
const { telegramInfo } = require('./telegram');

const router = express.Router();

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Некорректные данные запроса' });
    }
    req.body = result.data;
    next();
  };
}

const driverSchema = z.object({
  userId: z.coerce.number().int().positive(),
  vehicleId: z.coerce.number().int().positive().nullable().optional(),
});

const driverUpdateSchema = z.object({
  vehicleId: z.coerce.number().int().positive().nullable().optional(),
  status: z.enum(['available', 'busy', 'offline']).optional(),
  // Уволить/восстановить — см. комментарий у колонки active в db.js. Отдельно
  // от status: "офлайн" — временное "не на смене", "неактивен" — ушёл совсем.
  active: z.boolean().optional(),
});

const selfStatusSchema = z.object({
  status: z.enum(['available', 'offline']),
});

function serialize(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    phone: row.phone,
    vehicleId: row.vehicle_id,
    vehiclePlate: row.plate_number || null,
    status: row.status,
    active: !!row.active,
    // Подключён ли Telegram-бот (и не заблокирован водителем).
    telegramLinked: row.telegram_chat_id != null && !row.telegram_blocked,
  };
}

const FULL_SELECT = `
  SELECT d.*, u.name, u.phone, v.plate_number,
         tl.chat_id AS telegram_chat_id, tl.blocked AS telegram_blocked
  FROM drivers d
  JOIN users u ON u.id = d.user_id
  LEFT JOIN vehicles v ON v.id = d.vehicle_id
  LEFT JOIN telegram_user_links tl ON tl.user_id = d.user_id
`;

router.get('/', requireRoleOrSiteAdmin('dispatcher'), (req, res) => {
  const rows = getWriteDb().prepare(`${FULL_SELECT} ORDER BY u.name`).all();
  res.json({ drivers: rows.map(serialize) });
});

// Диспетчеру нужен именно список свободных — для формы принудительного
// назначения; уволенных (active=0) сюда не пускаем, даже если статус в базе
// остался "available" (не должно случаться — архивирование сбрасывает его в
// offline, см. PATCH ниже, но фильтр не помешает на случай рассинхрона).
// Кандидаты на назначение: работающие водители на линии. С ?requestId=N —
// только те, у кого нет заказа, пересекающегося по времени с заявкой N
// (занятость по интервалам, см. driverAvailability.js): водитель с заказом
// на завтра свободен для сегодняшней заявки.
router.get('/available', requireRideRole('dispatcher'), (req, res) => {
  const db = getWriteDb();
  let rows = db.prepare(`${FULL_SELECT} WHERE d.status != 'offline' AND d.active = 1 ORDER BY u.name`).all();
  const requestId = Number(req.query.requestId);
  if (requestId) {
    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    if (!request) return res.status(404).json({ error: 'Заявка не найдена' });
    rows = rows.filter((row) => !findDriverConflict(db, row.id, request));
  }
  res.json({ drivers: rows.map(serialize) });
});

// Собственный профиль водителя (статус online/offline/busy, закреплённая машина).
router.get('/me', requireRideRole('driver'), (req, res) => {
  const row = getWriteDb().prepare(`${FULL_SELECT} WHERE d.user_id = ?`).get(req.rideUser.id);
  // Главный админ смотрит панель водителя, не будучи водителем.
  if (!row && req.isSiteAdmin) return res.json({ driver: null });
  if (!row) return res.status(404).json({ error: 'Вы не зарегистрированы как водитель' });
  res.json({ driver: serialize(row), telegram: telegramInfo() });
});

// Ссылка привязки Telegram: t.me/<бот>?start=<одноразовый токен на 15 мин>.
// Водитель открывает её — бот получает токен и привязывает чат.
router.post('/me/telegram-link', requireRideRole('driver'), (req, res) => {
  const info = telegramInfo();
  if (!info.enabled) return res.status(503).json({ error: 'Telegram-бот сейчас не подключён на сервере' });
  const db = getWriteDb();
  const driver = db.prepare('SELECT * FROM drivers WHERE user_id = ? AND active = 1').get(req.rideUser.id);
  if (!driver) return res.status(403).json({ error: 'Вы не зарегистрированы как водитель' });
  const { token, expiresAt } = telegramStore.createLinkToken(db, req.rideUser.id);
  res.json({ url: `https://t.me/${info.username}?start=${token}`, expiresAt });
});

router.delete('/me/telegram', requireRideRole('driver'), (req, res) => {
  const db = getWriteDb();
  const driver = db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(req.rideUser.id);
  if (!driver) return res.status(403).json({ error: 'Вы не зарегистрированы как водитель' });
  telegramStore.unlinkDriver(db, driver.id);
  res.json({ ok: true });
});

router.post('/', requireRideRole('dispatcher'), validate(driverSchema), (req, res) => {
  const db = getWriteDb();
  const user = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'driver'`).get(req.body.userId);
  if (!user) return res.status(400).json({ error: 'Пользователь не найден или не имеет роли "водитель"' });

  try {
    const info = db
      .prepare('INSERT INTO drivers (user_id, vehicle_id) VALUES (?, ?)')
      .run(req.body.userId, req.body.vehicleId ?? null);
    res.status(201).json({ driver: serialize(db.prepare(`${FULL_SELECT} WHERE d.id = ?`).get(info.lastInsertRowid)) });
  } catch (err) {
    res.status(409).json({ error: 'У этого пользователя уже есть карточка водителя' });
  }
});

router.patch('/:id', requireRideRole('dispatcher'), validate(driverUpdateSchema), (req, res) => {
  const db = getWriteDb();
  const existing = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Водитель не найден' });

  const archiving = req.body.active === false && existing.active;
  if (archiving) {
    // Тот же кейс, что и у DELETE: нельзя убрать из работы того, кто прямо
    // сейчас в рейсе — водитель освободится с активным заказом на руках.
    const inUse = db.prepare(`SELECT 1 FROM requests WHERE driver_id = ? AND status IN ('assigned', 'in_progress')`).get(req.params.id);
    if (inUse) return res.status(409).json({ error: 'У водителя есть активный заказ — сначала закройте его' });
  }

  const next = {
    vehicle_id: req.body.vehicleId !== undefined ? req.body.vehicleId : existing.vehicle_id,
    // Уволенный не может остаться "доступен"/"занят" — archiving форсирует offline.
    status: archiving ? 'offline' : req.body.status ?? existing.status,
    active: req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active,
  };
  db.prepare('UPDATE drivers SET vehicle_id = ?, status = ?, active = ? WHERE id = ?')
    .run(next.vehicle_id, next.status, next.active, req.params.id);
  // Уволенному — никаких рассылок: Telegram отвязывается.
  if (archiving) telegramStore.unlinkDriver(db, existing.id);
  res.json({ driver: serialize(db.prepare(`${FULL_SELECT} WHERE d.id = ?`).get(req.params.id)) });
});

router.delete('/:id', requireRideRole('dispatcher'), (req, res) => {
  const db = getWriteDb();
  const inUse = db.prepare(`SELECT 1 FROM requests WHERE driver_id = ? AND status IN ('assigned', 'in_progress')`).get(req.params.id);
  if (inUse) return res.status(409).json({ error: 'У водителя есть активный заказ — сначала закройте его' });
  try {
    const driver = db.prepare('SELECT user_id FROM drivers WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM drivers WHERE id = ?').run(req.params.id);
    if (driver) telegramStore.unlinkUser(db, driver.user_id);
  } catch (err) {
    // requests.driver_id хранит водителя для ЛЮБОГО статуса, не только
    // активного (иначе завершённая поездка потеряла бы, кто её вёз) —
    // проверка выше ловит только "активный заказ", а водитель с ЗАВЕРШЁННОЙ
    // историей (или записью в request_merges) всё равно валит DELETE
    // ограничением внешнего ключа. Это ожидаемое ограничение схемы (историю
    // поездок не теряем), но раньше падало без ответа клиенту вовсе.
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return res.status(409).json({ error: 'У водителя есть история заказов — карточку нельзя удалить' });
    }
    throw err;
  }
  res.json({ ok: true });
});

// Водитель сам ставит себя online/offline перед сменой.
router.patch('/me/status', requireRideRole('driver'), validate(selfStatusSchema), (req, res) => {
  const out = setLineStatus({ userId: req.rideUser.id, status: req.body.status });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ driver: serialize(getWriteDb().prepare(`${FULL_SELECT} WHERE d.id = ?`).get(out.driver.id)) });
});

module.exports = router;
