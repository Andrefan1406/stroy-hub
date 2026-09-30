// /api/v1/drivers — CRUD карточек водителей ведёт диспетчер (тот же
// человек, что и справочник машин в vehiclesRouter.js) + водитель сам
// переключает себя online/offline (available <-> offline; busy проставляет
// только сервер при взятии заказа, вручную недоступен). Главный админ
// сайта карточки только читает, см. requireRoleOrSiteAdmin ниже.
const express = require('express');
const { z } = require('zod');
const { getWriteDb } = require('./db');
const { requireRideRole, requireRoleOrSiteAdmin } = require('./auth');

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
  };
}

const FULL_SELECT = `
  SELECT d.*, u.name, u.phone, v.plate_number
  FROM drivers d
  JOIN users u ON u.id = d.user_id
  LEFT JOIN vehicles v ON v.id = d.vehicle_id
`;

router.get('/', requireRoleOrSiteAdmin('dispatcher'), (req, res) => {
  const rows = getWriteDb().prepare(`${FULL_SELECT} ORDER BY u.name`).all();
  res.json({ drivers: rows.map(serialize) });
});

// Диспетчеру нужен именно список свободных — для формы принудительного назначения.
router.get('/available', requireRideRole('dispatcher'), (req, res) => {
  const rows = getWriteDb().prepare(`${FULL_SELECT} WHERE d.status = 'available' ORDER BY u.name`).all();
  res.json({ drivers: rows.map(serialize) });
});

// Собственный профиль водителя (статус online/offline/busy, закреплённая машина).
router.get('/me', requireRideRole('driver'), (req, res) => {
  const row = getWriteDb().prepare(`${FULL_SELECT} WHERE d.user_id = ?`).get(req.rideUser.id);
  if (!row) return res.status(404).json({ error: 'Вы не зарегистрированы как водитель' });
  res.json({ driver: serialize(row) });
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

  const next = {
    vehicle_id: req.body.vehicleId !== undefined ? req.body.vehicleId : existing.vehicle_id,
    status: req.body.status ?? existing.status,
  };
  db.prepare('UPDATE drivers SET vehicle_id = ?, status = ? WHERE id = ?').run(next.vehicle_id, next.status, req.params.id);
  res.json({ driver: serialize(db.prepare(`${FULL_SELECT} WHERE d.id = ?`).get(req.params.id)) });
});

router.delete('/:id', requireRideRole('dispatcher'), (req, res) => {
  const db = getWriteDb();
  const inUse = db.prepare(`SELECT 1 FROM requests WHERE driver_id = ? AND status IN ('assigned', 'in_progress')`).get(req.params.id);
  if (inUse) return res.status(409).json({ error: 'У водителя есть активный заказ — сначала закройте его' });
  try {
    db.prepare('DELETE FROM drivers WHERE id = ?').run(req.params.id);
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
  const db = getWriteDb();
  const driver = db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(req.rideUser.id);
  if (!driver) return res.status(403).json({ error: 'Вы не зарегистрированы как водитель' });
  if (driver.status === 'busy') {
    return res.status(409).json({ error: 'Нельзя менять статус, пока не закрыт текущий заказ' });
  }
  db.prepare('UPDATE drivers SET status = ? WHERE id = ?').run(req.body.status, driver.id);
  res.json({ driver: serialize(db.prepare(`${FULL_SELECT} WHERE d.id = ?`).get(driver.id)) });
});

module.exports = router;
