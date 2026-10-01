// Внутренние read-only эндпоинты для сервер-сервер вызовов между своими же
// бэкендами этого проекта (пока только Python-сервис финплана, см.
// services/financing-api/) — защищены общим секретом (requireInternalApiKey
// в adminAuth.js), а не Firebase-логином, потому что вызывающая сторона не
// живой пользователь.
const express = require('express');
const { requireInternalApiKey } = require('./adminAuth');
const { getWriteDb } = require('./db');
const { resyncSource } = require('./syncGprReport');

const router = express.Router();
router.use(requireInternalApiKey);

// Сырые строки еженедельного % готовности ГПР (см. syncGprReport.js) по
// одному источнику — начало/конец раздела по позиции вычисляются на
// стороне вызывающего (первая/последняя дата с ненулевым %), здесь отдаём
// данные как есть, без интерпретации.
router.get('/gpr-values', (req, res) => {
  const { source_key: sourceKey } = req.query;
  if (!sourceKey) {
    return res.status(400).json({ error: 'Параметр source_key обязателен' });
  }

  try {
    const rows = getWriteDb()
      .prepare(
        `SELECT position, block, work_name, report_date, percent
         FROM gpr_report_values
         WHERE source_key = ?
         ORDER BY position, work_name, report_date`
      )
      .all(sourceKey);

    res.json({ source_key: sourceKey, rows });
  } catch (err) {
    // Например, таблица ещё не создана на этом инстансе (миграция не
    // прошла/БД на эфемерном диске не проинициализирована) — без этого
    // клиент (FastAPI) видел голый 500 без тела ответа, причина была
    // видна только в этом логе.
    console.error(`[internal-api] GET /gpr-values?source_key=${sourceKey} не сработал:`, err);
    res.status(500).json({ error: 'Не удалось получить данные ГПР' });
  }
});

// Плановые начало/конец раздела (см. gpr_report_plan_dates в db.js) — из
// исходника, не вычислено из %; для факта (по проценту готовности) есть
// /gpr-values выше.
router.get('/gpr-plan-dates', (req, res) => {
  const { source_key: sourceKey } = req.query;
  if (!sourceKey) {
    return res.status(400).json({ error: 'Параметр source_key обязателен' });
  }

  try {
    const rows = getWriteDb()
      .prepare(
        `SELECT position, block, work_name, plan_start, plan_end
         FROM gpr_report_plan_dates
         WHERE source_key = ?
         ORDER BY position, work_name`
      )
      .all(sourceKey);

    res.json({ source_key: sourceKey, rows });
  } catch (err) {
    console.error(`[internal-api] GET /gpr-plan-dates?source_key=${sourceKey} не сработал:`, err);
    res.status(500).json({ error: 'Не удалось получить плановые сроки ГПР' });
  }
});

// Точечный пересинк ОДНОГО источника ГПР (см. resyncSource в
// syncGprReport.js) — вызывается перед открытием финплана (Python-сервис),
// чтобы данные не ждали планового 6-часового крона. Источник — таблицы
// правятся вживую людьми на площадке, а не по расписанию.
router.post('/gpr-resync', async (req, res) => {
  const { source_key: sourceKey } = req.body || {};
  if (!sourceKey) {
    return res.status(400).json({ error: 'Параметр source_key обязателен' });
  }

  try {
    const result = await resyncSource(sourceKey);
    res.json({ source_key: sourceKey, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
