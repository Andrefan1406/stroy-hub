// Журнал использования сервиса ЛЗК/М-29: кто, когда, сколько работ, какие работы
// не нашлись, какие были ошибки. Пишется из server/lzk/router.js на каждый запрос;
// читает админ-страница «Использование ЛЗК/М-29» (src/pages/LzkUsageAdminPage.jsx).
//
// Таблица lzk_usage — постоянная (CREATE TABLE IF NOT EXISTS, см. server/db.js).
// Если на хостинге файловая система эфемерная (Render без диска), история сотрётся
// при перезапуске — см. CONCRETE_DATA_DIR в CLAUDE.md.
const express = require('express');
const { requireAdmin } = require('../adminAuth');
const { getWriteDb } = require('../db');

const MAX_UNMATCHED = 50;

// Никогда не роняет запрос пользователя: журнал вторичен.
function logUsage({ email, fileSize, summary, error }) {
  try {
    getWriteDb()
      .prepare(
        `INSERT INTO lzk_usage (email, file_size, rows_count, works_count, materials_count, unmatched, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        email || null,
        fileSize || 0,
        summary ? summary.rows : null,
        summary ? summary.works.length : null,
        summary ? summary.materials.length : null,
        summary ? JSON.stringify(summary.unmatched.slice(0, MAX_UNMATCHED).map((u) => ({ name: u.name, unit: u.unit, qty: u.qty }))) : null,
        error || null,
      );
  } catch (err) {
    console.error('[lzk] не удалось записать использование:', err.message);
  }
}

function readUsage(limit) {
  const db = getWriteDb();
  const recent = db
    .prepare(
      `SELECT id, email, created_at, file_size, rows_count, works_count, materials_count, unmatched, error
       FROM lzk_usage ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({ ...r, unmatched: r.unmatched ? JSON.parse(r.unmatched) : [] }));

  const t = db.prepare('SELECT COUNT(*) AS requests, COUNT(DISTINCT email) AS users, SUM(error IS NOT NULL) AS errors FROM lzk_usage').get();
  const totals = { requests: t.requests || 0, users: t.users || 0, errors: t.errors || 0 };

  const perUser = db
    .prepare(
      `SELECT email, COUNT(*) AS requests, SUM(error IS NOT NULL) AS errors, MAX(created_at) AS last_at
       FROM lzk_usage GROUP BY email ORDER BY last_at DESC`,
    )
    .all()
    .map((u) => ({ ...u, errors: u.errors || 0 }));

  // какие работы чаще всего не находятся — по последним 1000 запросам
  const counts = new Map();
  for (const r of db.prepare('SELECT unmatched FROM lzk_usage WHERE unmatched IS NOT NULL ORDER BY id DESC LIMIT 1000').all()) {
    for (const u of JSON.parse(r.unmatched)) {
      const key = `${u.name}|${u.unit}`;
      const cur = counts.get(key) || { name: u.name, unit: u.unit, count: 0 };
      cur.count += 1;
      counts.set(key, cur);
    }
  }
  const topUnmatched = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 30);

  return { totals, perUser, topUnmatched, recent };
}

const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.get('/', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  res.json(readUsage(limit));
});

module.exports = { logUsage, readUsage, adminRouter };
