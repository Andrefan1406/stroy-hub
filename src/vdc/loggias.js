// Лоджии и балконы в экспликации помещений: площадь там приведённая (умноженная на коэффициент),
// в названии помещения коэффициент написан в скобках — «Лоджия (к=0,5)». Фактическая площадь =
// площадь по экспликации ÷ коэффициент. Коэффициент мы только ПРЕДЛАГАЕМ, подтверждает пользователь.
import { groupRows } from "./tepParser";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const DEC = /^\d+(?:,\d+)?$/;

export const isLoggiaName = (name) => /лоджи|балкон|террас/i.test(String(name));

// Типовые коэффициенты, если в названии помещения коэффициента нет (приведение площадей лоджий, балконов, террас).
const DEFAULTS = [
  { re: /лоджи\S*\s*-?\s*балкон|балкон\S*\s*-?\s*лоджи/i, k: 0.4, label: "совмещённая лоджия-балкон" },
  { re: /лоджи/i, k: 0.5, label: "лоджия" },
  { re: /балкон/i, k: 0.3, label: "балкон" },
  { re: /террас/i, k: 0.3, label: "терраса" },
];

// «Лоджия (к=0,5)» → { k: 0.5, source: 'drawing' }; без числа → типовой коэффициент, source: 'default'
export function proposeCoefficient(name) {
  const m = String(name).match(/к\s*=\s*(\d+(?:[.,]\d+)?)/i);
  if (m) {
    const k = Number(m[1].replace(",", "."));
    if (k > 0 && k <= 1) return { k, source: "drawing" };
  }
  const def = DEFAULTS.find((d) => d.re.test(name));
  return def ? { k: def.k, source: "default", note: def.label } : { k: 1, source: "default" };
}

// Уникальные лоджии и балконы по всем экспликациям: [{ key, no, name, k, source, areas: { тип: приведённая площадь } }]
export function proposeLoggias(roomsByPage) {
  const out = new Map();
  for (const rooms of Object.values(roomsByPage || {})) {
    for (const r of rooms || []) {
      if (!isLoggiaName(r.name)) continue;
      const key = `${r.no}|${r.name}`;
      if (!out.has(key)) out.set(key, { key, no: r.no, name: r.name, ...proposeCoefficient(r.name), areas: { ...r.areas } });
    }
  }
  return [...out.values()].sort((a, b) => Number(a.no) - Number(b.no));
}

// К каждой квартире — её лоджии и балконы с фактической площадью. coefficients: { [key]: число }
export function attachLoggias(rows, roomsByPage, coefficients) {
  return rows.map((row) => {
    const rooms = roomsByPage[row.page] || Object.values(roomsByPage)[0] || [];
    const loggias = [];
    for (const r of rooms) {
      if (!isLoggiaName(r.name)) continue;
      const reduced = r.areas?.[row.code];
      const k = coefficients[`${r.no}|${r.name}`];
      if (reduced == null || !(k > 0)) continue;
      loggias.push({ no: r.no, name: r.name, reduced, k, area: round2(reduced / k) });
    }
    return { ...row, loggias };
  });
}

// «Балконы, лоджии» в экспликации полов: площади на секцию №1, №2 и на дом (строка с «см. указ.»).
// → { perSection: [193.5, 193.5], total: 387 } или null
export function findLoggiaFloorAreas(pages) {
  for (const p of pages || []) {
    const items = (p.items || []).filter((i) => String(i.str ?? "").trim());
    if (!items.some((i) => /экспликация полов/i.test(i.str))) continue;
    const label = items.find((i) => /балкон\S*\s*,?\s*лоджи/i.test(i.str.replace(/\s+/g, " ")));
    if (!label) continue;
    const near = items.filter((i) => Math.abs(i.y - label.y) <= 14 && i.x > label.x + 150 && DEC.test(i.str.trim()));
    const values = groupRows(near, 14).flatMap((r) => r.tokens).sort((a, b) => a.x - b.x).map((t) => Number(t.str.trim().replace(",", ".")));
    if (values.length >= 2) return { perSection: values.slice(0, -1), total: values[values.length - 1], page: p.page };
  }
  return null;
}

// Сверка: сумма фактических площадей лоджий и балконов секции = площадь по экспликации полов на секцию.
export function checkLoggiaAreas(rows, sections, floorAreas) {
  if (!floorAreas) return [{ ok: false, text: "«Балконы, лоджии» в экспликации полов не найдены — сверить площадь лоджий не с чем" }];
  const checks = [];
  sections.forEach((id, idx) => {
    const expected = floorAreas.perSection[idx];
    if (expected == null) return;
    const sum = round2(rows.filter((r) => r.section === id).reduce((s, r) => s + (r.loggias || []).reduce((a, l) => a + l.area, 0), 0));
    const ok = Math.abs(sum - expected) <= 0.1;
    checks.push({
      ok,
      text: ok
        ? `Секция ${id}: лоджии и балконы по вашим коэффициентам ${sum} м² — совпадает с экспликацией полов (${expected} м²)`
        : `Секция ${id}: лоджии и балконы по вашим коэффициентам ${sum} м², а в экспликации полов ${expected} м² — проверьте коэффициенты`,
    });
  });
  return checks;
}
