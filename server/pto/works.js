// Виды работ по материалам раздела КЖ — по одной строке на элемент и вид
// работ, с объёмом в единицах расценки (арматура и закладные — в тоннах).
//
//   арматура (учитываемая)        -> Армирование, тн
//   закладные изделия             -> Установка закладных изделий, тн
//   бетон                         -> Бетонирование монолитных конструкций, м³
//   бетонная подготовка           -> Устройство бетонной подготовки, м³
//
// Опалубка: площади опалубки в ведомостях КЖ нет (на чертежах — только
// размеры), поэтому объём не выдумываем — работу можно добавить вручную.
const { round } = require('./layout');

const WORK_RULES = [
  {
    id: 'rebar', name: 'Армирование монолитных конструкций', unit: 'тн', query: 'Армирование',
    pick: (it) => it.kind === 'steel' && it.counted, qty: (sum) => sum / 1000,
    basis: 'арматура по сводной ведомости расхода стали, кг ÷ 1000',
  },
  {
    id: 'embedded', name: 'Установка закладных изделий', unit: 'тн', query: 'Установка закладных деталей',
    pick: (it) => it.kind === 'embedded' && it.counted, qty: (sum) => sum / 1000,
    basis: 'закладные изделия по сводной ведомости, кг ÷ 1000',
  },
  {
    id: 'concrete', name: 'Бетонирование монолитных конструкций', unit: 'м³', query: 'Бетонирование монолитных конструкций',
    pick: (it) => it.kind === 'concrete' && it.counted && !/подготовк/i.test(it.name), qty: (sum) => sum,
    basis: 'бетон по спецификациям элементов',
  },
  {
    id: 'concretePrep', name: 'Устройство бетонной подготовки', unit: 'м³', query: 'Устройство бетонной подготовки',
    pick: (it) => it.kind === 'concrete' && it.counted && /подготовк/i.test(it.name), qty: (sum) => sum,
    basis: 'бетонная подготовка по спецификациям элементов',
  },
];

// items — строки ведомости (с quantity, element, kind, counted, name). Возвращает работы.
function deriveWorks(items) {
  const works = [];
  for (const rule of WORK_RULES) {
    const byElement = new Map();
    for (const it of items.filter(rule.pick)) {
      byElement.set(it.element, (byElement.get(it.element) || 0) + it.quantity);
    }
    for (const [element, sum] of byElement) {
      const quantity = round(rule.qty(sum), 3);
      if (!(quantity > 0)) continue;
      works.push({ element, name: rule.name, unit: rule.unit, quantity, basis_note: rule.basis, rule: rule.id, query: rule.query });
    }
  }
  return works.map((w, i) => ({ ...w, sort: i }));
}

module.exports = { deriveWorks, WORK_RULES };
