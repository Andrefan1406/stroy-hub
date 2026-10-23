// «Спецификация …» на листах элементов КЖ (стена, плита, лестница, приямок):
//
//   Марка, поз. | Обозначение | Наименование | Кол. | Масса ед., кг | Примечание
//   Детали
//   (214-210-0201-0004)  Арматура ∅12 А400                       ← заголовок группы
//   1   ГОСТ 34028-2016   L=5280 мм   94   6,1   573,0 кг.       ← позиции группы
//   Итого : 9889,0 кг.                                           ← итог группы
//   Материалы
//   (212-101-0901)  Бетон С20/25   92,0   м³                     ← бетон элемента
//
// Таблицы находим по шапке («Обозначение», «Наименование», «Кол.», часто
// «Масса», «Примечание»): на листе их может быть несколько (рядом и друг под
// другом). Колонки — по левым краям, смещённым от шапки: шапка выровнена по
// центру ячейки, а данные — по левому краю, поэтому «ближайшая колонка»
// по x ошибается (например, «мм» из наименования попадает в «Кол.»).
//
// Что берём: бетон (класс, объём), арматуру по группам (из «Итого» группы,
// а без него — суммой масс позиций), прочий металл и закладные с массой
// (труба, лист, МН-детали) — справочно.
const { groupRows, joinText, parseNum, tidy, round } = require('../layout');

// «Арматура ∅12 А 400», «Арматура ∅10 А400, L=3945» и просто «∅10 A400, м.п.»
// (в спецификациях фундаментов слова «Арматура» нет; А бывает латинской).
const STEEL_HDR_RE = /(?:Арматура\s*)?[∅Ø⌀]\s*(\d+(?:[.,]\d+)?)\s*[АA]\s*-?\s*(\d{3})/i;
const SECTION_RE = /^(Детали|Материалы|Изделия закладные|Сборочные единицы|Стандартные изделия|Прочие изделия)(?![А-Яа-яЁёA-Za-z0-9])/i;
// «Бетон С20/25», «Бетон С 8/10», «Бетон кл. С12/15, F100, W4», «Бетон B25».
const CONCRETE_RE = /Бетон\s*(?:кл\.?\s*)?([СCсcВBвb])\s?(\d+(?:[.,]\d+)?(?:\s?\/\s?\d+)?)/;
const VOLUME_RE = /(\d+(?:[.,]\d+)?)\s*м\s*[³3]/i;
const TABLE_END_RE = /(Ведомость расхода|Ведомость деталей|Удельные показатели|Спецификация|Расход стали)/i;
const MASS_KG_RE = /(\d[\d\s]*(?:[.,]\d+)?)\s*кг/i;

const cyr = (ch) => ({ C: 'С', c: 'С', с: 'С', B: 'В', b: 'В', b2: 'В', в: 'В' }[ch] || ch);
const normClass = (letter, num) => `${cyr(letter.toUpperCase() === 'С' || letter.toUpperCase() === 'C' ? 'C' : 'B')}${num.replace(/\s/g, '').replace(',', '.')}`;

// Заголовки таблиц на странице.
function findTables(items) {
  const tables = [];
  for (const obozn of items.filter((it) => /^Обозначение$/i.test(it.s.trim()))) {
    const near = items.filter((it) => Math.abs(it.y - obozn.y) <= 8);
    const name = near.filter((it) => /^Наименование$/i.test(it.s.trim()) && it.x > obozn.x).sort((a, b) => a.x - b.x)[0];
    if (!name) continue;
    const kol = near.filter((it) => /^Кол\s*\.?$/i.test(it.s.trim()) && it.x > name.x).sort((a, b) => a.x - b.x)[0];
    if (!kol) continue; // без «Кол.» — не спецификация (например, таблица примечаний)
    const posItem = items
      .filter((it) => /^(Поз|Марка)/i.test(it.s.trim()) && it.x < obozn.x && Math.abs(it.y - obozn.y) <= 14 && obozn.x - it.x < 140)
      .sort((a, b) => a.x - b.x)[0];
    const mass = items
      .filter((it) => /^Масса/i.test(it.s.trim()) && it.x > kol.x - 5 && it.x < kol.x + 110 && it.y > obozn.y - 6 && it.y < obozn.y + 50)
      .sort((a, b) => a.x - b.x)[0];
    // «Примеча-» / «ние» бывает в две строки, верхняя выше «Обозначения» на ~10.
    const prim = items
      .filter((it) => /^Приме/i.test(it.s.trim()) && it.x > kol.x && Math.abs(it.y - obozn.y) <= 18)
      .sort((a, b) => a.x - b.x)[0];
    const posX = posItem ? posItem.x : obozn.x - 90;
    tables.push({
      yHeader: obozn.y,
      edges: {
        pos: posX - 30,
        oboz: obozn.x - 25,
        // Заголовок выровнен по центру ячейки, данные — по левому краю: граница
        // «Обозначение | Наименование» — середина между заголовками.
        name: (obozn.x + name.x) / 2,
        kol: kol.x - 14,
        mass: mass ? mass.x - 12 : null,
        prim: prim ? prim.x - 12 : null,
      },
      xRight: (prim ? prim.x : kol.x) + (prim ? 150 : 170),
    });
  }
  // Таблицы рядом: правая граница левой — не дальше левого края правой.
  tables.sort((a, b) => a.edges.pos - b.edges.pos);
  tables.forEach((t, i) => {
    const next = tables[i + 1];
    if (next && Math.abs(next.yHeader - t.yHeader) < 200) t.xRight = Math.min(t.xRight, next.edges.pos - 2);
  });
  return tables;
}

// Текст ячеек по колонкам.
function columnOf(edges, x) {
  const order = ['prim', 'mass', 'kol', 'name', 'oboz', 'pos'];
  for (const c of order) if (edges[c] != null && x >= edges[c]) return c;
  return 'pos';
}

function cellsOf(edges, rowItems) {
  const by = { pos: [], oboz: [], name: [], kol: [], mass: [], prim: [] };
  for (const it of rowItems) by[columnOf(edges, it.x)].push(it);
  const out = {};
  for (const k of Object.keys(by)) out[k] = joinText(by[k]);
  out.full = joinText(rowItems);
  return out;
}

function titleOf(items, table) {
  const region = items.filter((it) => it.x >= table.edges.pos && it.x < table.xRight && it.y > table.yHeader + 14 && it.y < table.yHeader + 75);
  const row = groupRows(region, 4).find((r) => /Спецификация/i.test(joinText(r.items)));
  if (!row) return '';
  return elementLabel(joinText(row.items).replace(/^.*?Спецификация\s*/i, ''));
}

// «стен монолитных См 1 т , См 1 н ( начало )» -> «Стен монолитных См 1 т, См 1 н».
function elementLabel(s) {
  const t = tidy(String(s).replace(/\(\s*(начало|окончание|продолжение)\s*\)/gi, ' ').replace(/,(?=[^\s\d])/g, ', '));
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

const massOf = (text) => {
  const m = String(text || '').match(MASS_KG_RE);
  return m ? parseNum(m[1]) : null;
};

// Масса позиции арматуры: «573,0 кг», но в части листов вместо «кг» стоит
// «мм» («72,9 мм») или единицы нет вовсе («9,90») — тогда берём число из
// колонки «Примечание».
const positionMass = (c) => {
  const m = massOf(c.prim) ?? massOf(c.full);
  if (m !== null) return m;
  const num = String(c.prim || '').match(/^\s*(\d+(?:[.,]\d+)?)/);
  return num ? parseNum(num[1]) : null;
};

// Объём бетона: число в «Кол.» либо «0,30 м³» в «Примечании».
const concreteVolume = (c) => {
  const q = parseNum(c.kol);
  if (q !== null) return q;
  const m = String(c.prim || '').match(VOLUME_RE);
  return m ? parseNum(m[1]) : null;
};

// Разбор одной таблицы. Возвращает { rows, issues, title }.
//
// В таблице может быть несколько элементов подряд (плита ППдм 1, приямки
// П 1, П 2): каждый начинается строкой-названием с количеством элементов в
// колонке «Кол.», дальше — «Детали» / «Материалы» на ОДИН элемент. Поэтому
// объёмы и массы умножаются на это количество (проверка по листу «Ведомость
// расхода стали»: ППдм 1 — 2 шт., ∅8 22,5 кг × 2 = 45 кг в сводной ведомости).
function parseTable(items, table, pageNo) {
  const { edges } = table;
  const title = titleOf(items, table);
  const issues = [];
  const rows = [];
  const sheetElement = title || `Лист ${pageNo}`;

  const region = items.filter((it) => it.x >= edges.pos && it.x < table.xRight && it.y < table.yHeader - 24 && it.y > 120);
  const lines = groupRows(region, 3);
  const consumed = [];
  let prevY = table.yHeader - 24;
  for (const line of lines) {
    if (consumed.length && prevY - line.y > 100) break; // дальше — текст примечаний, а не таблица
    const text = joinText(line.items);
    if (TABLE_END_RE.test(text)) break;
    consumed.push({ y: line.y, items: line.items, c: cellsOf(edges, line.items) });
    prevY = line.y;
  }

  // Сноска «Расход в спецификации дан на одну стену» — значения на один элемент,
  // а сколько элементов — в спецификации к схемам расположения (не разбираем).
  const perUnitNote = items.some((it) => /Расход в спецификации дан/i.test(it.s) && it.x >= edges.pos && it.x < table.xRight)
    ? 'Расход в спецификации дан на один элемент — количество элементов смотрите на листах расположения'
    : null;

  // Текущий элемент: название и количество (по строке-названию либо по листу).
  let state = { element: sheetElement, count: 1 };
  const groups = new Map(); // `${dia}|${cls}` -> { dia, cls, positions, total, state }
  let current = null;
  const noteFor = (st) => (st.count > 1 ? `Элементов: ${st.count} × расход на один элемент` : perUnitNote);
  const flush = (g) => {
    if (!g) return;
    const kg = g.total ?? (g.positions.length ? g.positions.reduce((s, v) => s + v, 0) : null);
    if (kg == null || !(kg > 0)) return;
    if (g.total != null && g.positions.length) {
      const sum = g.positions.reduce((s, v) => s + v, 0);
      if (Math.abs(sum - g.total) > Math.max(1, g.total * 0.02)) {
        issues.push({ page: pageNo, message: `${g.state.element}: арматура ∅${g.dia} А${g.cls} — «Итого» ${round(g.total, 1)} кг не сходится с суммой позиций ${round(sum, 1)} кг` });
      }
    }
    rows.push({
      kind: 'steel', element: g.state.element, name: `Арматура ∅${g.dia}`, markClass: `А${g.cls}`, unit: 'кг',
      quantity: round(kg * g.state.count, 1), page: pageNo, basis: 'spec', note: noteFor(g.state),
    });
  };
  const flushAll = () => { for (const g of groups.values()) flush(g); groups.clear(); current = null; };
  const groupFor = (dia, cls) => {
    const key = `${dia}|${cls}`;
    if (!groups.has(key)) groups.set(key, { dia, cls, positions: [], total: null, state });
    return groups.get(key);
  };

  // Строки-обломки названия (без числа и массы) относим к ближайшей строке с данными.
  const isData = (l) => parseNum(l.c.kol) !== null || positionMass(l.c) !== null;
  const fragments = new Map();
  consumed.forEach((l) => {
    if (isData(l) || !l.c.name || SECTION_RE.test(l.c.name) || STEEL_HDR_RE.test(l.c.name)) return;
    let best = null;
    for (const d of consumed) if (isData(d) && (best === null || Math.abs(d.y - l.y) < Math.abs(best.y - l.y))) best = d;
    if (best && Math.abs(best.y - l.y) <= 16) {
      if (!fragments.has(best)) fragments.set(best, []);
      fragments.get(best).push(l);
    }
  });

  // Строка-название элемента: текст в «Наименовании», без кодов и масс, а
  // следом — «Детали» / «Материалы» / группа арматуры (или это первая строка).
  const isElementHead = (l, i) => {
    const { c } = l;
    if (!c.name || c.pos || c.oboz || positionMass(c) !== null) return false;
    if (SECTION_RE.test(c.name) || STEEL_HDR_RE.test(c.name) || CONCRETE_RE.test(c.name) || /^Итого/i.test(c.name)) return false;
    const next = consumed[i + 1];
    return i === 0 || (!!next && (SECTION_RE.test(next.c.name) || STEEL_HDR_RE.test(next.c.name)));
  };

  consumed.forEach((l, i) => {
    const { c } = l;
    const n = c.name;

    if (isElementHead(l, i)) {
      flushAll();
      const cnt = parseNum(c.kol);
      state = { element: elementLabel(n), count: cnt > 0 ? cnt : 1 };
      return;
    }

    if (SECTION_RE.test(n) && parseNum(c.kol) === null) {
      flushAll();
      return;
    }

    // Итого по группе арматуры.
    if (/^Итого(?![А-Яа-яЁёA-Za-z0-9])/i.test(n) || /^Итого(?![А-Яа-яЁёA-Za-z0-9])/i.test(c.full)) {
      const kg = massOf(c.prim) ?? massOf(c.full);
      if (current && kg != null) {
        current.total = kg;
        flush(current);
        groups.delete(`${current.dia}|${current.cls}`);
        current = null;
      }
      return;
    }

    // Заголовок группы арматуры.
    const hdr = n.match(STEEL_HDR_RE);
    if (hdr && parseNum(c.kol) === null) {
      current = groupFor(hdr[1].replace(',', '.'), hdr[2]);
      return;
    }

    // Бетон.
    const full = `${c.oboz} ${c.name}`;
    const con = full.match(CONCRETE_RE);
    if (con) {
      const qty = concreteVolume(c);
      if (qty === null) {
        issues.push({ page: pageNo, message: `${state.element}: строка бетона «${tidy(full)}» без объёма` });
        return;
      }
      const cls = normClass(con[1], con[2]);
      const prep = /подготовк/i.test(full);
      rows.push({
        kind: 'concrete', element: state.element,
        name: prep ? `Бетонная подготовка, бетон ${cls}` : `Бетон ${cls}`,
        markClass: cls, unit: 'м³', quantity: round(qty * state.count, 2), page: pageNo, basis: 'spec', note: noteFor(state),
      });
      return;
    }

    // Позиция арматуры: «Арматура ∅10 А400, L=3945» в строке или «L=5280 мм» под заголовком группы.
    const kg = positionMass(c);
    if (parseNum(c.kol) !== null && (hdr || (current && /^L\s*=|м\.п\./i.test(n)))) {
      const g = hdr ? groupFor(hdr[1].replace(',', '.'), hdr[2]) : current;
      const m = positionMass(c);
      if (m != null) g.positions.push(m);
      return;
    }

    // Прочий металл и закладные с массой: труба, лист, МН-детали.
    if (n && parseNum(c.kol) !== null && kg !== null && !(current && /^L\s*=/i.test(n))) {
      const extra = (fragments.get(l) || []).sort((a, b) => b.y - a.y).map((f) => f.c.name).join(' ');
      const own = `Количество: ${c.kol}`;
      const note = [own, noteFor(state)].filter(Boolean).join('; ');
      rows.push({
        kind: 'metal', element: state.element, name: tidy(`${n} ${extra}`), markClass: '', unit: 'кг',
        quantity: round(kg * state.count, 1), page: pageNo, basis: 'spec', note,
      });
    }
  });
  flushAll();
  return { rows, issues, title };
}

// Все спецификации страницы: { rows, issues, tables }.
function parseSpecifications(page) {
  const tables = findTables(page.items);
  const out = { rows: [], issues: [], tables: tables.length, titles: [] };
  for (const table of tables) {
    try {
      const r = parseTable(page.items, table, page.page);
      out.rows.push(...r.rows);
      out.issues.push(...r.issues);
      out.titles.push(r.title);
      if (!r.rows.length) out.issues.push({ page: page.page, message: `Спецификация «${r.title || 'без названия'}»: не найдено ни бетона, ни арматуры, ни закладных`, level: 'info' });
    } catch (err) {
      out.issues.push({ page: page.page, message: `Не удалось разобрать таблицу спецификации: ${err.message}` });
    }
  }
  return out;
}

module.exports = { parseSpecifications, findTables, elementLabel };
