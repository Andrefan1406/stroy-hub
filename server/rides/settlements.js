// Населённые пункты для адресов заявок: Восточно-Казахстанская и Абайская
// области.
//
// Адрес в заявке хранится одной строкой «<населённый пункт>, <улица, дом>»
// («г. Семей, ул. Ленина, 5») — водитель видит город, а геокодер ищет
// улицу только внутри этого населённого пункта (routeEstimate.lookupAddress).
// Без этого одинаковые улицы путались: «г. Шемонаиха, ул. Ленина» находилась
// в Усть-Каменогорске, и время в пути считалось по чужому городу.
//
// Список KNOWN — для выпадающего списка в форме (Усть-Каменогорск первым,
// остальные по алфавиту). Любой другой населённый пункт можно вписать
// вручную — он проверяется по карте (resolveSettlement): принимаем только
// точное совпадение названия в пределах двух областей, иначе — «не найден»
// с подсказками, как пишется правильно.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// left,bottom,right,top — ВКО + Абайская область (Аягоз, Курчатов, Семей —
// на западе, Катон-Карагай — на востоке). Алматы и Павлодар — вне рамки.
const REGION_VIEWBOX = process.env.RIDES_GEOCODE_REGION_VIEWBOX || '76.5,46.3,87.5,51.6';

const DEFAULT_SETTLEMENT = 'г. Усть-Каменогорск';

// box — где искать улицу (left,bottom,right,top): граница населённого
// пункта с запасом на окраины. У Усть-Каменогорска — прежняя рамка поиска
// (город с пригородами), у остальных — их граница по карте + ~3 км.
const KNOWN = [
  { name: 'г. Усть-Каменогорск', query: 'Усть-Каменогорск', lat: 49.9484, lng: 82.6275, box: process.env.RIDES_GEOCODE_VIEWBOX || '82.20,49.70,83.05,50.20' },
  { name: 'г. Алтай', query: 'Алтай', lat: 49.7242, lng: 84.2751, box: '84.19,49.67,84.37,49.79' },
  { name: 'с. Глубокое', query: 'Глубокое', lat: 50.1438, lng: 82.317, box: '82.24,50.09,82.39,50.19' },
  { name: 'с. Горная Ульбинка', query: 'Горная Ульбинка', lat: 49.9868, lng: 82.9165, box: '82.87,49.96,82.97,50.02' },
  { name: 'пос. Новая Бухтарма', query: 'Новая Бухтарма', lat: 49.6294, lng: 83.5186, box: '83.45,49.59,83.59,49.67' },
  { name: 'г. Риддер', query: 'Риддер', lat: 50.3533, lng: 83.5207, box: '83.38,50.26,83.62,50.41' },
  { name: 'г. Семей', query: 'Семей', lat: 50.4067, lng: 80.2503, box: '80.07,50.30,80.50,50.51' },
  { name: 'г. Шемонаиха', query: 'Шемонаиха', lat: 50.6273, lng: 81.9086, box: '81.81,50.58,81.99,50.68' },
];

// «г. Семей», «г.Семей», «Семей», «ГОРОД СЕМЕЙ» -> «семей».
const PREFIX_RE = /^(г|гор|город|с|село|п|пос|поселок|посёлок|пгт|аул|а)\.?\s+|^(г|с|п|пос|пгт|а)\./i;
const normalize = (s) => String(s || '')
  .trim()
  .replace(PREFIX_RE, '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[\s-]+/g, ' ')
  .trim();
const hasPrefix = (s) => PREFIX_RE.test(String(s || '').trim());

const KNOWN_BY_KEY = new Map(KNOWN.map((k) => [normalize(k.name), k]));

// Город/посёлок по типу места на карте -> как подписывать.
const PREFIX_BY_TYPE = { city: 'г.', town: 'г.' };

// Граница места с запасом ~3 км (0,03°).
function boxAround(bbox) {
  const [south, north, west, east] = bbox.map(Number);
  const pad = 0.03;
  return [west - pad, south - pad, east + pad, north + pad].map((x) => x.toFixed(3)).join(',');
}

// Ответы по вписанным вручную названиям — в памяти на сутки (названия
// повторяются, а лимит Nominatim — 1 запрос в секунду).
const cache = new Map();
const CACHE_TTL_MS = 24 * 3600 * 1000;

async function searchPlaces(name) {
  const params = new URLSearchParams({
    q: name,
    format: 'jsonv2',
    limit: '8',
    countrycodes: 'kz',
    featureType: 'settlement',
    viewbox: REGION_VIEWBOX,
    bounded: '1',
    'accept-language': 'ru',
  });
  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, { headers: { 'User-Agent': 'my-first-site-rides/1.0' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  // Только сами населённые пункты, не районы и не администрации.
  return (await res.json()).filter((r) => r.category === 'place');
}

// Похожие названия из списка — подсказка при опечатке, когда карта ничего
// не нашла («Шимонаиха» -> «г. Шемонаиха»).
function similarKnown(key) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  };
  return KNOWN.filter((k) => dist(key, normalize(k.name)) <= 2).map((k) => k.name);
}

// Проверка названия населённого пункта:
//   { status: 'found', name, lat, lng, box, known } — из списка или точное
//     совпадение на карте (name — как подписывать: «с. Ивановка»);
//   { status: 'not_found', suggestions } — нет такого в двух областях
//     (suggestions — похожие названия: опечатка, старое название);
//   { status: 'unavailable' } — карта не ответила.
async function resolveSettlement(input) {
  const key = normalize(input);
  if (!key) return { status: 'not_found', suggestions: [] };
  const known = KNOWN_BY_KEY.get(key);
  if (known) return { status: 'found', name: known.name, query: known.query, lat: known.lat, lng: known.lng, box: known.box, known: true };

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  let places;
  try {
    places = await searchPlaces(key);
  } catch (err) {
    return { status: 'unavailable' };
  }
  const exact = places.find((p) => normalize(p.name) === key);
  let result;
  if (exact) {
    const name = `${PREFIX_BY_TYPE[exact.type] || 'с.'} ${exact.name}`;
    result = {
      status: 'found', name, query: exact.name, lat: Number(exact.lat), lng: Number(exact.lon), box: boxAround(exact.boundingbox), known: false,
    };
  } else {
    // Карта нашла похожее (другое написание, старое название —
    // «Зыряновск» -> Алтай): не подставляем молча, а подсказываем.
    const fromMap = places.map((p) => `${PREFIX_BY_TYPE[p.type] || 'с.'} ${p.name}`);
    result = { status: 'not_found', suggestions: [...new Set([...fromMap, ...similarKnown(key)])].slice(0, 5) };
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

// Адрес «<населённый пункт>, <остальное>» -> { settlement, rest } либо null —
// адрес без населённого пункта (заявки до появления этого поля) ищется по-
// старому, в Усть-Каменогорске. Первую часть считаем населённым пунктом,
// только если она из списка или с приставкой «г.», «с.», «пос.» — иначе
// «ул. Ленина, 5» ушла бы на карту искать посёлок «ул. Ленина».
async function splitSettlement(address) {
  const text = String(address || '').trim();
  const comma = text.indexOf(',');
  if (comma < 0) return null;
  const head = text.slice(0, comma).trim();
  const rest = text.slice(comma + 1).trim();
  if (!rest || (!KNOWN_BY_KEY.has(normalize(head)) && !hasPrefix(head))) return null;
  return { settlement: await resolveSettlement(head), rest };
}

// Для выпадающего списка: Усть-Каменогорск первым, остальные по алфавиту.
function settlementOptions() {
  const [first, ...rest] = KNOWN;
  const byName = (a, b) => normalize(a.name).localeCompare(normalize(b.name), 'ru');
  return [first, ...[...rest].sort(byName)].map(({ name, lat, lng }) => ({ name, lat, lng }));
}

module.exports = {
  DEFAULT_SETTLEMENT,
  REGION_VIEWBOX,
  KNOWN,
  normalize,
  resolveSettlement,
  splitSettlement,
  settlementOptions,
};
