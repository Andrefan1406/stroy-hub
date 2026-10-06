// Socket.io для системы поездок: 'drivers' (все свободные водители,
// broadcast о новых/забранных заявках пула), 'dispatcher' (мониторинг),
// 'employee:{userId}' (уведомление конкретного сотрудника, что его заказ
// взяли) и 'driver:{driverId}' (уведомление конкретного водителя, что ему
// принудительно назначили заказ диспетчером — свои же действия водитель
// и так видит из ответа REST-запроса, эта комната только для чужих
// действий над его заказами). Комнату сокет получает не по слову клиента,
// а по роли из rides.users после проверки Firebase ID-токена — иначе
// любой мог бы подключиться с auth:{room:'employee:5'} и подслушивать
// чужие заявки (там телефон заказчика).
const { Server } = require('socket.io');
const { getAuth } = require('firebase-admin/auth');
const { rideUserForEmail } = require('./auth');
const { getWriteDb } = require('./db');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Не передан токен авторизации'));
    try {
      const decoded = await getAuth().verifyIdToken(token);
      const rideUser = rideUserForEmail(decoded.email);
      if (!rideUser) return next(new Error('Вы не добавлены как пользователь системы служебного транспорта'));
      socket.rideUser = rideUser;
      next();
    } catch (err) {
      next(new Error('Недействительный или просроченный токен авторизации'));
    }
  });

  io.on('connection', (socket) => {
    const { role, id } = socket.rideUser;
    if (role === 'driver') {
      socket.join('drivers');
      const driver = getWriteDb().prepare('SELECT id FROM drivers WHERE user_id = ?').get(id);
      if (driver) socket.join(`driver:${driver.id}`);
    }
    if (role === 'dispatcher') socket.join('dispatcher');
    // Главный админ (служебная запись, см. auth.js) смотрит все три панели —
    // ему нужны события и диспетчера, и пула водителей.
    if (role === 'admin') {
      socket.join('dispatcher');
      socket.join('drivers');
    }
    // Диспетчер (и админ) иногда сам подаёт заявку (как сотрудник) — ему
    // тоже нужны уведомления по комнате employee:{id} о своих же заявках.
    if (role === 'employee' || role === 'dispatcher' || role === 'admin') socket.join(`employee:${id}`);
  });

  return io;
}

function emitToDrivers(event, payload) {
  io?.to('drivers').emit(event, payload);
}

function emitToDispatcher(event, payload) {
  io?.to('dispatcher').emit(event, payload);
}

function emitToEmployee(employeeId, event, payload) {
  io?.to(`employee:${employeeId}`).emit(event, payload);
}

function emitToDriver(driverId, event, payload) {
  io?.to(`driver:${driverId}`).emit(event, payload);
}

module.exports = { initSocket, emitToDrivers, emitToDispatcher, emitToEmployee, emitToDriver };
