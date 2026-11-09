// «Ведомость отделки помещений» (лист «Общие данные»): по каждому типу квартиры — помещения с видом
// отделки потолка и стен и площадями на 1 квартиру / секцию / дом. Таблица может идти в две колонки листа
// («начало» и «окончание»), последний тип квартиры продолжается во второй. Плюс «Виды отделки помещений» —
// расшифровка номеров видов.
import { groupRows } from "./tepParser";

const DEC = /^\d+(?:,\d+)?$/;
const TYPE = /^\d+\s?[а-яa-z]?$/i;
const letters = (s) => (String(s).match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
const toNum = (s) => Number(String(s).replace(",", "."));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const normId = (s) => String(s).replace(/\s+/g, "").toLowerCase();
const naturalCompare = (a, b) => String(a).localeCompare(String(b), "ru", { numeric: true });
const EMPTY_WALLS_PENALTY = 60;

const nearest = (x, anchors) => anchors.reduce((best, a, i) => (Math.abs(a - x) < Math.abs(anchors[best] - x) ? i : best), 0);

// Стены — подряд идущие строки, их надо раздать помещениям так, чтобы строки помещения стояли вокруг его
// собственной строки (помещение с несколькими видами стен вертикально центрировано).
function assignWalls(rooms, walls) {
  const m = rooms.length;
  const n = walls.length;
  if (!m || !n) return;
  const INF = 1e12;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(INF));
  const from = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  dp[0][0] = 0;
  for (let j = 1; j <= m; j += 1) {
    for (let k = 0; k <= n; k += 1) {
      for (let st = 0; st <= k; st += 1) {
        if (dp[j - 1][st] >= INF) continue;
        let cost = EMPTY_WALLS_PENALTY;
        if (k > st) {
          const mean = walls.slice(st, k).reduce((acc, w) => acc + w.y, 0) / (k - st);
          cost = Math.abs(mean - rooms[j - 1].y);
        }
        if (dp[j - 1][st] + cost < dp[j][k]) {
          dp[j][k] = dp[j - 1][st] + cost;
          from[j][k] = st;
        }
      }
    }
  }
  let k = n;
  for (let j = m; j >= 1; j -= 1) {
    const st = from[j][k];
    rooms[j - 1].walls = walls.slice(st, k);
    k = st;
  }
}

// Найти таблицы по шапке: «Наименование» + «Примечание» справа; якоря столбцов площадей по шапке.
function findTables(items) {
  const heads = items.filter((i) => /^наименование$/i.test(i.str.trim()));
  if (!heads.length) return [];
  const topY = Math.min(...heads.map((h) => h.y));
  const starts = heads.filter((h) => Math.abs(h.y - topY) <= 4).sort((a, b) => a.x - b.x);
  return starts.map((h) => {
    const note = items.filter((i) => /^примечание/i.test(i.str.trim()) && i.x > h.x && Math.abs(i.y - topY) <= 12).sort((a, b) => a.x - b.x)[0];
    const next = starts.find((o) => o.x > h.x);
    const endX = note ? note.x + 45 : (next ? next.x - 10 : h.x + 540);
    const inTable = (i) => i.x >= h.x - 20 && i.x <= endX;
    const head = items.filter((i) => inTable(i) && i.y >= topY - 4 && i.y <= topY + 60);
    const anchor = (re) => head.filter((i) => re.test(i.str.trim())).map((i) => i.x).sort((a, b) => a - b);
    const flat = anchor(/^1\s*кв/i);
    const sec = anchor(/^секцию/i);
    const house = anchor(/^дом/i);
    const unitRows = head.filter((i) => /^м\s*[²2]$/.test(i.str.trim()));
    const bodyY = (unitRows.length ? Math.max(...unitRows.map((i) => i.y)) : topY + 40) + 3;
    if (flat.length < 2 || sec.length < 2 || house.length < 2) return null;
    return { startX: h.x - 20, endX, bodyY, anchors: [flat[0], sec[0], house[0], flat[1], sec[1], house[1]] };
  }).filter(Boolean);
}

// «Помещения являющиеся общим имуществом 1-9 этаж» → этажи группы; без номеров этажей — null
export function parseCommonFloors(title) {
  const range = String(title).match(/(\d+)\s*[-–—]\s*(\d+)\s*этаж/i);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return to >= from && to <= 200 ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : null;
  }
  const single = String(title).match(/(\d+)\s*этаж/i);
  return single ? [Number(single[1])] : null;
}

// → { apartments: { [code]: { rooms: [{ room, ceiling, walls }] } }, common: [{ floors, rooms }], groupAtEnd }
// common — группы «Помещения являющиеся общим имуществом N-M этаж»: площади в них даны на секцию сразу за все этажи группы.
export function parseFinishing(items, startGroup = null) {
  const clean = (items || []).filter((i) => String(i.str ?? "").trim());
  const tables = findTables(clean);
  const apartments = {};
  const common = [];
  let group = startGroup;

  for (const table of tables) {
    const body = clean.filter((i) => i.x >= table.startX && i.x <= table.endX && i.y > table.bodyY);
    const [cFlat, , cHouse, wFlat] = table.anchors;
    let segment = null; // { code, rooms, walls }
    const flush = () => {
      if (!segment) return;
      assignWalls(segment.rooms, segment.walls);
      if (segment.common) {
        const key = segment.common.title;
        const dst = common.find((c) => c.title === key) || (common.push({ title: key, floors: segment.common.floors, rooms: [] }), common[common.length - 1]);
        dst.rooms.push(...segment.rooms);
      } else {
        const dst = (apartments[segment.code] ||= { rooms: [] });
        dst.rooms.push(...segment.rooms);
      }
      segment = null;
    };

    for (const row of groupRows(body, 3)) {
      const tokens = row.tokens.map((t) => ({ ...t, str: t.str.trim() }));
      // в группе общих помещений столбцы «1 кв-ру» пусты — стоящий рядом с ними номер вида отделки не площадь
      const commonRow = group?.kind === "common";
      const decimals = tokens.filter((t) => {
        const idx = nearest(t.x, table.anchors);
        return DEC.test(t.str) && Math.abs(t.x - table.anchors[idx]) <= 28 && !(commonRow && (idx === 0 || idx === 3));
      });
      const rest = tokens.filter((t) => !decimals.includes(t));

      // заголовок группы: текст без площадей («Квартира - тип 1», «Подвал в осях 1…11», «Помещения являющиеся …»)
      if (!decimals.length && rest.some((t) => letters(t.str) >= 6)) {
        const text = rest.map((t) => t.str).join(" ").replace(/\s+/g, " ");
        flush();
        // «Сводная ведомость отделки» под таблицей — другая таблица; группа на ней не меняется,
        // и последний тип квартиры продолжается в следующей колонке листа («окончание»)
        if (/сводн/i.test(text)) break;
        const m = text.match(/квартира\s*-?\s*тип\s*(\S+)/i);
        if (m) group = { kind: "apartment", code: m[1] };
        else if (/общим\s+имуществ/i.test(text) && parseCommonFloors(text)) group = { kind: "common", title: text, floors: parseCommonFloors(text) };
        else group = { kind: "other", title: text };
        continue;
      }
      if (group?.kind !== "apartment" && group?.kind !== "common") continue;
      if (!segment) segment = { code: group.code, common: group.kind === "common" ? group : null, rooms: [], walls: [] };

      const byAnchor = (idx) => decimals.find((d) => nearest(d.x, table.anchors) === idx);
      // в группе общих помещений столбец «1 кв-ру» пуст: значения стоят в «на секцию» (за все этажи группы) и «на дом» —
      // «на секцию» кладём в flat, чтобы дальше работать с ней как с квартирой
      const common = group.kind === "common";
      const ceil = common ? [byAnchor(1), null, byAnchor(2)] : [byAnchor(0), byAnchor(1), byAnchor(2)];
      const wall = common ? [byAnchor(4), null, byAnchor(5)] : [byAnchor(3), byAnchor(4), byAnchor(5)];

      // слева от площади потолка: помещение и вид отделки потолка; между потолком и стенами — вид отделки стен
      const left = rest.filter((t) => t.x < cFlat - 15);
      const mid = rest.filter((t) => t.x > cHouse + 20 && t.x < wFlat - 12 && TYPE.test(t.str));

      if (ceil[0]) {
        const typeTok = left.length && TYPE.test(left[left.length - 1].str) ? left[left.length - 1] : null;
        const roomToks = typeTok ? left.slice(0, -1) : left;
        segment.rooms.push({
          room: roomToks.map((t) => t.str).join(" ").trim(),
          ceiling: typeTok ? { id: normId(typeTok.str), flat: toNum(ceil[0].str), section: ceil[1] ? toNum(ceil[1].str) : null, house: ceil[2] ? toNum(ceil[2].str) : null } : null,
          walls: [],
          y: row.y,
        });
      } else if (left.length && !wall[0]) {
        segment.rooms.push({ room: left.map((t) => t.str).join(" ").trim(), ceiling: null, walls: [], y: row.y });
      }
      if (wall[0] && mid.length) {
        segment.walls.push({ id: normId(mid[0].str), flat: toNum(wall[0].str), section: wall[1] ? toNum(wall[1].str) : null, house: wall[2] ? toNum(wall[2].str) : null, y: row.y });
      }
    }
    flush();
  }
  return { apartments, common, groupAtEnd: group };
}

// Объём отделки одной квартиры типа: потолки и стены по видам, площади «на 1 кв-ру» суммируются по помещениям.
export function summarizeApartment(rooms) {
  const acc = new Map();
  const add = (element, id, area) => {
    const key = `${element}|${id}`;
    acc.set(key, { element, id, area: (acc.get(key)?.area || 0) + area });
  };
  for (const r of rooms) {
    if (r.ceiling) add("ceiling", r.ceiling.id, r.ceiling.flat);
    for (const w of r.walls) add("walls", w.id, w.flat);
  }
  const order = { ceiling: 0, walls: 1 };
  return [...acc.values()]
    .map((x) => ({ ...x, area: round2(x.area) }))
    .sort((a, b) => order[a.element] - order[b.element] || naturalCompare(a.id, b.id));
}

// «Виды отделки помещений»: «1. Сплошное выравнивание …», «6а. Штукатурная …» → { '1': { text, title } }
export function parseLegend(items) {
  const clean = (items || []).filter((i) => String(i.str ?? "").trim());
  const head = clean.find((i) => /^виды отделки помещений/i.test(i.str.trim()));
  if (!head) return {};
  const startX = head.x - 12;
  const rows = groupRows(clean.filter((i) => i.x >= startX && i.y > head.y + 2), 3);
  const out = {};
  let cur = null;
  let lastId = null;
  for (const row of rows) {
    const first = row.tokens[0];
    const m = first.x <= head.x + 8 ? first.str.trim().match(/^(\d+[а-яa-z]?)\.\s*(.*)$/i) : null;
    if (m) {
      const id = normId(m[1]);
      if (lastId !== null && naturalCompare(id, lastId) <= 0) break; // дальше пошёл список примечаний — нумерация началась заново
      lastId = id;
      cur = { id, parts: [[m[2], ...row.tokens.slice(1).map((t) => t.str.trim())].filter(Boolean).join(" ")] };
      out[id] = cur;
    } else if (cur) {
      cur.parts.push(row.tokens.map((t) => t.str.trim()).join(" "));
    }
  }
  const result = {};
  for (const [id, v] of Object.entries(out)) {
    const text = v.parts.join(" ").replace(/\s+/g, " ").trim();
    const cut = text.split(/\s+АГСК/)[0].replace(/([а-яa-z])\s+-([а-яa-z])/gi, "$1-$2").trim();
    result[id] = { text, title: cut.length > 140 ? `${cut.slice(0, 137)}…` : cut };
  }
  return result;
}

// Проверки: потолки в сумме дают общую площадь квартиры; «на дом» = «на 1 кв-ру» × число квартир.
export function checkFinishing(apartments, tepTypes, typeCodeFromName) {
  const checks = [];
  for (const t of tepTypes || []) {
    const code = typeCodeFromName(t.name);
    const apt = code && apartments[code];
    if (!apt) {
      if (code) checks.push({ ok: false, text: `Тип ${code}: в ведомости отделки не найден` });
      continue;
    }
    const ceilSum = round2(apt.rooms.reduce((s, r) => s + (r.ceiling ? r.ceiling.flat : 0), 0));
    if (t.areaTotal != null) {
      checks.push({
        ok: Math.abs(ceilSum - t.areaTotal) <= 0.02,
        text: Math.abs(ceilSum - t.areaTotal) <= 0.02
          ? `Тип ${code}: сумма потолков ${ceilSum} м² = общая площадь квартиры по ТЭП`
          : `Тип ${code}: сумма потолков ${ceilSum} м², а общая площадь по ТЭП ${t.areaTotal} м² — возможно, часть помещений не прочитана`,
      });
    }
    if (t.qtyHouse) {
      const items = apt.rooms.flatMap((r) => [r.ceiling, ...r.walls]).filter((x) => x && x.house != null);
      const bad = items.filter((x) => Math.abs(x.flat * t.qtyHouse - x.house) > 0.05 * Math.max(1, t.qtyHouse / 10));
      if (items.length) {
        checks.push({
          ok: bad.length === 0,
          text: bad.length === 0
            ? `Тип ${code}: площади «на дом» = «на 1 кв-ру» × ${t.qtyHouse} во всех ${items.length} строках`
            : `Тип ${code}: в ${bad.length} из ${items.length} строк «на дом» не равно «на 1 кв-ру» × ${t.qtyHouse} — проверьте столбцы`,
        });
      }
    }
  }
  return checks;
}

// Названия помещений из экспликации плана подставляются в ведомость отделки по номеру помещения.
// Проверка: площадь помещения в экспликации (по типу квартиры) = площадь потолка из ведомости отделки.
export function checkRoomNames(apartments, explicationRooms) {
  const byNo = new Map((explicationRooms || []).map((r) => [r.no, r]));
  const checks = [];
  for (const [code, apt] of Object.entries(apartments)) {
    let total = 0;
    const bad = [];
    for (const room of apt.rooms) {
      if (!room.ceiling) continue;
      total += 1;
      const ex = byNo.get(String(room.room).trim());
      const area = ex?.areas?.[code];
      if (area == null || Math.abs(area - room.ceiling.flat) > 0.02) bad.push(room.room);
    }
    if (!total) continue;
    checks.push({
      ok: bad.length === 0,
      text: bad.length === 0
        ? `Тип ${code}: названия помещений подставлены по номерам, площади помещений совпадают с экспликацией (${total} из ${total})`
        : `Тип ${code}: у помещений № ${bad.join(", ")} название или площадь не совпали с экспликацией на плане — проверьте номера помещений`,
    });
  }
  return checks;
}
