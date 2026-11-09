// Сборка квартир по секциям и этажам (каждая квартира — отдельная строка, с осями «в/о 1-6») и проверка по ТЭП.
// Поддержаны экспликации «на секцию» (одинаковы для всех секций) и «на секцию №N» (только для неё).
// Экспликации «на две секции» / «на дом» пока не поддержаны — секции с разной планировкой подключим позже.
import { summarizeApartment } from "./finishing";

// «Однокомнатная Тип 1» → '1'
export function typeCodeFromName(name) {
  const m = String(name).match(/тип\s*([0-9]+[а-яa-z]?)\s*$/i);
  return m ? m[1] : null;
}

// «Тип 1 в/о 1-6»; без осей — просто «Тип 1»
export const flatLabel = (code, axes) => `Тип ${code}${axes ? ` ${axes}` : ""}`;

const sortRows = (typeOrder) => (a, b) =>
  a.sectionIndex - b.sectionIndex || a.floor - b.floor || a.flatIndex - b.flatIndex || (typeOrder.get(a.code) ?? 0) - (typeOrder.get(b.code) ?? 0);

// sections: ['1','2']; explications: [{ page, floors, scope, types:[{code,qty}], flats? }]; tep — результат parseTep или null.
// flats — квартиры плана: [{ code, labels: { '1': 'в/о 1-6' } }] (из plan.js, могут быть правлены пользователем).
export function assembleBlocks({ sections, explications, tep }) {
  const warnings = [];
  const names = new Map();
  for (const t of tep?.types || []) {
    const code = typeCodeFromName(t.name);
    if (code) names.set(code, t.name);
  }
  const nameOf = (code) => names.get(code) || `Тип ${code}`;

  const usable = [];
  for (const e of explications) {
    if (e.scope.kind === "several" || e.scope.kind === "house") {
      warnings.push(`Лист ${e.page}: экспликация относится сразу к нескольким секциям или ко всему дому — по секциям её пока не разделить, лист пропущен.`);
    } else usable.push(e);
  }

  const floors = [...new Set(usable.flatMap((e) => e.floors))].sort((a, b) => a - b);
  const typeOrder = new Map();
  usable.forEach((e) => e.types.forEach((t) => { if (!typeOrder.has(t.code)) typeOrder.set(t.code, typeOrder.size); }));

  const rows = [];
  sections.forEach((section, sectionIndex) => {
    for (const floor of floors) {
      const covering = usable.filter((e) => e.floors.includes(floor));
      const own = covering.filter((e) => e.scope.id === section);
      const generic = covering.filter((e) => e.scope.id === null);
      const chosen = own[0] || generic[0];
      if (!chosen) {
        warnings.push(`Секция ${section}, этаж ${floor}: нет экспликации.`);
        continue;
      }
      if ((own.length || generic.length) > 1) {
        const list = (own.length ? own : generic).map((e) => e.page).join(" и ");
        warnings.push(`Секция ${section}, этаж ${floor}: описан на нескольких листах (${list}), взят лист ${chosen.page}.`);
      }
      let flatIndex = 0;
      for (const t of chosen.types) {
        const known = (chosen.flats || []).filter((f) => f.code === t.code);
        const list = known.length === t.qty ? known : Array.from({ length: t.qty }, () => ({ code: t.code, labels: {} }));
        for (const flat of list) {
          const axes = flat.labels?.[section] || "";
          rows.push({
            section, sectionIndex, floor, flatIndex, code: t.code, type: nameOf(t.code), axes, label: flatLabel(t.code, axes), qty: 1, page: chosen.page,
          });
          flatIndex += 1;
        }
      }
    }
  });
  rows.sort(sortRows(typeOrder));

  const checks = [];
  if (tep) {
    for (const t of tep.types) {
      const code = typeCodeFromName(t.name);
      if (!code || t.qtyHouse === null) continue;
      const actual = rows.filter((r) => r.code === code).length;
      checks.push({
        ok: actual === t.qtyHouse,
        text: actual === t.qtyHouse
          ? `${t.name}: по планам ${actual} кв. — совпадает с ТЭП (${t.qtyHouse})`
          : `${t.name}: по планам ${actual} кв., а в ТЭП ${t.qtyHouse} — проверьте номера секций и листы экспликаций`,
      });
    }
    if (tep.totalHouse !== null) {
      checks.push({
        ok: rows.length === tep.totalHouse,
        text: rows.length === tep.totalHouse
          ? `Всего квартир по планам ${rows.length} — совпадает с ТЭП (${tep.totalHouse})`
          : `Всего квартир по планам ${rows.length}, а в ТЭП ${tep.totalHouse}`,
      });
    }
    const tepFloors = new Set(tep.rows.map((r) => r.floor));
    const missing = [...tepFloors].filter((f) => !floors.includes(f));
    if (missing.length) {
      checks.push({ ok: false, text: `В ТЭП есть этажи ${missing.join(", ")}, а экспликации для них не выбраны` });
    }
  } else {
    checks.push({ ok: false, text: "ТЭП не прочитан — сверить количество квартир не с чем" });
  }

  // одинаковые подписи у двух квартир одного типа на этаже — по ним квартиры не различить
  const dupes = new Set();
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.section}|${r.floor}|${r.label}`;
    if (seen.has(key)) dupes.add(`${r.label} (секция ${r.section})`);
    seen.add(key);
  }
  if (dupes.size) warnings.push(`Одинаковые подписи у разных квартир одного этажа: ${[...dupes].join(", ")} — укажите разные оси.`);
  return { rows, floors, checks, warnings };
}

// К каждой квартире — помещения (номер и название) с видами отделки потолка и стен и объёмами, а также
// сводка по видам отделки на квартиру. finishing: { [код типа]: { rooms } }; legend: { [вид]: { title } };
// roomsByPage: { [лист]: [{ no, name }] } — названия помещений из экспликации плана этого этажа.
const naturalCompare = (a, b) => String(a).localeCompare(String(b), "ru", { numeric: true });

export function attachFinishing(rows, finishing, legend, roomsByPage = {}) {
  const titleOf = (id) => legend?.[id]?.title || "";
  const textOf = (id) => legend?.[id]?.text || ""; // полный текст вида отделки: по нему различаем фартук и облицовку плиткой
  const cache = new Map();
  const forFlat = (code, page) => {
    const key = `${code}|${page}`;
    if (cache.has(key)) return cache.get(key);
    const apt = finishing?.[code];
    let out = { finish: null, rooms: null };
    if (apt) {
      const names = new Map((roomsByPage[page] || Object.values(roomsByPage)[0] || []).map((r) => [String(r.no), r.name]));
      const rooms = apt.rooms
        .map((r) => ({
          no: String(r.room).trim(),
          name: names.get(String(r.room).trim()) || "",
          ceiling: r.ceiling ? { id: r.ceiling.id, area: r.ceiling.flat, title: titleOf(r.ceiling.id), text: textOf(r.ceiling.id) } : null,
          walls: r.walls.map((w) => ({ id: w.id, area: w.flat, title: titleOf(w.id), text: textOf(w.id) })),
        }))
        .sort((a, b) => naturalCompare(a.no, b.no));
      out = { finish: summarizeApartment(apt.rooms).map((f) => ({ ...f, title: titleOf(f.id) })), rooms };
    }
    cache.set(key, out);
    return out;
  };
  return rows.map((r) => ({ ...r, ...forFlat(r.code, r.page) }));
}

// Разбиение на ВДЦ: первый блок отдельно, остальные секции вместе.
export function splitFirstBlock(rows, firstId) {
  return {
    first: rows.filter((r) => r.section === firstId),
    others: rows.filter((r) => r.section !== firstId),
  };
}

// ---------- Общие помещения: на каждом этаже секции две группы — «Лестница» и «МОП» ----------
// Группы обмера: у МОП плинтус обмеряется по помещениям (одинаковые на разных этажах — один раз), у лестницы кровля отличается от этажей и чердака
export const COMMON_MEASURE_LABELS = {
  mop: "МОП — общие помещения этажей",
  stairs: "Лестница — элементы (марши и площадки)",
  "stairs-roof": "Лестница — план кровли",
};
export const COMMON_GROUPS = [
  { code: "stairs", label: "Лестница" },
  { code: "mop", label: "МОП" },
];
const noKey = (no) => String(no ?? "").replace(/\s+/g, "").toLowerCase();
const isStairs = (name) => /лестнич/i.test(name);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Общие помещения этажа берём из экспликации (номер, название, площадь), виды отделки — из группы
// «Помещения являющиеся общим имуществом N-M этаж» ведомости отделки: там площади даны на секцию за ВСЕ этажи группы,
// поэтому на один этаж делим на число этажей, где помещение есть по экспликациям.
// common: результат parseFinishing(...).common (объединённый по листам); legend — виды отделки.
// → { rows, warnings }; строки с признаком common: true, как квартиры (rooms, finish), но без количества квартир.
export function buildCommonRows({ sections, explications, common, legend }) {
  const warnings = [];
  const groups = common || [];
  const usable = (explications || []).filter((e) => e.scope.kind !== "several" && e.scope.kind !== "house");
  if (!usable.some((e) => Array.isArray(e.commonRooms) && e.commonRooms.length)) {
    return { rows: [], warnings: usable.length && !usable.some((e) => Array.isArray(e.commonRooms)) ? ["Общие помещения не прочитаны: заново прочитайте экспликации (шаг 4)."] : [] };
  }
  if (!groups.length) return { rows: [], warnings: ["В ведомости отделки не найдена группа «Помещения, являющиеся общим имуществом» — общие помещения не добавлены."] };

  const titleOf = (id) => legend?.[id]?.title || "";
  const textOf = (id) => legend?.[id]?.text || "";
  const floors = [...new Set(usable.flatMap((e) => e.floors))].sort((a, b) => a - b);
  const pick = (section, floor) => {
    const covering = usable.filter((e) => e.floors.includes(floor));
    return covering.find((e) => e.scope.id === section) || covering.find((e) => e.scope.id === null) || null;
  };

  const rows = [];
  const missing = new Set();
  sections.forEach((section, sectionIndex) => {
    for (const floor of floors) {
      const expl = pick(section, floor);
      if (!expl || !expl.commonRooms?.length) continue;
      const group = groups.find((g) => g.floors.includes(floor));
      if (!group) {
        warnings.push(`Секция ${section}, этаж ${floor}: нет группы общих помещений в ведомости отделки.`);
        continue;
      }
      const finishingOf = new Map(group.rooms.map((r) => [noKey(r.room), r]));
      // сколько этажей группы содержат помещение с этим номером (по экспликациям этой секции)
      const floorsWith = (no) => group.floors.filter((f) => pick(section, f)?.commonRooms?.some((r) => noKey(r.no) === noKey(no))).length;
      const roomsOf = (isGroup) => expl.commonRooms
        .filter((r) => isGroup(r.name))
        .map((r) => {
          const fin = finishingOf.get(noKey(r.no));
          const n = Math.max(1, floorsWith(r.no));
          if (!fin) missing.add(`${r.no} ${r.name}`);
          const perFloor = (v) => round2(v / n);
          const ceilingArea = r.area ?? (fin?.ceiling ? perFloor(fin.ceiling.flat) : null);
          return {
            no: String(r.no),
            name: r.name,
            ceiling: fin?.ceiling ? { id: fin.ceiling.id, area: ceilingArea ?? perFloor(fin.ceiling.flat), title: titleOf(fin.ceiling.id), text: textOf(fin.ceiling.id) } : null,
            walls: (fin?.walls || []).map((w) => ({ id: w.id, area: perFloor(w.flat), title: titleOf(w.id), text: textOf(w.id) })),
          };
        });
      COMMON_GROUPS.forEach(({ code, label }, gi) => {
        const rooms = roomsOf(code === "stairs" ? isStairs : (name) => !isStairs(name));
        if (!rooms.length) return;
        const acc = new Map();
        const add = (element, id, area) => {
          const key = `${element}|${id}`;
          acc.set(key, { element, id, area: (acc.get(key)?.area || 0) + area });
        };
        for (const r of rooms) {
          if (r.ceiling) add("ceiling", r.ceiling.id, r.ceiling.area);
          for (const w of r.walls) add("walls", w.id, w.area);
        }
        const finish = [...acc.values()]
          .map((x) => ({ ...x, area: round2(x.area), title: titleOf(x.id) }))
          .sort((a, b) => (a.element === b.element ? naturalCompare(a.id, b.id) : a.element === "ceiling" ? -1 : 1));
        rows.push({
          common: true, section, sectionIndex, floor, flatIndex: 1000 + gi, code, mcode: code, type: label, axes: "", label, qty: 1, page: expl.page, rooms, finish,
        });
      });
    }
  });
  // чердак и кровля: лестница на чердаке такая же, как на этажах (копия верхнего этажа), на кровле другая — отделка не известна,
  // считаем только то, что обмеряется (подступенки и плинтус)
  sections.forEach((section, sectionIndex) => {
    const top = rows.filter((r) => r.section === section && r.code === "stairs").sort((a, b) => b.floor - a.floor)[0];
    if (!top) return;
    const copy = (extra) => ({ ...top, rooms: top.rooms.map((r) => ({ ...r, walls: [...r.walls] })), finish: [...top.finish], ...extra });
    // уровень строки в лестнице: 1 этаж, верхний этаж (последний марш малый), типовой; чердак — верхняя этажная площадка
    const stairRows = rows.filter((r) => r.section === section && r.code === "stairs");
    const lo = Math.min(...stairRows.map((r) => r.floor));
    for (const r of stairRows) r.stairLevel = r.floor === lo && r.floor === top.floor ? "firstLast" : r.floor === lo ? "first" : r.floor === top.floor ? "last" : "mid";
    rows.push(copy({ floor: top.floor + 1, flatIndex: 1002, levelLabel: "Чердак", label: "Лестница (чердак)", mcode: "stairs", stairLevel: "attic" }));
    rows.push(copy({ floor: top.floor + 2, flatIndex: 1003, levelLabel: "Кровля", label: "Лестница (кровля)", mcode: "stairs-roof", stairLevel: "roof", rooms: [], finish: [] }));
  });
  if (missing.size) warnings.push(`Общие помещения без отделки в ведомости: ${[...missing].join("; ")}.`);
  return { rows, warnings };
}
