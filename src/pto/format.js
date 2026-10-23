// Подписи и форматирование модуля ПТО.
const numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const moneyFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export const fmtNum = (v) => (v === null || v === undefined || v === "" ? "—" : numberFormat.format(Number(v)));
export const fmtMoney = (v) => (v === null || v === undefined ? "—" : `${moneyFormat.format(Number(v))} ₸`);

export const KIND_TITLE = {
  steel: "Арматура",
  embedded: "Закладные изделия",
  concrete: "Бетон",
  metal: "Прочий металл (справочно)",
};

export const DOC_STATUS = {
  parsing: { label: "разбирается…", color: "#b8860b", bg: "#fff6e0" },
  draft: { label: "черновик", color: "#b45309", bg: "#fff3e0" },
  confirmed: { label: "проверено", color: "#1a7f37", bg: "#e6f4ea" },
  error: { label: "ошибка", color: "#c00", bg: "#fdecea" },
};

export const RATE_STATUS = {
  none: { label: "не подобрана", color: "#c00" },
  suggested: { label: "предложена", color: "#b45309" },
  confirmed: { label: "подтверждена", color: "#1a7f37" },
};

export const formatDate = (value) => {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T") + (String(value).includes("T") || String(value).endsWith("Z") ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

// «23, 25 (92,5)» — листы-источники строки; у объединённых позиций показываем и вклад каждого листа.
export const formatSources = (sources) => {
  if (!sources || !sources.length) return "";
  if (sources.length === 1) return String(sources[0].page);
  return sources.map((s) => `${s.page} (${fmtNum(s.quantity)})`).join(", ");
};
