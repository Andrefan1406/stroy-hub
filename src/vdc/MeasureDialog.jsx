// Окно обмера: лист PDF с чертежом и инструмент замеров из подсчёта объёмов (src/takeoff). Пользователь
// калибрует лист (по размеру на чертеже или по масштабу), обводит линией плинтус или стены, отмечает проёмы
// (они вычитаются) и получает длину или площадь. Shift при обводке — полярное отслеживание по углам.
// Окно измеряет ОДНУ задачу для одной квартиры типа — значение потом подставляется во все квартиры этого типа.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import TakeoffCanvas from "../takeoff/TakeoffCanvas";
import { distance, metersPerUnitFromDistance, metersPerUnitFromScale, polylineLength } from "../takeoff/model";
import { POLAR_STEPS } from "../takeoff/polar";
import { findAxisRows } from "./plan";
import { OPENING_TYPES, RISER_HEIGHT_M, parseManual, suggestScale, taskTotal } from "./measure";
import { doorsInContour, DOOR_CATEGORIES, pointInPolygon, summarizeDoors } from "./doors";
import { elementsInContour } from "./extraWorks";

const SCALES = [20, 25, 50, 75, 100, 150, 200, 250, 500];
const fmt = (v) => Number(v).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export default function MeasureDialog({
  doc, numPages, task, flatsHint, initialPage, itemsOf, lines, onLinesChange, calibrations, onCalibrate, height, onHeightChange, onClose, doorDirectory,
}) {
  const [pageNo, setPageNo] = useState(String(initialPage || 1));
  const [mode, setMode] = useState(task.kind === "doors" || task.kind === "stairarea" || task.kind === "stairunder" || task.kind === "steps" || task.kind === "platform" ? "contour" : "select"); // select | line | rect | opening | calibrate | contour | vent | hole
  const [selectedId, setSelectedId] = useState(null);
  const [calibPoints, setCalibPoints] = useState(null);
  const [calibMeters, setCalibMeters] = useState("");
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [polarStep, setPolarStep] = useState(45); // шаг угла при зажатом Shift
  const [openingType, setOpeningType] = useState("door");
  const [openingHeight, setOpeningHeight] = useState(OPENING_TYPES.door.height);

  const page = Number(pageNo);
  const pageValid = Number.isInteger(page) && page >= 1 && page <= numPages;
  const mpu = pageValid ? calibrations[page] || null : null;
  const isWalls = task.kind === "walls" || task.kind === "box"; // короб из гипсокартона измеряется как стены: длина × высота
  const isSteps = task.kind === "steps"; // марш: контур одной ступени и число ступеней
  const isPlatform = task.kind === "platform"; // площадка: площадь контуром и плинтус из того же обмера
  const isStairArea = task.kind === "stairarea" || task.kind === "stairunder" || isSteps || isPlatform; // площадь пола лестницы: замкнутые контуры маршей и площадок
  const isRisers = task.kind === "risers"; // подступенки лестницы: линия по ширине ступени × число ступеней × 0,15 м
  const isDoors = task.kind === "doors"; // подсчёт дверей по контуру квартиры: калибровка и масштаб не нужны

  // предложение масштаба по размеру между крайними осями — пользователь подтверждает
  const suggestion = useMemo(() => {
    if (!pageValid) return null;
    const items = itemsOf(page);
    const rows = findAxisRows(items, 0);
    return rows[0] ? suggestScale(items, rows[0].labels) : null;
  }, [page, pageValid, itemsOf]);

  const total = useMemo(() => taskTotal(lines, calibrations, { kind: task.kind, height }), [lines, calibrations, task.kind, height]);
  const pageLines = useMemo(
    () => lines.filter((l) => l.page === page && l.kind !== "point").map((l) => (isDoors ? l : isStairArea ? { ...l, calc: "area" } : isRisers ? { ...l, calc: "wall", height: RISER_HEIGHT_M } : { ...l, calc: isWalls ? "wall" : "length", height: isWalls ? (l.deduct ? l.height : height) : undefined })),
    [lines, page, isWalls, isDoors, isRisers, isStairArea, height],
  );
  const openings = useMemo(() => lines.filter((l) => l.deduct), [lines]);

  // подсчёт дверей по контурам: метки «Д-N» внутри обведённой квартиры
  const foundByLine = useMemo(() => {
    const map = new Map();
    if (!isDoors) return map;
    for (const l of lines) if (l.kind === "area") map.set(l.id, doorsInContour(itemsOf(l.page), l.points, doorDirectory));
    return map;
  }, [isDoors, lines, itemsOf, doorDirectory]);
  const foundAll = useMemo(() => [...foundByLine.values()].flat(), [foundByLine]);
  // окна и балконные блоки внутри контуров; решётки и отверстия — точки, поставленные на плане
  const elementsAll = useMemo(() => {
    const acc = { windows: 0, blocks: 0, found: [] };
    if (!isDoors) return acc;
    for (const l of lines) {
      if (l.kind !== "area") continue;
      const r = elementsInContour(itemsOf(l.page), l.points, pointInPolygon);
      acc.windows += r.windows;
      acc.blocks += r.blocks;
      acc.found.push(...r.found.map((f) => ({ ...f, page: l.page })));
    }
    return acc;
  }, [isDoors, lines, itemsOf]);
  const pointCounts = useMemo(() => ({
    vent: lines.filter((l) => l.kind === "point" && l.what === "vent").length,
    hole: lines.filter((l) => l.kind === "point" && l.what === "hole").length,
  }), [lines]);
  const doorSummary = useMemo(() => summarizeDoors(foundAll), [foundAll]);
  const DOOR_COLORS = { entrance: "#c62828", interior: "#1565c0", group: "#6a1b9a", fire: "#e65100", other: "#777" };
  const doorMarks = useMemo(
    () => (isDoors ? [
      ...lines.filter((l) => l.page === page).flatMap((l) => foundByLine.get(l.id) || []).map((d) => ({
        x: d.x, y: d.y, color: DOOR_COLORS[d.category] || "#777", label: `${d.mark}${d.leaves === 2 ? " (2 ств.)" : ""}`,
      })),
      ...elementsAll.found.filter((f) => f.page === page).map((f) => ({ x: f.x, y: f.y, color: f.kind === "blocks" ? "#ef6c00" : "#00897b", label: f.label })),
      ...lines.filter((l) => l.page === page && l.kind === "point").map((l) => ({ x: l.points[0].x, y: l.points[0].y, color: l.what === "vent" ? "#7b1fa2" : "#455a64", label: l.what === "vent" ? "решётка" : "отверстие" })),
    ] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isDoors, lines, page, foundByLine, elementsAll],
  );

  // подпись линии на холсте: у проёма со знаком «−»
  const labelFor = useCallback((m) => {
    if (isDoors) return `${(foundByLine.get(m.id) || []).length} дв.`;
    const t = taskTotal([m], calibrations, { kind: task.kind, height });
    if (t.uncounted) return "";
    return m.deduct ? `−${fmt(t.deducted)} ${task.unit}` : `${fmt(t.gross)} ${task.unit}`;
  }, [calibrations, task.kind, task.unit, height, isDoors, foundByLine]);

  const onFinish = useCallback(({ kind, points }) => {
    if (isStairArea) {
      if (kind === "area" && mode === "contour") onLinesChange([...lines, { id: newId(), page, kind: "area", points, count: 1 }]);
      else if (kind === "rect" && mode === "rect") {
        // прямоугольник по двум точкам диагонали → контур из четырёх углов (марш или площадка прямоугольной формы)
        const [a, b] = points;
        onLinesChange([...lines, { id: newId(), page, kind: "area", points: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], count: 1 }]);
      }
      return;
    }
    if (isDoors) {
      if (kind === "area" && mode === "contour") onLinesChange([...lines, { id: newId(), page, kind: "area", points, count: 1 }]);
      else if (kind === "point" && (mode === "vent" || mode === "hole")) onLinesChange([...lines, { id: newId(), page, kind: "point", what: mode, points, count: 1 }]);
      return;
    }
    if (kind === "rect" && mode === "rect") {
      // прямоугольник по двум точкам диагонали → замкнутая линия по периметру (4 стороны)
      const [a, b] = points;
      const contour = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
      onLinesChange([...lines, { id: newId(), page, kind: "line", points: contour, count: 1 }]);
      return;
    }
    if (kind !== "line") return;
    if (mode === "line") onLinesChange([...lines, { id: newId(), page, kind: "line", points, count: 1 }]);
    else if (mode === "opening") {
      onLinesChange([...lines, { id: newId(), page, kind: "line", points, count: 1, deduct: true, openingType, height: isWalls ? openingHeight : undefined }]);
    }
  }, [mode, lines, page, onLinesChange, openingType, openingHeight, isWalls, isDoors, isStairArea]);

  const onEdit = useCallback((id, patch) => onLinesChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l))), [lines, onLinesChange]);
  const removeLine = (id) => {
    onLinesChange(lines.filter((l) => l.id !== id));
    setSelectedId(null);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.key === "Delete" && selectedId && mode === "select") removeLine(selectedId);
      if (e.key === "Escape" && !calibPoints) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, mode, calibPoints, lines]);

  const applyCalibration = (e) => {
    e.preventDefault();
    const meters = Number(String(calibMeters).replace(",", "."));
    const k = metersPerUnitFromDistance(distance(calibPoints[0], calibPoints[1]), meters);
    if (!k) {
      setNote("Укажите длину отрезка в метрах — больше нуля.");
      return;
    }
    onCalibrate(page, k);
    setCalibPoints(null);
    setMode("line");
    setNote("");
  };

  const pickOpeningType = (type) => {
    setOpeningType(type);
    setOpeningHeight(OPENING_TYPES[type].height);
  };

  const widthOf = (l) => (mpu && l.page === page ? polylineLength(l.points) * mpu : calibrations[l.page] ? polylineLength(l.points) * calibrations[l.page] : null);

  const toolBtn = (m, label, title) => (
    <button type="button" title={title} onClick={() => { setMode(mode === m ? "select" : m); setNote(""); }} style={mode === m ? { ...s.tool, ...s.toolOn } : s.tool}>
      {label}
    </button>
  );

  return (
    <div style={s.overlay} role="dialog" aria-modal="true" aria-label="Обмер по чертежу">
      <div style={s.panel}>
        <div style={s.top}>
          <div>
            <div style={s.title}>Обмер: {task.label}</div>
            <div style={s.sub}>
              {task.common
                ? `Общие помещения: ${task.roomNo && !task.element ? `${task.roomNo}. ` : ""}${task.roomName} · результат ${task.unit} — подставится на все этажи, где есть это помещение`
                : `Квартира типа ${task.code} · ${task.roomNo}. ${task.roomName} · результат ${task.unit} — подставится во все квартиры этого типа`}
            </div>
          </div>
          <button type="button" onClick={onClose} style={s.done}>Готово</button>
        </div>

        <div style={s.hint}>
          {flatsHint}
          {isDoors
            ? " Обведите контур квартиры на плане (щёлкайте по углам, двойной щелчок или Enter — конец контура). Двери — это метки «Д-N» внутри контура: они подсвечиваются на листе и считаются по категориям и числу створок. Окна «ОК-N» внутри контура считаются так же (балконные блоки «ББ-N» подсвечиваются, но считаются вручную: они бывают с окном и без). Вентиляционные решётки и технологические отверстия отметьте щелчками (кнопки «Вент. решётка» и «Техн. отверстие»). Одного контура на тип квартиры достаточно: результат подставится во все квартиры этого типа."
            : isPlatform
            ? " Обведите площадку контуром или выберите «Прямоугольник» и сделайте два щелчка по противоположным углам. Плинтус считается из этого же обмера: две короткие стороны и одна длинная сторона площадки (по габаритам контура)."
            : isSteps
            ? " Обведите контуром ОДНУ ступень (проступь) или выберите «Прямоугольник» и сделайте два щелчка по противоположным углам ступени. Ниже укажите, сколько ступеней в марше: площадь пола = ступень × число ступеней, подступенков столько же (длинная сторона ступени × 0,15 м на каждую). Плинтус марша считается из этого же обмера: на каждую ступень малая сторона контура + 100 мм (плинтус) + 150 мм (подступенок). Если ступени в марше разной формы — обведите каждую форму отдельно и укажите её количество."
            : isStairArea
            ? " Измерьте пол элемента лестницы: обведите контуром (щёлкайте по углам, двойной щелчок или Enter — конец контура) или, если марш или площадка прямоугольные, выберите «Прямоугольник» и сделайте два щелчка по противоположным углам. Контуров может быть несколько — площади сложатся. Подступенки измеряются отдельной задачей и добавятся к этой площади."
            : isRisers
            ? " Проведите линию по ширине ступени (двумя щелчками поперёк марша) и впишите ниже, сколько таких ступеней на этаже. Если ширина ступеней разная — линий несколько. Площадь подступенков = ширина × число ступеней × 0,15 м; она добавится к площади пола лестничной клетки."
            : isWalls
            ? " Обведите линией стены помещения по периметру (щёлкайте по углам, двойной щелчок или Enter — конец линии) или прямоугольником — двумя щелчками по противоположным углам; площадь = длина × высота от пола до потолка. Двери, окна и другие проёмы отметьте отдельно кнопкой «Проём» — их площадь вычтется."
            : " Обведите линией плинтус вдоль стен (щёлкайте по углам, двойной щелчок или Enter — конец линии). Дверные проёмы можно не обходить, а отметить кнопкой «Проём» — их ширина вычтется. Линий может быть несколько — они сложатся."}
          {!isDoors && ` Удерживайте Shift — линия зафиксируется по углам, кратным ${polarStep}°.`}
        </div>

        <div style={s.bar}>
          <label style={s.row}>
            Лист
            <input type="number" min={1} max={numPages} value={pageNo} onChange={(e) => { setPageNo(e.target.value); setSelectedId(null); }} style={s.num} />
            <span style={s.muted}>из {numPages}</span>
          </label>
          {!isDoors && (<>
          <span style={mpu ? s.ok : s.warn}>{mpu ? "✓ лист откалиброван" : "лист не откалиброван — без этого длины не считаются"}</span>
          {toolBtn("calibrate", "📏 Калибровка по размеру", "Щёлкните по двум концам размера с известной длиной (например, 3200 мм между осями)")}
          <label style={s.row}>
            или масштаб 1:
            <select value="" onChange={(e) => e.target.value && onCalibrate(page, metersPerUnitFromScale(Number(e.target.value)))} style={s.sel}>
              <option value="">—</option>
              {SCALES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          </>)}
        </div>

        <div style={s.bar}>
          {isStairArea ? (
            <>
              {toolBtn("contour", isSteps ? "⬠ Обвести ступень" : "⬠ Обвести марш / площадку", "Щёлкайте по углам; двойной щелчок или Enter — конец контура")}
              {toolBtn("rect", "▭ Прямоугольник", "Два щелчка по противоположным углам — площадь прямоугольного марша или площадки")}
              {toolBtn("select", "✋ Прокрутка / выбор", "Перетаскивание листа; выбор контура — Delete удалит")}
              <button type="button" style={s.tool} disabled={!selectedId} onClick={() => removeLine(selectedId)}>Удалить выбранный</button>
              <button type="button" style={s.tool} disabled={!lines.length} onClick={() => { onLinesChange([]); setSelectedId(null); }}>Очистить всё</button>
            </>
          ) : isDoors ? (
            <>
              {toolBtn("contour", "⬠ Обвести контур квартиры", "Щёлкайте по углам квартиры; двойной щелчок или Enter — конец контура")}
              {toolBtn("vent", "▦ Вент. решётка", "Щелчок по каждой вентиляционной решётке квартиры")}
              {toolBtn("hole", "◉ Техн. отверстие", "Щелчок по каждому технологическому отверстию квартиры")}
              {toolBtn("select", "✋ Прокрутка / выбор", "Перетаскивание листа; выбор контура — Delete удалит")}
              <button type="button" style={s.tool} disabled={!selectedId} onClick={() => removeLine(selectedId)}>Удалить выбранный</button>
              <button type="button" style={s.tool} disabled={!pointCounts.vent && !pointCounts.hole} onClick={() => { const i = [...lines].reverse().findIndex((l) => l.kind === "point"); if (i >= 0) onLinesChange(lines.filter((_, k) => k !== lines.length - 1 - i)); }}>Убрать последнюю точку</button>
              <button type="button" style={s.tool} disabled={!lines.length} onClick={() => { onLinesChange([]); setSelectedId(null); }}>Очистить всё</button>
            </>
          ) : (
          <>
          {toolBtn("line", isWalls ? "✏️ Обвести стены" : "✏️ Обвести", "Линия по точкам")}
          {toolBtn("rect", isWalls ? "▭ Стены прямоугольником" : "▭ Прямоугольник", "Два щелчка по противоположным углам — контур по периметру прямоугольника")}
          {!isRisers && toolBtn("opening", "🚪 Проём (вычет)", "Два щелчка по краям проёма (ширина), двойной щелчок по второму краю — готово")}
          {isWalls && (
            <>
              <label style={s.row}>
                тип
                <select value={openingType} onChange={(e) => pickOpeningType(e.target.value)} style={s.sel} aria-label="Тип проёма">
                  {Object.entries(OPENING_TYPES).map(([key, t]) => <option key={key} value={key}>{t.label}</option>)}
                </select>
              </label>
              <label style={s.row}>
                высота проёма, м
                <input value={openingHeight} onChange={(e) => setOpeningHeight(e.target.value)} style={{ ...s.num, width: 64 }} aria-label="Высота проёма, м" />
              </label>
            </>
          )}
          {toolBtn("select", "✋ Прокрутка / выбор", "Перетаскивание листа; выбор линии — Delete удалит")}
          <label style={s.row}>
            Shift — шаг угла
            <select value={polarStep} onChange={(e) => setPolarStep(Number(e.target.value))} style={s.sel} aria-label="Шаг полярного отслеживания">
              {POLAR_STEPS.map((a) => <option key={a} value={a}>{a === 90 ? "90° (гориз./верт.)" : `${a}°`}</option>)}
            </select>
          </label>
          <button type="button" style={s.tool} disabled={!selectedId} onClick={() => removeLine(selectedId)}>Удалить выбранную</button>
          <button type="button" style={s.tool} disabled={!lines.length} onClick={() => { onLinesChange([]); setSelectedId(null); }}>Очистить всё</button>
          </>
          )}
        </div>

        {!isDoors && suggestion && !mpu && (
          <div style={s.suggest}>
            Предложено: масштаб 1:{suggestion.scale} (по размеру {suggestion.dimensionMm.toLocaleString("ru-RU")} мм между крайними осями). Верно, если PDF сохранён в натуральную величину листа.
            <button type="button" style={s.accept} onClick={() => onCalibrate(page, metersPerUnitFromScale(suggestion.scale))}>Принять масштаб 1:{suggestion.scale}</button>
          </div>
        )}
        {calibPoints && (
          <form onSubmit={applyCalibration} style={s.suggest}>
            Длина выбранного отрезка, м:
            <input autoFocus value={calibMeters} onChange={(e) => setCalibMeters(e.target.value)} placeholder="например 3,2" style={{ ...s.num, width: 110 }} />
            <button type="submit" style={s.accept}>Применить</button>
            <button type="button" style={s.tool} onClick={() => setCalibPoints(null)}>Отмена</button>
          </form>
        )}
        {note && <div style={s.err}>{note}</div>}

        <div style={s.canvasBox}>
          {pageValid ? (
            <TakeoffCanvas
              pdf={doc}
              pageNumber={page}
              measurements={pageLines}
              selectedId={selectedId}
              mode={isDoors ? (mode === "contour" ? "area" : mode === "vent" || mode === "hole" ? "point" : mode) : isStairArea && mode === "contour" ? "area" : mode}
              noScale={isDoors}
              marks={isDoors ? doorMarks : undefined}
              deduct={mode === "opening"}
              polarStep={polarStep}
              metersPerUnit={mpu}
              labelFor={labelFor}
              colorFor={() => "#1565c0"}
              onSelect={setSelectedId}
              onFinish={onFinish}
              onCalibrated={setCalibPoints}
              onStatus={setStatus}
              onEdit={onEdit}
            />
          ) : (
            <div style={s.empty}>В файле нет листа {pageNo}</div>
          )}
        </div>

        {openings.length > 0 && (
          <div style={s.openings}>
            <div style={s.openingsTitle}>Проёмы (вычитаются)</div>
            {openings.map((o, i) => {
              const w = widthOf(o);
              const area = w && parseManual(o.height) ? w * parseManual(o.height) : null;
              return (
                <div key={o.id} style={s.openingRow}>
                  <span>{i + 1}. {OPENING_TYPES[o.openingType]?.label || "Проём"} · лист {o.page}</span>
                  <span>ширина {w ? `${fmt(w)} м` : "— (лист не откалиброван)"}</span>
                  {isWalls && (
                    <label style={s.row}>
                      высота, м
                      <input value={o.height || ""} onChange={(e) => onEdit(o.id, { height: e.target.value })} style={{ ...s.num, width: 64 }} aria-label={`Высота проёма ${i + 1}, м`} />
                    </label>
                  )}
                  <b>{isWalls ? (area ? `−${fmt(area)} м²` : "высота не задана") : w ? `−${fmt(w)} м` : ""}</b>
                  <button type="button" style={s.tool} onClick={() => removeLine(o.id)}>Удалить</button>
                </div>
              );
            })}
          </div>
        )}

        {isSteps && (
          <div style={s.openings}>
            <div style={{ ...s.openingsTitle, color: "#1a5fb4" }}>Ступени марша (подступенок {RISER_HEIGHT_M * 1000} мм)</div>
            {lines.length === 0 && <div style={s.muted}>Обведите одну ступень — она появится здесь, затем укажите число ступеней.</div>}
            {lines.map((l, i) => {
              const one = taskTotal([{ ...l, count: 1 }], calibrations, { kind: "steps" });
              const all = taskTotal([l], calibrations, { kind: "steps" });
              return (
                <div key={l.id} style={s.openingRow}>
                  <span>{i + 1}. лист {l.page}</span>
                  <span>ступень {one.uncounted ? "— (лист не откалиброван)" : `${fmt(one.area)} м²`}</span>
                  <label style={s.row}>
                    ступеней в марше, шт
                    <input value={l.count > 0 ? l.count : ""} placeholder="1" onChange={(e) => onEdit(l.id, { count: parseManual(e.target.value) || 1 })} style={{ ...s.num, width: 64 }} aria-label={`Число ступеней для контура ${i + 1}`} />
                  </label>
                  <span>проступи {fmt(all.area)} м² + подступенки {fmt(all.risers)} м² · плинтус {fmt(all.plinth)} м.п</span>
                  <b>{all.uncounted ? "" : `${fmt(all.total)} м²`}</b>
                  <button type="button" style={s.tool} onClick={() => removeLine(l.id)}>Удалить</button>
                </div>
              );
            })}
          </div>
        )}

        {isRisers && (
          <div style={s.openings}>
            <div style={{ ...s.openingsTitle, color: "#1a5fb4" }}>Ступени (подступенок {RISER_HEIGHT_M * 1000} мм)</div>
            {lines.length === 0 && <div style={s.muted}>Проведите линию по ширине ступени — она появится здесь.</div>}
            {lines.map((l, i) => {
              const w = widthOf(l);
              return (
                <div key={l.id} style={s.openingRow}>
                  <span>{i + 1}. лист {l.page}</span>
                  <span>ширина {w ? `${fmt(w)} м` : "— (лист не откалиброван)"}</span>
                  <label style={s.row}>
                    ступеней, шт
                    <input value={l.count > 0 ? l.count : ""} placeholder="1" onChange={(e) => onEdit(l.id, { count: parseManual(e.target.value) || 1 })} style={{ ...s.num, width: 64 }} aria-label={`Число ступеней для линии ${i + 1}`} />
                  </label>
                  <b>{w ? `${fmt(w * RISER_HEIGHT_M * (l.count > 0 ? l.count : 1))} м²` : ""}</b>
                  <button type="button" style={s.tool} onClick={() => removeLine(l.id)}>Удалить</button>
                </div>
              );
            })}
          </div>
        )}

        {isDoors && (
          <div style={s.openings}>
            <div style={{ ...s.openingsTitle, color: "#1a5fb4" }}>Найдено в контуре ({foundAll.length})</div>
            {foundAll.length === 0 && <div style={s.muted}>Обведите контур квартиры — двери появятся здесь.</div>}
            {Object.entries(foundAll.reduce((acc, d) => ({ ...acc, [d.mark]: [...(acc[d.mark] || []), d] }), {})).map(([mark, list]) => (
              <div key={mark} style={s.openingRow}>
                <b>{mark}</b>
                <span>{DOOR_CATEGORIES[list[0].category] || "—"}{list[0].category === "interior" ? `, ${list[0].leaves === 2 ? "двупольная" : "однопольная"}` : ""}</span>
                <span>{list.length} шт.</span>
              </div>
            ))}
          </div>
        )}

        <div style={s.bottom}>
          {isDoors && <span style={s.total}>Входных: {doorSummary.entrance} · межкомнатных однопольных: {doorSummary.single} · двупольных: {doorSummary.double} · окон: {elementsAll.windows}{elementsAll.blocks ? ` (балконных блоков на плане: ${elementsAll.blocks} — считаются вручную)` : ""} · вент. решёток: {pointCounts.vent} · техн. отверстий: {pointCounts.hole}</span>}
          {isWalls && (
            <label style={s.row}>
              Высота от пола до потолка, м
              <input value={height} onChange={(e) => onHeightChange(e.target.value)} style={{ ...s.num, width: 80 }} aria-label="Высота от пола до потолка, м" />
            </label>
          )}
          {!isDoors && total.deducted > 0 && <span style={s.muted}>{isWalls ? "Стены" : "Длина"} {fmt(total.gross)} − проёмы {fmt(total.deducted)} {task.unit}</span>}
          {isPlatform && <span style={s.total}>Плинтус: {total.plinth ? `${fmt(total.plinth)} м.п` : "—"}</span>}
          {!isDoors && <span style={s.total}>Итого по задаче: {total.total ? `${fmt(total.total)} ${task.unit}` : "—"}</span>}
          {!isDoors && total.uncounted > 0 && <span style={s.warn}>{total.uncounted} лин. не посчитано (нет калибровки{isWalls ? " или высоты" : ""})</span>}
          <span style={s.muted}>{status}</span>
        </div>
      </div>
    </div>
  );
}

const s = {
  overlay: { position: "fixed", inset: 0, background: "rgba(20,30,45,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 },
  panel: { background: "#fff", borderRadius: 12, width: "100%", height: "100%", maxWidth: 1500, display: "flex", flexDirection: "column", gap: 8, padding: 14, boxSizing: "border-box" },
  top: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  title: { fontSize: 16, fontWeight: 700 },
  sub: { fontSize: 13, color: "#555", marginTop: 2 },
  done: { background: "#1a5fb4", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  hint: { background: "#eef5ff", color: "#27415f", borderRadius: 8, padding: "8px 12px", fontSize: 13, lineHeight: 1.5 },
  bar: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 },
  row: { display: "flex", alignItems: "center", gap: 6 },
  num: { width: 70, padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13 },
  sel: { padding: "5px 6px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13 },
  tool: { background: "#fff", color: "#1a5fb4", border: "1px solid #1a5fb4", borderRadius: 8, padding: "6px 10px", fontSize: 13, cursor: "pointer" },
  toolOn: { background: "#1a5fb4", color: "#fff" },
  muted: { color: "#777" },
  ok: { color: "#1a7f37", fontWeight: 600 },
  warn: { color: "#8a5a00", fontWeight: 600 },
  err: { background: "#fdecec", color: "#c0392b", borderRadius: 8, padding: "6px 10px", fontSize: 13 },
  suggest: { background: "#fff6e0", color: "#6b4a00", borderRadius: 8, padding: "8px 12px", fontSize: 13, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  accept: { background: "#8a5a00", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  canvasBox: { position: "relative", flex: 1, minHeight: 260, border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" },
  empty: { padding: 20, color: "#777" },
  openings: { border: "1px solid #f0d4d4", background: "#fff8f8", borderRadius: 8, padding: "6px 10px", maxHeight: 130, overflow: "auto", fontSize: 13 },
  openingsTitle: { fontWeight: 700, color: "#a03030", marginBottom: 4 },
  openingRow: { display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", padding: "3px 0" },
  bottom: { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", fontSize: 14 },
  total: { fontWeight: 700 },
};
