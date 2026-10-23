// Логика модуля ПТО поверх SQLite (db.js): документы, ведомость материалов,
// виды работ, расценки, итоги. Роутер (router.js) только принимает запросы и
// вызывает отсюда. Зависимости — через createPtoService({ db, rates, extract })
// — в тестах подставляются своя база, заглушка расценок и заготовленные
// страницы вместо чтения PDF.
const { extractPages, PdfError } = require('./pdf');
const { SECTIONS } = require('./sections');
const { consolidate } = require('./consolidate');
const { reconcileKzh, groupById } = require('./reconcile');
const { workKey, RatesUnavailable } = require('./rates');
const { round } = require('./layout');

const RECONCILE = { КЖ: reconcileKzh };

class ServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const parseJson = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

const itemOut = (r) => ({
  id: r.id, documentId: r.document_id, kind: r.kind, element: r.element, name: r.name, markClass: r.mark_class,
  unit: r.unit, quantity: r.quantity, basis: r.basis, counted: !!r.counted, note: r.note,
  sources: parseJson(r.sources_json, []), status: r.status, edited: !!r.edited, manual: !!r.manual,
});

const workOut = (r) => ({
  id: r.id, documentId: r.document_id, element: r.element, name: r.name, unit: r.unit, quantity: r.quantity,
  basisNote: r.basis_note, status: r.status, edited: !!r.edited, manual: !!r.manual,
  rate: r.rate_name ? {
    id: r.rate_id, class: r.rate_class, name: r.rate_name, unit: r.rate_unit, price: r.price,
    confidence: r.confidence, status: r.mapping_status, manual: !!r.manual_rate,
  } : null,
  rateStatus: r.mapping_status,
});

const docOut = (r) => ({
  id: r.id, section: r.section, category: r.category, object: r.object_name, position: r.position, block: r.block,
  fileName: r.file_name, fileSize: r.file_size, pageCount: r.page_count, status: r.status, error: r.error,
  uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at, parsedAt: r.parsed_at, worksStale: !!r.works_stale,
});

function createPtoService({ db, rates, extract = extractPages }) {
  const now = () => new Date().toISOString();

  const getDoc = (id) => {
    const row = db.prepare('SELECT * FROM pto_documents WHERE id = ?').get(Number(id));
    if (!row) throw new ServiceError('Документ не найден', 404);
    return row;
  };
  // Любая правка проверенного документа возвращает его в «черновик».
  const touch = (docId, { staleWorks = false } = {}) => {
    db.prepare(`UPDATE pto_documents SET status = CASE WHEN status = 'confirmed' THEN 'draft' ELSE status END,
                works_stale = CASE WHEN ? THEN 1 ELSE works_stale END WHERE id = ?`).run(staleWorks ? 1 : 0, docId);
  };

  // ---------- документы ----------

  function createDocument({ section, category, object, position, block, fileName, fileSize, uploadedBy }) {
    if (!SECTIONS[section]) throw new ServiceError(`Раздел «${section}» пока не поддерживается`);
    const info = db.prepare(
      `INSERT INTO pto_documents (section, category, object_name, position, block, file_name, file_size, status, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'parsing', ?)`
    ).run(section, category || null, object, position || null, block || null, fileName, fileSize ?? null, uploadedBy || null);
    return Number(info.lastInsertRowid);
  }

  // Разбор PDF в фоне: документ сразу виден в списке со статусом «parsing».
  async function processDocument(docId, buffer) {
    const doc = getDoc(docId);
    const section = SECTIONS[doc.section];
    try {
      const { pageCount, pages } = await extract(buffer);
      const parsed = section.parse(pages);
      const items = consolidate(parsed.rows);
      const works = section.deriveWorks(items);
      const reconciliation = (RECONCILE[doc.section] || (() => []))(parsed.rows);
      const report = {
        pageCount,
        sheets: parsed.sheets,
        issues: parsed.issues,
        reconciliation,
        stats: { rawRows: parsed.rows.length, items: items.length, works: works.length },
      };
      db.transaction(() => {
        db.prepare('DELETE FROM pto_items WHERE document_id = ?').run(docId);
        db.prepare('DELETE FROM pto_works WHERE document_id = ?').run(docId);
        const ins = db.prepare(
          `INSERT INTO pto_items (document_id, kind, element, name, mark_class, unit, quantity, basis, counted, note, sources_json, sort)
           VALUES (@document_id, @kind, @element, @name, @mark_class, @unit, @quantity, @basis, @counted, @note, @sources_json, @sort)`
        );
        for (const it of items) ins.run({ ...it, document_id: docId, sources_json: JSON.stringify(it.sources) });
        insertWorks(docId, works);
        // Статус остаётся «parsing» до конца подбора расценок: иначе экран откроется
        // с видами работ без расценок и не обновится.
        db.prepare(`UPDATE pto_documents SET error = NULL, page_count = ?, report_json = ?, parsed_at = ?, works_stale = 0 WHERE id = ?`)
          .run(pageCount, JSON.stringify(report), now(), docId);
      })();
      await applyRates(docId).catch((err) => {
        // Расценки не подобрались (сервис недоступен) — документ остаётся рабочим,
        // расценки можно подобрать позже кнопкой.
        console.error('[pto] расценки не подобраны:', err.message);
      });
      db.prepare(`UPDATE pto_documents SET status = 'draft' WHERE id = ?`).run(docId);
    } catch (err) {
      const message = err instanceof PdfError ? err.message : `Не удалось разобрать документ: ${err.message}`;
      db.prepare(`UPDATE pto_documents SET status = 'error', error = ?, parsed_at = ? WHERE id = ?`).run(message, now(), docId);
    }
  }

  const listDocuments = ({ object, position, block } = {}) => {
    const where = [];
    const args = [];
    if (object) { where.push('object_name = ?'); args.push(object); }
    if (position) { where.push('position = ?'); args.push(position); }
    if (block) { where.push('block = ?'); args.push(block); }
    const rows = db.prepare(`SELECT * FROM pto_documents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`).all(...args);
    return rows.map(docOut);
  };

  const getDocument = (id) => {
    const row = getDoc(id);
    return { ...docOut(row), report: parseJson(row.report_json, null) };
  };

  const deleteDocument = (id) => {
    getDoc(id);
    db.prepare('DELETE FROM pto_documents WHERE id = ?').run(Number(id));
  };

  // ---------- ведомость материалов ----------

  const listItems = (docId) => {
    getDoc(docId);
    return db.prepare('SELECT * FROM pto_items WHERE document_id = ? ORDER BY sort, id').all(Number(docId)).map(itemOut);
  };

  const num = (v, label) => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) throw new ServiceError(`${label}: нужно неотрицательное число`);
    return n;
  };
  const text = (v, label, { required = false, max = 300 } = {}) => {
    const s = String(v ?? '').trim();
    if (required && !s) throw new ServiceError(`${label}: заполните поле`);
    return s.slice(0, max);
  };

  function updateItem(id, patch) {
    const cur = db.prepare('SELECT * FROM pto_items WHERE id = ?').get(Number(id));
    if (!cur) throw new ServiceError('Строка не найдена', 404);
    const next = {};
    let changed = false;
    if (patch.element !== undefined) { next.element = text(patch.element, 'Элемент'); changed = true; }
    if (patch.name !== undefined) { next.name = text(patch.name, 'Наименование', { required: true }); changed = true; }
    if (patch.markClass !== undefined) { next.mark_class = text(patch.markClass, 'Марка/класс', { max: 60 }); changed = true; }
    if (patch.unit !== undefined) { next.unit = text(patch.unit, 'Единица', { required: true, max: 20 }); changed = true; }
    if (patch.quantity !== undefined) { next.quantity = round(num(patch.quantity, 'Количество'), 3); changed = true; }
    if (patch.note !== undefined) { next.note = text(patch.note, 'Примечание', { max: 500 }) || null; changed = true; }
    if (patch.counted !== undefined) { next.counted = patch.counted ? 1 : 0; changed = true; }
    if (patch.status !== undefined) {
      if (!['draft', 'confirmed'].includes(patch.status)) throw new ServiceError('Статус: draft или confirmed');
      next.status = patch.status;
    }
    const cols = Object.keys(next);
    if (!cols.length) return itemOut(cur);
    if (changed) next.edited = 1;
    const keys = Object.keys(next);
    db.prepare(`UPDATE pto_items SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...next, id: cur.id });
    if (changed) touch(cur.document_id, { staleWorks: true });
    return itemOut(db.prepare('SELECT * FROM pto_items WHERE id = ?').get(cur.id));
  }

  function addItem(docId, body) {
    getDoc(docId);
    const kind = ['steel', 'embedded', 'concrete', 'metal'].includes(body.kind) ? body.kind : 'steel';
    const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM pto_items WHERE document_id = ?').get(Number(docId)).s);
    const info = db.prepare(
      `INSERT INTO pto_items (document_id, kind, element, name, mark_class, unit, quantity, basis, counted, note, sources_json, manual, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, '[]', 1, ?)`
    ).run(Number(docId), kind, text(body.element, 'Элемент'), text(body.name, 'Наименование', { required: true }),
      text(body.markClass, 'Марка/класс', { max: 60 }), text(body.unit, 'Единица', { required: true, max: 20 }),
      round(num(body.quantity, 'Количество'), 3), body.counted === false ? 0 : 1, text(body.note, 'Примечание', { max: 500 }) || null, sort);
    touch(Number(docId), { staleWorks: true });
    return itemOut(db.prepare('SELECT * FROM pto_items WHERE id = ?').get(Number(info.lastInsertRowid)));
  }

  function deleteItem(id) {
    const cur = db.prepare('SELECT * FROM pto_items WHERE id = ?').get(Number(id));
    if (!cur) throw new ServiceError('Строка не найдена', 404);
    db.prepare('DELETE FROM pto_items WHERE id = ?').run(cur.id);
    touch(cur.document_id, { staleWorks: true });
  }

  // ---------- виды работ ----------

  function insertWorks(docId, works) {
    const ins = db.prepare(
      `INSERT INTO pto_works (document_id, element, name, unit, quantity, basis_note, rate_query, manual, sort)
       VALUES (@document_id, @element, @name, @unit, @quantity, @basis_note, @rate_query, @manual, @sort)`
    );
    for (const w of works) {
      ins.run({
        document_id: docId, element: w.element, name: w.name, unit: w.unit, quantity: w.quantity,
        basis_note: w.basis_note || null, rate_query: w.query || w.name, manual: w.manual ? 1 : 0, sort: w.sort ?? 0,
      });
    }
  }

  const listWorks = (docId) => {
    getDoc(docId);
    return db.prepare('SELECT * FROM pto_works WHERE document_id = ? ORDER BY sort, id').all(Number(docId)).map(workOut);
  };

  // Пересчёт видов работ по текущей ведомости: выведенные строки пересоздаются,
  // добавленные вручную остаются; расценки подбираются заново (подтверждённые
  // ранее соответствия применяются сами).
  async function rebuildWorks(docId) {
    const doc = getDoc(docId);
    const items = db.prepare('SELECT * FROM pto_items WHERE document_id = ? ORDER BY sort, id').all(doc.id).map((r) => ({
      kind: r.kind, element: r.element, name: r.name, quantity: r.quantity, counted: r.counted, unit: r.unit,
    }));
    const works = SECTIONS[doc.section].deriveWorks(items);
    db.transaction(() => {
      // Уже подобранные расценки (предложенные и подтверждённые) переносим на
      // пересозданные работы с тем же названием и единицей — а не подбираем заново.
      const prev = new Map();
      for (const w of db.prepare('SELECT * FROM pto_works WHERE document_id = ? AND manual = 0 AND rate_name IS NOT NULL').all(doc.id)) {
        prev.set(workKey(w.name, w.unit), w);
      }
      db.prepare('DELETE FROM pto_works WHERE document_id = ? AND manual = 0').run(doc.id);
      const base = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM pto_works WHERE document_id = ?').get(doc.id).s;
      insertWorks(doc.id, works.map((w, i) => ({ ...w, sort: base + i })));
      for (const w of db.prepare('SELECT id, name, unit FROM pto_works WHERE document_id = ? AND manual = 0').all(doc.id)) {
        const p = prev.get(workKey(w.name, w.unit));
        if (p) {
          applyRateRow([w.id], { id: p.rate_id, class: p.rate_class, name: p.rate_name, unit: p.rate_unit, price: p.price, manual: !!p.manual_rate }, p.mapping_status, p.confidence);
        }
      }
      db.prepare('UPDATE pto_documents SET works_stale = 0 WHERE id = ?').run(doc.id);
    })();
    touch(doc.id);
    await applyRates(doc.id).catch((err) => console.error('[pto] расценки не подобраны:', err.message));
    return listWorks(doc.id);
  }

  function updateWork(id, patch) {
    const cur = db.prepare('SELECT * FROM pto_works WHERE id = ?').get(Number(id));
    if (!cur) throw new ServiceError('Работа не найдена', 404);
    const next = {};
    let changed = false;
    if (patch.element !== undefined) { next.element = text(patch.element, 'Элемент'); changed = true; }
    if (patch.name !== undefined) { next.name = text(patch.name, 'Наименование', { required: true }); changed = true; }
    if (patch.unit !== undefined) { next.unit = text(patch.unit, 'Единица', { required: true, max: 20 }); changed = true; }
    if (patch.quantity !== undefined) { next.quantity = patch.quantity === null || patch.quantity === '' ? null : round(num(patch.quantity, 'Объём'), 3); changed = true; }
    if (patch.status !== undefined) {
      if (!['draft', 'confirmed'].includes(patch.status)) throw new ServiceError('Статус: draft или confirmed');
      next.status = patch.status;
    }
    if (!Object.keys(next).length) return workOut(cur);
    if (changed) {
      next.edited = 1;
      // Название или единица изменились — прежняя расценка могла перестать подходить.
      if ((next.name && next.name !== cur.name) || (next.unit && next.unit !== cur.unit)) {
        Object.assign(next, { rate_id: null, rate_class: null, rate_name: null, rate_unit: null, price: null, confidence: null, mapping_status: 'none', manual_rate: 0, rate_query: next.name || cur.name });
      }
    }
    db.prepare(`UPDATE pto_works SET ${Object.keys(next).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...next, id: cur.id });
    if (changed) touch(cur.document_id);
    return workOut(db.prepare('SELECT * FROM pto_works WHERE id = ?').get(cur.id));
  }

  function addWork(docId, body) {
    getDoc(docId);
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM pto_works WHERE document_id = ?').get(Number(docId)).s;
    const name = text(body.name, 'Наименование', { required: true });
    const info = db.prepare(
      `INSERT INTO pto_works (document_id, element, name, unit, quantity, basis_note, rate_query, manual, sort)
       VALUES (?, ?, ?, ?, ?, 'добавлено вручную', ?, 1, ?)`
    ).run(Number(docId), text(body.element, 'Элемент'), name, text(body.unit, 'Единица', { required: true, max: 20 }),
      body.quantity === undefined || body.quantity === '' ? null : round(num(body.quantity, 'Объём'), 3), name, sort);
    touch(Number(docId));
    return workOut(db.prepare('SELECT * FROM pto_works WHERE id = ?').get(Number(info.lastInsertRowid)));
  }

  function deleteWork(id) {
    const cur = db.prepare('SELECT * FROM pto_works WHERE id = ?').get(Number(id));
    if (!cur) throw new ServiceError('Работа не найдена', 404);
    db.prepare('DELETE FROM pto_works WHERE id = ?').run(cur.id);
    touch(cur.document_id);
  }

  // ---------- расценки ----------

  const applyRateRow = (workIds, rate, status, confidence) => {
    const upd = db.prepare(
      `UPDATE pto_works SET rate_id = ?, rate_class = ?, rate_name = ?, rate_unit = ?, price = ?, confidence = ?,
         mapping_status = ?, manual_rate = ? WHERE id = ?`
    );
    for (const wid of workIds) {
      upd.run(rate.id ?? null, rate.class ?? rate.tier ?? null, rate.name, rate.unit, rate.price ?? null, confidence ?? null, status, rate.manual ? 1 : 0, wid);
    }
  };

  // Подбор расценок для видов работ документа без подтверждённой расценки:
  // сначала ранее подтверждённые соответствия, затем предложение по своду.
  // Ошибка доступности свода пробрасывается — вызывающий решает, что показать.
  // redo: переподобрать и уже предложенные (кнопка «Подобрать расценки заново»); по умолчанию — только работы без расценки.
  async function applyRates(docId, { redo = false } = {}) {
    const states = redo ? "('none', 'suggested')" : "('none')";
    const works = db.prepare(`SELECT * FROM pto_works WHERE document_id = ? AND mapping_status IN ${states}`).all(Number(docId));
    const byKey = new Map();
    for (const w of works) {
      const key = workKey(w.name, w.unit);
      if (!byKey.has(key)) byKey.set(key, { query: w.rate_query || w.name, name: w.name, unit: w.unit, ids: [] });
      byKey.get(key).ids.push(w.id);
    }
    let unavailable = null;
    const toSuggest = [];
    for (const [key, g] of byKey) {
      const mapped = db.prepare('SELECT * FROM pto_price_mappings WHERE work_key = ?').get(key);
      if (mapped) {
        applyRateRow(g.ids, { id: mapped.rate_id, class: mapped.rate_class, name: mapped.rate_name, unit: mapped.rate_unit, price: mapped.price, manual: !!mapped.manual }, 'confirmed', 1);
      } else {
        toSuggest.push(g);
      }
    }
    // Предложения по своду — параллельно: на каждое уходит поиск и арбитр (модель).
    await Promise.all(toSuggest.map(async (g) => {
      try {
        const { best } = await rates.suggest(g.query, g.unit, { workName: g.name });
        if (best) applyRateRow(g.ids, best, 'suggested', round(best.score, 3));
      } catch (err) {
        if (err instanceof RatesUnavailable) unavailable = err;
        else throw err;
      }
    }));
    if (unavailable) throw unavailable;
  }

  // Подтвердить расценку для вида работ: rateId — из свода (берём расценку из
  // Qdrant, а не присланную клиентом) либо manual { name, unit, price } — свою.
  // Соответствие запоминается: следующий документ с такой работой получит её сам.
  async function confirmRate(workId, { rateId, manual }, user) {
    const w = db.prepare('SELECT * FROM pto_works WHERE id = ?').get(Number(workId));
    if (!w) throw new ServiceError('Работа не найдена', 404);
    let rate;
    if (manual) {
      rate = {
        id: null, class: 'Ручной ввод', name: text(manual.name, 'Название расценки', { required: true }),
        unit: text(manual.unit || w.unit, 'Единица', { required: true, max: 20 }), price: num(manual.price, 'Цена'), manual: true,
      };
    } else {
      rate = await rates.get(rateId);
      if (!rate) throw new ServiceError('Расценка не найдена в своде', 404);
      if (rate.price == null) throw new ServiceError('У этой расценки в своде нет цены');
    }
    const key = workKey(w.name, w.unit);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO pto_price_mappings (work_key, rate_id, rate_class, rate_name, rate_unit, price, manual, confirmed_by, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(work_key) DO UPDATE SET rate_id = excluded.rate_id, rate_class = excluded.rate_class, rate_name = excluded.rate_name,
           rate_unit = excluded.rate_unit, price = excluded.price, manual = excluded.manual, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`
      ).run(key, rate.id, rate.class ?? rate.tier ?? null, rate.name, rate.unit, rate.price, rate.manual ? 1 : 0, user || null);
      const same = db.prepare('SELECT id, name, unit FROM pto_works WHERE document_id = ?').all(w.document_id)
        .filter((r) => workKey(r.name, r.unit) === key).map((r) => r.id);
      applyRateRow(same, rate, 'confirmed', 1);
    })();
    touch(w.document_id);
    return workOut(db.prepare('SELECT * FROM pto_works WHERE id = ?').get(w.id));
  }

  // Снять расценку (вернуть к «не подобрана»), запомненное соответствие тоже удаляется.
  function clearRate(workId) {
    const w = db.prepare('SELECT * FROM pto_works WHERE id = ?').get(Number(workId));
    if (!w) throw new ServiceError('Работа не найдена', 404);
    const key = workKey(w.name, w.unit);
    db.prepare('DELETE FROM pto_price_mappings WHERE work_key = ?').run(key);
    const ids = db.prepare('SELECT id, name, unit FROM pto_works WHERE document_id = ?').all(w.document_id)
      .filter((r) => workKey(r.name, r.unit) === key).map((r) => r.id);
    const upd = db.prepare(`UPDATE pto_works SET rate_id = NULL, rate_class = NULL, rate_name = NULL, rate_unit = NULL, price = NULL,
      confidence = NULL, mapping_status = 'none', manual_rate = 0 WHERE id = ?`);
    for (const id of ids) upd.run(id);
    touch(w.document_id);
    return workOut(db.prepare('SELECT * FROM pto_works WHERE id = ?').get(w.id));
  }

  // ---------- подтверждение, сверка ----------

  function confirmDocument(docId) {
    getDoc(docId);
    db.transaction(() => {
      db.prepare(`UPDATE pto_items SET status = 'confirmed' WHERE document_id = ?`).run(Number(docId));
      db.prepare(`UPDATE pto_works SET status = 'confirmed' WHERE document_id = ?`).run(Number(docId));
      db.prepare(`UPDATE pto_documents SET status = 'confirmed' WHERE id = ?`).run(Number(docId));
    })();
    return getDocument(docId);
  }

  // Применить коэффициент из сверки к объёмам группы (спецификации даны на один элемент).
  async function applyMultiplier(docId, groupId, factor) {
    const doc = getDoc(docId);
    const group = groupById(groupId);
    const report = parseJson(doc.report_json, null);
    const rec = report && (report.reconciliation || []).find((r) => r.id === groupId);
    if (!group || !rec) throw new ServiceError('Для этой группы нет данных сверки');
    const f = Number(factor);
    if (!Number.isInteger(f) || f < 2 || f > 10) throw new ServiceError('Коэффициент — целое число от 2 до 10');
    if (rec.applied) throw new ServiceError(`Коэффициент ×${rec.applied} уже применён`);
    const mark = `×${f} по сверке со сводной ведомостью стали`;
    // Все спецификационные строки группы, кроме уже умноженных на явное число
    // элементов («Элементов: N ×…»): сноска «на одну стену» есть не на всех листах,
    // а коэффициент выведен по всей группе.
    const rows = db.prepare(`SELECT * FROM pto_items WHERE document_id = ? AND basis = 'spec' AND kind IN ('concrete', 'steel', 'metal')`).all(doc.id)
      .filter((r) => group.spec.test(r.element) && !/^Элементов: /.test(r.note || ''));
    db.transaction(() => {
      const upd = db.prepare('UPDATE pto_items SET quantity = ?, sources_json = ?, note = ?, edited = 1 WHERE id = ?');
      for (const r of rows) {
        const sources = parseJson(r.sources_json, []).map((s) => ({ ...s, quantity: round(s.quantity * f, 3) }));
        upd.run(round(r.quantity * f, 3), JSON.stringify(sources), [r.note, mark].filter(Boolean).join('; '), r.id);
      }
      rec.applied = f;
      db.prepare('UPDATE pto_documents SET report_json = ? WHERE id = ?').run(JSON.stringify(report), doc.id);
    })();
    touch(doc.id, { staleWorks: true });
    await rebuildWorks(doc.id);
    return { changedItems: rows.length, document: getDocument(doc.id) };
  }

  // ---------- цены на материалы и итоги ----------

  const listMaterialPrices = () => db.prepare('SELECT * FROM pto_material_prices ORDER BY kind').all().map((r) => ({
    kind: r.kind, name: r.name, unit: r.unit, price: r.price, note: r.note, updatedBy: r.updated_by, updatedAt: r.updated_at,
  }));

  function setMaterialPrice(kind, price, user) {
    const cur = db.prepare('SELECT * FROM pto_material_prices WHERE kind = ?').get(kind);
    if (!cur) throw new ServiceError('Неизвестный вид материала', 404);
    db.prepare(`UPDATE pto_material_prices SET price = ?, updated_by = ?, updated_at = datetime('now') WHERE kind = ?`)
      .run(num(price, 'Цена'), user || null, kind);
    return listMaterialPrices();
  }

  // Стоимость раздела с разбивкой по конструктивным элементам. Материалы:
  // арматура и закладные — по цене за тонну, бетон (в т.ч. подготовка) — за м³;
  // работы — объём × расценка с НДС. Строки справочные (counted = 0) и работы
  // без расценки в сумму не входят — их количество в missing.
  function totals(docId) {
    getDoc(docId);
    const prices = Object.fromEntries(listMaterialPrices().map((p) => [p.kind, p.price]));
    const items = db.prepare('SELECT * FROM pto_items WHERE document_id = ? AND counted = 1').all(Number(docId));
    const works = db.prepare('SELECT * FROM pto_works WHERE document_id = ?').all(Number(docId));
    const byEl = new Map();
    const el = (name) => {
      const key = name || '—';
      if (!byEl.has(key)) byEl.set(key, { element: key, steelT: 0, steelCost: 0, concreteM3: 0, concreteCost: 0, materials: 0, works: 0, total: 0, missing: 0 });
      return byEl.get(key);
    };
    for (const it of items) {
      const row = el(it.element);
      if (it.kind === 'steel' || it.kind === 'embedded') {
        const t = it.unit === 'кг' ? it.quantity / 1000 : it.unit === 'тн' ? it.quantity : 0;
        row.steelT += t;
        row.steelCost += t * (prices.steel || 0);
      } else if (it.kind === 'concrete' && it.unit === 'м³') {
        row.concreteM3 += it.quantity;
        row.concreteCost += it.quantity * (prices.concrete || 0);
      }
    }
    for (const w of works) {
      const row = el(w.element);
      if (w.quantity != null && w.price != null) row.works += w.quantity * w.price;
      else row.missing += 1;
    }
    const rows = [...byEl.values()].map((r) => {
      const materials = r.steelCost + r.concreteCost;
      return {
        element: r.element, steelT: round(r.steelT, 3), steelCost: Math.round(r.steelCost), concreteM3: round(r.concreteM3, 2),
        concreteCost: Math.round(r.concreteCost), materials: Math.round(materials), works: Math.round(r.works),
        total: Math.round(materials + r.works), missing: r.missing,
      };
    });
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    return {
      prices,
      rows,
      totals: {
        steelT: round(sum('steelT'), 3), concreteM3: round(sum('concreteM3'), 2), materials: sum('materials'),
        works: sum('works'), total: sum('total'), missing: sum('missing'),
      },
    };
  }

  return {
    ServiceError,
    createDocument, processDocument, listDocuments, getDocument, deleteDocument,
    listItems, updateItem, addItem, deleteItem,
    listWorks, rebuildWorks, updateWork, addWork, deleteWork,
    applyRates, confirmRate, clearRate, searchRates: (q, unit) => rates.search(q, { unit }),
    confirmDocument, applyMultiplier,
    listMaterialPrices, setMaterialPrice, totals,
  };
}

module.exports = { createPtoService, ServiceError };
