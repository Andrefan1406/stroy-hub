// Работы ВДЦ на внутреннюю отделку: по правилам «помещение → работы» (лист «Помещения» файла расценок
// VK development group) и объёмам из ведомости отделки считаем количество, цену и сумму.
//
// Основа объёма определяется по названию работы и примечанию из правил:
//   шпатлевание стен и потолков — стены + потолок (потолки в помещениях 1–10 НЕ учитываются: будет отдельная ВДЦ на
//                                 натяжные потолки), из площади стен вычитается фартук кухни;
//   оклейка / окраска стен       — площадь стен (без фартука); окраска потолков — площадь потолка;
//   облицовка стен плиткой       — стены, у которых в «Видах отделки» указана облицовка плиткой (не фартук);
//   фартук                       — стены, у которых в «Видах отделки» указан «фартук»;
//   пол (плитка, линолеум)       — «взять по потолку»: площадь пола = площадь потолка помещения;
//   короб из гипсокартона         — обмер длины короба × высота стены (одна работа на квартиру, в туалете);
//   «требуется обмер»            — количество не определяем (ячейка пустая), показываем только расценку.
import ratesData from "./data/rates.json";
import roomRulesData from "./data/roomRules.json";

// Помещения с номерами 1–10 — жилые комнаты квартиры; их потолки в эту ВДЦ не входят.
export const CEILINGS_EXCLUDED_UP_TO = 10;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// «Улучшенное … (в скобках)» → слова в нижнем регистре; сравнение по основам слов (7 букв):
// «плинтуса»/«плинтусов» совпадают, «керамической»/«керамогранитной» — нет.
const norm = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/\([^)]*\)/g, " ").replace(/[^a-zа-я0-9]+/g, " ").trim();
const stems = (s) => norm(s).split(" ").filter(Boolean).map((w) => w.slice(0, 7)).join(" ");

// Расценка по названию работы; «тоже что X» в примечании означает расценку X.
export function findRate(work, note, rates = ratesData) {
  const alias = String(note ?? "").match(/тоже\s+что\s+(.+)$/i);
  const wanted = stems(alias ? alias[1] : work);
  return rates.find((r) => stems(r.name) === wanted) || null;
}

export function findRule(roomName, rules = roomRulesData) {
  const key = norm(roomName);
  return rules.find((r) => norm(r.name) === key) || null;
}

// Основа объёма работы.
export function classifyWork(work, note) {
  const n = norm(work);
  const t = String(note ?? "").toLowerCase();
  if (/требуется\s+обмер/.test(t)) return "measure";
  if (/шпатлеван/.test(n)) return "walls_ceilings";
  if (/короб/.test(n)) return "box";
  if (/фартук/.test(n)) return "apron";
  if (/оклейк\S*\s+стен|окраск\S*.*стен/.test(n)) return "walls";
  if (/окраск\S*.*потолк/.test(n)) return "ceiling";
  if (/облицовк\S*\s+стен/.test(n)) return "wall_tile";
  if (/облицовк\S*\s+пола|линолеум|ламинат|наливн\S*\s+пол|стяжк/.test(n) || /по\s+потолку/.test(t)) return "floor";
  return "manual";
}

const textOf = (w) => `${w.text || ""} ${w.title || ""}`;
const sum = (list) => list.reduce((s, w) => s + w.area, 0);

// Объёмы помещения: стены без фартука, фартук, облицовка стен плиткой, потолок (= пол).
// wallsMeasured — площадь стен по обмеру (у лоджий в ведомости отделки стен нет).
function measures(room, wallsMeasured = null) {
  if (room.walls === null) return { walls: wallsMeasured > 0 ? round2(wallsMeasured) : null, apron: null, tile: null, ceiling: room.ceiling?.area ?? null };
  const apron = room.walls.filter((w) => /фартук/i.test(textOf(w)));
  const tile = room.walls.filter((w) => !apron.includes(w) && /облицовк[^.]*плитк/i.test(textOf(w)));
  return {
    walls: round2(sum(room.walls) - sum(apron)),
    apron: apron.length ? round2(sum(apron)) : null,
    tile: tile.length ? round2(sum(tile)) : null,
    ceiling: room.ceiling?.area ?? null,
  };
}

// Помещения квартиры: из ведомости отделки (с видами отделки) и лоджии/балконы с подтверждённой площадью.
// У лоджий в ведомости отделки данных нет — известна только площадь (пол = потолок), стены нужно обмерять.
function flatRooms(row) {
  const rooms = (row.rooms || []).map((r) => ({
    no: r.no, name: r.name, ceiling: r.ceiling, walls: r.walls, loggia: false,
  }));
  for (const l of row.loggias || []) {
    rooms.push({ no: l.no, name: l.name, ceiling: { area: l.area }, walls: null, loggia: true });
  }
  return rooms;
}

// → { lines, warnings }. Строка: { roomNo, roomName, work, rateNo, unit, qty|null, priceVat, priceNoVat, sum|null, sumNoVat|null, note }
// measured — результаты обмера по типу квартиры: { "<тип>|<№ помещения>|plinth": метры, "<тип>|<№ помещения>|walls": м² }.
export function worksForFlat(row, { rates = ratesData, rules = roomRulesData, measured = {} } = {}) {
  const lines = [];
  const warnings = [];
  for (const room of flatRooms(row)) {
    const rule = findRule(room.name, rules);
    if (!rule) {
      warnings.push(`Для помещения «${room.name}» нет правил в листе «Помещения» — работы не добавлены.`);
      continue;
    }
    const excludeCeilings = rule.no <= CEILINGS_EXCLUDED_UP_TO;
    const measuredKey = (kind) => `${row.code}|${room.no}|${kind}`;
    const m = measures(room, measured[measuredKey("walls")]);
    for (const spec of rule.works) {
      const basis = classifyWork(spec.work, spec.note);
      const rate = findRate(spec.work, spec.note, rates);
      if (!rate) warnings.push(`Работы «${spec.work}» нет в расценках — цена не определена.`);
      let qty = null;
      let note = "";
      let need = null; // что нужно обмерить, чтобы появился объём
      const noWalls = "стены лоджии в ведомости отделки не указаны — нужен обмер";
      switch (basis) {
        case "walls":
          qty = m.walls;
          if (qty === null) {
            note = noWalls;
            need = "walls";
          } else if (room.walls === null) note = "по обмеру стен";
          break;
        case "walls_ceilings":
          if (m.walls === null) {
            note = noWalls;
            need = "walls";
          } else {
            qty = round2(m.walls + (excludeCeilings ? 0 : m.ceiling ?? 0));
            if (excludeCeilings) note = "потолки не учтены: отдельная ВДЦ на натяжные потолки";
            else if (room.walls === null) note = "стены по обмеру + потолок";
          }
          break;
        case "ceiling":
          if (excludeCeilings) continue; // потолки в помещениях 1–10 в эту ВДЦ не входят
          qty = m.ceiling;
          break;
        case "apron":
          qty = m.apron;
          if (qty === null) note = "фартук в ведомости отделки не найден";
          break;
        case "wall_tile":
          qty = m.tile;
          if (qty === null) note = "облицовка стен плиткой в ведомости отделки не найдена";
          break;
        case "floor":
          qty = m.ceiling;
          note = /по\s+потолку/i.test(spec.note) ? "по площади потолка" : "принято по площади потолка (пола)";
          break;
        case "box": {
          // короб в туалете: длина обмера × высота стены, одна работа на квартиру
          const v = measured[measuredKey("box")];
          if (v > 0) {
            qty = v;
            note = "по обмеру (на всю высоту стены)";
          } else {
            note = "требуется обмер короба";
            need = "box";
          }
          break;
        }
        case "measure": {
          const v = measured[measuredKey("plinth")];
          if (v > 0) {
            qty = v;
            note = "по обмеру";
          } else {
            note = "требуется обмер";
            need = "plinth";
          }
          break;
        }
        default:
          note = "правило объёма не задано";
      }
      if (qty !== null) qty = round2(qty);
      lines.push({
        roomNo: room.no,
        roomName: room.name,
        work: spec.work,
        rateNo: rate?.no ?? null,
        rateName: rate?.name ?? "",
        unit: rate?.unit ?? "",
        qty,
        priceVat: rate?.priceVat ?? null,
        priceNoVat: rate?.priceNoVat ?? null,
        sum: qty !== null && rate ? round2(qty * rate.priceVat) : null,
        sumNoVat: qty !== null && rate ? round2(qty * rate.priceNoVat) : null,
        note,
        need: need ? { kind: need, roomNo: room.no, roomName: room.name } : null,
      });
    }
  }
  return { lines, warnings: [...new Set(warnings)] };
}

// Итоги по набору строк-квартир с уже посчитанными работами (row.works.lines).
export function totalsOf(rows) {
  let sumVat = 0;
  let sumNoVat = 0;
  let pending = 0;
  for (const r of rows) {
    for (const l of r.works?.lines || []) {
      if (l.sum === null) pending += 1;
      else {
        sumVat += l.sum;
        sumNoVat += l.sumNoVat;
      }
    }
  }
  return { sumVat: round2(sumVat), sumNoVat: round2(sumNoVat), pending };
}

// Сводка по работам: «наименование + ед.» → объём и сумма по всем квартирам.
export function summarizeWorks(rows) {
  const acc = new Map();
  for (const r of rows) {
    for (const l of r.works?.lines || []) {
      const key = `${l.work}|${l.rateNo}`;
      const cur = acc.get(key) || { rateNo: l.rateNo, rateName: l.rateName, work: l.work, unit: l.unit, priceVat: l.priceVat, qty: 0, sum: 0, pending: 0 };
      if (l.qty === null) cur.pending += 1;
      else cur.qty += l.qty;
      if (l.sum !== null) cur.sum += l.sum;
      acc.set(key, cur);
    }
  }
  return [...acc.values()]
    .map((x) => ({ ...x, qty: round2(x.qty), sum: round2(x.sum) }))
    .sort((a, b) => Number((a.rateNo || "99.99").split(".")[1]) - Number((b.rateNo || "99.99").split(".")[1]) || a.work.localeCompare(b.work, "ru"));
}

// Что нужно обмерить, чтобы заполнить ВДЦ. Квартиры одного типа одинаковы, поэтому задачи — на тип и помещение,
// а не на каждую квартиру: [{ key, code, roomNo, roomName, kind: 'plinth' | 'walls', unit, label, works }].
export function collectMeasureTasks(rows) {
  const tasks = new Map();
  const seenTypes = new Set();
  for (const r of rows) {
    if (seenTypes.has(r.code)) continue;
    seenTypes.add(r.code);
    for (const l of r.works?.lines || []) {
      if (!l.need) continue;
      const key = `${r.code}|${l.need.roomNo}|${l.need.kind}`;
      const task = tasks.get(key) || {
        key,
        code: r.code,
        roomNo: l.need.roomNo,
        roomName: l.need.roomName,
        kind: l.need.kind,
        unit: l.need.kind === "plinth" ? "м" : "м²",
        label: l.need.kind === "plinth" ? l.work : l.need.kind === "box" ? "Площадь короба (длина × высота стены)" : "Площадь стен (длина × высота)",
        works: [],
      };
      task.works.push(l.work);
      tasks.set(key, task);
    }
  }
  return [...tasks.values()].sort((a, b) => a.code.localeCompare(b.code, "ru", { numeric: true }) || Number(a.roomNo) - Number(b.roomNo));
}
