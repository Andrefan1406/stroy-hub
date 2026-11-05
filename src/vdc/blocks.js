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
