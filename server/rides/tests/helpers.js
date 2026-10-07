// Общая обвязка для тестов системы поездок (node:test, без доп. зависимостей):
// временная SQLite-база, заглушки вместо Firebase-авторизации, Socket.io и
// геокодера, и Express-приложение с роутерами заявок/водителей.
//
// Авторизация в тестах — заголовок x-test-email: роль берётся из rides.users
// по этому email, как это делает настоящий requireRideRole после проверки
// Firebase-токена.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RIDES_DIR = path.join(__dirname, '..');

function stubModule(relPath, exports) {
  const file = require.resolve(path.join(RIDES_DIR, relPath));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// Должен вызываться до первого require модулей системы поездок: db.js
// читает RIDES_DATA_DIR при загрузке. realSocket — оставить настоящий
// socket.js (без сервера Socket.io он только публикует во внутреннюю шину
// ridesBus — нужно тестам Telegram-бота).
function setupRidesTestApp({ realSocket = false } = {}) {
  process.env.RIDES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rides-test-'));

  const emitted = [];
  if (!realSocket) stubModule('socket.js', {
    initSocket() {},
    emitToDrivers: (event, payload) => emitted.push({ to: 'drivers', event, payload }),
    emitToDispatcher: (event, payload) => emitted.push({ to: 'dispatcher', event, payload }),
    emitToEmployee: (id, event, payload) => emitted.push({ to: `employee:${id}`, event, payload }),
    emitToDriver: (id, event, payload) => emitted.push({ to: `driver:${id}`, event, payload }),
    ridesBus: { on() {}, emit() {} },
  });
  stubModule('routeEstimate.js', { recomputeRequestEstimate: async () => null });

  const { initSchema, getWriteDb } = require(path.join(RIDES_DIR, 'db.js'));
  initSchema();
  const db = getWriteDb();

  const loadUser = (req) => {
    const email = (req.headers['x-test-email'] || '').toLowerCase();
    req.rideUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
  };
  const requireRideRole = (...roles) => (req, res, next) => {
    loadUser(req);
    if (!req.rideUser) return res.status(403).json({ error: 'not a ride user' });
    if (!roles.includes(req.rideUser.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
  stubModule('auth.js', {
    loadRideUser: (req, res, next) => { loadUser(req); next(); },
    requireAnyRideUser: requireRideRole('employee', 'dispatcher', 'driver'),
    requireRideRole,
    requireRoleOrSiteAdmin: requireRideRole,
    requireSiteAdmin: (req, res) => res.status(403).json({ error: 'forbidden' }),
    findRideUserByEmail: (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()),
    rideUserForEmail: (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) || null,
    isSiteAdminEmail: () => false,
  });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/requests', require(path.join(RIDES_DIR, 'requestsRouter.js')));
  app.use('/api/v1/drivers', require(path.join(RIDES_DIR, 'driversRouter.js')));

  return { app, db, emitted };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const call = async (email, method, url, body) => {
        const res = await fetch(base + url, {
          method,
          headers: { 'content-type': 'application/json', 'x-test-email': email },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };
      resolve({ server, call });
    });
  });
}

// Тестовые данные. Даты — далеко в будущем (2030), чтобы проверки «на
// заказе прямо сейчас» не зависели от момента запуска тестов.
function seedPeople(db, { driverStatuses = ['available', 'available'] } = {}) {
  const user = (email, role) =>
    db.prepare('INSERT INTO users (email, name, phone, role) VALUES (?, ?, ?, ?)').run(email, email, '+7700', role).lastInsertRowid;
  const employeeId = user('employee@test', 'employee');
  user('dispatcher@test', 'dispatcher');
  const driver = (email, status = 'available') => {
    const userId = user(email, 'driver');
    return db.prepare('INSERT INTO drivers (user_id, status) VALUES (?, ?)').run(userId, status).lastInsertRowid;
  };
  const drivers = driverStatuses.map((status, i) => driver(`driver${i + 1}@test`, status));
  return { employeeId, driver1: drivers[0], driver2: drivers[1], driver3: drivers[2], drivers };
}

function insertRequest(db, { employeeId, requestedAt, status = 'pending_assignment', driverId = null, durationMin = 60 }) {
  return db
    .prepare(
      `INSERT INTO requests (employee_id, driver_id, from_address, to_address, requested_at, purpose, duration_min, status, assigned_by)
       VALUES (?, ?, 'Базовая 3', 'Штабы', ?, 'тест', ?, ?, ?)`
    )
    .run(employeeId, driverId, requestedAt, durationMin, status, driverId ? 'self' : null).lastInsertRowid;
}

module.exports = { setupRidesTestApp, listen, seedPeople, insertRequest };
