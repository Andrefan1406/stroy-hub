// /api/v1/users — управление допуском к системе поездок.
// GET /me — для любого залогиненного (Firebase) — есть ли у него запись
// здесь и какая роль; на это опирается фронтовый гейт (см.
// src/components/RideAccessGate.jsx), который прячет остальной сайт от
// тех, у кого full_site_access = 0.
//
// Разделение обязанностей на остальных эндпоинтах:
// - Главный админ сайта (ADMIN_EMAIL, server/adminAuth.js) — ТОЛЬКО
//   назначает роль и full_site_access. Имя/телефон он не трогает и не
//   видит их в своей форме — это не его забота. У него самого записи в
//   этой таблице нет: он не сотрудник/диспетчер/водитель, а отдельная
//   функция сверху, определяется по email, а не по роли.
// - Диспетчер (он же ведёт справочники водителей/машин, см.
//   driversRouter.js/vehiclesRouter.js) заполняет "карточку" — имя и
//   телефон — тем, кому роль уже назначил главный админ. Роль и
//   full_site_access ему не видны и не редактируются: это не его решение.
const express = require('express');
const { z } = require('zod');
const { getAuth } = require('firebase-admin/auth');
const { getWriteDb } = require('./db');
const { loadRideUser, requireSiteAdmin, requireRoleOrSiteAdmin } = require('./auth');
const { ADMIN_EMAIL } = require('../adminAuth');

const router = express.Router();

function serializeUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    role: row.role,
    fullSiteAccess: !!row.full_site_access,
  };
}

router.get('/me', loadRideUser, (req, res) => {
  res.json({ user: req.rideUser ? serializeUser(req.rideUser) : null });
});

// И главному админу (полный список + назначение ролей), и диспетчеру
// (карточки уже назначенных) нужен один и тот же список пользователей
// Firebase — различается только то, что каждый из них в ответе видит и
// может редактировать (см. фильтрацию в конце функции).
router.get('/', requireRoleOrSiteAdmin('dispatcher'), async (req, res) => {
  const db = getWriteDb();
  const isSiteAdmin = req.firebaseEmail?.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  let firebaseUsers;
  try {
    firebaseUsers = (await getAuth().listUsers(1000)).users;
  } catch (err) {
    // Реальная причина (обычно — нет/неверный service account: см.
    // server/rides/README.md про GOOGLE_APPLICATION_CREDENTIALS) видна
    // только здесь, в логе бэкенда — клиенту отдаём общее сообщение,
    // чтобы не светить детали инфраструктуры наружу.
    console.error('listUsers() не сработал — вероятно, не задан валидный GOOGLE_APPLICATION_CREDENTIALS:', err);
    return res.status(502).json({ error: 'Не удалось получить список пользователей Firebase' });
  }

  // Весь остальной путь — тоже под try/catch (не только listUsers()): без
  // этого любая неожиданная строка/данные (например, задание с БД до
  // текущей NOT NULL-схемы) роняют запрос без JSON-тела — клиент видит
  // голый "Ошибка сервера (500)" вместо понятного сообщения, а причина
  // видна только тут, в логе бэкенда.
  try {
    // .filter(r => r.email) — на случай строки без email, оставшейся с более
    // ранней версии схемы (до NOT NULL на этой колонке, см. db.js): такая
    // строка не даст восстановить исходный email обратно, но не должна
    // обрушивать весь список остальных пользователей.
    const localByEmail = new Map(
      db.prepare('SELECT * FROM users').all().filter((r) => r.email).map((r) => [r.email.toLowerCase(), r])
    );

    const merged = [];
    for (const fu of firebaseUsers) {
      if (!fu.email) continue;
      const key = fu.email.toLowerCase();
      const local = localByEmail.get(key);
      localByEmail.delete(key);
      merged.push({
        id: local?.id || null,
        email: fu.email,
        displayName: fu.displayName || null,
        name: local?.name || '',
        phone: local?.phone || '',
        role: local?.role || null,
        fullSiteAccess: local ? !!local.full_site_access : false,
      });
    }
    // Локальные записи без соответствующего Firebase-аккаунта (удалён/переименован)
    // всё равно показываем, чтобы главный админ мог их убрать вручную.
    for (const leftover of localByEmail.values()) {
      merged.push({
        id: leftover.id,
        email: leftover.email,
        displayName: null,
        name: leftover.name,
        phone: leftover.phone,
        role: leftover.role,
        fullSiteAccess: !!leftover.full_site_access,
      });
    }
    merged.sort((a, b) => a.email.localeCompare(b.email));

    if (isSiteAdmin) {
      return res.json({ users: merged });
    }

    // Диспетчер: только тем, кому роль уже назначена, без full_site_access
    // (это не его рычаг) — заполняет карточку (имя/телефон) уже готовым записям.
    const result = merged.filter((u) => u.role).map(({ fullSiteAccess, ...rest }) => rest);
    res.json({ users: result });
  } catch (err) {
    console.error('GET /api/v1/users не сработал:', err);
    res.status(500).json({ error: 'Не удалось собрать список пользователей' });
  }
});

const roleAssignmentSchema = z.object({
  role: z.enum(['employee', 'dispatcher', 'driver']),
  fullSiteAccess: z.boolean().default(false),
});

const cardSchema = z.object({
  name: z.string().trim().min(1, 'Укажите имя'),
  phone: z.string().trim().min(1, 'Укажите телефон'),
});

// Главный админ: назначить/сменить роль и full_site_access. Имя/телефон
// он не присылает — при первом назначении роли новому email они остаются
// пустыми, пока диспетчер не заполнит карточку (см. PATCH ниже).
router.put('/:email', requireSiteAdmin, (req, res) => {
  const result = roleAssignmentSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.issues[0]?.message || 'Некорректные данные запроса' });
  }
  const { role, fullSiteAccess } = result.data;

  const db = getWriteDb();
  const email = req.params.email.toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (existing) {
    db.prepare('UPDATE users SET role = ?, full_site_access = ? WHERE id = ?')
      .run(role, fullSiteAccess ? 1 : 0, existing.id);
  } else {
    db.prepare('INSERT INTO users (email, name, phone, role, full_site_access) VALUES (?, ?, ?, ?, ?)')
      .run(email, '', '', role, fullSiteAccess ? 1 : 0);
  }

  res.json({ user: serializeUser(db.prepare('SELECT * FROM users WHERE email = ?').get(email)) });
});

// Диспетчер: заполнить карточку (имя/телефон) уже существующей записи —
// роль он не назначает и создать новую запись не может, только дополняет то,
// что до него сделал главный админ.
router.patch('/:email', requireRoleOrSiteAdmin('dispatcher'), (req, res) => {
  const isSiteAdmin = req.firebaseEmail?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  if (isSiteAdmin) {
    return res.status(403).json({ error: 'Имя и телефон заполняет диспетчер, не главный админ' });
  }
  const result = cardSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.issues[0]?.message || 'Некорректные данные запроса' });
  }

  const db = getWriteDb();
  const email = req.params.email.toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing) return res.status(404).json({ error: 'Сначала главный админ должен назначить этому email роль' });

  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?')
    .run(result.data.name, result.data.phone, existing.id);
  res.json({ user: serializeUser(db.prepare('SELECT * FROM users WHERE email = ?').get(email)) });
});

router.delete('/:email', requireSiteAdmin, (req, res) => {
  const db = getWriteDb();
  const email = req.params.email.toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing) return res.status(404).json({ error: 'Пользователь не найден в системе поездок' });

  const hasDriverProfile = db.prepare('SELECT 1 FROM drivers WHERE user_id = ?').get(existing.id);
  if (hasDriverProfile) {
    return res.status(409).json({ error: 'У пользователя есть карточка водителя — сначала удалите её в разделе "Водители"' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

module.exports = router;
