// Сохраняемое состояние проекта: что именно запоминаем между сеансами и как восстанавливаем.
// Запоминаются только решения и вводы пользователя (листы, оси, коэффициенты, обмеры) — PDF никуда не уходит.

// Шифр чертежа из штампа: «АВ/24-11/187-1.6-АР». В PDF он бывает разбит на части («АВ», «/24-11/187-1.6», «-АР»),
// а в штампе повторяется на каждом листе — берём самый частый.
const CODE_RE = /([A-Za-zА-Яа-я]{1,4})\s*\/\s*(\d{2}-\d{2}\s*\/\s*\d+-\d+(?:\.\d+)*)\s*-\s*([A-Za-zА-Яа-я]{2,4})/g;

export function findProjectCode(pages) {
  const count = new Map();
  for (const p of pages || []) {
    const seen = new Set();
    for (const m of String(p.text ?? "").matchAll(CODE_RE)) {
      const code = `${m[1]}/${m[2].replace(/\s+/g, "")}-${m[3]}`.toUpperCase();
      seen.add(code);
    }
    seen.forEach((code) => count.set(code, (count.get(code) || 0) + 1));
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// Ключ проекта: шифр чертежа, а без него — имя и размер файла.
export const projectKeyFor = (pages, file) => findProjectCode(pages) || (file ? `файл:${file.name}:${file.size}` : null);

export const pickedList = (map) => Object.keys(map || {}).filter((k) => map[k]).map(Number).sort((a, b) => a - b);
export const pickedMap = (list) => Object.fromEntries((Array.isArray(list) ? list : []).map((n) => [n, true]));

// Оси квартир по листам экспликаций: [{ page, flats: [{ code, labels }] }]
export const axisLabelsOf = (layout) => (layout || []).map((e) => ({ page: e.page, flats: e.flats.map((f) => ({ code: f.code, labels: { ...f.labels } })) }));

// Подстановка сохранённых подписей осей в заново построенные квартиры: только там, где лист и порядок типов совпали.
export function applyAxisLabels(layout, saved) {
  if (!Array.isArray(saved) || !saved.length) return layout;
  return layout.map((e) => {
    const s = saved.find((x) => x.page === e.page);
    if (!s || !Array.isArray(s.flats) || s.flats.length !== e.flats.length || s.flats.some((f, i) => f.code !== e.flats[i].code)) return e;
    return {
      ...e,
      flats: e.flats.map((f, i) => {
        const labels = { ...f.labels };
        for (const [section, value] of Object.entries(s.flats[i].labels || {})) if (typeof value === "string" && value.trim()) labels[section] = value;
        return { ...f, labels };
      }),
    };
  });
}

// Собрать состояние для сохранения
export function collectState(f) {
  return {
    version: 1,
    numPages: f.numPages || null,
    tepPage: f.tepPage ? Number(f.tepPage) : null,
    sections: f.sections || "",
    explPages: pickedList(f.explPicked),
    finPages: pickedList(f.finPicked),
    axisLabels: f.axisLabels || [],
    loggias: (f.loggias || []).map((l) => ({ key: l.key, k: l.k })),
    loggiasConfirmed: !!f.loggiasConfirmed,
    wallHeight: f.wallHeight || "",
    calibrations: f.calibrations || {},
    measureLines: f.measureLines || {},
    manualValues: f.manualValues || {},
  };
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// Привести сохранённое к безопасному виду (старые или повреждённые данные не должны ломать страницу)
export function normalizeState(raw) {
  const s = obj(raw);
  return {
    numPages: Number.isInteger(s.numPages) ? s.numPages : null,
    tepPage: Number.isInteger(s.tepPage) ? String(s.tepPage) : "",
    sections: typeof s.sections === "string" ? s.sections : "",
    explPicked: pickedMap(s.explPages),
    finPicked: pickedMap(s.finPages),
    axisLabels: Array.isArray(s.axisLabels) ? s.axisLabels : [],
    loggias: Array.isArray(s.loggias) ? s.loggias.filter((l) => l && typeof l.key === "string") : [],
    loggiasConfirmed: !!s.loggiasConfirmed,
    wallHeight: typeof s.wallHeight === "string" ? s.wallHeight : "",
    calibrations: obj(s.calibrations),
    measureLines: obj(s.measureLines),
    manualValues: obj(s.manualValues),
  };
}

// Что уже сохранено — для строки в предложении восстановить («обмеров: 3, вручную: 2, листов откалибровано: 1»)
export function describeState(state) {
  const s = normalizeState(state);
  const parts = [];
  if (s.sections) parts.push(`секции: ${s.sections}`);
  const flats = s.axisLabels.reduce((n, e) => n + (e.flats?.length || 0), 0);
  if (flats) parts.push(`оси квартир: ${flats}`);
  if (s.loggias.length) parts.push(`коэффициенты лоджий: ${s.loggias.map((l) => l.k).join(", ")}${s.loggiasConfirmed ? " (подтверждены)" : ""}`);
  const lines = Object.values(s.measureLines).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  if (lines) parts.push(`линий обмера: ${lines}`);
  const manual = Object.values(s.manualValues).filter((v) => String(v).trim()).length;
  if (manual) parts.push(`значений вручную: ${manual}`);
  const cal = Object.keys(s.calibrations).length;
  if (cal) parts.push(`откалибровано листов: ${cal}`);
  if (s.wallHeight) parts.push(`высота от пола до потолка: ${s.wallHeight} м`);
  return parts;
}
