// /api/layouts — схема бытовок: общий лист и список редакторов. Совместная
// правка самих объектов — по сокету (socket.js), не здесь.
//
// Лист один на всех: объект на нём — это заголовок со своими бытовками,
// новый объект — новый заголовок (см. src/pages/SiteLayoutsPage.jsx).
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

// Общий лист: id для подключения к сокету.
router.get('/main', anyEditor, (req, res) => {
  res.json({ layoutId: store.getOrCreateMainLayoutId(req.layoutUser.email) });
});

// Кому, кроме главного админа, можно открывать и править схему.
router.get('/editors', adminOnly, (req, res) => res.json({ editors: store.listEditors() }));

router.post('/editors', adminOnly, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Укажите корректный email' });
  store.addEditor(email, req.layoutUser.email);
  res.status(201).json({ editors: store.listEditors() });
});

router.delete('/editors/:email', adminOnly, (req, res) => {
  store.removeEditor(req.params.email);
  res.json({ editors: store.listEditors() });
});

module.exports = router;
