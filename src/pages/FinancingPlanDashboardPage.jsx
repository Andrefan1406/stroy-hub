// Модуль «Финплан объекта» — подключён к реальному Python-сервису
// (services/financing-api/) вместо макета с фиктивными данными.
//
// Четыре уровня навигации: категория -> объект -> позиция -> детали позиции.
// Категории/объекты приходят лёгким эндпоинтом /categories (только из
// config.py, без Sheets/ГПР — открывается мгновенно); полный финплан
// конкретного объекта (смета + график) подгружается только по клику на него.
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchCategories, fetchFinancingPlan } from "./financingPlanApi";

const MONTHS_RU = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];

// Годы раньше этого — одной колонкой на год, а не помесячно: графики Нурлы
// Жол 3 начались в 2023, и 24 месячные колонки за 2023-2024 сжимали бы
// актуальную часть шкалы.
const MONTHLY_FROM_YEAR = 2025;

// ---------------------------------------------------------------------------
// Работа с реальными датами разделов (вместо фиксированного окна в макете)
// ---------------------------------------------------------------------------

function parseISO(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return { year: y, month: m - 1 };
}

// Сквозной номер месяца (год * 12 + месяц) — единица распределения денег в
// финплане, независимо от того, месячная колонка или годовая.
function absMonth(dateStr) {
  const { year, month } = parseISO(dateStr);
  return year * 12 + month;
}

function nowAbsMonth() {
  const now = new Date();
  return now.getFullYear() * 12 + now.getMonth();
}

// Диапазон месяцев, покрывающий все разделы позиции, у которых вообще есть
// сроки (разделы без сроков — расхождение "(!)" — в шкалу не входят, они
// показаны отдельно в смете без даты). Прогнозные даты тоже учитываются в
// диапазоне (даже если чекбокс "Прогноз" сейчас выключен) — чтобы шкала не
// перестраивалась и не прыгала при включении, а сдвинутые вправо/влево
// полосы не обрезались.
function buildTimeline(sections) {
  const dated = sections.filter((sec) => sec.start && sec.end);
  if (!dated.length) return [];

  let min = null;
  let max = null;
  for (const sec of dated) {
    const st = parseISO(sec.start);
    const en = parseISO(sec.end);
    if (!min || st.year < min.year || (st.year === min.year && st.month < min.month)) min = st;
    if (!max || en.year > max.year || (en.year === max.year && en.month > max.month)) max = en;
    if (sec.forecast_end) {
      const fe = parseISO(sec.forecast_end);
      if (fe.year > max.year || (fe.year === max.year && fe.month > max.month)) max = fe;
    }
    // Прогноз может уйти и раньше плана (опережение графика) — расширяем
    // диапазон влево, иначе такая полоса обрежется.
    if (sec.forecast_start) {
      const fs = parseISO(sec.forecast_start);
      if (fs.year < min.year || (fs.year === min.year && fs.month < min.month)) min = fs;
    }
  }

  // Колонка — месяц ({monthIndex: 0..11}) или, до MONTHLY_FROM_YEAR, целый
  // год ({monthIndex: null}, всегда январь-декабрь целиком, даже если
  // разделы начались не с января — так позиция даты внутри колонки
  // календарно честная). months — сквозные номера месяцев колонки (absMonth).
  const columns = [];
  let { year, month } = min;
  while (year < max.year || (year === max.year && month <= max.month)) {
    if (year < MONTHLY_FROM_YEAR) {
      columns.push({
        year,
        monthIndex: null,
        label: String(year),
        months: Array.from({ length: 12 }, (_, k) => year * 12 + k),
      });
      year++;
      month = 0;
      continue;
    }
    columns.push({ year, monthIndex: month, label: MONTHS_RU[month], months: [year * 12 + month] });
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }
  return columns;
}

// Подпись колонки в шапке: у годовой — сам год; у месячной — месяц, а у
// января, первой колонки и первой месячной после годовых — ещё и год.
function columnLabel(timeline, i) {
  const col = timeline[i];
  if (col.monthIndex === null) return col.label;
  const showYear = col.monthIndex === 0 || i === 0 || timeline[i - 1].monthIndex === null;
  return showYear ? `${col.label} ${String(col.year).slice(2)}` : col.label;
}

function monthIndexOf(timeline, dateStr) {
  if (!dateStr) return -1;
  const { year, month } = parseISO(dateStr);
  return timeline.findIndex((t) => t.year === year && (t.monthIndex === null || t.monthIndex === month));
}

function todayIndex(timeline) {
  const now = new Date();
  return timeline.findIndex(
    (t) => t.year === now.getFullYear() && (t.monthIndex === null || t.monthIndex === now.getMonth())
  );
}

// Позиция даты на шкале графика в "колонках": индекс колонки + доля дня
// внутри неё (месяца или, у годовой колонки, года). atEnd — дата
// включительно (конец дня): 31.08 -> конец августа, 01.07 без atEnd ->
// начало июля. null, если дата вне шкалы.
function datePos(timeline, dateStr, atEnd) {
  const idx = monthIndexOf(timeline, dateStr);
  if (idx === -1) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (timeline[idx].monthIndex === null) {
    const dayOfYear = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
    const daysInYear = Math.round((Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000);
    return idx + (atEnd ? dayOfYear + 1 : dayOfYear) / daysInYear;
  }
  const daysInMonth = new Date(y, m, 0).getDate();
  return idx + (atEnd ? d : d - 1) / daysInMonth;
}

// Кусок отрезка [a, b) (в единицах datePos), попадающий в клетку месяца i,
// в долях ширины клетки; null — отрезок эту клетку не задевает.
function cellPiece(a, b, i) {
  const left = Math.max(a, i);
  const right = Math.min(b, i + 1);
  if (right <= left) return null;
  return { left: left - i, width: right - left, startsHere: a >= i, endsHere: b <= i + 1 };
}

// Сводит разделы со всех позиций объекта в один список — по одной строке на
// НАЗВАНИЕ раздела (сумма стоимости, мин.начало/макс.окончание, % готовности
// как средневзвешенное по стоимости). Даёт "агрегированный" график/смету/
// финплан по объекту целиком, без захода в конкретную позицию — те же
// компоненты (GanttTable/EstimateView/FinPlanTable), что и на уровне
// позиции, просто на входе не одна позиция, а сумма по всем.
function aggregateSectionsByName(positions) {
  const byName = new Map();

  for (const pos of Object.values(positions)) {
    for (const sec of pos.sections) {
      if (!byName.has(sec.name)) {
        byName.set(sec.name, {
          name: sec.name,
          cost: 0,
          start: null,
          end: null,
          forecast_start: null,
          forecast_end: null,
          forecast_pause_start: null,
          forecast_pause_end: null,
          fact_start: null,
          fact_end: null,
          fact_as_of: null,
          weightedFactSum: 0,
          factWeight: 0,
          anyFact: false,
          anyStarted: false,
          allCompleted: true,
        });
      }
      const agg = byName.get(sec.name);
      if (sec.cost != null) agg.cost += sec.cost;
      if (sec.start && (!agg.start || sec.start < agg.start)) agg.start = sec.start;
      if (sec.end && (!agg.end || sec.end > agg.end)) agg.end = sec.end;
      if (sec.forecast_end && (!agg.forecast_end || sec.forecast_end > agg.forecast_end)) agg.forecast_end = sec.forecast_end;
      // min, симметрично start/end выше — "с какой самой ранней даты хоть
      // где-то по прогнозу должен начаться этот раздел".
      if (sec.forecast_start && (!agg.forecast_start || sec.forecast_start < agg.forecast_start)) {
        agg.forecast_start = sec.forecast_start;
      }
      // Разные позиции могут получить чуть разное окно паузы (если старт
      // прогноза уже сам сдвинут в зиму, см. forecast.py) — берём самую
      // раннюю границу начала и самую позднюю границу конца, чтобы
      // объединённая полоса накрывала паузу любой из позиций целиком.
      if (sec.forecast_pause_start && (!agg.forecast_pause_start || sec.forecast_pause_start < agg.forecast_pause_start)) {
        agg.forecast_pause_start = sec.forecast_pause_start;
      }
      if (sec.forecast_pause_end && (!agg.forecast_pause_end || sec.forecast_pause_end > agg.forecast_pause_end)) {
        agg.forecast_pause_end = sec.forecast_pause_end;
      }
      if (sec.fact_start && (!agg.fact_start || sec.fact_start < agg.fact_start)) agg.fact_start = sec.fact_start;
      if (sec.fact_end && (!agg.fact_end || sec.fact_end > agg.fact_end)) agg.fact_end = sec.fact_end;
      if (sec.fact_as_of && (!agg.fact_as_of || sec.fact_as_of > agg.fact_as_of)) agg.fact_as_of = sec.fact_as_of;
      // Нет данных о факте по позиции = работы не начаты (0%), как и в
      // forecast.py, — а не "пропустить позицию": иначе средний % начатых
      // позиций размазывался бы и на неначатые, завышая факт по разделу.
      if (sec.cost != null) {
        agg.weightedFactSum += sec.cost * (sec.fact_percent || 0);
        agg.factWeight += sec.cost;
      }
      if (sec.fact_percent != null) agg.anyFact = true;
      if (sec.fact_percent > 0) agg.anyStarted = true;
      if (!sec.fact_completed) agg.allCompleted = false;
    }
  }

  return Array.from(byName.values()).map((agg) => {
    const factPercent = agg.anyFact && agg.factWeight > 0 ? agg.weightedFactSum / agg.factWeight : null;
    return {
      name: agg.name,
      cost: agg.cost,
      start: agg.start,
      end: agg.end,
      forecast_start: agg.forecast_start,
      forecast_end: agg.forecast_end,
      forecast_pause_start: agg.forecast_pause_start,
      forecast_pause_end: agg.forecast_pause_end,
      fact_percent: factPercent,
      fact_started: agg.anyStarted,
      fact_completed: agg.allCompleted && factPercent != null && factPercent >= 100,
      fact_start: agg.fact_start,
      fact_end: agg.fact_end,
      fact_as_of: agg.fact_as_of,
      in_schedule: !!(agg.start && agg.end),
      expected_no_schedule: false,
    };
  });
}

// Окончание по плану/прогнозу и отставание — общая логика для карточки и
// объекта, и позиции.
function computeFinishSummary(sections) {
  const dated = sections.filter((sec) => sec.start && sec.end);
  if (!dated.length) return null;

  let planFinish = null;
  let factFinish = null;
  for (const sec of dated) {
    if (!planFinish || sec.end > planFinish) planFinish = sec.end;
    if (sec.forecast_end && (!factFinish || sec.forecast_end > factFinish)) factFinish = sec.forecast_end;
  }
  const delayDays =
    planFinish && factFinish ? Math.round((new Date(factFinish) - new Date(planFinish)) / 86400000) : null;

  return { planFinish, factFinish, delayDays };
}

// Отрезки полос раздела на шкале datePos (см. выше) — по дням, а не целыми
// месяцами: одинаковая длительность выглядит одинаковой длины, где бы в
// месяце ни начиналась.
//
// План — от плановой даты начала до плановой даты окончания (включительно).
// Факт — та же точка старта, длина = % готовности от длины плана: реальных
// понедельных отметок по каждому месяцу у нас на фронте нет, только
// итоговый %, поэтому это приближение, а не точная посуточная картина.
// Прогноз, три случая:
// - завершён (fact% >= 100) — прогнозировать нечего, полосы нет;
// - в процессе — стыкуется ВПЛОТНУЮ к концу полосы факта (левый край —
//   шов, не скругляется), до forecast_end;
// - ещё не начат — forecast_start..forecast_end как есть.
// Зимний простой монолитных работ (forecast.py:_apply_winter_pause)
// вырезается из прогноза по дням; если раздел стартует прямо в паузу,
// куска "до паузы" просто не остаётся.
function sectionSpans(sec, timeline) {
  const planStart = datePos(timeline, sec.start, false);
  const planEnd = datePos(timeline, sec.end, true);
  if (planStart == null || planEnd == null) return null;
  const pct = sec.fact_percent;

  const fact = pct != null && pct > 0 ? { a: planStart, b: planStart + (planEnd - planStart) * Math.min(pct, 100) / 100 } : null;

  let forecast = [];
  const forecastEnd = sec.forecast_end ? datePos(timeline, sec.forecast_end, true) : null;
  if (forecastEnd != null && !(pct != null && pct >= 100)) {
    const inProgress = pct != null && pct > 0;
    const a = inProgress ? fact.b : sec.forecast_start ? datePos(timeline, sec.forecast_start, false) : null;
    if (a != null && forecastEnd > a) forecast = [{ a, b: forecastEnd, seamLeft: inProgress }];
  }
  if (forecast.length && sec.forecast_pause_start && sec.forecast_pause_end) {
    const pauseA = datePos(timeline, sec.forecast_pause_start, false);
    const pauseB = datePos(timeline, sec.forecast_pause_end, true);
    if (pauseA != null && pauseB != null) {
      const [f] = forecast;
      forecast = [
        { a: f.a, b: Math.min(f.b, pauseA), seamLeft: f.seamLeft },
        { a: Math.max(f.a, pauseB), b: f.b, seamLeft: false },
      ].filter((p) => p.b > p.a);
    }
  }

  return { plan: { a: planStart, b: planEnd }, fact, forecast, factComplete: pct != null && pct >= 100 };
}

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------

function formatMoney(n) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
}

function formatMoneyM(n) {
  return `${(n / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн ₸`;
}

// ---------------------------------------------------------------------------
// Тёмная тема (только для этого модуля)
// ---------------------------------------------------------------------------

const ACCENT = "linear-gradient(135deg, #7c5cff, #33d6c0)";
// Один и тот же цвет для полосы на графике и для чекбокса, который её
// включает — чтобы соответствие считывалось сразу, без подписи.
const PLAN_COLOR = "#7c5cff";
const FACT_COLOR = "#57d9c6";
const FORECAST_COLOR = "#ffb454";
// Колонка названий разделов в графике/финплане: самое длинное название
// ("Чистовой монтаж эл.оборудования", ~262px при 16px) + боковые отступы.
const NAME_COL_WIDTH = 280;

const s = {
  page: {
    minHeight: "100vh",
    background: "#0b0d12",
    color: "#e8eaf0",
    fontFamily: "'Segoe UI', Roboto, -apple-system, sans-serif",
    padding: "16px 20px 12px",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    maxWidth: 1180,
    margin: "0 auto 12px",
  },
  back: {
    background: "transparent",
    border: "1px solid #242835",
    color: "#9aa0b4",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: 14,
  },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  container: { maxWidth: 1180, margin: "0 auto" },
  breadcrumb: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
    marginBottom: 12,
    fontSize: 14,
    color: "#9aa0b4",
  },
  crumbBtn: {
    background: "transparent",
    border: "none",
    color: "#9aa0b4",
    cursor: "pointer",
    fontSize: 14,
    padding: "2px 4px",
  },
  crumbCurrent: { color: "#e8eaf0", fontWeight: 600, padding: "2px 4px" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: 16,
  },
  card: {
    background: "#171a21",
    border: "1px solid #242835",
    borderRadius: 14,
    padding: "18px 20px",
    cursor: "pointer",
    transition: "border-color .15s, transform .15s",
  },
  cardTitle: { fontSize: 16, fontWeight: 700, marginBottom: 4 },
  cardSubtitle: { fontSize: 13, color: "#9aa0b4", marginBottom: 14 },
  cardDescription: { fontSize: 12, color: "#767c8f", marginBottom: 14, lineHeight: 1.4 },
  cardRow: { display: "flex", justifyContent: "space-between", fontSize: 13, color: "#9aa0b4", marginBottom: 4 },
  cardValue: { color: "#e8eaf0", fontWeight: 600 },

  // Заголовок, цифры и вкладки собраны плотно (в одну строку каждый блок),
  // чтобы график/финплан позиции целиком входил в экран без вертикального
  // скролла; размеры шрифтов прежние, ужаты только отступы.
  detailHeader: {
    display: "flex",
    alignItems: "center",
    gap: 32,
    flexWrap: "wrap",
    background: "#171a21",
    border: "1px solid #242835",
    borderRadius: 14,
    padding: "10px 20px",
    marginBottom: 10,
  },
  detailTitle: { fontSize: 20, fontWeight: 700 },
  builtAt: { fontSize: 12, color: "#7d8499", marginTop: 4 },
  detailStats: { display: "flex", gap: 32, flexWrap: "wrap" },
  statLabel: { fontSize: 12, color: "#9aa0b4" },
  statValue: { fontSize: 18, fontWeight: 700, marginTop: 2 },

  posStrip: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 },
  posChip: (active) => ({
    background: active ? "rgba(87, 217, 198, 0.15)" : "transparent",
    border: `1px solid ${active ? FACT_COLOR : "#242835"}`,
    color: active ? "#e8eaf0" : "#9aa0b4",
    fontWeight: active ? 700 : 500,
    borderRadius: 8,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 14,
  }),

  tabsRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    marginBottom: 10,
  },
  tabs: { display: "flex", gap: 8, flexWrap: "wrap" },
  toggles: { display: "flex", gap: 20 },
  tabBtn: (active) => ({
    background: active ? ACCENT : "transparent",
    border: active ? "none" : "1px solid #242835",
    color: active ? "#0b0d12" : "#9aa0b4",
    fontWeight: active ? 700 : 500,
    borderRadius: 10,
    padding: "8px 16px",
    cursor: "pointer",
    fontSize: 14,
  }),

  tableWrap: {
    background: "#171a21",
    border: "1px solid #242835",
    borderRadius: 14,
    overflow: "auto",
    padding: 4,
  },
  table: { borderCollapse: "collapse", width: "100%", fontSize: 13 },
  th: {
    position: "sticky",
    top: 0,
    background: "#1c2029",
    color: "#9aa0b4",
    fontWeight: 600,
    padding: "10px 6px",
    textAlign: "center",
    borderBottom: "1px solid #242835",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // Подпись месяца повёрнута на 90° — при большом числе месяцев в строке
  // это единственный способ показать полное название без горизонтального
  // скролла (см. th выше — там подпись не помещалась и обрезалась "…").
  // Высота не фиксирована — строка шапки растягивается под самую длинную
  // подпись ("Янв 27"), иначе при другой ширине шрифта обрезается год.
  thMonth: {
    writingMode: "vertical-rl",
    transform: "rotate(180deg)",
    padding: "6px 2px",
    whiteSpace: "nowrap",
  },
  thFirst: {
    position: "sticky",
    left: 0,
    top: 0,
    zIndex: 2,
    background: "#1c2029",
    textAlign: "left",
    minWidth: 220,
  },
  tdFirst: {
    position: "sticky",
    left: 0,
    background: "#171a21",
    padding: "10px 12px",
    borderBottom: "1px solid #1e222b",
    minWidth: 220,
  },
  // Строка графика/финплана: название в одну строку (колонка NAME_COL_WIDTH
  // рассчитана под самое длинное название при шрифте 16px; если появится
  // длиннее — обрежется "…", полное название в подсказке title).
  tdFirstCompact: {
    position: "sticky",
    left: 0,
    background: "#171a21",
    padding: "2px 8px",
    lineHeight: "20px",
    borderBottom: "1px solid #1e222b",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  td: {
    padding: "10px 4px",
    textAlign: "center",
    borderBottom: "1px solid #1e222b",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // Без горизонтального паддинга у ячейки (в отличие от обычного s.td) —
  // чтобы полоса работы у соседних активных месяцев стыковалась вплотную,
  // без разрыва, и читалась одной сплошной полосой, а не отдельными кубиками.
  // Строки графика чуть выше строк финплана (30px против 25px) — между
  // полосами больше воздуха; финплан с таким шагом перестал бы влезать в экран.
  tdFirstGantt: { padding: "4.5px 8px" },
  ganttTd: { padding: "5.5px 0", textAlign: "center", borderBottom: "1px solid #1e222b", whiteSpace: "nowrap" },
  // Меньше шрифт и паддинг, чем у обычного s.td — суммы по объекту целиком
  // (агрегат по 9 позициям) четырёхзначные, при 20+ месяцах в строке
  // обычный размер не помещается в колонку и обрезается многоточием.
  finplanNum: { fontSize: 10, padding: "2px 1px", lineHeight: "20px" },
  ganttBarWrap: { position: "relative", height: 18 },
  ganttBar: { position: "absolute", top: 0, background: PLAN_COLOR, height: 18 },
  ganttMonthDivider: { boxShadow: "inset 1px 0 0 rgba(11, 13, 18, 0.75)" },
  // Полоса факта — снизу поверх плановой, потоньше, другим цветом, чтобы
  // план оставался виден целиком, а не перекрывался фактом.
  ganttFactBar: { position: "absolute", left: 0, bottom: 0, height: 7, background: FACT_COLOR },
  // Прогноз — сверху, полупрозрачная заливка + пунктирная рамка янтарного
  // цвета: наглядно отличается и от плана (сплошная заливка), и от факта
  // (снизу, бирюзовый).
  ganttForecastBar: {
    position: "absolute",
    top: 0,
    height: 18,
    background: "rgba(255, 180, 84, 0.25)",
    border: `1.5px dashed ${FORECAST_COLOR}`,
    boxSizing: "border-box",
  },
  todayCol: { boxShadow: "inset 1px 0 0 #57d9c6, inset -1px 0 0 #57d9c6" },
  footnote: { padding: "12px 16px", color: "#767c8f", fontSize: 12 },
  centerNote: { textAlign: "center", color: "#9aa0b4", padding: "60px 0", fontSize: 14 },
  // color задаёт цвет подписи, accentColor (через factCheckbox ниже) — цвет
  // самого чекбокса, тем же цветом, что и полоса, которую он включает.
  factToggle: (color) => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color,
    fontWeight: 600,
  }),
  factCheckbox: (color) => ({ accentColor: color, width: 16, height: 16, cursor: "pointer" }),
};

// ---------------------------------------------------------------------------
// Мелкие переиспользуемые блоки
// ---------------------------------------------------------------------------

function StatCard({ title, description, total, finish, onClick }) {
  return (
    <div
      style={s.card}
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#57d9c6")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#242835")}
    >
      <div style={s.cardTitle}>{title}</div>
      {description && <div style={s.cardDescription}>{description}</div>}
      <div style={s.cardRow}>
        <span>Общая стоимость (план)</span>
        <span style={s.cardValue}>{formatMoneyM(total)}</span>
      </div>
      {finish && (
        <>
          <div style={s.cardRow}>
            <span>Окончание по плану</span>
            <span style={{ ...s.cardValue, color: PLAN_COLOR }}>{finish.planFinish}</span>
          </div>
          <div style={s.cardRow}>
            <span>Окончание по прогнозу</span>
            <span style={{ ...s.cardValue, color: FORECAST_COLOR }}>{finish.factFinish || "—"}</span>
          </div>
        </>
      )}
    </div>
  );
}

function FinishStats({ total, finish }) {
  const delay = finish ? finish.delayDays : null;
  return (
    <div style={s.detailStats}>
      <div>
        <div style={s.statLabel}>Общая стоимость (план)</div>
        <div style={s.statValue}>{formatMoney(total)}</div>
      </div>
      {finish && (
        <>
          <div>
            <div style={s.statLabel}>Окончание по плану</div>
            <div style={{ ...s.statValue, color: PLAN_COLOR }}>{finish.planFinish}</div>
          </div>
          <div>
            <div style={s.statLabel}>Окончание по прогнозу</div>
            <div style={{ ...s.statValue, color: FORECAST_COLOR }}>{finish.factFinish || "—"}</div>
          </div>
          <div>
            <div style={s.statLabel}>Отставание от плана</div>
            <div
              style={{
                ...s.statValue,
                color: delay > 0 ? FORECAST_COLOR : delay < 0 ? FACT_COLOR : "#e8eaf0",
              }}
            >
              {delay > 0 ? `+${delay} дн.` : `${delay || 0} дн.`}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Карточка категории/объекта — агрегаты из config.py (без сметы/ГПР, дёшево
// и быстро открывается верхний уровень навигации).
function AggregateCard({ title, agg, onClick, summaryToggle }) {
  return (
    <div
      style={s.card}
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#57d9c6")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#242835")}
    >
      <div style={s.cardTitle}>{title}</div>
      <div style={s.cardRow}>
        <span>Домов</span>
        <span style={s.cardValue}>{agg.buildings_count}</span>
      </div>
      <div style={s.cardRow}>
        <span>Квартир</span>
        <span style={s.cardValue}>{agg.apartments_count}</span>
      </div>
      <div style={s.cardRow}>
        <span>Площадь квартир</span>
        <span style={s.cardValue}>{agg.apartments_area_m2.toLocaleString("ru-RU")} м²</span>
      </div>
      {agg.commercial_area_m2 > 0 && (
        <div style={s.cardRow}>
          <span>Площадь коммерческих</span>
          <span style={s.cardValue}>{agg.commercial_area_m2.toLocaleString("ru-RU")} м²</span>
        </div>
      )}
      {summaryToggle && (
        // stopPropagation — клик по чекбоксу не должен ещё и открывать карточку.
        <label style={{ ...s.factToggle(FACT_COLOR), marginTop: 12 }} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            style={s.factCheckbox(FACT_COLOR)}
            checked={summaryToggle.checked}
            onChange={(e) => summaryToggle.onChange(e.target.checked)}
          />
          Сводная информация
        </label>
      )}
    </div>
  );
}

// Галочки слоёв графика — в строке вкладок (а не над таблицей), чтобы не
// тратить на них отдельную строку по высоте.
function GanttToggles({ layers }) {
  return (
    <div style={s.toggles}>
      {layers.map(({ label, color, checked, onChange }) => (
        <label key={label} style={s.factToggle(color)}>
          <input
            type="checkbox"
            style={s.factCheckbox(color)}
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

function barRadius(roundLeft, roundRight) {
  const l = roundLeft ? 9 : 0;
  const r = roundRight ? 9 : 0;
  return `${l}px ${r}px ${r}px ${l}px`;
}

function GanttTable({ sections, timeline, showPlan, showFact, showForecast }) {
  const dated = sections.filter((sec) => sec.start && sec.end);
  const today = todayIndex(timeline);
  // minmax(0, 1fr), а не просто 1fr — иначе колонки не сжимались бы уже
  // родного min-content подписи месяца, и таблица всё равно бы поехала
  // вбок при большом числе месяцев.
  const gridTemplateColumns = `${NAME_COL_WIDTH}px repeat(${timeline.length}, minmax(0, 1fr))`;

  return (
    <div>
      <div style={s.tableWrap}>
        <div style={{ display: "grid", gridTemplateColumns }}>
          <div style={{ ...s.th, ...s.thFirst }}>Раздел работ</div>
          {timeline.map((_, i) => (
            <div key={i} style={{ ...s.th, ...s.thMonth, ...(i === today ? s.todayCol : {}) }}>
              {columnLabel(timeline, i)}
            </div>
          ))}

          {dated.map((sec) => {
            const spans = sectionSpans(sec, timeline);

            return (
              <React.Fragment key={sec.name}>
                <div style={{ ...s.tdFirstCompact, ...s.tdFirstGantt }} title={sec.name}>
                  {sec.name}
                </div>
                {timeline.map((_, i) => {
                  const plan = spans && showPlan ? cellPiece(spans.plan.a, spans.plan.b, i) : null;
                  const fact = spans && showFact && spans.fact ? cellPiece(spans.fact.a, spans.fact.b, i) : null;
                  const forecast =
                    spans && showForecast
                      ? spans.forecast.map((f) => ({ f, piece: cellPiece(f.a, f.b, i) })).filter((x) => x.piece)
                      : [];

                  return (
                    <div key={i} style={{ ...s.ganttTd, ...(i === today ? s.todayCol : {}) }}>
                      {(plan || fact || forecast.length > 0) && (
                        <div style={s.ganttBarWrap}>
                          {plan && (
                            <div
                              style={{
                                ...s.ganttBar,
                                left: `${plan.left * 100}%`,
                                width: `${plan.width * 100}%`,
                                borderRadius: barRadius(plan.startsHere, plan.endsHere),
                                // Тонкая тёмная черта на границе месяцев — по сегментам
                                // плановой полосы считается её длительность в месяцах.
                                ...(plan.startsHere ? {} : s.ganttMonthDivider),
                              }}
                            />
                          )}
                          {fact && (
                            <div
                              style={{
                                ...s.ganttFactBar,
                                left: `${fact.left * 100}%`,
                                width: `${fact.width * 100}%`,
                                borderRadius: barRadius(fact.startsHere, fact.endsHere && spans.factComplete),
                              }}
                            />
                          )}
                          {forecast.map(({ f, piece }, k) => (
                            <div
                              key={k}
                              style={{
                                ...s.ganttForecastBar,
                                left: `${piece.left * 100}%`,
                                width: `${piece.width * 100}%`,
                                borderRadius: barRadius(piece.startsHere && !f.seamLeft, piece.endsHere),
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function perM2(cost, area) {
  return cost != null && area ? formatMoney(cost / area) : "—";
}

function EstimateView({ sections, total, apartmentsArea, commercialArea }) {
  const totalAreaWithCommercial = apartmentsArea && commercialArea ? apartmentsArea + commercialArea : null;

  return (
    <div style={s.tableWrap}>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={{ ...s.th, ...s.thFirst }}>Раздел работ</th>
            <th style={s.th}>Сумма</th>
            <th style={s.th}>₸ / м² квартир</th>
            {totalAreaWithCommercial && <th style={s.th}>₸ / м² с коммерческими</th>}
          </tr>
        </thead>
        <tbody>
          {sections.map((sec) => (
            <tr key={sec.name}>
              <td style={s.tdFirst}>{sec.name}</td>
              <td style={s.td}>{sec.cost != null ? formatMoney(sec.cost) : "—"}</td>
              <td style={s.td}>{perM2(sec.cost, apartmentsArea)}</td>
              {totalAreaWithCommercial && <td style={s.td}>{perM2(sec.cost, totalAreaWithCommercial)}</td>}
            </tr>
          ))}
          <tr>
            <td style={{ ...s.tdFirst, fontWeight: 700, background: "#1c2029" }}>Итого</td>
            <td style={{ ...s.td, fontWeight: 700, background: "#1c2029" }}>{formatMoney(total)}</td>
            <td style={{ ...s.td, fontWeight: 700, background: "#1c2029" }}>{perM2(total, apartmentsArea)}</td>
            {totalAreaWithCommercial && (
              <td style={{ ...s.td, fontWeight: 700, background: "#1c2029" }}>
                {perM2(total, totalAreaWithCommercial)}
              </td>
            )}
          </tr>
        </tbody>
      </table>
      <div style={s.footnote}>
        Непредвиденные расходы, накладные расходы и расходы на технику распределены пропорционально между всеми разделами
        проекта.
      </div>
    </div>
  );
}

// Три режима финплана, одно и то же по смыслу распределение (сумма поровну
// на месяцы диапазона), но разные диапазон и сумма для раздела:
// - "plan"     — весь план целиком, как и раньше (sec.start..sec.end, sec.cost).
// - "fact"     — план с учётом факта, но только прошедшие месяцы (текущий,
//                ещё не закрытый, не показывается): сколько реально освоено
//                (cost * fact% / 100), размазано по факт.старту..прошлому
//                месяцу (или факт.концу, если завершён раньше). Разделы, где
//                работы ещё не начинались или начались только в этом месяце
//                — не участвуют, показывать нечего.
// - "forecast" — разница план/факт, но только текущий месяц и будущее:
//                остаток (cost * (1 - fact%/100)), размазан от "сейчас" (as_of
//                для начатых, сдвинутый план для ещё не начатых) до
//                forecast_end. Завершённые разделы не участвуют — остатка нет.
//                Месяцы зимнего простоя пропускаются (см. monthsFullyInPause в
//                FinPlanTable).
// Диапазон — в сквозных месяцах (absMonth), а не в колонках: годовая
// колонка (см. MONTHLY_FROM_YEAR) получает сумму всех своих месяцев
// диапазона, а не одну месячную долю.
function sectionMonthlyRange(mode, sec, todayAbs) {
  if (mode === "plan") {
    if (!sec.start || !sec.end || sec.cost == null) return null;
    return { startAbs: absMonth(sec.start), endAbs: absMonth(sec.end), amount: sec.cost };
  }

  if (mode === "fact") {
    if (!sec.fact_percent || sec.fact_percent <= 0 || !sec.fact_start) return null;
    const earned = sec.cost * (sec.fact_percent / 100);
    const startAbs = absMonth(sec.fact_start);
    let endAbs = sec.fact_completed && sec.fact_end ? absMonth(sec.fact_end) : todayAbs;
    endAbs = Math.min(endAbs, todayAbs - 1); // "факт" — только закрытые месяцы
    if (startAbs > endAbs) {
      if (startAbs <= todayAbs - 1) return { startAbs, endAbs: startAbs, amount: earned };
      return null; // начат только в текущем месяце — прошлого ещё нет
    }
    return { startAbs, endAbs, amount: earned };
  }

  if (mode === "forecast") {
    if (!sec.forecast_end) return null;
    const percent = sec.fact_percent;
    if (percent != null && percent >= 100) return null; // завершён — остатка нет
    const remaining = sec.cost * (1 - (percent || 0) / 100);
    if (remaining <= 0) return null;
    const rawStart = percent != null && percent > 0 ? sec.fact_as_of : sec.forecast_start;
    if (!rawStart) return null;
    let startAbs = absMonth(rawStart);
    const endAbs = absMonth(sec.forecast_end);
    if (startAbs < todayAbs) startAbs = todayAbs; // в прошлое "прогноз" не заходит, текущий месяц — да
    if (startAbs > endAbs) return null;
    return { startAbs, endAbs, amount: remaining };
  }

  return null;
}

// footnoteLabel отдельно от label чекбокса: сама галочка называется
// "Прогноз" (единый термин с графиком производства работ), но итоговая
// сумма в этом режиме — по сути остаток (сумма × (100% - факт)), не
// "прогноз" в бытовом смысле "что будет" — чтобы не путать, внизу подписано иначе.
const FINPLAN_MODES = [
  { id: "plan", label: "План", footnoteLabel: "План", color: PLAN_COLOR },
  { id: "fact", label: "Факт", footnoteLabel: "Факт", color: FACT_COLOR },
  { id: "forecast", label: "Прогноз", footnoteLabel: "Остаток", color: FORECAST_COLOR },
];

// Месяцы, целиком попадающие в зимний простой раздела (forecast.py) — в
// режиме "Прогноз" работы в них не идут, значит и денег на них нет.
// Граничные месяцы (ноябрь с 15-го) остаются рабочими. Возвращает сквозные
// номера месяцев (absMonth).
function monthsFullyInPause(sec, range) {
  const skip = new Set();
  if (!sec.forecast_pause_start || !sec.forecast_pause_end) return skip;
  for (let abs = range.startAbs; abs <= range.endAbs; abs++) {
    const year = Math.floor(abs / 12);
    const monthIndex = abs % 12;
    const mm = String(monthIndex + 1).padStart(2, "0");
    const lastDay = String(new Date(year, monthIndex + 1, 0).getDate()).padStart(2, "0");
    if (sec.forecast_pause_start <= `${year}-${mm}-01` && sec.forecast_pause_end >= `${year}-${mm}-${lastDay}`) {
      skip.add(abs);
    }
  }
  return skip;
}

function FinPlanModeToggles({ mode, onModeChange }) {
  return (
    <div style={s.toggles}>
      {FINPLAN_MODES.map((m) => (
        <label key={m.id} style={s.factToggle(m.color)}>
          <input
            type="radio"
            name="finplan-mode"
            style={s.factCheckbox(m.color)}
            checked={mode === m.id}
            onChange={() => onModeChange(m.id)}
          />
          {m.label}
        </label>
      ))}
    </div>
  );
}

function FinPlanTable({ sections, timeline: fullTimeline, mode }) {
  // Колонки — только те, в которые этот режим вообще может что-то положить:
  // "Факт" — прошедшие месяцы (до текущего), "Прогноз" — текущий месяц и
  // дальше, "План" — вся шкала.
  const todayAbs = nowAbsMonth();
  const timeline = fullTimeline.filter((col) => {
    if (mode === "fact") return col.months[0] < todayAbs;
    if (mode === "forecast") return col.months[col.months.length - 1] >= todayAbs;
    return true;
  });
  const today = todayIndex(timeline);
  if (!timeline.length) {
    return <div style={s.footnote}>{mode === "fact" ? "Прошедших месяцев на шкале нет." : "Будущих месяцев на шкале нет."}</div>;
  }
  // Деньги за пределами шкалы (например, факт начался раньше самого раннего
  // планового старта) — в крайнюю колонку, а не теряются из итога.
  const firstAbs = timeline[0].months[0];
  const lastCol = timeline[timeline.length - 1];
  const lastAbs = lastCol.months[lastCol.months.length - 1];
  const clamp = (abs) => Math.min(Math.max(abs, firstAbs), lastAbs);

  const rows = sections
    .map((sec) => ({ sec, range: sectionMonthlyRange(mode, sec, todayAbs) }))
    .filter((r) => r.range)
    .map(({ sec, range: raw }) => {
      const range = { ...raw, startAbs: clamp(raw.startAbs), endAbs: clamp(raw.endAbs) };
      let skip = mode === "forecast" ? monthsFullyInPause(sec, range) : new Set();
      let activeMonths = 0;
      for (let abs = range.startAbs; abs <= range.endAbs; abs++) if (!skip.has(abs)) activeMonths++;
      if (activeMonths === 0) {
        skip = new Set();
        activeMonths = range.endAbs - range.startAbs + 1;
      }
      const perMonth = range.amount / activeMonths;
      const isActiveMonth = (abs) => abs >= range.startAbs && abs <= range.endAbs && !skip.has(abs);
      // Сумма по колонке: у месячной — доля одного месяца, у годовой — всех
      // активных месяцев этого года.
      const cells = timeline.map((col) => {
        const n = col.months.filter(isActiveMonth).length;
        return n ? perMonth * n : null;
      });
      return { sec, cells };
    });

  const monthly = timeline.map((_, i) => rows.reduce((sum, { cells }) => sum + (cells[i] || 0), 0));
  const grandTotal = monthly.reduce((a, b) => a + b, 0);
  const gridTemplateColumns = `${NAME_COL_WIDTH}px repeat(${timeline.length}, minmax(0, 1fr))`;
  const activeColor = FINPLAN_MODES.find((m) => m.id === mode).color;

  return (
    <div>
      <div style={s.tableWrap}>
        <div style={{ display: "grid", gridTemplateColumns }}>
          <div style={{ ...s.th, ...s.thFirst }}>Раздел работ</div>
          {timeline.map((_, i) => (
            <div key={i} style={{ ...s.th, ...s.thMonth, ...(i === today ? s.todayCol : {}) }}>
              {columnLabel(timeline, i)}
            </div>
          ))}

          {rows.map(({ sec, cells }) => (
            <React.Fragment key={sec.name}>
              <div style={s.tdFirstCompact} title={sec.name}>
                {sec.name}
              </div>
              {cells.map((v, i) => (
                <div key={i} style={{ ...s.td, ...s.finplanNum, ...(i === today ? s.todayCol : {}) }}>
                  {v != null
                    ? (v / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 0, useGrouping: false })
                    : "—"}
                </div>
              ))}
            </React.Fragment>
          ))}

          <div style={{ ...s.tdFirstCompact, fontWeight: 700, background: "#1c2029" }}>
            {timeline.some((col) => col.monthIndex === null) ? "Итого за период, млн ₸" : "Итого за месяц, млн ₸"}
          </div>
          {monthly.map((v, i) => (
            <div
              key={i}
              style={{
                ...s.td,
                ...s.finplanNum,
                fontWeight: 700,
                background: "#1c2029",
                ...(i === today ? s.todayCol : {}),
              }}
            >
              {(v / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 0, useGrouping: false })}
            </div>
          ))}
        </div>
        <div style={s.footnote}>
          Итого (
          <span style={{ color: activeColor, fontWeight: 700 }}>
            {FINPLAN_MODES.find((m) => m.id === mode).footnoteLabel}
          </span>
          ): <span style={{ color: "#e8eaf0", fontWeight: 700 }}>{formatMoney(grandTotal)}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Основной компонент
// ---------------------------------------------------------------------------

const TABS = [
  { id: "schedule", label: "График производства работ" },
  { id: "estimate", label: "Коммерческая смета" },
  { id: "finplan", label: "План финансирования" },
];

const FinancingPlanDashboardPage = () => {
  const navigate = useNavigate();
  const [categories, setCategories] = useState(null);
  const [categoryKey, setCategoryKey] = useState(null);
  const [objectKey, setObjectKey] = useState(null);
  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [positionKey, setPositionKey] = useState(null);
  const [activeTab, setActiveTab] = useState("schedule");
  const [showPlan, setShowPlan] = useState(true);
  const [showFact, setShowFact] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [finPlanMode, setFinPlanMode] = useState("plan");
  // Галочка "Сводная информация" — своя у каждого объекта: { [objectKey]: true }.
  const [summaryByObject, setSummaryByObject] = useState({});
  const setObjectSummary = (key, checked) => setSummaryByObject((prev) => ({ ...prev, [key]: checked }));
  const summaryOnly = !!summaryByObject[objectKey];
  // Общая сводка по нескольким отмеченным объектам сразу (карточка появляется,
  // когда галочка стоит у 2+ объектов категории).
  const [combinedView, setCombinedView] = useState(false);
  const [combinedPlans, setCombinedPlans] = useState(null);

  // Верхние уровни (категория/объект) — лёгкий эндпоинт, грузится сразу.
  useEffect(() => {
    fetchCategories()
      .then((data) => setCategories(data.categories))
      .catch((err) => setLoadError(err.message || "Не удалось загрузить категории"));
  }, []);

  // Полный финплан объекта (смета + ГПР — дороже) — только когда реально
  // выбрали объект, не раньше.
  useEffect(() => {
    if (!objectKey) return;
    setPlan(null);
    fetchFinancingPlan(objectKey)
      .then(setPlan)
      .catch((err) => setLoadError(err.message || "Не удалось загрузить финплан"));
  }, [objectKey]);

  const category = useMemo(
    () => (categories ? categories.find((c) => c.key === categoryKey) : null),
    [categories, categoryKey]
  );
  const objectSummary = useMemo(
    () => (category ? category.objects.find((o) => o.key === objectKey) : null),
    [category, objectKey]
  );

  const selectedObjects = useMemo(
    () => (category ? category.objects.filter((o) => summaryByObject[o.key]) : []),
    [category, summaryByObject]
  );
  const selectedAgg = useMemo(
    () => ({
      buildings_count: selectedObjects.reduce((sum, o) => sum + o.buildings_count, 0),
      apartments_count: selectedObjects.reduce((sum, o) => sum + o.apartments_count, 0),
      apartments_area_m2: selectedObjects.reduce((sum, o) => sum + o.apartments_area_m2, 0),
      commercial_area_m2: selectedObjects.reduce((sum, o) => sum + o.commercial_area_m2, 0),
    }),
    [selectedObjects]
  );
  const combinedTitle = selectedObjects.map((o) => o.name).join(" + ");

  // Финпланы всех отмеченных объектов — только когда открыли общую сводку
  // (каждый запрос дорогой: смета + пересинк ГПР).
  const combinedKeys = combinedView ? selectedObjects.map((o) => o.key).join(",") : "";
  useEffect(() => {
    if (!combinedKeys) return;
    setCombinedPlans(null);
    Promise.all(combinedKeys.split(",").map(fetchFinancingPlan))
      .then(setCombinedPlans)
      .catch((err) => setLoadError(err.message || "Не удалось загрузить финплан"));
  }, [combinedKeys]);

  // Разделы всех позиций всех отмеченных объектов, сведённые по названию —
  // так же, как сводная по одному объекту, только позиций больше. Ключи
  // позиций с префиксом объекта, чтобы одинаковые номера не склеились.
  const combined = useMemo(() => {
    if (!combinedPlans) return null;
    const positions = {};
    for (const p of combinedPlans) {
      for (const [key, pos] of Object.entries(p.positions)) positions[`${p.object}:${key}`] = pos;
    }
    const sections = aggregateSectionsByName(positions);
    return {
      total: combinedPlans.reduce((sum, p) => sum + p.total, 0),
      sections,
      timeline: buildTimeline(sections),
      finish: computeFinishSummary(sections),
      // Самые старые из данных объектов — сводная не свежее их.
      builtAt: combinedPlans.map((p) => p.built_at).filter(Boolean).sort()[0] || null,
    };
  }, [combinedPlans]);

  const position = useMemo(
    () => (plan && positionKey ? plan.positions[positionKey] : null),
    [plan, positionKey]
  );
  const timeline = useMemo(() => (position ? buildTimeline(position.sections) : []), [position]);
  const positionSummary = useMemo(() => (position ? computeFinishSummary(position.sections) : null), [position]);

  // Агрегированные разделы по объекту целиком (сумма по всем позициям) —
  // для графика/сметы/финплана прямо на уровне объекта, без захода в
  // конкретную позицию.
  const objectSections = useMemo(
    () => (plan && objectKey && !positionKey ? aggregateSectionsByName(plan.positions) : []),
    [plan, objectKey, positionKey]
  );
  const objectTimeline = useMemo(() => buildTimeline(objectSections), [objectSections]);
  const objectFinishSummary = useMemo(() => computeFinishSummary(objectSections), [objectSections]);

  const selectCategory = (key) => {
    setCategoryKey(key);
    setObjectKey(null);
    setPlan(null);
    setPositionKey(null);
    setCombinedView(false);
  };
  const selectObject = (key) => {
    setObjectKey(key);
    setPositionKey(null);
    setCombinedView(false);
  };
  const openCombined = () => {
    setObjectKey(null);
    setPositionKey(null);
    setCombinedView(true);
  };
  const selectPosition = (key) => {
    setPositionKey(key);
    setActiveTab("schedule");
  };
  const openObjectSummary = () => {
    setPositionKey(null);
    setObjectSummary(objectKey, true);
  };

  // Полоса переключения: у объекта — "Сводная" + его позиции; у общей
  // сводки по нескольким объектам — "Сводная" + сами объекты (клик ведёт в
  // сводную этого объекта, его галочка уже стоит).
  const objectStrip = () => [
    { key: "summary", label: "Сводная", active: !positionKey, onClick: openObjectSummary },
    ...Object.keys(plan.positions).map((key) => ({
      key,
      label: key,
      active: key === positionKey,
      onClick: () => setPositionKey(key),
    })),
  ];
  const combinedStrip = () => [
    { key: "summary", label: "Сводная", active: true, onClick: () => {} },
    ...selectedObjects.map((o) => ({ key: o.key, label: o.name, active: false, onClick: () => selectObject(o.key) })),
  ];

  // Экран деталей — общий для сводной по объекту, для позиции и для общей
  // сводки по нескольким объектам: заголовок с цифрами, полоса переключения
  // (вкладка и галочки при переключении сохраняются — в отличие от входа с
  // карточки, см. selectPosition), вкладки.
  const renderDetail = ({ title, total, finish, sections, timeline: tl, apartmentsArea, commercialArea, strip, builtAt }) => (
    <>
      <div style={s.detailHeader}>
        <div>
          <div style={s.detailTitle}>{title}</div>
          {/* Данные не живые — пересчитываются ночью или кнопкой в админ-панели
              (services/financing-api/plan_cache.py). */}
          {builtAt && (
            <div style={s.builtAt}>
              Данные на {new Date(builtAt).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "short", timeStyle: "short" })}
            </div>
          )}
        </div>
        <FinishStats total={total} finish={finish} />
      </div>

      <div style={s.posStrip}>
        {strip.map((item) => (
          <button key={item.key} style={s.posChip(item.active)} onClick={item.onClick}>
            {item.label}
          </button>
        ))}
      </div>

      <div style={s.tabsRow}>
        <div style={s.tabs}>
          {TABS.map((t) => (
            <button key={t.id} style={s.tabBtn(activeTab === t.id)} onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {activeTab === "schedule" && (
          <GanttToggles
            layers={[
              { label: "План", color: PLAN_COLOR, checked: showPlan, onChange: setShowPlan },
              { label: "Факт", color: FACT_COLOR, checked: showFact, onChange: setShowFact },
              { label: "Прогноз", color: FORECAST_COLOR, checked: showForecast, onChange: setShowForecast },
            ]}
          />
        )}
        {activeTab === "finplan" && <FinPlanModeToggles mode={finPlanMode} onModeChange={setFinPlanMode} />}
      </div>

      {activeTab === "schedule" && (
        <GanttTable
          sections={sections}
          timeline={tl}
          showPlan={showPlan}
          showFact={showFact}
          showForecast={showForecast}
        />
      )}
      {activeTab === "estimate" && (
        <EstimateView
          sections={sections}
          total={total}
          apartmentsArea={apartmentsArea}
          commercialArea={commercialArea}
        />
      )}
      {activeTab === "finplan" && <FinPlanTable sections={sections} timeline={tl} mode={finPlanMode} />}
    </>
  );

  return (
    <div style={s.page}>
      <div style={s.topBar}>
        <button style={s.back} onClick={() => navigate("/reports-dashboard")}>← На главный экран</button>
        <h2 style={s.title}>Финплан</h2>
        <div style={{ width: 90 }} />
      </div>

      <div style={s.container}>
        {loadError && <div style={s.centerNote}>Ошибка загрузки: {loadError}</div>}
        {!categories && !loadError && <div style={s.centerNote}>Загрузка категорий…</div>}

        {categories && (
          <>
            <div style={s.breadcrumb}>
              <button
                style={categoryKey ? s.crumbBtn : { ...s.crumbBtn, ...s.crumbCurrent }}
                onClick={() => selectCategory(null)}
              >
                Все категории
              </button>
              {category && (
                <>
                  <span>/</span>
                  <button
                    style={objectKey || combinedView ? s.crumbBtn : { ...s.crumbBtn, ...s.crumbCurrent }}
                    onClick={() => selectObject(null)}
                  >
                    {category.name}
                  </button>
                </>
              )}
              {combinedView && (
                <>
                  <span>/</span>
                  <span style={s.crumbCurrent}>Сводная: {combinedTitle}</span>
                </>
              )}
              {objectSummary && (
                <>
                  <span>/</span>
                  <button
                    style={positionKey ? s.crumbBtn : { ...s.crumbBtn, ...s.crumbCurrent }}
                    onClick={() => selectPosition(null)}
                  >
                    {objectSummary.name}
                  </button>
                </>
              )}
              {position && (
                <>
                  <span>/</span>
                  <span style={s.crumbCurrent}>Поз.{positionKey}</span>
                </>
              )}
            </div>

            {!category && (
              <div style={s.grid}>
                {categories.map((cat) => (
                  <AggregateCard key={cat.key} title={cat.name} agg={cat} onClick={() => selectCategory(cat.key)} />
                ))}
              </div>
            )}

            {category && !objectSummary && !combinedView && (
              <div style={s.grid}>
                {category.objects.map((obj) => (
                  <AggregateCard
                    key={obj.key}
                    title={obj.name}
                    agg={obj}
                    onClick={() => selectObject(obj.key)}
                    summaryToggle={{
                      checked: !!summaryByObject[obj.key],
                      onChange: (checked) => setObjectSummary(obj.key, checked),
                    }}
                  />
                ))}
                {selectedObjects.length >= 2 && (
                  <AggregateCard title={`Сводная: ${combinedTitle}`} agg={selectedAgg} onClick={openCombined} />
                )}
              </div>
            )}

            {category && combinedView && selectedObjects.length >= 2 && !combined && !loadError && (
              <div style={s.centerNote}>Загрузка данных из сметы и ГПР…</div>
            )}

            {category &&
              combinedView &&
              selectedObjects.length >= 2 &&
              combined &&
              renderDetail({
                title: `Сводная: ${combinedTitle}`,
                total: combined.total,
                finish: combined.finish,
                sections: combined.sections,
                timeline: combined.timeline,
                apartmentsArea: selectedAgg.apartments_area_m2,
                commercialArea: selectedAgg.commercial_area_m2,
                strip: combinedStrip(),
                builtAt: combined.builtAt,
              })}

            {objectSummary && !plan && !loadError && (
              <div style={s.centerNote}>Загрузка данных из сметы и ГПР…</div>
            )}

            {objectSummary && plan && !position && (
              <>
                {summaryOnly ? (
                  renderDetail({
                    title: `${plan.name} — сводная информация`,
                    total: plan.total,
                    finish: objectFinishSummary,
                    sections: objectSections,
                    timeline: objectTimeline,
                    apartmentsArea: objectSummary.apartments_area_m2,
                    commercialArea: objectSummary.commercial_area_m2,
                    strip: objectStrip(),
                    builtAt: plan.built_at,
                  })
                ) : (
                  <div style={s.grid}>
                    {Object.entries(plan.positions).map(([key, pos]) => (
                      <StatCard
                        key={key}
                        title={`Поз.${key}`}
                        description={pos.description}
                        total={pos.total}
                        finish={computeFinishSummary(pos.sections)}
                        onClick={() => selectPosition(key)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {position &&
              renderDetail({
                title: `${plan.name} — поз.${positionKey}`,
                total: position.total,
                finish: positionSummary,
                sections: position.sections,
                timeline,
                apartmentsArea: position.apartments_area_m2,
                commercialArea: (position.commercial_floor1_area_m2 || 0) + (position.commercial_basement_area_m2 || 0),
                strip: objectStrip(),
                builtAt: plan.built_at,
              })}
          </>
        )}
      </div>
    </div>
  );
};

export default FinancingPlanDashboardPage;
