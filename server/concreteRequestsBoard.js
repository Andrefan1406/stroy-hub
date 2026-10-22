// API для таблицы неисполненных заявок на бетон/раствор на странице
// заявки (заменяет встроенный iframe Google Таблицы, см.
// src/components/ConcretePendingRequestsTable.jsx). Read-only список +
// одно admin-действие (локальное скрытие строки).
//
// Сортировка считается здесь, а не на клиенте: приоритет объекта не хранится
// в БД (это внешняя таблица concreteObjectPriority.json, которая может
// меняться независимо от синка), а список неисполненных заявок обычно
// небольшой (десятки-сотни строк), так что сортировка в JS после одного
// SELECT дешевле, чем городить CASE WHEN на полсотни объектов в SQL.
const express = require('express');
const { getReadDb, getWriteDb } = require('./db');
const { requireEmails } = require('./adminAuth');
const { runSyncOnce } = require('./syncConcrete');
const { priorities: OBJECT_PRIORITIES } = require('../src/data/concreteObjectPriority.json');

const DEFAULT_PRIORITY = 5;

// Кто может скрывать строки локально (см. db.js:concrete_hidden_requests) —
// по требованию задачи, не только главный админ.
const ROW_DELETE_ALLOWED_EMAILS = ['admin@vkdev.kz', 'nach.bsu@vkdevgroup.kz'];

const router = express.Router();

function priorityFor(objectName) {
  return OBJECT_PRIORITIES[objectName] ?? DEFAULT_PRIORITY;
}

router.get('/pending', (req, res) => {
  const rows = getReadDb()
    .prepare(`
      SELECT
        co.request_key, co.category, co.object_name, co.block_position, co.material,
        co.grade_class, co.volume_planned_m3, co.planned_delivery_date, co.submitted_at,
        co.geo_approved, co.energy_approved, co.responsible_name, co.responsible_phone, co.note
      FROM concrete_orders co
      LEFT JOIN concrete_hidden_requests h ON h.request_key = co.request_key
      WHERE (co.execution_note IS NULL OR co.execution_note = '')
        AND co.request_key IS NOT NULL
        AND h.request_key IS NULL
    `)
    .all();

  const withPriority = rows.map((row) => ({ ...row, priority: priorityFor(row.object_name) }));

  // Уровень 1: плановая дата поставки (раньше — выше). Уровни 2 и 3:
  // согласование энергетиков, затем геодезистов (согласованные — выше) —
  // важнее приоритета объекта, только внутри бетона (у раствора этих
  // признаков нет ни в колонках, ни в сортировке, см.
  // ConcretePendingRequestsTable.jsx). Уровень 4: приоритет объекта (меньше —
  // выше). Уровень 5: дата/время подачи заявки (раньше — выше). Пустые
  // значения — всегда в конец своей группы.
  const compareAsc = (x, y) => {
    if (!x) return 1;
    if (!y) return -1;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  withPriority.sort((a, b) => {
    const byPlannedDate = compareAsc(a.planned_delivery_date, b.planned_delivery_date);
    if (byPlannedDate !== 0) return byPlannedDate;
    if (a.material === 'Бетон' && b.material === 'Бетон') {
      if (a.energy_approved !== b.energy_approved) return b.energy_approved - a.energy_approved;
      if (a.geo_approved !== b.geo_approved) return b.geo_approved - a.geo_approved;
    }
    if (a.priority !== b.priority) return a.priority - b.priority;
    return compareAsc(a.submitted_at, b.submitted_at);
  });

  res.json({ rows: withPriority });
});

// Форма заявки шлёт данные напрямую в Google Apps Script (см.
// ConcreteRequestPage.js), а не через наш бэкенд — новая строка попадает в
// concrete_orders только после синка. Обычно это раз в 2 часа (см.
// CONCRETE_SYNC_CRON); фронтенд дёргает этот эндпоинт сразу после подачи
// заявки, чтобы не ждать. Может не подхватить самую свежую строку, если
// Google Таблица ещё не обновила свой CSV-экспорт (задержка публикации на
// стороне Google, обычно секунды, но не гарантирована) — это ограничение
// самого источника данных, а не этого эндпоинта.
router.post('/resync', async (req, res) => {
  try {
    const count = await runSyncOnce();
    res.json({ ok: true, count });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/hide', requireEmails(ROW_DELETE_ALLOWED_EMAILS), (req, res) => {
  const { request_key: requestKey } = req.body || {};
  if (!requestKey || typeof requestKey !== 'string') {
    return res.status(400).json({ error: 'Не передан request_key' });
  }

  getWriteDb()
    .prepare(`
      INSERT INTO concrete_hidden_requests (request_key, hidden_by)
      VALUES (@requestKey, @hiddenBy)
      ON CONFLICT(request_key) DO NOTHING
    `)
    .run({ requestKey, hiddenBy: req.userEmail });

  res.json({ ok: true });
});

module.exports = router;
