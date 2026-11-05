// Экспликация помещений этажа на секцию (лист «Маркировочный план …»): колонки по типам квартир
// и строка «Количество квартир на этаже». Нужны этажи (из заголовка), типы и количество на этаж.
import { groupRows } from "./tepParser";

const squash = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9№]/g, "");
const rowText = (row) => row.tokens.map((t) => t.str).join(" ").replace(/\s+/g, " ").trim();

const TITLE_RE = /экспликаци\S*\s+помещени\S*\s+(.+?)\s+этаж\S*\s+на\s+(.+)$/i;
const TYPE_CODE = /^\d+[а-яa-z]?$/i;
const INT = /^\d+$/;
const MAX_FLOOR = 200;

// «2...6-го», «1-го», «7…9-го», «2-6-го» → [2..6]
export function parseFloorsFromTitle(text) {
  const range = String(text).match(/(\d+)\s*(?:\.{2,}|…|[–—]|-(?=\s*\d))\s*(\d+)/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to < from || to > MAX_FLOOR) return null;
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  const single = String(text).match(/(\d+)/);
  return single ? [Number(single[1])] : null;
}

// «секцию» → одна типовая; «секцию №2» → конкретная; «две секции», «дом» → не по одной секции
export function parseScope(text) {
  const t = String(text);
  const numbered = t.match(/секци\S*\s*№\s*(\d+(?:\/\d+)?)/i);
  if (numbered) return { kind: "section", id: numbered[1] };
  if (/(?:две|три|четыре|пять|\d+)\s+секци/i.test(t)) return { kind: "several", id: null };
  if (/(?:^|[^а-яё])дом(?![а-яё])/i.test(t)) return { kind: "house", id: null };
  return { kind: "section", id: null };
}

// Заголовок экспликации этажей в элементах листа → { text, floors, scope, row } или null.
export function findExplicationTitle(items) {
  const rows = groupRows((items || []).filter((i) => String(i.str ?? "").trim()));
  for (const full of rows) {
    // в одной строке с заголовком бывает подпись соседнего чертежа («АР-13 Маркировочный план …») —
    // берём только часть строки, начиная со слова «Экспликация»
    const idx = full.tokens.findIndex((t) => /экспликаци/i.test(t.str));
    if (idx < 0) continue;
    const row = { y: full.y, tokens: full.tokens.slice(idx) };
    const text = rowText(row);
    const m = text.match(TITLE_RE);
    if (!m) continue;
    const floors = parseFloorsFromTitle(m[1]);
    if (!floors) continue;
    return { text, floors, scope: parseScope(m[2]), row };
  }
  return null;
}

// → { title, floors, scope, types: [{ code, qty }] }. Бросает Error с понятным текстом.
export function parseExplication(items) {
  const title = findExplicationTitle(items);
  if (!title) throw new Error("не найден заголовок «Экспликация помещений … этажа на секцию».");

  const leftX = Math.min(...title.row.tokens.map((t) => t.x)) - 40;
  const body = (items || []).filter((i) => i.y > title.row.y + 2 && i.x >= leftX && String(i.str ?? "").trim());
  const rows = groupRows(body);

  // строка «Тип квартиры»: подпись + коды типов справа
  const typeRow = rows.find((r) => squash(r.tokens.map((t) => t.str).join("")).startsWith("типквартиры"));
  if (!typeRow) throw new Error("не найдена строка «Тип квартиры».");
  const typeCols = typeRow.tokens.filter((t) => TYPE_CODE.test(t.str.trim())).map((t) => ({ code: t.str.trim(), x: t.x, w: t.w || 0 }));
  if (!typeCols.length) throw new Error("в строке «Тип квартиры» нет ни одного типа.");

  // строка «Количество квартир на этаже»: подпись склеена из отдельных букв — ищем по «сплющенному» тексту
  const qtyRow = rows.find((r) => squash(r.tokens.map((t) => t.str).join("")).includes("количествоквартир"));
  if (!qtyRow) throw new Error("не найдена строка «Количество квартир на этаже».");
  const firstCol = Math.min(...typeCols.map((c) => c.x));
  const values = qtyRow.tokens.filter((t) => INT.test(t.str.trim()) && t.x >= firstCol - 30);

  // «Жилая площадь квартиры» — строка со значениями по типам (как напечатано, «16,65»)
  const livingRow = rows.find((r) => squash(r.tokens.map((t) => t.str).join("")).startsWith("жилаяплощадьквартиры"));
  const livingOf = (col) => {
    const v = livingRow?.tokens.filter((t) => /^\d+(?:,\d+)?$/.test(t.str.trim())).reduce((best, t) => (Math.abs(t.x - col.x) < Math.abs((best?.x ?? Infinity) - col.x) ? t : best), null);
    return v && Math.abs(v.x - col.x) <= 30 ? v.str.trim() : null;
  };

  const types = [];
  for (const col of typeCols) {
    const v = values.reduce((best, t) => (Math.abs(t.x - col.x) < Math.abs((best?.x ?? Infinity) - col.x) ? t : best), null);
    if (!v || Math.abs(v.x - col.x) > 30) throw new Error(`для типа ${col.code} не нашлось количества квартир на этаже.`);
    types.push({ code: col.code, qty: Number(v.str.trim()), living: livingOf(col) });
  }
  // помещения квартир: «1 | Прихожая | 4,83 | 8,85» — номер, название и площадь по типам («-» — в этом типе помещения нет)
  const rooms = [];
  if (livingRow) {
    for (const r of rows) {
      if (r.y <= typeRow.y + 2 || r.y >= livingRow.y - 2) continue;
      const left = r.tokens.filter((t) => t.x < firstCol - 30);
      const no = left[0] && INT.test(left[0].str.trim()) ? left[0].str.trim() : null;
      const name = left.slice(1).map((t) => t.str.trim()).join(" ").replace(/\s+/g, " ").trim();
      if (!no || !/[A-Za-zА-Яа-яЁё]/.test(name)) continue;
      const areas = {};
      for (const col of typeCols) {
        const v = r.tokens.filter((t) => t.x >= firstCol - 30).reduce((best, t) => (Math.abs(t.x - col.x) < Math.abs((best?.x ?? Infinity) - col.x) ? t : best), null);
        areas[col.code] = v && Math.abs(v.x - col.x) <= 30 && /^\d+(?:,\d+)?$/.test(v.str.trim()) ? Number(v.str.trim().replace(",", ".")) : null;
      }
      rooms.push({ no, name, areas });
    }
  }
  return { title: title.text, floors: title.floors, scope: title.scope, types, rooms, planLimitX: leftX - 20 };
}
