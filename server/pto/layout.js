// Геометрические помощники для разбора таблиц по координатам текста: строки
// по близости baseline, склейка фрагментов, числа в русской записи.

// Группировка по строкам: элементы одной строки — те, чей y отличается от
// строки не больше tol. Строки сверху вниз (по убыванию y), внутри — слева
// направо.
function groupRows(items, tol = 3) {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) last.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

// Склейка фрагментов строки в текст: пробел, если между фрагментами есть зазор.
function joinText(items) {
  const sorted = items.slice().sort((a, b) => a.x - b.x);
  let out = '';
  let prevEnd = null;
  for (const it of sorted) {
    if (prevEnd !== null && it.x - prevEnd > 1) out += ' ';
    out += it.s.trim();
    prevEnd = it.x + it.w;
  }
  return tidy(out);
}

// Лишние пробелы вокруг знаков препинания и внутри чисел-единиц.
function tidy(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .trim();
}

// «92,0», «74.7», «1 234,5», «46394,8» -> число; не число -> null.
function parseNum(s) {
  if (s == null) return null;
  const t = String(s).replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const isNum = (s) => parseNum(s) !== null;

const round = (v, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

module.exports = { groupRows, joinText, tidy, parseNum, isNum, round };
