// /api/pto/* — API модуля ПТО. Доступ — только по списку из access.js
// (requireAccess — Firebase ID-токен, 403 всем остальным); роутер собирается
// фабрикой, чтобы в тестах подставить свою авторизацию, базу и расценки.
const express = require('express');
const { createPtoService, ServiceError } = require('./service');
const { SECTIONS, sectionList } = require('./sections');
const { RatesUnavailable } = require('./rates');
const { workbookBuffer } = require('./excel');
const taxonomy = require('../../src/data/concreteObjectTaxonomy.json');

// Лимит загрузки PDF: проектный раздел бывает десятки МБ. Подстроить: PTO_MAX_UPLOAD_MB.
const MAX_UPLOAD_MB = Number(process.env.PTO_MAX_UPLOAD_MB || 100);

// Иерархия объект → позиция по справочникам сайта. Дом (блок) — произвольный
// текст: список блоков живёт на фронтенде (positionBlockOptions), его выбирает пользователь.
function validateHierarchy({ category, object, position }) {
  const objects = taxonomy.objectCategoryOptions;
  if (!object) throw new ServiceError('Выберите объект');
  const known = Object.values(objects).some((list) => list.includes(object));
  if (!known) throw new ServiceError(`Объект «${object}» нет в справочнике объектов`);
  if (category && !(objects[category] || []).includes(object)) throw new ServiceError(`Объект «${object}» не относится к категории «${category}»`);
  const positions = taxonomy.objectPositionOptions[object] || [];
  if (position && positions.length && !positions.includes(position)) throw new ServiceError(`Позиции «${position}» нет у объекта «${object}»`);
}

const asyncRoute = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
    if (err instanceof RatesUnavailable) return res.status(503).json({ error: err.message });
    console.error('[pto]', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });
};

function createPtoRouter({ requireAccess, service }) {
  const router = express.Router();
  router.use(requireAccess);

  router.get('/sections', (req, res) => res.json({ sections: sectionList() }));

  router.get('/documents', asyncRoute(async (req, res) => {
    res.json({ documents: service.listDocuments({ object: req.query.object, position: req.query.position, block: req.query.block }) });
  }));

  // Загрузка: тело запроса — сам PDF (application/pdf), остальное — в query.
  // Разбор идёт в фоне: ответ 202 сразу, статус документа — GET /documents/:id.
  router.post('/documents',
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: `${MAX_UPLOAD_MB}mb` }),
    asyncRoute(async (req, res) => {
      const q = req.query;
      const section = String(q.section || 'КЖ');
      if (!SECTIONS[section]) throw new ServiceError(`Раздел «${section}» пока не поддерживается`);
      validateHierarchy({ category: q.category, object: q.object, position: q.position });
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) throw new ServiceError('Файл не получен');
      if (body.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ServiceError('Это не PDF-файл');
      const id = service.createDocument({
        section, category: q.category, object: q.object, position: q.position, block: q.block,
        fileName: String(q.fileName || 'document.pdf').slice(0, 200), fileSize: body.length, uploadedBy: req.userEmail,
      });
      setImmediate(() => service.processDocument(id, body).catch((err) => console.error('[pto] разбор:', err)));
      res.status(202).json({ id, status: 'parsing' });
    }));

  router.get('/documents/:id', asyncRoute(async (req, res) => res.json({ document: service.getDocument(req.params.id) })));
  router.delete('/documents/:id', asyncRoute(async (req, res) => { service.deleteDocument(req.params.id); res.json({ deleted: true }); }));
  router.post('/documents/:id/confirm', asyncRoute(async (req, res) => res.json({ document: service.confirmDocument(req.params.id) })));
  router.post('/documents/:id/apply-multiplier', asyncRoute(async (req, res) => {
    res.json(await service.applyMultiplier(req.params.id, String(req.body.group || ''), req.body.factor));
  }));

  router.get('/documents/:id/items', asyncRoute(async (req, res) => res.json({ items: service.listItems(req.params.id) })));
  router.post('/documents/:id/items', asyncRoute(async (req, res) => res.status(201).json({ item: service.addItem(req.params.id, req.body || {}) })));
  router.patch('/items/:id', asyncRoute(async (req, res) => res.json({ item: service.updateItem(req.params.id, req.body || {}) })));
  router.delete('/items/:id', asyncRoute(async (req, res) => { service.deleteItem(req.params.id); res.json({ deleted: true }); }));

  router.get('/documents/:id/works', asyncRoute(async (req, res) => res.json({ works: service.listWorks(req.params.id) })));
  router.post('/documents/:id/works', asyncRoute(async (req, res) => res.status(201).json({ work: service.addWork(req.params.id, req.body || {}) })));
  router.post('/documents/:id/works/rebuild', asyncRoute(async (req, res) => res.json({ works: await service.rebuildWorks(req.params.id) })));
  router.post('/documents/:id/rates/apply', asyncRoute(async (req, res) => {
    let warning = null;
    try { await service.applyRates(req.params.id); } catch (err) {
      if (!(err instanceof RatesUnavailable)) throw err;
      warning = err.message;
    }
    res.json({ works: service.listWorks(req.params.id), warning });
  }));
  router.patch('/works/:id', asyncRoute(async (req, res) => res.json({ work: service.updateWork(req.params.id, req.body || {}) })));
  router.delete('/works/:id', asyncRoute(async (req, res) => { service.deleteWork(req.params.id); res.json({ deleted: true }); }));
  router.post('/works/:id/rate', asyncRoute(async (req, res) => {
    res.json({ work: await service.confirmRate(req.params.id, { rateId: req.body.rateId, manual: req.body.manual }, req.userEmail) });
  }));
  router.delete('/works/:id/rate', asyncRoute(async (req, res) => res.json({ work: service.clearRate(req.params.id) })));

  // Поиск расценок вручную (кандидаты в порядке приоритета категорий).
  router.get('/rates/search', asyncRoute(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) throw new ServiceError('Введите запрос');
    res.json({ rates: await service.searchRates(q, String(req.query.unit || '') || null) });
  }));

  router.get('/material-prices', asyncRoute(async (req, res) => res.json({ prices: service.listMaterialPrices() })));
  router.put('/material-prices/:kind', asyncRoute(async (req, res) => {
    res.json({ prices: service.setMaterialPrice(req.params.kind, (req.body || {}).price, req.userEmail) });
  }));

  router.get('/documents/:id/totals', asyncRoute(async (req, res) => res.json(service.totals(req.params.id))));

  router.get('/documents/:id/export.xlsx', asyncRoute(async (req, res) => {
    const doc = service.getDocument(req.params.id);
    const buffer = workbookBuffer({
      doc, items: service.listItems(req.params.id), works: service.listWorks(req.params.id), totals: service.totals(req.params.id),
    });
    // В заголовке — ASCII-имя (кириллица в значении заголовка запрещена), красивое — в filename*.
    const name = `PTO_${doc.id}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(`Ведомость ${doc.section} ${doc.object}.xlsx`)}`);
    res.send(buffer);
  }));

  return router;
}

// Боевая сборка: настоящая авторизация, БД и расценки.
function createDefaultPtoRouter() {
  const { requirePto } = require('./access');
  const { initSchema } = require('./db');
  const { createRates } = require('./rates');
  const db = initSchema();
  const rates = createRates();
  const service = createPtoService({ db, rates });
  return createPtoRouter({ requireAccess: requirePto, service });
}

module.exports = { createPtoRouter, createDefaultPtoRouter, validateHierarchy, MAX_UPLOAD_MB };
