// Проверка полей заявки на технологическое бурение и резку.
// Число — только цифры и один разделитель (запятая или точка равнозначны),
// не больше одного знака после разделителя; для штук — только целое.
const taxonomy = require('../../src/data/concreteObjectTaxonomy.json');

const MATERIALS = ['кирпич', 'бетон'];
const WORK_TYPES = ['drill', 'cut'];
const MAX_ITEMS = 50;
const MAX_REASON = 500;

const UNITS = { drill: 'шт', cut: 'м.п.' };

// «12,5» / «12.5» / 12.5 -> 12.5; null — если это не число в допустимом виде.
function parseNumber(raw, { integer = false } = {}) {
  if (typeof raw === 'number') raw = String(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const re = integer ? /^\d+$/ : /^\d+([.,]\d)?$/;
  if (!re.test(text)) return null;
  return Number(text.replace(',', '.'));
}

const isInteger = (workType) => workType === 'drill';

// Допустимые объекты и позиции — те же справочники, что у формы заявки на бетон.
const OBJECTS = Object.keys(taxonomy.objectPositionOptions);
const positionsOf = (object) => taxonomy.objectPositionOptions[object] || [];

// Одна строка заявки -> { ok: true, item } или { ok: false, error }.
function validateItem(raw, index) {
  const n = index + 1;
  const err = (msg) => ({ ok: false, error: `Строка ${n}: ${msg}` });
  if (!raw || typeof raw !== 'object') return err('нет данных');

  const object = String(raw.object || '').trim();
  const position = String(raw.position || '').trim();
  if (!OBJECTS.includes(object)) return err('выберите объект из списка');
  if (!positionsOf(object).includes(position)) return err('выберите позицию из списка');
  if (!WORK_TYPES.includes(raw.workType)) return err('выберите вид работ');
  if (!MATERIALS.includes(raw.material)) return err('выберите материал');

  const quantity = parseNumber(raw.quantity, { integer: isInteger(raw.workType) });
  if (quantity === null || quantity <= 0) {
    return err(raw.workType === 'drill'
      ? 'количество — целое число штук (только цифры)'
      : 'длина реза — число, не больше одного знака после запятой');
  }

  let diameter = null;
  let thickness = null;
  if (raw.workType === 'drill') {
    diameter = parseNumber(raw.diameterMm, { integer: true });
    if (diameter === null || diameter <= 0) return err('диаметр — целое число мм (только цифры)');
  } else {
    thickness = parseNumber(raw.thicknessCm);
    if (thickness === null || thickness <= 0) return err('толщина реза — число, не больше одного знака после запятой');
  }

  const reason = String(raw.reason || '').trim();
  if (reason.length > MAX_REASON) return err(`причина длиннее ${MAX_REASON} символов`);

  return {
    ok: true,
    item: { object, position, workType: raw.workType, material: raw.material, diameterMm: diameter, thicknessCm: thickness, quantity, reason },
  };
}

// Массив строк -> { ok, items } | { ok: false, error }.
function validateItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { ok: false, error: 'Добавьте хотя бы одну строку' };
  if (rawItems.length > MAX_ITEMS) return { ok: false, error: `Не больше ${MAX_ITEMS} строк в заявке` };
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const res = validateItem(rawItems[i], i);
    if (!res.ok) return res;
    items.push(res.item);
  }
  return { ok: true, items };
}

// Факт выполнения строки: число по тем же правилам, 0 допустим, больше заявленного нельзя.
function validateFact(raw, item) {
  const value = parseNumber(raw, { integer: isInteger(item.work_type) });
  if (value === null) {
    return { ok: false, error: item.work_type === 'drill' ? 'Введите целое число (только цифры)' : 'Введите число, не больше одного знака после запятой' };
  }
  if (value > item.quantity) return { ok: false, error: `Не больше заявленного (${item.quantity} ${UNITS[item.work_type]})` };
  return { ok: true, value };
}

// Позиция в справочнике иногда уже начинается с «поз.» («поз.56») — второе «поз.» не добавляем.
const positionLabel = (position) => (/^\s*поз/i.test(String(position)) ? String(position).trim() : `поз. ${position}`);

module.exports = { positionLabel, MATERIALS, WORK_TYPES, UNITS, OBJECTS, MAX_ITEMS, parseNumber, positionsOf, validateItem, validateItems, validateFact };
