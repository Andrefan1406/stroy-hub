// Сведение сырых строк разбора в ведомость раздела: одинаковые позиции с
// разных листов объединяются в одну строку (количества складываются), листы-
// источники остаются в sources — по ним видно, из чего собрана позиция.
const { round } = require('./layout');

const KIND_ORDER = { steel: 0, embedded: 1, concrete: 2, metal: 3 };

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s,.;:()]+/g, '');

// «Плита монолитная ППдм 1» (спецификация) и «ППдм 1» (сводная ведомость стали)
// — один элемент: к названию из сводной ведомости приводим спецификационные,
// если оно в них содержится (берём самое длинное совпадение: «ППм 1.1» длиннее «ППм 1»).
function canonicalizer(rows) {
  const names = [...new Set(rows.filter((r) => r.basis === 'summary').map((r) => r.element))]
    .map((name) => ({ name, key: norm(name) }))
    .filter((n) => n.key.length >= 4)
    .sort((a, b) => b.key.length - a.key.length);
  return (element, basis) => {
    if (basis === 'summary') return element;
    const key = norm(element);
    const hit = names.find((n) => key.includes(n.key));
    return hit ? hit.name : element;
  };
}

// rows -> items (готовы к записи в pto_items, без id/document_id).
function consolidate(rows) {
  const hasSummary = rows.some((r) => r.basis === 'summary');
  const canon = canonicalizer(rows);
  const elementOrder = new Map();
  const map = new Map();
  for (const r of rows) {
    const element = canon(r.element, r.basis);
    if (!elementOrder.has(element)) elementOrder.set(element, elementOrder.size);
    // Блок — часть ключа: одинаковые позиции разных блоков не складываются.
    const key = [r.kind, r.block || '', element, r.name, r.markClass, r.unit, r.basis].join('\u0001');
    let item = map.get(key);
    if (!item) {
      item = {
        kind: r.kind, block: r.block || null, element, name: r.name, mark_class: r.markClass || '', unit: r.unit, basis: r.basis,
        quantity: 0, sources: [], notes: new Set(),
      };
      map.set(key, item);
    }
    item.quantity += r.quantity;
    item.sources.push({ page: r.page, quantity: round(r.quantity, 3) });
    if (r.note) item.notes.add(r.note);
  }
  const items = [...map.values()].map((it) => {
    // Арматура и закладные: сводная ведомость — основной источник; если её
    // нет, считаем по спецификациям. Бетон — только из спецификаций. Прочий
    // металл (труба, лист) в расчёт не идёт — на него нет цены.
    let counted = 1;
    if (it.kind === 'metal') counted = 0;
    else if ((it.kind === 'steel' || it.kind === 'embedded') && it.basis === 'spec' && hasSummary) counted = 0;
    return {
      kind: it.kind, block: it.block, element: it.element, name: it.name, mark_class: it.mark_class, unit: it.unit, basis: it.basis,
      quantity: round(it.quantity, 3), counted,
      note: [...it.notes].join('; ') || null,
      sources: it.sources.sort((a, b) => a.page - b.page),
    };
  });
  items.sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || b.counted - a.counted
    || (a.block || '').localeCompare(b.block || '', 'ru', { numeric: true })
    || elementOrder.get(a.element) - elementOrder.get(b.element)
    || a.name.localeCompare(b.name, 'ru', { numeric: true }));
  return items.map((it, i) => ({ ...it, sort: i }));
}

module.exports = { consolidate, norm, KIND_ORDER };
