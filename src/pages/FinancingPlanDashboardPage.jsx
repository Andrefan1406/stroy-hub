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

// ---------------------------------------------------------------------------
// Работа с реальными датами разделов (вместо фиксированного окна в макете)
// ---------------------------------------------------------------------------

function parseISO(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return { year: y, month: m - 1 };
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

  const months = [];
  let { year, month } = min;
  while (year < max.year || (year === max.year && month <= max.month)) {
    months.push({ year, monthIndex: month, label: MONTHS_RU[month] });
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }
  return months;
}

function monthIndexOf(timeline, dateStr) {
  if (!dateStr) return -1;
  const { year, month } = parseISO(dateStr);
  return timeline.findIndex((t) => t.year === year && t.monthIndex === month);
}

function todayIndex(timeline) {
  const now = new Date();
  return timeline.findIndex((t) => t.year === now.getFullYear() && t.monthIndex === now.getMonth());
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
          fact_start: null,
          fact_end: null,
          fact_as_of: null,
          weightedFactSum: 0,
          factWeight: 0,
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
      if (sec.fact_start && (!agg.fact_start || sec.fact_start < agg.fact_start)) agg.fact_start = sec.fact_start;
      if (sec.fact_end && (!agg.fact_end || sec.fact_end > agg.fact_end)) agg.fact_end = sec.fact_end;
      if (sec.fact_as_of && (!agg.fact_as_of || sec.fact_as_of > agg.fact_as_of)) agg.fact_as_of = sec.fact_as_of;
      if (sec.fact_percent != null && sec.cost != null) {
        agg.weightedFactSum += sec.cost * sec.fact_percent;
        agg.factWeight += sec.cost;
        if (sec.fact_percent > 0) agg.anyStarted = true;
      }
      if (!sec.fact_completed) agg.allCompleted = false;
    }
  }

  return Array.from(byName.values()).map((agg) => {
    const factPercent = agg.factWeight > 0 ? agg.weightedFactSum / agg.factWeight : null;
    return {
      name: agg.name,
      cost: agg.cost,
      start: agg.start,
      end: agg.end,
      forecast_start: agg.forecast_start,
      forecast_end: agg.forecast_end,
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

// Какая доля (0..1) месяца i закрашивается фактом — % готовности считаем
// равномерно распределённым по плановой длительности раздела (реальных
// понедельных отметок по каждому месяцу у нас на фронте нет, только
// итоговый %), поэтому это приближение, а не точная посуточная картина.
function factFillFraction(startIdx, endIdx, factPercent, i) {
  if (factPercent == null || i < startIdx || i > endIdx) return 0;
  const totalMonths = endIdx - startIdx + 1;
  const factMonths = totalMonths * (factPercent / 100);
  const posInRun = i - startIdx;
  if (posInRun < Math.floor(factMonths)) return 1;
  if (posInRun === Math.floor(factMonths)) return factMonths - Math.floor(factMonths);
  return 0;
}

// Где и как рисовать полосу "Прогноз" для раздела — возвращает Map<monthIndex,
// {left, width, roundLeft, roundRight}> (доли 0..1 внутри ячейки месяца).
//
// Три случая:
// - Завершён (fact% >= 100) — прогнозировать нечего, полосы нет вообще.
// - В процессе (0 < fact% < 100) — прогноз стыкуется ВПЛОТНУЮ к концу уже
//   нарисованной полосы факта (та же точка, что даёт factFillFraction,
//   с точностью до доли месяца, а не только до месяца целиком), левый край
//   всегда квадратный (шов, не начало отрезка), скруглён только правый —
//   у истинного конца прогноза.
// - Ещё не начат — целиком фактических данных нет, весь отрезок (со сдвигом
//   от предыдущих разделов, вперёд ИЛИ назад — опережение плана тоже
//   возможно) просто переносится из forecast_start/forecast_end как есть,
//   с обычными скруглёнными краями с обеих сторон.
function computeForecastOverlay(sec, timeline) {
  if (!sec.forecast_end) return new Map();
  const percent = sec.fact_percent;
  const isCompleted = percent != null && percent >= 100;
  if (isCompleted) return new Map();

  const forecastEndIdx = monthIndexOf(timeline, sec.forecast_end);
  if (forecastEndIdx === -1) return new Map();

  const cells = new Map();
  const isInProgress = percent != null && percent > 0;

  if (isInProgress) {
    const startIdx = monthIndexOf(timeline, sec.start);
    const endIdx = monthIndexOf(timeline, sec.end);
    const totalMonths = endIdx - startIdx + 1;
    const factMonths = totalMonths * (percent / 100);
    const joinContinuous = startIdx + factMonths;
    const joinCell = Math.floor(joinContinuous);
    const joinFrac = joinContinuous - joinCell;
    if (joinCell > forecastEndIdx) return cells; // защита от аномальных данных
    for (let i = joinCell; i <= forecastEndIdx; i++) {
      const left = i === joinCell ? joinFrac : 0;
      cells.set(i, { left, width: 1 - left, roundLeft: false, roundRight: i === forecastEndIdx });
    }
  } else if (sec.forecast_start) {
    const forecastStartIdx = monthIndexOf(timeline, sec.forecast_start);
    if (forecastStartIdx === -1) return cells;
    for (let i = forecastStartIdx; i <= forecastEndIdx; i++) {
      cells.set(i, { left: 0, width: 1, roundLeft: i === forecastStartIdx, roundRight: i === forecastEndIdx });
    }
  }
  return cells;
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

const s = {
  page: {
    minHeight: "100vh",
    background: "#0b0d12",
    color: "#e8eaf0",
    fontFamily: "'Segoe UI', Roboto, -apple-system, sans-serif",
    padding: "24px 20px 60px",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    maxWidth: 1180,
    margin: "0 auto 20px",
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
    marginBottom: 22,
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

  detailHeader: {
    background: "#171a21",
    border: "1px solid #242835",
    borderRadius: 14,
    padding: "22px 24px",
    marginBottom: 20,
  },
  detailTitle: { fontSize: 20, fontWeight: 700, marginBottom: 10 },
  subheading: { fontSize: 16, fontWeight: 700, margin: "28px 0 14px" },
  detailStats: { display: "flex", gap: 32, flexWrap: "wrap" },
  statLabel: { fontSize: 12, color: "#9aa0b4" },
  statValue: { fontSize: 18, fontWeight: 700, marginTop: 2 },

  tabs: { display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" },
  tabBtn: (active) => ({
    background: active ? ACCENT : "transparent",
    border: active ? "none" : "1px solid #242835",
    color: active ? "#0b0d12" : "#9aa0b4",
    fontWeight: active ? 700 : 500,
    borderRadius: 10,
    padding: "10px 18px",
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
  // Без строки с датами под названием — компактнее по высоте (см. GanttTable).
  tdFirstCompact: {
    position: "sticky",
    left: 0,
    background: "#171a21",
    padding: "6px 12px",
    borderBottom: "1px solid #1e222b",
    minWidth: 220,
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
  ganttTd: { padding: "6px 0", textAlign: "center", borderBottom: "1px solid #1e222b", whiteSpace: "nowrap" },
  // Меньше шрифт и паддинг, чем у обычного s.td — суммы по объекту целиком
  // (агрегат по 9 позициям) четырёхзначные, при 20+ месяцах в строке
  // обычный размер не помещается в колонку и обрезается многоточием.
  finplanNum: { fontSize: 10, padding: "10px 1px" },
  ganttBarWrap: { position: "relative", height: 18 },
  ganttBar: { background: PLAN_COLOR, height: 18 },
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

function GanttTable({
  sections,
  timeline,
  showPlan,
  onTogglePlan,
  showFact,
  onToggleFact,
  showForecast,
  onToggleForecast,
}) {
  const dated = sections.filter((sec) => sec.start && sec.end);
  const today = todayIndex(timeline);
  // minmax(0, 1fr), а не просто 1fr — иначе колонки не сжимались бы уже
  // родного min-content подписи месяца, и таблица всё равно бы поехала
  // вбок при большом числе месяцев.
  const gridTemplateColumns = `220px repeat(${timeline.length}, minmax(0, 1fr))`;

  return (
    <div>
      <div style={{ display: "flex", gap: 20, marginBottom: 12 }}>
        <label style={s.factToggle(PLAN_COLOR)}>
          <input
            type="checkbox"
            style={s.factCheckbox(PLAN_COLOR)}
            checked={showPlan}
            onChange={(e) => onTogglePlan(e.target.checked)}
          />
          План
        </label>
        <label style={s.factToggle(FACT_COLOR)}>
          <input
            type="checkbox"
            style={s.factCheckbox(FACT_COLOR)}
            checked={showFact}
            onChange={(e) => onToggleFact(e.target.checked)}
          />
          Факт
        </label>
        <label style={s.factToggle(FORECAST_COLOR)}>
          <input
            type="checkbox"
            style={s.factCheckbox(FORECAST_COLOR)}
            checked={showForecast}
            onChange={(e) => onToggleForecast(e.target.checked)}
          />
          Прогноз
        </label>
      </div>
      <div style={s.tableWrap}>
        <div style={{ display: "grid", gridTemplateColumns }}>
          <div style={{ ...s.th, ...s.thFirst }}>Раздел работ</div>
          {timeline.map((m, i) => (
            <div key={i} style={{ ...s.th, ...(i === today ? s.todayCol : {}) }}>
              {m.label}
              {m.monthIndex === 0 ? ` ${String(m.year).slice(2)}` : ""}
            </div>
          ))}

          {dated.map((sec) => {
            const startIdx = monthIndexOf(timeline, sec.start);
            const endIdx = monthIndexOf(timeline, sec.end);
            const forecastCells = showForecast ? computeForecastOverlay(sec, timeline) : new Map();

            return (
              <React.Fragment key={sec.name}>
                <div style={s.tdFirstCompact}>{sec.name}</div>
                {timeline.map((_, i) => {
                  const active = i >= startIdx && i <= endIdx;
                  const isRunStart = active && i === startIdx;
                  const isRunEnd = active && i === endIdx;
                  const radius = `${isRunStart ? 9 : 0}px ${isRunEnd ? 9 : 0}px ${isRunEnd ? 9 : 0}px ${
                    isRunStart ? 9 : 0
                  }px`;
                  const fillFrac = showFact ? factFillFraction(startIdx, endIdx, sec.fact_percent, i) : 0;
                  const factReachesEnd = sec.fact_percent >= 100 && i === endIdx;
                  const factRadius = `${isRunStart ? 9 : 0}px ${factReachesEnd ? 9 : 0}px ${
                    factReachesEnd ? 9 : 0
                  }px ${isRunStart ? 9 : 0}px`;

                  const forecastCell = forecastCells.get(i);
                  const forecastRadius = forecastCell
                    ? `${forecastCell.roundLeft ? 9 : 0}px ${forecastCell.roundRight ? 9 : 0}px ${
                        forecastCell.roundRight ? 9 : 0
                      }px ${forecastCell.roundLeft ? 9 : 0}px`
                    : "0";

                  return (
                    <div key={i} style={{ ...s.ganttTd, ...(i === today ? s.todayCol : {}) }}>
                      {(active || forecastCell) && (
                        <div style={s.ganttBarWrap}>
                          {active && showPlan && <div style={{ ...s.ganttBar, borderRadius: radius }} />}
                          {active && fillFrac > 0 && (
                            <div
                              style={{ ...s.ganttFactBar, width: `${fillFrac * 100}%`, borderRadius: factRadius }}
                            />
                          )}
                          {forecastCell && (
                            <div
                              style={{
                                ...s.ganttForecastBar,
                                left: `${forecastCell.left * 100}%`,
                                width: `${forecastCell.width * 100}%`,
                                borderRadius: forecastRadius,
                              }}
                            />
                          )}
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
// - "fact"     — план с учётом факта, но только прошедшее: сколько реально
//                освоено (cost * fact% / 100), размазано по факт.старту..сегодня
//                (или факт.концу, если завершён раньше сегодня). Разделы, где
//                работы ещё не начинались — не участвуют, показывать нечего.
// - "forecast" — разница план/факт, но только будущее: остаток (cost * (1 -
//                fact%/100)), размазан от "сейчас" (as_of для начатых, сдвинутый
//                план для ещё не начатых) до forecast_end. Завершённые разделы
//                не участвуют — остатка нет.
function sectionMonthlyRange(mode, sec, timeline, todayIdx) {
  if (mode === "plan") {
    const startIdx = monthIndexOf(timeline, sec.start);
    const endIdx = monthIndexOf(timeline, sec.end);
    if (startIdx === -1 || endIdx === -1) return null;
    return { startIdx, endIdx, amount: sec.cost };
  }

  if (mode === "fact") {
    if (!sec.fact_percent || sec.fact_percent <= 0 || !sec.fact_start) return null;
    const earned = sec.cost * (sec.fact_percent / 100);
    const startIdx = monthIndexOf(timeline, sec.fact_start);
    if (startIdx === -1) return null;
    let endIdx =
      sec.fact_completed && sec.fact_end ? monthIndexOf(timeline, sec.fact_end) : todayIdx !== -1 ? todayIdx : startIdx;
    if (todayIdx !== -1) endIdx = Math.min(endIdx, todayIdx); // в будущее "факт" не заходит
    if (endIdx === -1 || endIdx < startIdx) endIdx = startIdx;
    return { startIdx, endIdx, amount: earned };
  }

  if (mode === "forecast") {
    if (!sec.forecast_end) return null;
    const percent = sec.fact_percent;
    if (percent != null && percent >= 100) return null; // завершён — остатка нет
    const remaining = sec.cost * (1 - (percent || 0) / 100);
    if (remaining <= 0) return null;
    const rawStart = percent != null && percent > 0 ? sec.fact_as_of : sec.forecast_start;
    if (!rawStart) return null;
    let startIdx = monthIndexOf(timeline, rawStart);
    const endIdx = monthIndexOf(timeline, sec.forecast_end);
    if (startIdx === -1 || endIdx === -1) return null;
    if (todayIdx !== -1 && startIdx <= todayIdx) startIdx = todayIdx + 1; // в прошлое "прогноз" не заходит
    if (startIdx > endIdx) return null;
    return { startIdx, endIdx, amount: remaining };
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

function FinPlanTable({ sections, timeline, mode, onModeChange }) {
  const today = todayIndex(timeline);
  const rows = sections
    .map((sec) => ({ sec, range: sectionMonthlyRange(mode, sec, timeline, today) }))
    .filter((r) => r.range);

  const monthly = timeline.map((_, i) =>
    rows.reduce((sum, { range }) => {
      if (i < range.startIdx || i > range.endIdx) return sum;
      const dur = range.endIdx - range.startIdx + 1;
      return sum + range.amount / dur;
    }, 0)
  );
  const grandTotal = monthly.reduce((a, b) => a + b, 0);
  const gridTemplateColumns = `220px repeat(${timeline.length}, minmax(0, 1fr))`;
  const activeColor = FINPLAN_MODES.find((m) => m.id === mode).color;

  return (
    <div>
      <div style={{ display: "flex", gap: 20, marginBottom: 12 }}>
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
      <div style={s.tableWrap}>
        <div style={{ display: "grid", gridTemplateColumns }}>
          <div style={{ ...s.th, ...s.thFirst }}>Раздел работ</div>
          {timeline.map((m, i) => (
            <div key={i} style={{ ...s.th, ...(i === today ? s.todayCol : {}) }}>
              {m.label}
              {m.monthIndex === 0 ? ` ${String(m.year).slice(2)}` : ""}
            </div>
          ))}

          {rows.map(({ sec, range }) => (
            <React.Fragment key={sec.name}>
              <div style={s.tdFirst}>{sec.name}</div>
              {timeline.map((_, i) => {
                const active = i >= range.startIdx && i <= range.endIdx;
                const dur = range.endIdx - range.startIdx + 1;
                const perMonth = range.amount / dur;
                return (
                  <div key={i} style={{ ...s.td, ...s.finplanNum, ...(i === today ? s.todayCol : {}) }}>
                    {active
                      ? (perMonth / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 0, useGrouping: false })
                      : "—"}
                  </div>
                );
              })}
            </React.Fragment>
          ))}

          <div style={{ ...s.tdFirst, fontWeight: 700, background: "#1c2029" }}>Итого за месяц, млн ₸</div>
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
  const [summaryOnly, setSummaryOnly] = useState(false);

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
  };
  const selectObject = (key) => {
    setObjectKey(key);
    setPositionKey(null);
  };
  const selectPosition = (key) => {
    setPositionKey(key);
    setActiveTab("schedule");
  };

  return (
    <div style={s.page}>
      <div style={s.topBar}>
        <button style={s.back} onClick={() => navigate("/reports-dashboard")}>← На главный экран</button>
        <h2 style={s.title}>Финплан объекта</h2>
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
                    style={objectKey ? s.crumbBtn : { ...s.crumbBtn, ...s.crumbCurrent }}
                    onClick={() => selectObject(null)}
                  >
                    {category.name}
                  </button>
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

            {category && !objectSummary && (
              <div style={s.grid}>
                {category.objects.map((obj) => (
                  <AggregateCard
                    key={obj.key}
                    title={obj.name}
                    agg={obj}
                    onClick={() => selectObject(obj.key)}
                    summaryToggle={{ checked: summaryOnly, onChange: setSummaryOnly }}
                  />
                ))}
              </div>
            )}

            {objectSummary && !plan && !loadError && (
              <div style={s.centerNote}>Загрузка данных из сметы и ГПР…</div>
            )}

            {objectSummary && plan && !position && (
              <>
                {summaryOnly ? (
                  <>
                    <div style={s.detailHeader}>
                      <div style={s.detailTitle}>{plan.name} — сводная информация</div>
                      <div style={s.detailStats}>
                        <div>
                          <div style={s.statLabel}>Общая стоимость (план)</div>
                          <div style={s.statValue}>{formatMoney(plan.total)}</div>
                        </div>
                        {objectFinishSummary && (
                          <>
                            <div>
                              <div style={s.statLabel}>Окончание по плану</div>
                              <div style={{ ...s.statValue, color: PLAN_COLOR }}>{objectFinishSummary.planFinish}</div>
                            </div>
                            <div>
                              <div style={s.statLabel}>Окончание по прогнозу</div>
                              <div style={{ ...s.statValue, color: FORECAST_COLOR }}>
                                {objectFinishSummary.factFinish || "—"}
                              </div>
                            </div>
                            <div>
                              <div style={s.statLabel}>Отставание от плана</div>
                              <div
                                style={{
                                  ...s.statValue,
                                  color:
                                    objectFinishSummary.delayDays > 0
                                      ? FORECAST_COLOR
                                      : objectFinishSummary.delayDays < 0
                                      ? FACT_COLOR
                                      : "#e8eaf0",
                                }}
                              >
                                {objectFinishSummary.delayDays > 0
                                  ? `+${objectFinishSummary.delayDays} дн.`
                                  : objectFinishSummary.delayDays < 0
                                  ? `${objectFinishSummary.delayDays} дн.`
                                  : "0 дн."}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    <div style={s.tabs}>
                      {TABS.map((t) => (
                        <button key={t.id} style={s.tabBtn(activeTab === t.id)} onClick={() => setActiveTab(t.id)}>
                          {t.label}
                        </button>
                      ))}
                    </div>

                    {activeTab === "schedule" && (
                      <GanttTable
                        sections={objectSections}
                        timeline={objectTimeline}
                        showPlan={showPlan}
                        onTogglePlan={setShowPlan}
                        showFact={showFact}
                        onToggleFact={setShowFact}
                        showForecast={showForecast}
                        onToggleForecast={setShowForecast}
                      />
                    )}
                    {activeTab === "estimate" && (
                      <EstimateView
                        sections={objectSections}
                        total={plan.total}
                        apartmentsArea={objectSummary.apartments_area_m2}
                        commercialArea={objectSummary.commercial_area_m2}
                      />
                    )}
                    {activeTab === "finplan" && (
                      <FinPlanTable
                        sections={objectSections}
                        timeline={objectTimeline}
                        mode={finPlanMode}
                        onModeChange={setFinPlanMode}
                      />
                    )}
                  </>
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

            {position && (
              <>
                <div style={s.detailHeader}>
                  <div style={s.detailTitle}>{plan.name} — поз.{positionKey}</div>
                  <div style={s.detailStats}>
                    <div>
                      <div style={s.statLabel}>Общая стоимость (план)</div>
                      <div style={s.statValue}>{formatMoney(position.total)}</div>
                    </div>
                    {positionSummary && (
                      <>
                        <div>
                          <div style={s.statLabel}>Окончание по плану</div>
                          <div style={{ ...s.statValue, color: PLAN_COLOR }}>{positionSummary.planFinish}</div>
                        </div>
                        <div>
                          <div style={s.statLabel}>Окончание по прогнозу</div>
                          <div style={{ ...s.statValue, color: FORECAST_COLOR }}>
                            {positionSummary.factFinish || "—"}
                          </div>
                        </div>
                        <div>
                          <div style={s.statLabel}>Отставание от плана</div>
                          <div
                            style={{
                              ...s.statValue,
                              color:
                                positionSummary.delayDays > 0
                                  ? FORECAST_COLOR
                                  : positionSummary.delayDays < 0
                                  ? FACT_COLOR
                                  : "#e8eaf0",
                            }}
                          >
                            {positionSummary.delayDays > 0
                              ? `+${positionSummary.delayDays} дн.`
                              : positionSummary.delayDays < 0
                              ? `${positionSummary.delayDays} дн.`
                              : "0 дн."}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div style={s.tabs}>
                  {TABS.map((t) => (
                    <button key={t.id} style={s.tabBtn(activeTab === t.id)} onClick={() => setActiveTab(t.id)}>
                      {t.label}
                    </button>
                  ))}
                </div>

                {activeTab === "schedule" && (
                  <GanttTable
                    sections={position.sections}
                    timeline={timeline}
                    showPlan={showPlan}
                    onTogglePlan={setShowPlan}
                    showFact={showFact}
                    onToggleFact={setShowFact}
                    showForecast={showForecast}
                    onToggleForecast={setShowForecast}
                  />
                )}
                {activeTab === "estimate" && (
                  <EstimateView
                    sections={position.sections}
                    total={position.total}
                    apartmentsArea={position.apartments_area_m2}
                    commercialArea={(position.commercial_floor1_area_m2 || 0) + (position.commercial_basement_area_m2 || 0)}
                  />
                )}
                {activeTab === "finplan" && (
                  <FinPlanTable
                    sections={position.sections}
                    timeline={timeline}
                    mode={finPlanMode}
                    onModeChange={setFinPlanMode}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default FinancingPlanDashboardPage;
