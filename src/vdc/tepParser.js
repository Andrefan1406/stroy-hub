// Разбор таблицы «ТЭП по типам квартир» с листа чертежей АР.
//
// На вход — текстовые элементы листа из pdf.js: { str, x, y, w, h }, где (x, y) — левый верхний
// угол в пунктах, y растёт вниз. Таблица в чертеже имеет фиксированные столбцы:
//   № п/п | Наименование | Кол-во на этаж | Этаж размещения | жилая, общая, общая с летними (на квартиру)
//   | Кол-во на дом | жилая, общая, общая с летними (всего на дом)
// и итоговую строку «Всего на дом». Строки с этажами «1-9» разворачиваются в отдельные
// строки по каждому этажу: { floor, type, qty }.

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

const INT = /^\d+$/;
const NUM = /^\d+(?:[.,]\d+)?$/;
const FLOORS = /^\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–—]\s*\d+)?)*$/;

const MAX_FLOOR = 200;

// «1-9», «1, 3-5» → [1..9], [1,3,4,5]; мусор → null
function parseFloors(text) {
  const parts = String(text).split(/[,;]/);
  const out = new Set();
  for (const part of parts) {
    const m = part.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (to < from || to > MAX_FLOOR) return null;
    for (let f = from; f <= to; f += 1) out.add(f);
  }
  return [...out].sort((a, b) => a - b);
}

// Элементы → строки таблицы (по близости y), внутри строки — по x.
function groupRows(items, tolerance = 4) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.y - last.y) <= tolerance) last.tokens.push(it);
    else rows.push({ y: it.y, tokens: [it] });
  }
  rows.forEach((r) => r.tokens.sort((a, b) => a.x - b.x));
  return rows;
}

const rowText = (row) => row.tokens.map((t) => t.str).join(' ');

// Строка данных: № + название + ровно 9 числовых столбцов с хвоста.
function parseDataRow(row) {
  const tokens = row.tokens;
  if (tokens.length < 3 || !INT.test(tokens[0].str.trim())) return null;
  const rest = tokens.slice(1);
  let tail = 0;
  while (tail < rest.length && (NUM.test(rest[rest.length - 1 - tail].str.trim()) || FLOORS.test(rest[rest.length - 1 - tail].str.trim()))) tail += 1;
  if (tail < 9) return null;
  const cols = rest.slice(rest.length - 9).map((t) => t.str.trim());
  const nameTokens = rest.slice(0, rest.length - 9);
  const name = nameTokens.map((t) => t.str.trim()).join(' ').replace(/\s+/g, ' ').trim();
  if (!name || !/[A-Za-zА-Яа-яЁё]/.test(name)) return null;
  if (!INT.test(cols[0])) return null;
  const floors = parseFloors(cols[1]);
  if (!floors) return null;
  return {
    no: Number(tokens[0].str.trim()),
    name,
    qtyPerFloor: Number(cols[0]),
    floorsText: cols[1],
    floors,
    qtyHouse: INT.test(cols[5]) ? Number(cols[5]) : null,
    areaTotal: NUM.test(cols[3]) ? Number(cols[3].replace(',', '.')) : null,
    y: row.y,
    nameX: nameTokens[0].x,
  };
}

// → { types, rows, totalHouse, checks }. Бросает Error с понятным текстом, если таблицы нет.
export function parseTep(items) {
  const clean = (items || []).filter((i) => String(i.str ?? '').trim());
  const titleRow = groupRows(clean).find((r) => norm(rowText(r)).includes('тэп по типам квартир'));
  if (!titleRow) throw new Error('На этом листе не найдена таблица «ТЭП по типам квартир».');

  // левая граница таблицы — столбец «№ п/п» в шапке; всё левее (текст «Общих данных») не берём
  const headerZone = clean.filter((i) => i.y > titleRow.y && i.y < titleRow.y + 120);
  const numHead = headerZone.find((i) => norm(i.str).startsWith('№'));
  const titleItem = titleRow.tokens[0];
  const leftX = numHead ? numHead.x - 10 : titleItem.x - 250;

  const below = clean.filter((i) => i.y > titleRow.y + 2 && i.x >= leftX);
  const rows = groupRows(below);

  const types = [];
  let totalHouse = null;
  let lastData = null;
  for (const row of rows) {
    const text = norm(rowText(row));
    if (text.startsWith('всего')) {
      const first = row.tokens.slice(1).find((t) => INT.test(t.str.trim()));
      totalHouse = first ? Number(first.str.trim()) : null;
      break;
    }
    const data = parseDataRow(row);
    if (data) {
      types.push(data);
      lastData = data;
      continue;
    }
    if (lastData) {
      const onlyText = row.tokens.every((t) => !NUM.test(t.str.trim()));
      // перенос длинного названия на вторую строку
      if (onlyText && row.y - lastData.y < 16 && row.tokens[0].x >= lastData.nameX - 5) {
        lastData.name = `${lastData.name} ${rowText(row)}`.replace(/\s+/g, ' ').trim();
        lastData.y = row.y;
        continue;
      }
      if (row.y - lastData.y > 40) break; // таблица закончилась
    }
  }
  if (!types.length) throw new Error('Заголовок «ТЭП по типам квартир» найден, но строки с типами квартир разобрать не удалось.');

  const out = [];
  for (const t of types) for (const floor of t.floors) out.push({ floor, type: t.name, qty: t.qtyPerFloor });
  const typeOrder = new Map(types.map((t, i) => [t.name, i]));
  out.sort((a, b) => a.floor - b.floor || typeOrder.get(a.type) - typeOrder.get(b.type));

  const checks = [];
  for (const t of types) {
    if (t.qtyHouse === null) continue;
    const calc = t.qtyPerFloor * t.floors.length;
    checks.push({
      ok: calc === t.qtyHouse,
      text: calc === t.qtyHouse
        ? `${t.name}: ${t.qtyPerFloor} шт. × ${t.floors.length} эт. = ${calc} — совпадает с «Кол-во на дом» (${t.qtyHouse})`
        : `${t.name}: ${t.qtyPerFloor} шт. × ${t.floors.length} эт. = ${calc}, а в таблице «Кол-во на дом» ${t.qtyHouse} — проверьте этажи размещения`,
    });
  }
  const sumTable = out.reduce((s, r) => s + r.qty, 0);
  if (totalHouse !== null) {
    checks.push({
      ok: sumTable === totalHouse,
      text: sumTable === totalHouse
        ? `Всего квартир ${sumTable} — совпадает со строкой «Всего на дом» (${totalHouse})`
        : `Всего квартир ${sumTable}, а в строке «Всего на дом» ${totalHouse} — возможно, не все типы разобраны`,
    });
  } else {
    checks.push({ ok: false, text: 'Строка «Всего на дом» не найдена — сверить итог не с чем' });
  }

  return { types, rows: out, totalHouse, total: sumTable, checks };
}

export { parseFloors, groupRows };
