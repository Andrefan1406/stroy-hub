// /api/layouts — схемы бытовок: список, создание, переименование, удаление,
// снимок схемы, список редакторов. Совместная правка самих объектов — по
// сокету (socket.js), не здесь.
const express = require('express');
const { getAuth } = require('firebase-admin/auth');
const store = require('./store');
const { requireLayoutAccess, isSiteAdmin, canEditLayouts } = require('./access');

const router = express.Router();
const anyEditor = requireLayoutAccess();
const adminOnly = requireLayoutAccess({ adminOnly: true });

// Есть ли доступ — для кнопки на главной и самой страницы. Без доступа не
// 403, а { canEdit: false }: так проще скрыть кнопку.
router.get('/access', async (req, res) => {
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!match) return res.json({ canEdit: false, isAdmin: false });
  try {
    const email = ((await getAuth().verifyIdToken(match[1])).email || '').toLowerCase();
    res.json({ canEdit: canEditLayouts(email), isAdmin: isSiteAdmin(email) });
  } catch {
    res.json({ canEdit: false, isAdmin: false });
  }
});

router.get('/', anyEditor, (req, res) => res.json({ layouts: store.listLayouts() }));

router.post('/', anyEditor, (req, res) => {
  const name = store.cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Укажите название схемы' });
  const id = store.createLayout(name, req.layoutUser.email);
  res.status(201).json({ layout: store.getLayout(id) });
});

// Редакторы — до /:id, чтобы 'editors' не принялся за id схемы.
router.get('/editors/list', adminOnly, (req, res) => res.json({ editors: store.listEditors() }));

router.post('/editors/list', adminOnly, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Укажите корректный email' });
  store.addEditor(email, req.layoutUser.email);
  res.status(201).json({ editors: store.listEditors() });
});

router.delete('/editors/list/:email', adminOnly, (req, res) => {
  store.removeEditor(req.params.email);
  res.json({ editors: store.listEditors() });
});

router.get('/:id', anyEditor, (req, res) => {
  const layout = store.getLayout(Number(req.params.id));
  if (!layout) return res.status(404).json({ error: 'Схема не найдена' });
  res.json({ layout });
});

router.patch('/:id', anyEditor, (req, res) => {
  const name = store.cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Укажите название схемы' });
  if (!store.renameLayout(Number(req.params.id), name)) return res.status(404).json({ error: 'Схема не найдена' });
  res.json({ layout: store.getLayout(Number(req.params.id)) });
});

// Удалять схемы целиком — только главный админ.
router.delete('/:id', adminOnly, (req, res) => {
  if (!store.deleteLayout(Number(req.params.id))) return res.status(404).json({ error: 'Схема не найдена' });
  res.json({ ok: true });
});

module.exports = router;
