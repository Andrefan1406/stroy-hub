// Совместная правка схемы бытовок по Socket.io — отдельное пространство
// '/layouts' на том же сервере, что и система поездок (rides/socket.js),
// со своей проверкой доступа.
//
// Клиент -> сервер:
//   join   { layoutId }               -> ack { layout, peers } (снимок схемы и кто ещё здесь)
//   op     { layoutId, op }           -> ack { ok, revision } | { error }; остальным — 'op'
//   move   { layoutId, id, x, y, rotation } — перетаскивание «на лету», только пересылка;
//                                       итоговое положение приходит отдельной op
//   cursor { layoutId, x, y, selectedId } — курсор и выделение, только пересылка
// Сервер -> клиент: op, move, cursor, peer:joined, peer:left.
//
// Правки сохраняются сразу (одна строка в SQLite), курсоры и движение на
// лету — нет. При обрыве связи клиент переподключается и снова делает join.
const { emailFromToken, canEditLayouts } = require('./access');
const store = require('./store');

const COLORS = ['#e53935', '#8e24aa', '#3949ab', '#00897b', '#f4511e', '#6d4c41', '#c0ca33', '#039be5'];
const room = (layoutId) => `layout:${layoutId}`;

function colorFor(email) {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function initLayoutsSocket(io) {
  const nsp = io.of('/layouts');

  nsp.use(async (socket, next) => {
    try {
      const email = await emailFromToken(socket.handshake.auth?.token || '');
      if (!canEditLayouts(email)) return next(new Error('Нет доступа к схемам бытовок'));
      socket.layoutUser = { email, name: email.split('@')[0], color: colorFor(email) };
      next();
    } catch {
      next(new Error('Недействительный или просроченный токен авторизации'));
    }
  });

  const peersIn = async (layoutId) =>
    (await nsp.in(room(layoutId)).fetchSockets()).map((s) => ({ socketId: s.id, ...s.layoutUser }));

  nsp.on('connection', (socket) => {
    const peer = () => ({ socketId: socket.id, ...socket.layoutUser });
    const inRoom = (layoutId) => socket.rooms.has(room(layoutId));

    socket.on('join', async ({ layoutId } = {}, ack = () => {}) => {
      const id = Number(layoutId);
      const layout = store.getLayout(id);
      if (!layout) return ack({ error: 'Схема не найдена' });
      for (const r of socket.rooms) if (r.startsWith('layout:')) socket.leave(r);
      socket.join(room(id));
      socket.to(room(id)).emit('peer:joined', peer());
      ack({ layout, peers: (await peersIn(id)).filter((p) => p.socketId !== socket.id) });
    });

    socket.on('op', ({ layoutId, op } = {}, ack = () => {}) => {
      const id = Number(layoutId);
      if (!inRoom(id)) return ack({ error: 'Сначала откройте схему' });
      if (!canEditLayouts(socket.layoutUser.email)) return ack({ error: 'Доступ к схемам у вас отозван' });
      const result = store.applyOp(id, op, socket.layoutUser.email);
      if (result.error) return ack({ error: result.error });
      socket.to(room(id)).emit('op', { ...result, by: socket.layoutUser.email });
      ack({ ok: true, ...result });
    });

    socket.on('move', (data = {}) => {
      const id = Number(data.layoutId);
      if (!inRoom(id)) return;
      socket.to(room(id)).emit('move', { id: data.id, x: data.x, y: data.y, rotation: data.rotation, by: socket.id });
    });

    socket.on('cursor', (data = {}) => {
      const id = Number(data.layoutId);
      if (!inRoom(id)) return;
      socket.to(room(id)).emit('cursor', { ...peer(), x: data.x, y: data.y, selectedId: data.selectedId || null });
    });

    socket.on('disconnecting', () => {
      for (const r of socket.rooms) if (r.startsWith('layout:')) socket.to(r).emit('peer:left', { socketId: socket.id });
    });
  });

  return nsp;
}

module.exports = { initLayoutsSocket };
