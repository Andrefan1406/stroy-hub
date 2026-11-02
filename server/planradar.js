// Блокировка заявок на технику и бетон из-за просроченных замечаний в
// PlanRadar. Работает по справочнику scripts/planradar/projects.json
// (объект -> id в PlanRadar и emails закреплённых за ним сотрудников):
// пока по объекту есть незакрытые замечания, срок которых истёк три дня
// назад и раньше, закреплённым за ним сотрудникам подача заявок закрыта, а в
// сообщении названы объекты и число замечаний («Жилой дом поз.63 — 5 шт.»).
// Email, которого нет в справочнике, не блокируется — проверка для остальных
// прозрачна, как и у peopleGapsCheck.js / gprReportCheck.js.
//
// PlanRadar опрашивается по расписанию (раз в час), а не при каждой проверке:
// лимит API — 30 запросов в минуту на аккаунт. Результат — число замечаний по
// объекту — лежит в planradar_overdue и переживает рестарт; пока первый
// опрос не завершился (или PlanRadar недоступен), блокировки нет (fail-open).
// Нужны PLANRADAR_API_KEY и PLANRADAR_CUSTOMER_ID в .env / на хостинге.
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { getWriteDb } = require('./db');
const { requireAdmin } = require('./adminAuth');

const API_BASE = 'https://www.planradar.com/api';
const PROJECTS_FILE = process.env.PLANRADAR_PROJECTS_FILE || path.join(__dirname, '..', 'scripts', 'planradar', 'projects.json');
const CRON_SCHEDULE = process.env.PLANRADAR_SYNC_CRON || '0 * * * *';
const TIMEZONE = 'Asia/Almaty';

// Блокирует замечание, срок которого истёк столько дней назад или раньше.
const OVERDUE_DAYS = 3;
const OPEN_STATUSES = ['1', '2', '3', '4']; // открыто, в работе, устранено, на проверке (без закрытых и отклонённых)
const PAGESIZE = 500;
const PAUSE_MS = 2500; // лимит API — 30 запросов в минуту

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

// Сегодняшняя дата по времени Алматы, «YYYY-MM-DD».
function todayAlmaty(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(now);
}

// Дата за N дней до заданной «YYYY-MM-DD».
function daysBefore(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Поле из attributes: API пишет то через дефис, то через подчёркивание.
function attr(ticket, ...keys) {
  const a = ticket.attributes || {};
  for (const k of keys) {
    if (a[k] !== undefined && a[k] !== null && a[k] !== '') return a[k];
  }
  return null;
}

// Действующий срок: дата продления, если она позже планового срока.
function ticketDeadline(ticket) {
  const dates = [attr(ticket, 'due-date', 'due_date'), attr(ticket, 'extension-date', 'extension_date')]
    .map((v) => (v ? String(v).slice(0, 10) : null))
    .filter((v) => v && /^\d{4}-\d{2}-\d{2}$/.test(v));
  return dates.length ? dates.sort().at(-1) : null;
}

// Сколько замечаний просрочено на OVERDUE_DAYS дней и больше.
function countOverdue(tickets, today = todayAlmaty()) {
  const cutoff = daysBefore(today, OVERDUE_DAYS);
  return tickets.filter((t) => {
    const deadline = ticketDeadline(t);
    return deadline && deadline <= cutoff;
  }).length;
}

function loadProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    return Object.entries(raw).map(([name, v]) => ({
      name,
      id: String(v.id),
      emails: (v.emails || []).map(normalizeEmail).filter(Boolean),
    }));
  } catch (err) {
    console.error('[planradar] не удалось прочитать справочник объектов:', err.message);
    return [];
  }
}

// Все незакрытые замечания объекта (постранично).
async function fetchOpenTickets(projectId) {
  const key = process.env.PLANRADAR_API_KEY;
  const customer = process.env.PLANRADAR_CUSTOMER_ID;
  if (!key || !customer) throw new Error('не заданы PLANRADAR_API_KEY / PLANRADAR_CUSTOMER_ID');

  const tickets = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ page: String(page), pagesize: String(PAGESIZE) });
    params.append('filter[status_id][][predicate]', 'in');
    for (const s of OPEN_STATUSES) params.append('filter[status_id][][value][]', s);
    const res = await fetch(`${API_BASE}/v2/${customer}/projects/${projectId}/tickets?${params}`, {
      headers: { 'X-PlanRadar-API-Key': key, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`PlanRadar ${res.status}`);
    const body = await res.json();
    const batch = body.data || [];
    tickets.push(...batch);
    await sleep(PAUSE_MS);
    if (batch.length < PAGESIZE) return tickets;
  }
}

let refreshing = false;

// Обновляет число просроченных замечаний у объектов, за которыми кто-то
// закреплён (остальные блокировать некого). Сбой по одному объекту не
// стирает его прежнее значение и не мешает остальным.
async function refreshOverdue() {
  if (refreshing) return { skipped: true };
  refreshing = true;
  const db = getWriteDb();
  const upsert = db.prepare(
    `INSERT INTO planradar_overdue (project_id, project_name, overdue_count, checked_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       project_name = excluded.project_name, overdue_count = excluded.overdue_count, checked_at = excluded.checked_at`
  );
  let ok = 0;
  let failed = 0;
  try {
    for (const project of loadProjects().filter((p) => p.emails.length)) {
      try {
        const count = countOverdue(await fetchOpenTickets(project.id));
        upsert.run(project.id, project.name, count);
        ok += 1;
      } catch (err) {
        failed += 1;
        console.error(`[planradar] «${project.name}»: ${err.message}`);
      }
    }
  } finally {
    refreshing = false;
  }
  console.log(`[planradar] замечания обновлены: объектов ${ok}, ошибок ${failed}`);
  return { ok, failed };
}

// Объекты с просроченными замечаниями, закреплённые за email:
// [{ project, count }], по убыванию числа замечаний.
function overdueForEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return [];
  const rows = new Map(
    getWriteDb().prepare('SELECT project_id, overdue_count FROM planradar_overdue').all().map((r) => [r.project_id, r.overdue_count])
  );
  return loadProjects()
    .filter((p) => p.emails.includes(target))
    .map((p) => ({ project: p.name, count: rows.get(p.id) || 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project, 'ru'));
}

// Публичная проверка для форм и главной (как /api/gpr-report/check).
const checkRouter = express.Router();
checkRouter.get('/check', (req, res) => {
  const email = normalizeEmail(req.query.email);
  if (!email) return res.status(400).json({ error: 'Параметр email обязателен' });
  const items = overdueForEmail(email);
  res.json({ blocked: items.length > 0, items });
});

// Внеплановый опрос PlanRadar — только администратор.
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.post('/resync', async (req, res) => {
  res.json(await refreshOverdue());
});

function startPlanradarSync() {
  if (!process.env.PLANRADAR_API_KEY) {
    console.log('[planradar] PLANRADAR_API_KEY не задан — блокировка по замечаниям выключена');
    return;
  }
  refreshOverdue().catch((err) => console.error('[planradar] опрос не удался:', err.message));
  cron.schedule(CRON_SCHEDULE, () => {
    refreshOverdue().catch((err) => console.error('[planradar] опрос не удался:', err.message));
  }, { timezone: TIMEZONE });
}

module.exports = {
  checkRouter, adminRouter, startPlanradarSync, refreshOverdue, overdueForEmail,
  countOverdue, ticketDeadline, daysBefore, todayAlmaty, OVERDUE_DAYS,
};
