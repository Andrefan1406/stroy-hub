// Схемы бытовок: проверка правок, каскадное удаление, доступ и
// синхронизация двух участников через настоящий Socket.io. Вход Firebase
// подменён: токен = email.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.LAYOUTS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'layouts-test-'));

const accessPath = require.resolve('../access');
const store = require('../store');
const ADMIN = 'admin@vkdev.kz';
require.cache[accessPath] = {
  id: accessPath,
  filename: accessPath,
  loaded: true,
  exports: {
    isSiteAdmin: (email) => email === ADMIN,
    canEditLayouts: (email) => email === ADMIN || store.isEditor(email),
    emailFromToken: async (token) => {
      if (!token) throw new Error('no token');
      return token.toLowerCase();
    },
  },
};

const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { initLayoutsSocket } = require('../socket');

const cabin = (id, extra = {}) => ({ id, type: 'cabin', size: '12x2.5', x: 10, y: 5, rotation: 0, ...extra });

test('правки: проверка объекта, поворот кратно 45°, подпись только в бытовке', () => {
  const id = store.createLayout('Площадка 1', ADMIN);
  assert.equal(store.applyOp(id, { kind: 'upsert', object: cabin('cabin-1', { rotation: 50 }) }, ADMIN).object.rotation, 45);
  assert.equal(store.applyOp(id, { kind: 'upsert', object: cabin('cabin-1', { rotation: -90 }) }, ADMIN).object.rotation, 270);
  assert.match(store.applyOp(id, { kind: 'upsert', object: cabin('cabin-2', { size: '5x5' }) }, ADMIN).error, /размер/);
  assert.match(store.applyOp(id, { kind: 'upsert', object: cabin('cabin-3', { x: 'abc' }) }, ADMIN).error, /координаты/);
  assert.match(
    store.applyOp(id, { kind: 'upsert', object: { id: 'label-1', type: 'label', parentId: 'nope-123', text: 'склад' } }, ADMIN).error,
    /внутри бытовки/
  );
  const label = store.applyOp(id, { kind: 'upsert', object: { id: 'label-1', type: 'label', parentId: 'cabin-1', text: 'склад' } }, ADMIN);
  assert.equal(label.object.parentId, 'cabin-1');
  assert.match(store.applyOp(id, { kind: 'upsert', object: { id: 'cabin-1', type: 'title', x: 0, y: 0 } }, ADMIN).error, /тип/);
});

test('удаление бытовки удаляет её подписи; ревизия растёт', () => {
  const id = store.createLayout('Площадка 2', ADMIN);
  store.applyOp(id, { kind: 'upsert', object: cabin('cabin-a') }, ADMIN);
  store.applyOp(id, { kind: 'upsert', object: { id: 'label-a1', type: 'label', parentId: 'cabin-a', text: 'прораб' } }, ADMIN);
  const before = store.getLayout(id).revision;
  const out = store.applyOp(id, { kind: 'delete', id: 'cabin-a' }, ADMIN);
  assert.deepEqual(out.deletedIds.sort(), ['cabin-a', 'label-a1']);
  assert.equal(out.revision, before + 1);
  assert.equal(store.getLayout(id).objects.length, 0);
});

test('совместная правка: второй участник видит правку, движение и курсор; без доступа не пустит', async () => {
  const server = http.createServer();
  const io = new Server(server);
  initLayoutsSocket(io);
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/layouts`;
  after(() => { io.close(); server.close(); });

  store.addEditor('editor@test', ADMIN);
  const id = store.createLayout('Общая', ADMIN);
  const open = (email) => new Promise((resolve, reject) => {
    const s = connect(url, { auth: { token: email }, transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const emitAck = (s, event, data) => new Promise((r) => s.emit(event, data, r));
  const next = (s, event) => new Promise((r) => s.once(event, r));

  await assert.rejects(open('stranger@test'), /Нет доступа/);

  const a = await open(ADMIN);
  const b = await open('editor@test');
  after(() => { a.close(); b.close(); });
  await emitAck(a, 'join', { layoutId: id });
  const joinedB = await emitAck(b, 'join', { layoutId: id });
  assert.equal(joinedB.peers.length, 1, 'b видит, что a уже в схеме');

  const gotOp = next(b, 'op');
  const ack = await emitAck(a, 'op', { layoutId: id, op: { kind: 'upsert', object: cabin('cabin-x') } });
  assert.ok(ack.ok);
  assert.equal((await gotOp).object.id, 'cabin-x');
  assert.equal(store.getLayout(id).objects.length, 1, 'сохранено в базе');

  const gotMove = next(b, 'move');
  a.emit('move', { layoutId: id, id: 'cabin-x', x: 20, y: 7, rotation: 0 });
  assert.equal((await gotMove).x, 20);

  const gotCursor = next(a, 'cursor');
  b.emit('cursor', { layoutId: id, x: 1, y: 2, selectedId: 'cabin-x' });
  const cursor = await gotCursor;
  assert.equal(cursor.email, 'editor@test');
  assert.equal(cursor.selectedId, 'cabin-x');

  // Убрали из списка — следующая правка уже не проходит.
  store.removeEditor('editor@test');
  const denied = await emitAck(b, 'op', { layoutId: id, op: { kind: 'delete', id: 'cabin-x' } });
  assert.match(denied.error, /отозван/);

  const left = next(a, 'peer:left');
  b.close();
  await left;
});
