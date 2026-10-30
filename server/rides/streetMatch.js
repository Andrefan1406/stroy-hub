// Совпадает ли найденное на карте место с тем, что набрали в заявке.
//
// Nominatim ищет «по смыслу» и иногда возвращает случайный объект: на
// «Кайсенова 119» (такой улицы в OpenStreetMap нет) он отвечал АЗС на улице
// Бажова — зацепился за номер дома. Форма показывала «✓ найден», точка и
// маршрут были чужими. Поэтому ответ принимаем, только если в нём есть
// улица (или название места) из запроса; номер дома не совпал — это уже
// «только улица», точку на карте отмечают вручную.
//
// Названия сравниваются без учёта регистра, типа улицы («ул.», «проспект»,
// «көшесі»), казахских букв (қ → к, ү → у, …), окончаний фамилий («Кайсенова» =
// «Кайсенов»), с допуском на опечатку в одну-две буквы.

const KZ_TO_RU = { ә: 'а', ғ: 'г', қ: 'к', ң: 'н', ө: 'о', ұ: 'у', ү: 'у', һ: 'х', і: 'и', ё: 'е', й: 'и', ъ: '', ь: '' };

// Слова, не отличающие одну улицу от другой (после fold).
const NOISE = new Set([
  'ул', 'улица', 'пр', 'просп', 'проспект', 'пер', 'переулок', 'мкр', 'мик', 'микрорайон', 'бульвар', 'бул',
  'проезд', 'тупик', 'шоссе', 'площадь', 'пл', 'набережная', 'наб', 'тракт', 'район', 'рн',
  'кошеси', 'кучеси', 'дангили', 'дангылы', 'г', 'город', 'д', 'дом', 'корп', 'корпус', 'стр', 'строение',
  'кв', 'оф', 'офис', 'им', 'имени',
]);
// После этих слов число — не номер дома.
const NOT_HOUSE_AFTER = new Set(['мкр', 'мик', 'микрорайон', 'кв', 'оф', 'офис']);

// Казахские буквы -> русские с сохранением регистра: «Қайсенов» -> «Кайсенов».
// Карта (Nominatim) казахское написание часто не находит, а русское — находит.
const KZ_UPPER = { Ә: 'А', Ғ: 'Г', Қ: 'К', Ң: 'Н', Ө: 'О', Ұ: 'У', Ү: 'У', Һ: 'Х', І: 'И' };
const kzToRu = (s) => String(s || '').replace(/[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/g, (c) => KZ_UPPER[c] || KZ_TO_RU[c]);

// Нижний регистр, казахские буквы -> русские, всё кроме букв и цифр -> пробел.
function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[әғқңөұүһіёйъь]/g, (c) => KZ_TO_RU[c])
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

// «Кайсенова» / «Кайсенов» -> «кайсен»; «Базовая» / «Базовый» -> «базов».
function stem(word) {
  if (word.length < 5) return word;
  const cut = word.replace(/(ова|ева|ина|ов|ев|ин|ая|яя|ый|ий|ой|а|я)$/, '');
  return cut.length >= 3 ? cut : word;
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

const sameWord = (a, b) => {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  return len >= 5 && distance(a, b) <= (len >= 9 ? 2 : 1);
};

// Из текста запроса: значимые слова улицы/места и номер дома.
function parseQuery(text) {
  const tokens = fold(text).split(' ').filter(Boolean);
  const words = [];
  let house = null;
  tokens.forEach((t, i) => {
    if (/^\d+[a-zа-я]?$/.test(t)) {
      if (!house && !NOT_HOUSE_AFTER.has(tokens[i - 1])) house = t;
    } else if (!NOISE.has(t) && t.length > 1) {
      words.push(stem(t));
    }
  });
  return { words, house };
}

const wordsOf = (s) => fold(s).split(' ').filter((t) => t && !NOISE.has(t) && !/^\d+$/.test(t)).map(stem);

const houseKey = (h) => String(h || '').split('/').map((x) => fold(x).replace(/ /g, '')).join('/');
function sameHouse(asked, found) {
  const a = houseKey(asked);
  const f = houseKey(found);
  return !!f && (f === a || f.startsWith(`${a}/`));
}

// Один ответ Nominatim (addressdetails=1) -> { precise, matched } либо null —
// это не то, что просили. precise: конкретное место (дом, здание), номер
// дома совпал; иначе — только улица (точку отметят на карте).
//   matched — как найденное называется на карте, показывается в форме.
function matchResult(text, item, preciseRank) {
  const query = parseQuery(text);
  const addr = item.address || {};
  const road = addr.road || addr.pedestrian || addr.footway || addr.path || '';
  const name = item.name || '';
  if (!query.words.length) return null;
  const candidates = [...wordsOf(road), ...wordsOf(name)];
  if (!query.words.some((w) => candidates.some((c) => sameWord(w, c)))) return null;

  const rankOk = Number(item.place_rank) >= preciseRank;
  // Номера дома в запросе нет — это поиск места по названию («Штабы»), и
  // точным считается только ответ, целиком названный так же; здание с этой
  // улицей в названии («Касым кайсенова 34») на просто «Кайсенова» не годится.
  const nameWords = wordsOf(name);
  const nameIsQuery = nameWords.length > 0 && nameWords.every((w) => query.words.some((q) => sameWord(q, w)));
  const houseOk = query.house ? sameHouse(query.house, addr.house_number || '') : nameIsQuery;
  const parts = [];
  if (name && fold(name) !== fold(road) && rankOk) parts.push(name);
  if (road) parts.push(road);
  if (addr.house_number) parts.push(addr.house_number);
  return { precise: rankOk && houseOk, matched: parts.join(', ') || name };
}

module.exports = { kzToRu, fold, stem, parseQuery, matchResult };
