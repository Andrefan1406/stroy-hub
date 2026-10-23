// Справочник работ для подсчёта объёмов по чертежам (страница /takeoff):
// группы работ и работы с нормой расхода материала и расценками. Одна общая
// копия на сервере — у всех пользователей одинаковые нормы.
//
// Таблицы — «решения администратора» (CREATE TABLE IF NOT EXISTS, никогда
// не удаляются, см. server/db.js). Начальное наполнение (группа «Каменная
// кладка») — один раз, при первом запуске: если админ потом всё удалит,
// заново не появится.
//
// Доступ: читать — любой вошедший (Firebase ID-токен), менять — только
// админ (admin@vkdev.kz и список TAKEOFF_ADMIN_EMAILS через запятую в .env /
// на Render). Скрытие редактора на фронтенде — только удобство.
//
// version работы растёт при каждой правке: замер хранит снимок нормы с
// версией, и клиент видит, что норма изменилась после замера
// (src/takeoff/masonry.js, isSnapshotStale). Работу, которая уже
// использовалась в замерах (used), физически не удаляем — только в архив.
const express = require('express');

const WORK_UNITS = ['м²', 'м³', 'м', 'шт'];
const METHODS = ['wall_length', 'rect_channels', 'area', 'length'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS takeoff_work_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS takeoff_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES takeoff_work_groups(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  method TEXT NOT NULL,
  thickness REAL,
  material_name TEXT,
  material_unit TEXT,
  material_rate REAL,
  work_price REAL,
  material_price REAL,
  count_openings INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS takeoff_meta (key TEXT PRIMARY KEY, value TEXT);
`;

const SEED = {
  group: { name: 'Каменная кладка', sort: 10 },
  works: [
    { name: 'Кирпичная кладка перегородок толщиной 120 мм', unit: 'м²', method: 'wall_length', thickness: 0.12, materialName: 'Кирпич', materialUnit: 'шт', materialRate: 40, countOpenings: true },
    { name: 'Кирпичная кладка стен толщиной 250 мм', unit: 'м³', method: 'wall_length', thickness: 0.25, materialName: 'Кирпич', materialUnit: 'шт', materialRate: 305, countOpenings: true },
    { name: 'Кладка стен из газоблока толщиной 200 мм', unit: 'м³', method: 'wall_length', thickness: 0.2, materialName: 'Газоблок', materialUnit: 'м³', materialRate: 1.05, countOpenings: true },
    { name: 'Кладка стен из пазогребневых плит', unit: 'м²', method: 'wall_length', thickness: null, materialName: 'Пазогребневая плита', materialUnit: 'шт', materialRate: 3, countOpenings: true },
    { name: 'Кладка вентшахт', unit: 'м³', method: 'rect_channels', thickness: null, materialName: 'Кирпич', materialUnit: 'шт', materialRate: 305, countOpenings: false },
  ],
};

const now = () => new Date().toISOString();

function initCatalogSchema(db) {
  db.exec(SCHEMA);
  const seeded = db.prepare("SELECT value FROM takeoff_meta WHERE key = 'seeded'").get();
  if (seeded) return;
  db.transaction(() => {
    const g = db.prepare('INSERT INTO takeoff_work_groups (name, sort, updated_at, updated_by) VALUES (?, ?, ?, ?)')
      .run(SEED.group.name, SEED.group.sort, now(), 'seed');
    const ins = db.prepare(`INSERT INTO takeoff_works
      (group_id, name, unit, method, thickness, material_name, material_unit, material_rate, count_openings, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed')`);
    for (const w of SEED.works) {
      ins.run(g.lastInsertRowid, w.name, w.unit, w.method, w.thickness, w.materialName, w.materialUnit, w.materialRate, w.countOpenings ? 1 : 0, now());
    }
    db.prepare("INSERT INTO takeoff_meta (key, value) VALUES ('seeded', ?)").run(now());
  })();
}

const groupOut = (r) => ({ id: r.id, name: r.name, sort: r.sort, archived: !!r.archived, updatedAt: r.updated_at });
const workOut = (r) => ({
  id: r.id,
  groupId: r.group_id,
  name: r.name,
  unit: r.unit,
  method: r.method,
  thickness: r.thickness,
  materialName: r.material_name || '',
  materialUnit: r.material_unit || '',
  materialRate: r.material_rate,
  workPrice: r.work_price,
  materialPrice: r.material_price,
  countOpenings: !!r.count_openings,
  archived: !!r.archived,
  used: !!r.used,
  version: r.version,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

// Число из формы: «0,12», 0.12, "" -> null. NaN/отрицательное -> ошибка.
function optNumber(v, label, errors) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`${label}: нужно неотрицательное число`);
    return null;
  }
  return n;
}

function validateGroup(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Укажите название группы' };
  const sort = Number.parseInt(body.sort ?? 0, 10);
  return { value: { name: name.slice(0, 200), sort: Number.isFinite(sort) ? sort : 0, archived: body.archived ? 1 : 0 } };
}

function validateWork(body, db) {
  const errors = [];
  const name = String(body.name || '').trim();
  if (!name) errors.push('Укажите наименование работы');
  const groupId = Number(body.groupId);
  if (!db.prepare('SELECT 1 FROM takeoff_work_groups WHERE id = ?').get(groupId)) errors.push('Выберите группу');
  if (!WORK_UNITS.includes(body.unit)) errors.push(`Единица измерения: ${WORK_UNITS.join(', ')}`);
  if (!METHODS.includes(body.method)) errors.push('Выберите способ замера');
  const thickness = optNumber(body.thickness, 'Толщина', errors);
  const materialName = String(body.materialName || '').trim();
  const materialUnit = String(body.materialUnit || '').trim();
  const materialRate = optNumber(body.materialRate, 'Норма расхода', errors);
  if (materialName && (!materialUnit || !(materialRate > 0))) errors.push('Для материала укажите единицу и норму расхода больше нуля');
  const workPrice = optNumber(body.workPrice, 'Расценка работы', errors);
  const materialPrice = optNumber(body.materialPrice, 'Цена материала', errors);
  if (errors.length) return { error: errors.join('; ') };
  return {
    value: {
      group_id: groupId,
      name: name.slice(0, 300),
      unit: body.unit,
      method: body.method,
      thickness,
      material_name: materialName || null,
      material_unit: materialName ? materialUnit : null,
      material_rate: materialName ? materialRate : null,
      work_price: workPrice,
      material_price: materialName ? materialPrice : null,
      count_openings: body.countOpenings ? 1 : 0,
      archived: body.archived ? 1 : 0,
    },
  };
}

// Роутеры с подставляемыми зависимостями (в тестах — своя БД и заглушка
// авторизации). userRouter — /api/takeoff, adminRouter — /api/admin/takeoff.
function createTakeoffCatalog({ getDb, requireUser, requireAdmin, adminEmails }) {
  let ready = false;
  const db = () => {
    const d = getDb();
    if (!ready) {
      initCatalogSchema(d);
      ready = true;
    }
    return d;
  };
  const admins = new Set(adminEmails.map((e) => e.toLowerCase()));

  const listCatalog = () => ({
    groups: db().prepare('SELECT * FROM takeoff_work_groups ORDER BY sort, name').all().map(groupOut),
    works: db().prepare('SELECT * FROM takeoff_works ORDER BY name').all().map(workOut),
  });
  const getWork = (id) => db().prepare('SELECT * FROM takeoff_works WHERE id = ?').get(id);
  const getGroup = (id) => db().prepare('SELECT * FROM takeoff_work_groups WHERE id = ?').get(id);

  const userRouter = express.Router();
  userRouter.use(requireUser);

  userRouter.get('/catalog', (req, res) => {
    res.json({ ...listCatalog(), canEdit: admins.has(String(req.userEmail || '').toLowerCase()) });
  });

  // Работу выбрали в замере — с этого момента её нельзя удалить, только в архив.
  userRouter.post('/works/:id/used', (req, res) => {
    const r = db().prepare('UPDATE takeoff_works SET used = 1 WHERE id = ?').run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: 'Работа не найдена' });
    res.json({ ok: true });
  });

  const adminRouter = express.Router();
  adminRouter.use(requireAdmin);

  adminRouter.post('/groups', (req, res) => {
    const v = validateGroup(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const r = db().prepare('INSERT INTO takeoff_work_groups (name, sort, archived, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)')
      .run(v.value.name, v.value.sort, v.value.archived, now(), req.userEmail);
    res.status(201).json({ group: groupOut(getGroup(r.lastInsertRowid)) });
  });

  adminRouter.patch('/groups/:id', (req, res) => {
    const cur = getGroup(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Группа не найдена' });
    const v = validateGroup({ ...groupOut(cur), ...req.body });
    if (v.error) return res.status(400).json({ error: v.error });
    db().prepare('UPDATE takeoff_work_groups SET name = ?, sort = ?, archived = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(v.value.name, v.value.sort, v.value.archived, now(), req.userEmail, cur.id);
    res.json({ group: groupOut(getGroup(cur.id)) });
  });

  adminRouter.delete('/groups/:id', (req, res) => {
    const cur = getGroup(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Группа не найдена' });
    if (db().prepare('SELECT 1 FROM takeoff_works WHERE group_id = ?').get(cur.id)) {
      return res.status(409).json({ error: 'В группе есть работы — удалите их или отправьте группу в архив' });
    }
    db().prepare('DELETE FROM takeoff_work_groups WHERE id = ?').run(cur.id);
    res.json({ deleted: true });
  });

  adminRouter.post('/works', (req, res) => {
    const v = validateWork(req.body || {}, db());
    if (v.error) return res.status(400).json({ error: v.error });
    const cols = Object.keys(v.value);
    const r = db().prepare(`INSERT INTO takeoff_works (${cols.join(', ')}, updated_at, updated_by) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
      .run(...cols.map((c) => v.value[c]), now(), req.userEmail);
    res.status(201).json({ work: workOut(getWork(r.lastInsertRowid)) });
  });

  // Любая правка, кроме одного лишь архива, — новая версия нормы.
  adminRouter.patch('/works/:id', (req, res) => {
    const cur = getWork(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Работа не найдена' });
    const v = validateWork({ ...workOut(cur), ...req.body }, db());
    if (v.error) return res.status(400).json({ error: v.error });
    const changed = Object.keys(v.value).some((c) => c !== 'archived' && v.value[c] !== cur[c]);
    const cols = Object.keys(v.value);
    db().prepare(`UPDATE takeoff_works SET ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + ?, updated_at = ?, updated_by = ? WHERE id = ?`)
      .run(...cols.map((c) => v.value[c]), changed ? 1 : 0, now(), req.userEmail, cur.id);
    res.json({ work: workOut(getWork(cur.id)) });
  });

  adminRouter.delete('/works/:id', (req, res) => {
    const cur = getWork(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Работа не найдена' });
    if (cur.used) {
      db().prepare('UPDATE takeoff_works SET archived = 1, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), req.userEmail, cur.id);
      return res.json({ archived: true, work: workOut(getWork(cur.id)) });
    }
    db().prepare('DELETE FROM takeoff_works WHERE id = ?').run(cur.id);
    res.json({ deleted: true });
  });

  return { userRouter, adminRouter, initCatalogSchema: () => db() };
}

const takeoffAdminEmails = (env = process.env) => [
  require('./adminAuth').ADMIN_EMAIL,
  ...String(env.TAKEOFF_ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean),
];

module.exports = { createTakeoffCatalog, takeoffAdminEmails, initCatalogSchema, WORK_UNITS, METHODS, SEED };
