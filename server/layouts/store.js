// Данные схем: список, объекты, проверка и применение правок, редакторы.
// Правку присылает браузер целым объектом (upsert) или удалением (delete);
// всё, что приходит от клиента, проверяется здесь — типы, размеры, длина
// текста, принадлежность подписи бытовке этой же схемы.
const { getLayoutsDb } = require('./db');

const CABIN_SIZES = ['12x2.5', '6x2.5'];
const MAX_TEXT = 200;
const MAX_COORD = 100000; // метров — площадка «не ограничена», но без мусора
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

const normRotation = (deg) => ((Math.round(Number(deg) / 45) * 45) % 360 + 360) % 360;
const isCoord = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

function toClient(row) {
  return {
    id: row.id,
    type: row.type,
    size: row.size || undefined,
    x: row.x,
    y: row.y,
    rotation: row.rotation,
    text: row.text,
    parentId: row.parent_id || undefined,
    sort: row.sort,
    updatedBy: row.updated_by || undefined,
  };
}

function listLayouts() {
  return getLayoutsDb()
    .prepare(
      `SELECT l.id, l.name, l.created_by AS createdBy, l.created_at AS createdAt, l.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM layout_objects o WHERE o.layout_id = l.id AND o.type = 'cabin') AS cabins
         FROM layouts l ORDER BY l.updated_at DESC, l.id DESC`
    )
    .all();
}

function getLayout(id) {
  const db = getLayoutsDb();
  const layout = db.prepare('SELECT id, name, revision, updated_at AS updatedAt FROM layouts WHERE id = ?').get(id);
  if (!layout) return null;
  const objects = db.prepare('SELECT * FROM layout_objects WHERE layout_id = ? ORDER BY sort, id').all(id).map(toClient);
  return { ...layout, objects };
}

function cleanName(name) {
  const value = String(name ?? '').trim().slice(0, 120);
  return value || null;
}

function createLayout(name, email) {
  const info = getLayoutsDb().prepare('INSERT INTO layouts (name, created_by) VALUES (?, ?)').run(name, email);
  return Number(info.lastInsertRowid);
}

function renameLayout(id, name) {
  return getLayoutsDb().prepare("UPDATE layouts SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id).changes > 0;
}

function deleteLayout(id) {
  return getLayoutsDb().prepare('DELETE FROM layouts WHERE id = ?').run(id).changes > 0;
}

// Проверка объекта из браузера -> строка для базы или { error }.
function validateObject(db, layoutId, obj) {
  if (!obj || typeof obj !== 'object') return { error: 'Нет объекта' };
  if (!ID_RE.test(String(obj.id || ''))) return { error: 'Некорректный id объекта' };
  if (!['cabin', 'title', 'label'].includes(obj.type)) return { error: 'Неизвестный тип объекта' };
  const text = String(obj.text ?? '').slice(0, MAX_TEXT);
  const existing = db.prepare('SELECT type FROM layout_objects WHERE layout_id = ? AND id = ?').get(layoutId, obj.id);
  if (existing && existing.type !== obj.type) return { error: 'Нельзя менять тип объекта' };

  if (obj.type === 'label') {
    const parent = db.prepare("SELECT 1 FROM layout_objects WHERE layout_id = ? AND id = ? AND type = 'cabin'").get(layoutId, obj.parentId);
    if (!parent) return { error: 'Подпись можно поставить только внутри бытовки' };
    return { row: { id: obj.id, type: 'label', size: null, x: 0, y: 0, rotation: 0, text, parent_id: obj.parentId, sort: Number(obj.sort) || 0 } };
  }
  if (!isCoord(obj.x) || !isCoord(obj.y)) return { error: 'Некорректные координаты' };
  if (obj.type === 'cabin') {
    if (!CABIN_SIZES.includes(obj.size)) return { error: 'Неизвестный размер бытовки' };
    return { row: { id: obj.id, type: 'cabin', size: obj.size, x: obj.x, y: obj.y, rotation: normRotation(obj.rotation || 0), text: '', parent_id: null, sort: 0 } };
  }
  return { row: { id: obj.id, type: 'title', size: null, x: obj.x, y: obj.y, rotation: 0, text, parent_id: null, sort: 0 } };
}

// Применить правку: { kind: 'upsert', object } | { kind: 'delete', id }.
// Возвращает { revision, object | deletedIds } или { error }.
function applyOp(layoutId, op, email) {
  const db = getLayoutsDb();
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM layouts WHERE id = ?').get(layoutId)) return { error: 'Схема не найдена' };
    let result;
    if (op?.kind === 'upsert') {
      const checked = validateObject(db, layoutId, op.object);
      if (checked.error) return checked;
      const r = checked.row;
      db.prepare(
        `INSERT INTO layout_objects (layout_id, id, type, size, x, y, rotation, text, parent_id, sort, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(layout_id, id) DO UPDATE SET
           size = excluded.size, x = excluded.x, y = excluded.y, rotation = excluded.rotation, text = excluded.text,
           parent_id = excluded.parent_id, sort = excluded.sort, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).run(layoutId, r.id, r.type, r.size, r.x, r.y, r.rotation, r.text, r.parent_id, r.sort, email);
      result = { object: toClient(db.prepare('SELECT * FROM layout_objects WHERE layout_id = ? AND id = ?').get(layoutId, r.id)) };
    } else if (op?.kind === 'delete') {
      // Бытовка удаляется вместе со своими подписями.
      const ids = [String(op.id), ...db.prepare('SELECT id FROM layout_objects WHERE layout_id = ? AND parent_id = ?').all(layoutId, String(op.id)).map((o) => o.id)];
      const del = db.prepare('DELETE FROM layout_objects WHERE layout_id = ? AND id = ?');
      const deletedIds = ids.filter((id) => del.run(layoutId, id).changes > 0);
      result = { deletedIds };
    } else {
      return { error: 'Неизвестная правка' };
    }
    db.prepare("UPDATE layouts SET revision = revision + 1, updated_at = datetime('now') WHERE id = ?").run(layoutId);
    result.revision = db.prepare('SELECT revision FROM layouts WHERE id = ?').get(layoutId).revision;
    return result;
  })();
}

function listEditors() {
  return getLayoutsDb().prepare('SELECT email, added_by AS addedBy, added_at AS addedAt FROM layout_editors ORDER BY email').all();
}

function isEditor(email) {
  return !!email && !!getLayoutsDb().prepare('SELECT 1 FROM layout_editors WHERE email = ?').get(email.toLowerCase());
}

function addEditor(email, addedBy) {
  getLayoutsDb().prepare('INSERT OR IGNORE INTO layout_editors (email, added_by) VALUES (?, ?)').run(email.toLowerCase(), addedBy);
}

function removeEditor(email) {
  return getLayoutsDb().prepare('DELETE FROM layout_editors WHERE email = ?').run(email.toLowerCase()).changes > 0;
}

module.exports = {
  CABIN_SIZES,
  normRotation,
  listLayouts,
  getLayout,
  cleanName,
  createLayout,
  renameLayout,
  deleteLayout,
  applyOp,
  listEditors,
  isEditor,
  addEditor,
  removeEditor,
};
