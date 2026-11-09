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

// «Улучшенное шпатлевание стен и потолков, …» → «Улучшенное шпатлевание стен, …» / «… потолков, …»
export const splitWork = (work, element) => String(work).replace(/стен\s+и\s+потолков/i, element);

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

// ---------- Общие помещения: группы «МОП» и «Лестница» (одна строка ВДЦ на группу этажа) ----------
// Правила заданы на группу целиком, а не на каждое помещение: объёмы — сумма по помещениям группы.
// Стены — декоративная окраска (2.25, 2100 с НДС), потолки — водно-дисперсная окраска (2.16).
export const COMMON_SPECS = [
  { work: "Облицовка пола керамогранитной плиткой", basis: "floor" },
  { work: "Устройство плинтуса из керамогранита", basis: "plinth" },
  { work: "Улучшенное шпатлевание стен и потолков, сплошное выравнивание: черновой слой", basis: "walls_ceilings" },
  { work: "Улучшенное шпатлевание стен и потолков, сплошное выравнивание: чистовой слой", basis: "walls_ceilings" },
  { work: "Декоративная окраска стен", basis: "walls" },
  { work: "Окраска водо-дисперсной краской потолков за 2 раза", basis: "ceiling" },
];

// Лестница состоит из одинаковых элементов, обмеряется каждый один раз: марш типовой и верхний (малый), межэтажная площадка,
// этажная площадка типовая и верхняя (чердак), на 1 этаже — всё пространство под лестницей (керамогранит).
export const FLIGHTS_PER_FLOOR = 2; // маршей на этаж
export const STAIR_ELEMENTS = [
  { id: "flight", label: "Марш (типовой)", risers: true },
  { id: "flightTop", label: "Марш верхний (малый)", risers: true },
  { id: "mid", label: "Межэтажная площадка", platform: true },
  { id: "landing", label: "Этажная площадка (типовая)", platform: true },
  { id: "landingTop", label: "Этажная площадка верхняя (чердак)", platform: true },
  { id: "under", label: "1 этаж: пространство под лестницей (керамогранит)" },
];
const stairElement = (id) => STAIR_ELEMENTS.find((e) => e.id === id);
// вид обмера элемента: марш — «ступень × число ступеней» (площадь, подступенки и плинтус из одного обмера), площадка — контур
// (площадь и плинтус из одного обмера), остальное — площадь контуром (и отдельно плинтус)
const stairKind = (id, fallback) => (stairElement(id).risers ? "steps" : stairElement(id).platform ? "platform" : fallback);

// Сколько каких элементов приходится на строку лестницы (этаж): first — 1 этаж, last — верхний этаж (последний марш малый),
// attic — чердак (верхняя этажная площадка); остальные этажи типовые.
export function stairCounts(level) {
  switch (level) {
    case "first": return { flight: FLIGHTS_PER_FLOOR, mid: 1, under: 1 };
    case "last": return { flight: FLIGHTS_PER_FLOOR - 1, flightTop: 1, mid: 1, landing: 1 };
    case "firstLast": return { flight: FLIGHTS_PER_FLOOR - 1, flightTop: 1, mid: 1, under: 1 };
    case "attic": return { landingTop: 1 };
    default: return { flight: FLIGHTS_PER_FLOOR, mid: 1, landing: 1 };
  }
}

function commonWorks(row, { rates = ratesData, measured = {} } = {}) {
  const rooms = row.rooms || [];
  const walls = round2(rooms.reduce((acc, r) => acc + sum(r.walls || []), 0));
  const ceiling = round2(rooms.reduce((acc, r) => acc + (r.ceiling?.area || 0), 0));
  const stairs = row.code === "stairs";
  const mkey = row.mcode || row.code; // группа обмера: у МОП 1 этаж и типовые этажи, у лестницы типовой план и кровля — разные
  const lines = [];
  const warnings = [];
  // room — помещение, если строка относится к одному помещению группы (плинтус МОП обмеряется по помещениям)
  // need — что обмерить: один вид или список (пол лестницы ждёт и площадь, и подступенки)
  const push = (work, rate, qty, note, need, room = null) => {
    const q = qty !== null ? round2(qty) : null;
    const needs = (need ? [].concat(need) : []).map((n) => (typeof n === "string" ? { kind: n, roomNo: room ? room.no : "", roomName: room ? room.name : row.label } : n));
    lines.push({
      roomNo: room ? room.no : "",
      roomName: room ? room.name : row.label,
      work,
      rateNo: rate?.no ?? null,
      rateName: rate?.name ?? "",
      unit: rate?.unit ?? "",
      qty: q,
      priceVat: rate?.priceVat ?? null,
      priceNoVat: rate?.priceNoVat ?? null,
      sum: q !== null && rate ? round2(q * rate.priceVat) : null,
      sumNoVat: q !== null && rate ? round2(q * rate.priceNoVat) : null,
      note,
      need: needs[0] || null,
      needs,
    });
  };
  for (const spec of COMMON_SPECS) {
    const rate = findRate(spec.work, "", rates);
    if (!rate) warnings.push("Работы «" + spec.work + "» нет в расценках — цена не определена.");
    switch (spec.basis) {
      case "floor": {
        if (!(ceiling > 0) && !stairs) break;
        if (stairs && row.stairLevel !== "roof") {
          // пол лестницы по обмеру элементов: Σ (число элементов × (площадь + подступенки)); подлестничное пространство — отдельной строкой
          const counts = stairCounts(row.stairLevel);
          const need = (id, kind) => ({ kind, roomNo: id, roomName: stairElement(id).label, element: true });
          const needs = [];
          let total = 0;
          const parts = [];
          for (const [id, n] of Object.entries(counts)) {
            if (id === "under") continue;
            // марш — один обмер «ступень × число ступеней» (проступи + подступенки); площадки — площадь контуром
            const area = measured[mkey + "|" + id + "|" + stairKind(id, "stairarea")];
            if (!(area > 0)) needs.push(need(id, stairKind(id, "stairarea")));
            total += n * (area || 0);
            parts.push(stairElement(id).label.toLowerCase() + " ×" + n);
          }
          if (parts.length) push(spec.work, rate, needs.length ? null : total, needs.length ? "требуется обмер: " + [...new Set(needs.map((n) => n.roomName))].join("; ") : "по обмеру: " + parts.join(" + "), needs);
          if (counts.under) {
            const under = measured[mkey + "|under|stairarea"];
            if (under > 0) push(spec.work + " под лестницей", rate, under * counts.under, "по обмеру: всё пространство под лестницей", null);
            else push(spec.work + " под лестницей", rate, null, "требуется обмер пространства под лестницей", [need("under", "stairarea")]);
          }
          break;
        }
        if (stairs) {
          // кровля: пол лестницы целиком по обмеру: площадь маршей и площадок (контуры на плане) + подступенки (высота 150 мм)
          const area = measured[mkey + "||stairarea"];
          const risers = measured[mkey + "||risers"];
          const needs = [...(area > 0 ? [] : ["stairarea"]), ...(risers > 0 ? [] : ["risers"])];
          if (!needs.length) push(spec.work, rate, area + risers, "по обмеру: марши и площадки " + round2(area) + " м² + подступенки " + round2(risers) + " м²", null);
          else push(spec.work, rate, null, "требуется обмер: " + needs.map((k) => (k === "stairarea" ? "площадь маршей и площадок" : "подступенки высотой 150 мм")).join(" и "), needs);
        } else push(spec.work, rate, ceiling, "по площади потолка", null);
        break;
      }
      case "plinth": {
        // лестница — плинтус на группу целиком; МОП — по помещениям: коридор №13 одинаков на всех этажах и обмеряется один раз,
        // а холл 1 этажа (№14) и типовых (№14а) — разные помещения
        if (stairs && row.stairLevel !== "roof") {
          const needs = [];
          let total = 0;
          for (const [id, n] of Object.entries(stairCounts(row.stairLevel))) {
            // плинтус марша считается из того же обмера ступени (ширина ступени + 100 мм плинтус + 150 мм подступенок на каждую ступень)
            const v = measured[mkey + "|" + id + "|plinth"];
            if (!(v > 0)) needs.push({ kind: stairKind(id, "plinth"), roomNo: id, roomName: stairElement(id).label, element: true });
            total += n * (v || 0);
          }
          push(spec.work, rate, needs.length ? null : total, needs.length ? "требуется обмер: " + needs.map((n) => n.roomName).join("; ") : "по обмеру элементов лестницы", needs);
          break;
        }
        const targets = stairs ? [null] : rooms.filter((r) => r.ceiling?.area > 0);
        for (const room of targets) {
          const v = measured[mkey + "|" + (room ? room.no : "") + "|plinth"];
          if (v > 0) push(spec.work, rate, v, "по обмеру", null, room);
          else push(spec.work, rate, null, "требуется обмер", "plinth", room);
        }
        break;
      }
      case "walls_ceilings":
        if (walls > 0) push(splitWork(spec.work, "стен"), rate, walls, "", null);
        if (ceiling > 0) push(splitWork(spec.work, "потолков"), rate, ceiling, "", null);
        break;
      case "walls":
        if (walls > 0) push(spec.work, rate, walls, "", null);
        break;
      default:
        if (ceiling > 0) push(spec.work, rate, ceiling, "", null);
    }
  }
  return { lines, warnings };
}

// → { lines, warnings }. Строка: { roomNo, roomName, work, rateNo, unit, qty|null, priceVat, priceNoVat, sum|null, sumNoVat|null, note }
// measured — результаты обмера по типу квартиры: { "<тип>|<№ помещения>|plinth": метры, "<тип>|<№ помещения>|walls": м² }.
export function worksForFlat(row, { rates = ratesData, rules = roomRulesData, measured = {} } = {}) {
  if (row.common) return commonWorks(row, { rates, measured });
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
      let split = null; // работа, разделённая на несколько строк с одной расценкой: [{ work, qty, note, need }]
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
            qty = m.walls;
            if (excludeCeilings) note = "потолки не учтены: отдельная ВДЦ на натяжные потолки";
            else if (room.walls === null) note = "по обмеру стен";
          }
          // «шпатлевание стен и потолков» показываем двумя строками: стены и потолки (расценка одна и та же)
          split = [{ work: splitWork(spec.work, "стен"), qty, note, need: need ? { kind: need, roomNo: room.no, roomName: room.name } : null }];
          if (!excludeCeilings && m.walls !== null && m.ceiling !== null) split.push({ work: splitWork(spec.work, "потолков"), qty: m.ceiling, note: "", need: null });
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
      for (const part of split || [{ work: spec.work, qty, note, need: need ? { kind: need, roomNo: room.no, roomName: room.name } : null }]) {
        const q = part.qty !== null ? round2(part.qty) : null;
        lines.push({
          roomNo: room.no,
          roomName: room.name,
          work: part.work,
          rateNo: rate?.no ?? null,
          rateName: rate?.name ?? "",
          unit: rate?.unit ?? "",
          qty: q,
          priceVat: rate?.priceVat ?? null,
          priceNoVat: rate?.priceNoVat ?? null,
          sum: q !== null && rate ? round2(q * rate.priceVat) : null,
          sumNoVat: q !== null && rate ? round2(q * rate.priceNoVat) : null,
          note: part.note,
          need: part.need,
        });
      }
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
    const code = r.mcode || r.code; // у общих помещений — группа обмера (МОП 1 этаж, лестница на кровле …)
    // общие помещения: этажи различаются составом помещений (холл на 1 этаже и выше), поэтому смотрим все строки — задачи сами склеиваются по ключу
    if (!r.common && seenTypes.has(code)) continue;
    seenTypes.add(code);
    for (const l of r.works?.lines || []) {
      for (const need of l.needs?.length ? l.needs : l.need ? [l.need] : []) {
        const key = `${code}|${need.roomNo}|${need.kind}`;
        const task = tasks.get(key) || {
          key,
          code,
          roomNo: need.roomNo,
          roomName: need.roomName,
          kind: need.kind,
          unit: need.kind === "plinth" ? "м" : "м²",
          common: !!r.common,
          element: !!need.element,
          order: need.element ? STAIR_ELEMENTS.findIndex((e) => e.id === need.roomNo) : undefined,
          label: need.kind === "plinth" ? l.work : need.kind === "box" ? "Площадь короба (длина × высота стены)" : need.kind === "risers" ? "Подступенки: число ступеней и ширина (высота подступенка 150 мм)" : need.element ? (need.kind === "plinth" ? "Плинтус по периметру, м.п" : need.kind === "platform" ? "Площадь пола (контур или прямоугольник); плинтус — две короткие стороны и одна длинная" : need.kind === "steps" ? "Ступень (контур) и число ступеней в марше; подступенков столько же, плинтус считается по ступени" : need.kind === "risers" ? "Подступенки: число ступеней и ширина (высота 150 мм)" : "Площадь пола (контуры на плане)") : need.kind === "stairarea" ? "Площадь пола лестницы: марши и площадки (контуры на плане)" : "Площадь стен (длина × высота)",
          works: [],
        };
        task.works.push(l.work);
        tasks.set(key, task);
      }
    }
  }
  return [...tasks.values()].sort((a, b) => a.code.localeCompare(b.code, "ru", { numeric: true }) || (a.order ?? 0) - (b.order ?? 0) || String(a.roomNo).localeCompare(String(b.roomNo), "ru", { numeric: true }));
}
