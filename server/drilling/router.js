// REST для заявок на бурение и резку. Права определяются данными: автор,
// ответственные линии, админ — проверяются в service.js; здесь только вход по
// Firebase ID-токену (requireUser) и перевод ошибок в HTTP-ответы.
const express = require('express');
const { requireUser, requireAdmin, ADMIN_EMAIL } = require('../adminAuth');
const svc = require('./service');
const { buildRegistryXlsx } = require('./xlsx');
const { MATERIALS } = require('./validation');
const taxonomy = require('../../src/data/concreteObjectTaxonomy.json');

const isAdmin = (email) => email === ADMIN_EMAIL;

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof svc.DrillingError) return res.status(err.status).json({ error: err.message });
    console.error('[drilling]', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

const router = express.Router();
router.use(requireUser);

router.get('/me', wrap((req, res) => {
  res.json(svc.profile(req.userEmail, isAdmin(req.userEmail)));
}));

// Справочники формы (объекты и позиции — те же, что у заявки на бетон).
router.get('/options', wrap((req, res) => {
  res.json({ objectPositions: taxonomy.objectPositionOptions, materials: MATERIALS });
}));

// Реестр: фильтры берутся из query (from, to, status=a,b, object, workType, company, author, onlyMine=1).
const registryFilters = (q) => ({
  from: /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '',
  to: /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : '',
  status: String(q.status || '').split(',').filter(Boolean),
  object: q.object || '',
  workType: ['drill', 'cut'].includes(q.workType) ? q.workType : '',
  company: q.company || '',
  author: q.author || '',
  onlyMine: q.onlyMine === '1',
});

router.get('/registry', wrap((req, res) => {
  res.json(svc.registry(req.userEmail, isAdmin(req.userEmail), registryFilters(req.query)));
}));

router.get('/registry.xlsx', wrap(async (req, res) => {
  const data = svc.registry(req.userEmail, isAdmin(req.userEmail), registryFilters(req.query));
  const buffer = await buildRegistryXlsx(data);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="drilling-registry.xlsx"');
  res.send(buffer);
}));

router.get('/counter', wrap((req, res) => res.json(svc.counters(req.userEmail))));

router.get('/requests', wrap((req, res) => {
  const scope = ['mine', 'inbox', 'all'].includes(req.query.scope) ? req.query.scope : 'mine';
  res.json({ requests: svc.listRequests(req.userEmail, scope, isAdmin(req.userEmail)) });
}));

router.post('/requests', wrap((req, res) => {
  const id = svc.createRequest(req.userEmail, req.body?.items, { isAdmin: isAdmin(req.userEmail) });
  res.status(201).json(svc.getRequestView(id, req.userEmail, isAdmin(req.userEmail)));
}));

const viewOf = (req, id) => svc.getRequestView(id, req.userEmail, isAdmin(req.userEmail));
const idOf = (req) => Number(req.params.id);

router.get('/requests/:id', wrap((req, res) => res.json(viewOf(req, idOf(req)))));

router.put('/requests/:id', wrap((req, res) => {
  svc.updateRequest(idOf(req), req.userEmail, req.body?.items);
  res.json(viewOf(req, idOf(req)));
}));

router.post('/requests/:id/restart', wrap((req, res) => {
  svc.restartRequest(idOf(req), req.userEmail);
  res.json(viewOf(req, idOf(req)));
}));

router.post('/requests/:id/cancel', wrap((req, res) => {
  svc.cancelRequest(idOf(req), req.userEmail);
  res.json(viewOf(req, idOf(req)));
}));

router.post('/requests/:id/accept', wrap((req, res) => {
  svc.respond(idOf(req), req.userEmail, 'accept');
  res.json(viewOf(req, idOf(req)));
}));

router.post('/requests/:id/reject', wrap((req, res) => {
  svc.respond(idOf(req), req.userEmail, 'reject', req.body?.reason);
  res.json(viewOf(req, idOf(req)));
}));

router.post('/requests/:id/items/:itemId/done', wrap((req, res) => {
  svc.markItemDone(idOf(req), Number(req.params.itemId), req.userEmail, req.body?.factQuantity, req.body?.comment);
  res.json(viewOf(req, idOf(req)));
}));

// Сразу несколько строк (кнопка «Выполнить все строки»): { items: [{ itemId, factQuantity, comment }] }.
router.post('/requests/:id/items-done', wrap((req, res) => {
  svc.markItemsDone(idOf(req), req.userEmail, req.body?.items);
  res.json(viewOf(req, idOf(req)));
}));

// Чертежи и фото к заявке. Файл уходит телом запроса как есть (application/octet-stream), имя —
// в ?name=; тип проверяется по содержимому. Автор — пока заявку не приняли; видят все, кто видит заявку.
const rawFile = express.raw({ type: () => true, limit: '16mb' });
router.post('/requests/:id/attachments', rawFile, wrap((req, res) => {
  svc.addAttachment(idOf(req), req.userEmail, req.query.name, req.body);
  res.status(201).json(viewOf(req, idOf(req)));
}));

router.get('/requests/:id/attachments/:aid', wrap((req, res) => {
  const f = svc.getAttachmentFile(idOf(req), Number(req.params.aid), req.userEmail, isAdmin(req.userEmail));
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.sendFile(f.file);
}));

router.delete('/requests/:id/attachments/:aid', wrap((req, res) => {
  svc.removeAttachment(idOf(req), Number(req.params.aid), req.userEmail);
  res.json(viewOf(req, idOf(req)));
}));

// ---------- админка ----------
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// Исполнители (название, адресат, линия). Людей по ролям назначает главный
// админ на /rides-admin (server/rides/usersRouter.js), здесь они только показаны.
adminRouter.get('/', wrap((req, res) => {
  res.json({ companies: svc.listCompanies() });
}));
adminRouter.post('/companies', wrap((req, res) => {
  svc.saveCompany(req.body || {});
  res.json({ companies: svc.listCompanies() });
}));
adminRouter.put('/companies/:id', wrap((req, res) => {
  svc.saveCompany({ ...(req.body || {}), id: Number(req.params.id) });
  res.json({ companies: svc.listCompanies() });
}));

module.exports = { router, adminRouter };
