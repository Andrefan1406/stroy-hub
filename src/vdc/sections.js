// Какие секции (блоки) есть в доме. Номера собираем по всему PDF:
// «Схема блокировки» на планах («Секция №1», «Секция №2»), колонки «блок-секция №N» в таблицах,
// упоминания «секции №N» в общих данных. Считаем разные номера, а не количество упоминаний —
// «Секция №2» на одном плане может стоять несколько раз.

// «блок-секция №1», «Секция №2», «секции №3/2», «Блок №3/2» → номер
const SECTION_RE = /(?:блок[\s-]*)?секци[яиюе]\s*№\s*(\d+(?:\/\d+)?)/gi;
const BLOCK_RE = /блок\s*№\s*(\d+(?:\/\d+)?)/gi;

const naturalCompare = (a, b) => a.localeCompare(b, "ru", { numeric: true });

function idsIn(text) {
  const out = new Set();
  for (const re of [SECTION_RE, BLOCK_RE]) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m) {
      out.add(m[1]);
      m = re.exec(text);
    }
  }
  return out;
}

// pages: [{ page, text }] — весь текст листа одной строкой.
// → { ids: ['1','2'], source: 'scheme' | 'all' | 'none', schemePages: [..] }
export function detectSections(pages) {
  const perPage = pages.map((p) => ({ page: p.page, text: p.text, ids: idsIn(p.text), scheme: /схема\s+блокировки/i.test(p.text) }));
  const schemePages = perPage.filter((p) => p.scheme && p.ids.size);
  if (schemePages.length) {
    const ids = new Set(schemePages.flatMap((p) => [...p.ids]));
    return { ids: [...ids].sort(naturalCompare), source: "scheme", schemePages: schemePages.map((p) => p.page) };
  }
  const ids = new Set(perPage.flatMap((p) => [...p.ids]));
  return { ids: [...ids].sort(naturalCompare), source: ids.size ? "all" : "none", schemePages: [] };
}

// «1, 2» / «1;2» / «1 2» → ['1','2'] (без повторов, в естественном порядке)
export function parseSectionIds(text) {
  const ids = String(text || "")
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^№/, "").trim())
    .filter((s) => /^\d+(?:\/\d+)?$/.test(s));
  return [...new Set(ids)].sort(naturalCompare);
}

// Первый блок — секция №1 (если такой нет — первая по порядку).
export function firstSectionId(ids) {
  return ids.includes("1") ? "1" : ids[0] ?? null;
}
