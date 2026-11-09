// Публичная (без requireAdmin) проверка: есть ли у пользователя (по email)
// нерешённые пропуски ('missing') в отчётах по людям по участку(ам),
// закреплённым за ним в people_gap_check_rules (см. server/db.js,
// управляется через /admin/people-gaps/check-rules и
// src/pages/PeopleGapsUsersAdminPage.jsx) — ЛЮБЫЕ, за всю историю участка,
// кроме сегодняшнего дня (он ещё не закончился, отчёт за него может быть
// просто пока не подан). Используется формой подачи заявки на бетон/раствор
// и главной страницей (см. src/peopleGapsGate.js,
// src/components/PeopleGapsGuard.jsx), чтобы блокировать подачу заявок для
// пользователей из этого списка, пока по их участку не закрыты пропуски —
// для email без правил просто возвращает пустой список (не блокирует
// никого по умолчанию). Сама форма никак не привязана к admin-доступу,
// поэтому роут отдельный от peopleGapsAdmin.js (там requireAdmin на весь
// router) — а сам список правил редактируется только оттуда.
const express = require('express');
const { getWriteDb } = require('./db');
const { syncRawFromSheet, rebuildDerivedTables } = require('./syncPeople');
const { reconstructPeopleTimeline } = require('./peopleGapDetection');

const router = express.Router();

// НЕ читаем persisted-таблицу people_report_gaps напрямую — её ряд для
// каждого участка обрывается на самой свежей дате СРЕДИ ВСЕХ УЧАСТКОВ (см.
// rebuildDerivedTables/reconstructDailyTimeline), что для админ-панели
// пропусков и есть желаемое поведение, но здесь ломает проверку "сегодня":
// пока НИ ОДИН участок компании не сдал отчёт за сегодня, сегодняшний день
// вообще не попадает в people_report_gaps ни для кого — включая тот
// участок, который мы хотим проверить, даже если он сам сегодня тоже
// молчит. Поэтому считаем статус участка заново, "на лету", прямо из
// people_reports/people_gap_decisions, с seriesEndDate = today (клиентское
// "сегодня") — независимо от того, отчитались ли остальные участки, и
// возвращаем ВСЕ дни со статусом 'missing' в истории участка, кроме самого
// today (см. верхний комментарий).
function computeMissingDates(site, today) {
  const db = getWriteDb();

  const rawRows = db.prepare(`
    SELECT report_date, site, object_category, object_name, position, contractor, profession, headcount
    FROM people_reports WHERE site = ?
  `).all(site);

  const decisions = db.prepare(`
    SELECT site, report_date, action, source_date, decided_by, decided_at
    FROM people_gap_decisions WHERE site = ?
  `).all(site);

  const { dayRows } = reconstructPeopleTimeline(rawRows, decisions, { seriesEndDate: today });

  return dayRows
    .filter((r) => r.status === 'missing' && r.report_date !== today)
    .map((r) => r.report_date)
    .sort();
}

// people_reports пополняется по плановому синку раз в сутки ночью (см. server/syncSchedule.js,
// PEOPLE_SYNC_CRON в syncPeople.js) — локальная копия может отставать от
// Google-таблицы в ОБЕ стороны: и показывать пропуск, которого администратор
// уже закрыл (заполнил отчёт), и, наоборот, показывать "всё чисто", хотя
// отчёт из таблицы уже удалили. Раньше пересинк форсировался только когда
// проверка находила пропуск — это чинило первый случай, но не второй: если
// кэш ошибочно думает, что отчёт ЕСТЬ, missingDates выходит пустым и повода
// пересинхронизироваться никогда не появляется. Поэтому пересинк теперь
// зависит только от времени (RESYNC_COOLDOWN_MS) и запускается перед КАЖДОЙ
// проверкой без исключений — так расхождение в любую сторону живёт не
// дольше одного окна троттлинга. Конкурентные вызовы внутри одного пересинка
// ждут один и тот же промис, а не дёргают синк повторно.
//
// Намеренно вызываем ТОЛЬКО syncRawFromSheet (сырые people_reports), а НЕ
// runSyncOnce/rebuildDerivedTables — полный пересчёт people_report_gaps по
// ВСЕМ 25 участкам этой проверке не нужен вообще (см. computeMissingDates
// выше — статус считается на лету по одному участку), а стоит порядка
// нескольких секунд сам по себе. Именно он и делал пересинк здесь ощутимо
// медленнее, чем нужно.
const RESYNC_COOLDOWN_MS = 60 * 1000;
let inFlightResync = null;
let lastResyncAt = 0;
function resyncIfStale() {
  if (inFlightResync) return inFlightResync;
  if (Date.now() - lastResyncAt < RESYNC_COOLDOWN_MS) return Promise.resolve();

  inFlightResync = syncRawFromSheet()
    .catch((err) => {
      console.error('[people-gaps-check] не удалось пересинхронизировать перед проверкой:', err.message);
    })
    .finally(() => {
      lastResyncAt = Date.now();
      inFlightResync = null;
    });
  return inFlightResync;
}

// today приходит готовой строкой 'YYYY-MM-DD' от клиента (а не считается
// заново на сервере), чтобы не разъезжаться с представлением клиента о
// "сегодня" из-за разных часовых поясов сервера и пользователя. Участок(и)
// сервер находит сам по email через people_gap_check_rules — клиент их не
// знает и не передаёт.
router.get('/check', async (req, res) => {
  const { email, today } = req.query;

  if (!email || !/^\d{4}-\d{2}-\d{2}$/.test(today || '')) {
    return res.status(400).json({ error: 'Параметры email и today (YYYY-MM-DD) обязательны' });
  }

  const sites = getWriteDb()
    .prepare('SELECT DISTINCT site FROM people_gap_check_rules WHERE email = ?')
    .all(email.trim().toLowerCase())
    .map((r) => r.site);

  // Нет правил для этого email — значит, проверка на него не распространяется.
  // Не форсируем ресинк в этом случае: он не бесплатный (~секунды), а этот
  // путь проходит подавляющее большинство пользователей на каждой главной/
  // форме, у которых никаких правил нет вообще.
  if (!sites.length) {
    return res.json({ missingDates: [] });
  }

  await resyncIfStale();
  const missingDates = [...new Set(sites.flatMap((site) => computeMissingDates(site, today)))].sort();

  res.json({ missingDates });
});

// Позволяет начальнику участка самостоятельно отметить конкретный день как
// нерабочий прямо со страницы отчёта (см. src/PeopleReportPage.js), не
// дожидаясь, пока администратор обработает это на /admin/people-gaps. По
// сути то же действие 'confirm_no_report', что доступно там (см.
// peopleGapsAdmin.js) — та же таблица people_gap_decisions и тот же
// rebuildDerivedTables({ site }) — но без requireAdmin, потому что страницу
// отчёта заполняет не только администратор. decided_by берём из тела
// запроса (email залогиненного через Protected-роут пользователя) — как и
// весь остальной этот роутер, без криптографической проверки токена, тот
// же уровень доверия, что и у остальных публичных форм заявок в этом
// приложении (см. ConcreteRequestPage.js/PeopleReportPage.js — они тоже
// шлют данные без верификации личности на бэкенде).
router.post('/mark-day-off', (req, res) => {
  const { site, report_date: reportDate, decided_by: decidedBy } = req.body || {};

  if (!site || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate || '')) {
    return res.status(400).json({ error: 'site и report_date (YYYY-MM-DD) обязательны' });
  }
  if (!decidedBy || !decidedBy.trim()) {
    return res.status(400).json({ error: 'decided_by обязателен' });
  }

  const db = getWriteDb();

  const hasRealReport = db
    .prepare(`SELECT 1 FROM people_reports WHERE site = ? AND report_date = ? LIMIT 1`)
    .get(site, reportDate);
  if (hasRealReport) {
    return res.status(409).json({ error: `За ${reportDate} по участку "${site}" уже есть реальный отчёт` });
  }

  db.prepare(`
    INSERT INTO people_gap_decisions (site, report_date, action, source_date, note, decided_by, decided_at)
    VALUES (@site, @report_date, 'confirm_no_report', NULL, NULL, @decided_by, datetime('now'))
    ON CONFLICT(site, report_date) DO UPDATE SET
      action = 'confirm_no_report',
      source_date = NULL,
      decided_by = excluded.decided_by,
      decided_at = datetime('now')
  `).run({ site, report_date: reportDate, decided_by: decidedBy.trim() });

  rebuildDerivedTables({ site });

  res.json({ ok: true });
});

module.exports = router;
