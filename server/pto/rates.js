// Подбор расценок на виды работ по своду расценок 2026 (коллекция Qdrant
// rascenki_2026 — та же, что у поиска по расценкам в чате аналитики, см.
// server/rascenkiSearch.js; эмбеддинги — Voyage, тот же server/embeddings.js).
//
// Порядок приоритета (требование заказчика): сначала «утверждённые в
// VK development group», затем «ЕНиР для фирм». «ЕНиР для бригад» не берём.
// Цена — с НДС (поле price_vat).
//
// Предложение — лучший по близости вариант из первой категории, где есть
// подходящий по единице измерения и по порогу уверенности. Уверенность —
// косинусная близость (0…1). Остальные кандидаты показываются для ручного выбора.
const COLLECTION = 'rascenki_2026';
const APPROVED = 'Расценки утверждённые в ТОО VK development group';
const ENIR_FIRMS = 'Расценки из ЕНиР для фирм';
const TIERS = [APPROVED, ENIR_FIRMS];
const TIER_TITLE = { [APPROVED]: 'утверждённые в VK', [ENIR_FIRMS]: 'ЕНиР для фирм' };

// Порог уверенности для автоматического предложения (на коротких русских
// запросах точные совпадения дают ~0.5–0.65, шум ~0.35–0.45).
const MIN_SCORE = Number(process.env.PTO_RATE_MIN_SCORE || 0.45);
// Без арбитра (модель недоступна) автоматически предлагаем только уверенные совпадения.
const STRICT_SCORE = Number(process.env.PTO_RATE_STRICT_SCORE || 0.65);
const PER_TIER = 15;
const VAT = 1.16; // «Цена с НДС 16%» — если в своде есть только цена без НДС

class RatesUnavailable extends Error {}

// Единицы измерения к одному виду: «тн», «т», «тонна» → «т»; «м3», «м³» → «м³».
function normUnit(u) {
  const s = String(u || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s.]/g, '');
  if (/^(тн|т|тонна|тонн)$/.test(s)) return 'т';
  if (/^(м3|м³|кубм|куб)$/.test(s)) return 'м³';
  if (/^(м2|м²|квм|кв)$/.test(s)) return 'м²';
  if (/^(мпог|мп|пм|м)$/.test(s)) return 'м';
  if (/^(шт|штука|штук)$/.test(s)) return 'шт';
  return s;
}

const normText = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

// Ключ соответствия «вид работ → расценка»: название + единица. Объём и элемент
// в ключ не входят — расценка на армирование одна для всех элементов.
const workKey = (name, unit) => `${normText(name)}|${normUnit(unit)}`;

function toCandidate(point, unit) {
  const p = point.payload || {};
  const priceNoVat = p.price_no_vat ?? null;
  const vatEstimated = p.price_vat == null && priceNoVat != null;
  return {
    id: p.id ?? point.id,
    score: point.score ?? null,
    tier: p.class,
    class: p.class,
    tierTitle: TIER_TITLE[p.class] || p.class,
    name: p.name,
    unit: p.unit,
    price: p.price_vat ?? (priceNoVat != null ? Math.round(priceNoVat * VAT * 100) / 100 : null),
    priceNoVat,
    vatEstimated,
    object: p.object || null,
    section: p.section || null,
    subsection: p.subsection || null,
    justification: p.justification || null,
    unitMatch: unit ? normUnit(p.unit) === normUnit(unit) : true,
  };
}

// deps — подставляются в тестах; по умолчанию настоящие Qdrant и Voyage.
function createRates(deps = {}) {
  const lazy = () => ({
    embed: deps.embed || require('../embeddings').embed,
    getClient: deps.getClient || require('../qdrantClient').getClient,
    collectionStats: deps.collectionStats || require('../qdrantClient').collectionStats,
  });

  // Кандидаты по запросу: сначала по категориям в порядке приоритета, внутри — по близости.
  async function search(query, { unit = null } = {}) {
    const { embed, getClient, collectionStats } = lazy();
    const stats = await collectionStats(COLLECTION);
    if (!stats.exists || !stats.pointsCount) {
      throw new RatesUnavailable('Свод расценок не проиндексирован — запустите переиндексацию в разделе «Расценки» личного кабинета');
    }
    let vector;
    try {
      vector = await embed(query, { isQuery: true });
    } catch (err) {
      throw new RatesUnavailable('Сервис эмбеддингов недоступен — попробуйте позже');
    }
    const out = [];
    for (const tier of TIERS) {
      let res;
      try {
        res = await getClient().query(COLLECTION, {
          query: vector,
          filter: { must: [{ key: 'class', match: { value: tier } }] },
          limit: PER_TIER,
          with_payload: true,
        });
      } catch (err) {
        throw new RatesUnavailable('Поиск по своду расценок недоступен — попробуйте позже');
      }
      out.push(...(res.points || []).map((p) => toCandidate(p, unit)).sort((a, b) => b.score - a.score));
    }
    return out;
  }

  // Арбитр: модель из проекта (Ollama) выбирает расценку именно на эту работу
  // или «ничего не подходит». Близость по эмбеддингам путает смежное: на
  // «Бетонирование конструкций» без арбитра предлагалась «армированная
  // стяжка 50 мм» за 1392 ₸ (уверенность 55 %). Кандидаты — по приоритету
  // категорий, при равной применимости модель берёт верхнюю.
  const judge = deps.judge || (async (workName, unit, list) => {
    const { callOllamaJson } = require('../ollamaClient');
    const prompt = `Нужна расценка на вид работ: «${workName}», единица измерения: ${unit}.
Ниже кандидаты из свода расценок (JSON). Выбери ту, что описывает ИМЕННО эту работу, а не смежную
(например, расценка на стяжку, асфальтирование или кладку не подходит для бетонирования конструкций;
для «Армирования» подходит «Армирование» в тоннах, а не вязка каркасов в м²).
Кандидаты упорядочены по приоритету: если подходят несколько одинаково, бери верхнюю.
Если ни одна не подходит — верни null.
Кандидаты: ${JSON.stringify(list.map((c) => ({ id: c.id, категория: c.tierTitle, раздел: c.section, работа: c.name, ед: c.unit })))}

Ответь строго JSON: {"id": <id кандидата или null>}`;
    const out = await callOllamaJson([{ role: 'user', content: prompt }], { format: 'json', temperature: 0, timeoutMs: 15000 });
    if (!out || !('id' in out)) throw new Error('модель вернула ответ без поля id');
    return out.id;
  });

  // { best, candidates, verified }: best — предложение (или null), candidates —
  // все найденные, verified — выбор подтвердила модель (иначе — строгий порог).
  async function suggest(query, unit, { workName } = {}) {
    const candidates = await search(query, { unit });
    const pool = candidates.filter((c) => c.unitMatch && c.price != null && c.score >= MIN_SCORE);
    if (!pool.length) return { best: null, candidates, verified: false };
    try {
      const id = await judge(workName || query, unit, pool.slice(0, 12));
      const best = id == null ? null : pool.find((c) => String(c.id) === String(id)) || null;
      return { best, candidates, verified: true };
    } catch (err) {
      console.error('[pto] арбитр расценок недоступен, строгий порог:', err.message);
      return { best: pool.find((c) => c.score >= STRICT_SCORE) || null, candidates, verified: false };
    }
  }

  // Расценка по id — чтобы подтверждать выбранную, а не присланную клиентом.
  async function get(id) {
    const { getClient } = lazy();
    let points;
    try {
      points = await getClient().retrieve(COLLECTION, { ids: [Number(id)], with_payload: true });
    } catch (err) {
      throw new RatesUnavailable('Поиск по своду расценок недоступен — попробуйте позже');
    }
    return points && points[0] ? toCandidate(points[0], null) : null;
  }

  return { search, suggest, get };
}

module.exports = { createRates, RatesUnavailable, workKey, normUnit, TIERS, APPROVED, ENIR_FIRMS, MIN_SCORE };
