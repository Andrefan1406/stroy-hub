// Виды работ по материалам раздела КЖ — по одной строке на элемент и вид
// работ, с объёмом в единицах расценки.
//
//   бетон                         -> Бетонирование монолитных конструкций, м³
//   бетонная подготовка           -> Устройство бетонной подготовки, м³
//
// Армирование и установка закладных отдельными работами НЕ выводятся: они не
// оплачиваются отдельно, их стоимость входит в стоимость бетонирования
// (требование заказчика). Масса арматуры и закладных остаётся в ведомости
// материалов и в стоимости материалов.
//
// Опалубка: площади опалубки в ведомостях КЖ нет (на чертежах — только
// размеры), поэтому объём не выдумываем — работу можно добавить вручную.
const { round } = require('./layout');

const WORK_RULES = [
  {
    id: 'concrete', name: 'Бетонирование монолитных конструкций', unit: 'м³', query: 'Бетонирование монолитных конструкций',
    pick: (it) => it.kind === 'concrete' && it.counted && !/подготовк/i.test(it.name), qty: (sum) => sum,
    basis: 'бетон по спецификациям элементов; армирование и закладные входят в стоимость бетонирования',
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
