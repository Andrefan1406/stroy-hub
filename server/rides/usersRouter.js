// /api/v1/users — роли и карточки людей (ФИО, телефон, должность).
// GET /me — для любого залогиненного (Firebase) — есть ли у него запись
// здесь и какая роль; на это опирается фронтовый гейт (см.
// src/components/RideAccessGate.jsx), который прячет остальной сайт от
// тех, у кого full_site_access = 0.
//
// Всё про людей ведёт ТОЛЬКО главный админ сайта (ADMIN_EMAIL, server/adminAuth.js):
// назначает роль и сразу заполняет карточку — ФИО, телефон, должность — в одной
// форме (PUT /:email). Диспетчер карточки не правит: он их только читает (нужны
// имена и телефоны водителей и пассажиров) и ведёт справочники водителей/машин
// (driversRouter.js/vehiclesRouter.js). Главному админу роль не назначают: он
// проходит любую проверку роли по email (см. auth.js), его служебная запись
// (role 'admin') в списке не показывается и через эти эндпоинты не меняется
// (rejectSiteAdminTarget); свои ФИО и телефон он вписывает сам (PATCH /me).
//
// Роли: employee/dispatcher/driver — система поездок; staff (сотрудник без
// доступа к поездкам), chief_engineer, prom_alyans, driller — заявки на бурение
// и резку (server/drilling/). У них доступ ко всему сайту зашит в роль:
// driller заперт на своей странице, остальные пользуются всем сайтом.
const express = require('express');
const { z } = require('zod');
const { getAuth } = require('firebase-admin/auth');
const { getWriteDb } = require('./db');
const { loadRideUser, requireSiteAdmin, requireRoleOrSiteAdmin, isSiteAdminEmail, RIDE_ROLES } = require('./auth');
const { ADMIN_EMAIL } = require('../adminAuth');
const telegramStore = require('./telegram/store');

const router = express.Router();

// Служебную запись главного админа не трогаем: смена роли лишила бы его
// доступа к панелям по role 'admin' (сокет-комнаты), удаление — сломало бы
// ссылки его заявок на users.id.
function rejectSiteAdminTarget(req, res, next) {
  if (isSiteAdminEmail(req.params.email)) {
    return res.status(400).json({ error: 'Главному администратору роль не назначается — у него доступ ко всем панелям' });
  }
  next();
}

function serializeUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    position: row.position || '',
    companyId: row.company_id || null,
    role: row.role,
    fullSiteAccess: !!row.full_site_access,
  };
}

router.get('/me', loadRideUser, (req, res) => {
  res.json({ user: req.rideUser ? serializeUser(req.rideUser) : null });
});

// Главный админ сам заполняет свои ФИО и телефон — их видит водитель в его
// заявках. Его карточку в списке не ведут (служебная запись скрыта,
// rejectSiteAdminTarget). Объявлено до /:email, иначе 'me' приняли бы за email.
const ownContactSchema = z.object({
  name: z.string().trim().min(2, 'Укажите ФИО').max(120),
  phone: z.string().trim().regex(/^\+?[\d\s()-]{10,20}$/, 'Укажите телефон, например +7 701 123 45 67'),
});

router.patch('/me', loadRideUser, (req, res) => {
  if (!req.isSiteAdmin || !req.rideUser) {
    return res.status(403).json({ error: 'ФИО и телефон заполняет главный администратор' });
  }
  const result = ownContactSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.issues[0]?.message || 'Некорректные данные' });
  }
  const db = getWriteDb();
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(result.data.name, result.data.phone, req.rideUser.id);
  res.json({ user: serializeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.rideUser.id)) });
});

// И главному админу (полный список + назначение ролей), и диспетчеру
// (только чтение карточек людей системы поездок) нужен один и тот же список
// пользователей Firebase — различается то, что каждый из них видит.
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
  // этого любая неожиданная строка/данные роняют запрос без JSON-тела —
  // клиент видит голый "Ошибка сервера (500)" вместо понятного сообщения.
  try {
    // .filter(r => r.email) — на случай строки без email, оставшейся с более
    // ранней версии схемы: такая строка не должна обрушивать весь список.
    const localByEmail = new Map(
      db.prepare('SELECT * FROM users').all().filter((r) => r.email).map((r) => [r.email.toLowerCase(), r])
    );

    const merged = [];
    for (const fu of firebaseUsers) {
      if (!fu.email || isSiteAdminEmail(fu.email)) continue;
      const key = fu.email.toLowerCase();
      const local = localByEmail.get(key);
      localByEmail.delete(key);
      merged.push({
        id: local?.id || null,
        email: fu.email,
        displayName: fu.displayName || null,
        name: local?.name || '',
        phone: local?.phone || '',
        position: local?.position || '',
        companyId: local?.company_id || null,
        role: local?.role || null,
        fullSiteAccess: local ? !!local.full_site_access : false,
      });
    }
    // Локальные записи без соответствующего Firebase-аккаунта (удалён/переименован)
    // всё равно показываем, чтобы главный админ мог их убрать вручную.
    for (const leftover of localByEmail.values()) {
      if (isSiteAdminEmail(leftover.email)) continue;
      merged.push({
        id: leftover.id,
        email: leftover.email,
        displayName: null,
        name: leftover.name,
        phone: leftover.phone,
        position: leftover.position || '',
        companyId: leftover.company_id || null,
        role: leftover.role,
        fullSiteAccess: !!leftover.full_site_access,
      });
    }
    merged.sort((a, b) => a.email.localeCompare(b.email));

    if (isSiteAdmin) {
      return res.json({ users: merged });
    }

    // Диспетчер: только люди системы поездок, только чтение (имя и телефон).
    const result = merged
      .filter((u) => u.role && RIDE_ROLES.includes(u.role))
      .map(({ fullSiteAccess, position, companyId, ...rest }) => rest);
    res.json({ users: result });
  } catch (err) {
    console.error('GET /api/v1/users не сработал:', err);
    res.status(500).json({ error: 'Не удалось собрать список пользователей' });
  }
});

// Роли, которые назначает главный админ. Доступ ко всему сайту у ролей
// по заявкам на бурение зашит: бурильщик заперт на своей странице, остальные
// пользуются всем сайтом. Для ролей поездок флаг выбирает админ.
const ASSIGNABLE_ROLES = ['employee', 'dispatcher', 'driver', 'staff', 'chief_engineer', 'prom_alyans', 'driller'];
const FIXED_SITE_ACCESS = { staff: true, chief_engineer: true, prom_alyans: true, driller: false };
const PHONE_REQUIRED_ROLES = ['employee', 'dispatcher', 'driver'];

const roleAssignmentSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  fullSiteAccess: z.boolean().default(false),
  name: z.string().trim().min(1, 'Укажите ФИО').max(120),
  phone: z.string().trim().max(40).default(''),
  position: z.string().trim().max(200).default(''),
  companyId: z.number().int().positive().nullable().optional(),
});

// Главный админ: роль + карточка одной формой. ФИО нужно всем; телефон — ролям
// поездок; должность — главному инженеру (она в подписи документа); бурильщику —
// компания-субподрядчик. Главный инженер может быть только один.
router.put('/:email', requireSiteAdmin, rejectSiteAdminTarget, (req, res) => {
  const result = roleAssignmentSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.issues[0]?.message || 'Некорректные данные запроса' });
  }
  const { role, name, phone, position, companyId } = result.data;
  if (PHONE_REQUIRED_ROLES.includes(role) && !phone) {
    return res.status(400).json({ error: 'Укажите телефон' });
  }
  if (role === 'chief_engineer' && !position) {
    return res.status(400).json({ error: 'Укажите должность главного инженера — она печатается в подписи' });
  }
  if (role === 'driller') {
    const drilling = require('../drilling/service');
    if (!companyId || !drilling.isSubcontractor(companyId)) {
      return res.status(400).json({ error: 'Выберите компанию-субподрядчика для бурильщика' });
    }
  }

  const db = getWriteDb();
  const email = req.params.email.toLowerCase();

  if (role === 'chief_engineer') {
    const other = db.prepare("SELECT email, name FROM users WHERE role = 'chief_engineer' AND email != ?").get(email);
    if (other) {
      return res.status(409).json({ error: `Главным инженером уже назначен ${other.name || other.email} (${other.email}). Сначала снимите роль с него.` });
    }
  }

  const fullSiteAccess = role in FIXED_SITE_ACCESS ? FIXED_SITE_ACCESS[role] : result.data.fullSiteAccess;
  const company = role === 'driller' ? companyId : null;
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (existing) {
    db.prepare('UPDATE users SET role = ?, full_site_access = ?, name = ?, phone = ?, position = ?, company_id = ? WHERE id = ?')
      .run(role, fullSiteAccess ? 1 : 0, name, phone, position, company, existing.id);
  } else {
    db.prepare('INSERT INTO users (email, name, phone, position, company_id, role, full_site_access) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(email, name, phone, position, company, role, fullSiteAccess ? 1 : 0);
  }

  res.json({ user: serializeUser(db.prepare('SELECT * FROM users WHERE email = ?').get(email)) });
});

router.delete('/:email', requireSiteAdmin, rejectSiteAdminTarget, (req, res) => {
  const db = getWriteDb();
  const email = req.params.email.toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing) return res.status(404).json({ error: 'Пользователь не найден в системе поездок' });

  const hasDriverProfile = db.prepare('SELECT 1 FROM drivers WHERE user_id = ?').get(existing.id);
  if (hasDriverProfile) {
    return res.status(409).json({ error: 'У пользователя есть карточка водителя — сначала удалите её в разделе "Водители"' });
  }

  db.transaction(() => {
    telegramStore.forgetUser(db, existing.id); // привязка Telegram ссылается на пользователя
    db.prepare('DELETE FROM users WHERE id = ?').run(existing.id);
  })();
  res.json({ ok: true });
});

module.exports = router;
