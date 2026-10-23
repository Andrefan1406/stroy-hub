// Подбор расценок по своду: приоритет категорий (сначала «утверждённые в VK»,
// затем «ЕНиР для фирм»), совпадение единицы, цена с НДС, арбитр (модель) и
// строгий порог, когда модель недоступна. Qdrant, эмбеддинги и модель подменены.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRates, RatesUnavailable, workKey, normUnit, APPROVED, ENIR_FIRMS } = require('../rates');

const point = (id, cls, name, unit, vat, score, extra = {}) => ({
  id, score, payload: { id, class: cls, name, unit, price_vat: vat, price_no_vat: vat == null ? null : Math.round(vat / 1.16), section: 'СМР', object: 'Все объекты', ...extra },
});

function makeRates({ approved = [], enir = [], judge, stats = { exists: true, pointsCount: 100 }, embedFails = false } = {}) {
  const calls = { query: [], judge: [] };
  return {
    calls,
    rates: createRates({
      collectionStats: async () => stats,
      embed: async () => { if (embedFails) throw new Error('voyage down'); return [0.1, 0.2]; },
      getClient: () => ({
        query: async (collection, { filter }) => {
          const tier = filter.must[0].match.value;
          calls.query.push(tier);
          return { points: tier === APPROVED ? approved : enir };
        },
        retrieve: async (collection, { ids }) => [...approved, ...enir].filter((p) => ids.includes(p.id)),
      }),
      judge: judge && (async (...args) => { calls.judge.push(args); return judge(...args); }),
    }),
  };
}

test('единицы измерения приводятся к одному виду, ключ работы не зависит от регистра и знаков', () => {
  assert.equal(normUnit('тн'), 'т');
  assert.equal(normUnit('т'), 'т');
  assert.equal(normUnit('м3'), 'м³');
  assert.equal(normUnit('м³'), 'м³');
  assert.equal(normUnit('м.п.'), 'м');
  assert.equal(workKey('Армирование  монолитных конструкций!', 'тн'), workKey('армирование монолитных конструкций', 'т'));
  assert.notEqual(workKey('Армирование', 'тн'), workKey('Армирование', 'м²'));
});

test('кандидаты: сначала «утверждённые в VK», затем «ЕНиР для фирм», «ЕНиР для бригад» не запрашивается', async () => {
  const { rates, calls } = makeRates({
    approved: [point(1, APPROVED, 'Штукатурка', 'м2', 800, 0.5), point(2, APPROVED, 'Армирование стяжки', 'м2', 900, 0.7)],
    enir: [point(3, ENIR_FIRMS, 'Армирование', 'тн', 254318, 0.66)],
  });
  const list = await rates.search('Армирование', { unit: 'тн' });
  assert.deepEqual(calls.query, [APPROVED, ENIR_FIRMS]);
  assert.deepEqual(list.map((c) => c.id), [2, 1, 3], 'внутри категории — по близости, категории — по приоритету');
  assert.equal(list[2].unitMatch, true);
  assert.equal(list[0].unitMatch, false);
  assert.equal(list[2].tierTitle, 'ЕНиР для фирм');
});

test('цена — с НДС; если в своде только без НДС, пересчитывается и помечается', async () => {
  const { rates } = makeRates({
    enir: [point(3, ENIR_FIRMS, 'Работа А', 'тн', 1160, 0.6), point(4, ENIR_FIRMS, 'Работа Б', 'тн', null, 0.59, { price_no_vat: 1000 })],
  });
  const [a, b] = await rates.search('работа', { unit: 'тн' });
  assert.equal(a.price, 1160);
  assert.equal(a.vatEstimated, false);
  assert.equal(b.price, 1160);
  assert.equal(b.vatEstimated, true);
});

test('арбитр выбирает расценку, подходящую по смыслу, а не просто ближайшую', async () => {
  const { rates, calls } = makeRates({
    approved: [point(2, APPROVED, 'Устройство армированной бетонной стяжки', 'м3', 1392, 0.55)],
    enir: [point(3, ENIR_FIRMS, 'Укладка бетона на уровне выше нуля', 'м3', 17145, 0.5)],
    judge: async (name, unit, list) => list.find((c) => /Укладка бетона/.test(c.name)).id,
  });
  const r = await rates.suggest('Бетонирование монолитных конструкций', 'м³', { workName: 'Бетонирование монолитных конструкций' });
  assert.equal(r.best.id, 3);
  assert.equal(r.verified, true);
  assert.equal(calls.judge[0][0], 'Бетонирование монолитных конструкций');
  assert.deepEqual(calls.judge[0][2].map((c) => c.id), [2, 3], 'арбитру кандидаты переданы по приоритету категорий');
});

test('арбитр: «ничего не подходит» — предложения нет (пользователь выберет сам)', async () => {
  const { rates } = makeRates({ approved: [point(2, APPROVED, 'Штукатурка', 'м3', 500, 0.6)], judge: async () => null });
  const r = await rates.suggest('Закладные', 'м³');
  assert.equal(r.best, null);
  assert.equal(r.verified, true);
  assert.equal(r.candidates.length, 1, 'кандидаты остаются для ручного выбора');
});

test('арбитр не вызывается, когда подходящих по единице нет; единица и порог уверенности учитываются', async () => {
  const { rates, calls } = makeRates({
    approved: [point(2, APPROVED, 'Штукатурка', 'м2', 500, 0.9), point(5, APPROVED, 'Бетон', 'м3', 700, 0.3)],
    judge: async () => 2,
  });
  const r = await rates.suggest('Бетонирование', 'м³');
  assert.equal(r.best, null);
  assert.equal(calls.judge.length, 0, 'м2 не подходит по единице, м3 — ниже порога');
});

test('модель недоступна: предлагаем только уверенные совпадения (строгий порог), приоритет категорий сохраняется', async () => {
  const failing = async () => { throw new Error('Ollama Cloud не ответил'); };
  const weak = makeRates({ approved: [point(2, APPROVED, 'Нечто близкое', 'тн', 100, 0.55)], enir: [point(3, ENIR_FIRMS, 'Армирование', 'тн', 254318, 0.66)], judge: failing });
  const r1 = await weak.rates.suggest('Армирование', 'тн');
  assert.equal(r1.best.id, 3, 'слабое совпадение из первой категории не перебивает уверенное из второй');
  assert.equal(r1.verified, false);

  const strong = makeRates({ approved: [point(2, APPROVED, 'Армирование', 'тн', 300000, 0.7)], enir: [point(3, ENIR_FIRMS, 'Армирование', 'тн', 254318, 0.8)], judge: failing });
  assert.equal((await strong.rates.suggest('Армирование', 'тн')).best.id, 2, 'уверенное из «утверждённых» — первым');

  const none = makeRates({ approved: [point(2, APPROVED, 'Нечто', 'тн', 100, 0.5)], judge: failing });
  assert.equal((await none.rates.suggest('Армирование', 'тн')).best, null);
});

test('свод не проиндексирован или сервисы недоступны — понятная ошибка, а не падение', async () => {
  await assert.rejects(makeRates({ stats: { exists: false, pointsCount: 0 } }).rates.search('x'), (e) => e instanceof RatesUnavailable && /не проиндексирован/.test(e.message));
  await assert.rejects(makeRates({ embedFails: true }).rates.search('x'), (e) => e instanceof RatesUnavailable && /эмбеддингов/.test(e.message));
});

test('расценка по id берётся из свода (и её нет — null)', async () => {
  const { rates } = makeRates({ enir: [point(3, ENIR_FIRMS, 'Армирование', 'тн', 254318, 0.66)] });
  assert.equal((await rates.get(3)).price, 254318);
  assert.equal(await rates.get(99), null);
});
