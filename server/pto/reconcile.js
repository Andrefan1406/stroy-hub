// Сверка спецификаций со сводной «Ведомостью расхода стали».
//
// В спецификации элемента расход дан на ОДИН элемент, а сколько таких
// элементов в здании, указано не везде. Сводная ведомость стали содержит
// итог по всем элементам — по ней видно, сходится ли набранное по
// спецификациям. Пример (проверено на реальном КЖ): плиты — 205,9 т по
// спецификациям и 205,8 т по ведомости (сходится), стены — 154,7 т и 312,2 т
// (в 2,02 раза: стены повторяются в двух секциях здания).
//
// Если расхождение — целое число ≥ 2 (с запасом 8 %), предлагаем коэффициент
// для объёмов этой группы; применяет его пользователь (apply-multiplier).
const GROUPS = [
  { id: 'walls', title: 'Стены', summary: /стен/i, spec: /стен/i },
  { id: 'slabs', title: 'Плиты', summary: /ППм|ППдм|плит/i, spec: /ППм|ППдм|плит/i },
];

// rows — сырые строки разбора (basis summary | spec).
function reconcileKzh(rows) {
  const sumKg = (basis, test) => rows
    .filter((r) => r.kind === 'steel' && r.basis === basis && test.test(r.element))
    .reduce((s, r) => s + r.quantity, 0);
  const out = [];
  for (const g of GROUPS) {
    const summaryKg = sumKg('summary', g.summary);
    const specKg = sumKg('spec', g.spec);
    if (!(summaryKg > 0) || !(specKg > 0)) continue;
    const ratio = summaryKg / specKg;
    const n = Math.round(ratio);
    const factor = n >= 2 && Math.abs(ratio - n) <= 0.08 * n ? n : null;
    const status = Math.abs(ratio - 1) <= 0.03 ? 'ok' : factor ? 'factor' : 'mismatch';
    out.push({
      id: g.id, title: g.title,
      summaryKg: Math.round(summaryKg * 10) / 10, specKg: Math.round(specKg * 10) / 10,
      ratio: Math.round(ratio * 1000) / 1000, factor, status, applied: null,
    });
  }
  return out;
}

const groupById = (id) => GROUPS.find((g) => g.id === id) || null;

module.exports = { reconcileKzh, groupById, GROUPS };
