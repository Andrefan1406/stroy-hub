// Окно обмера: лист PDF с чертежом и инструмент замеров из подсчёта объёмов (src/takeoff). Пользователь
// калибрует лист (по размеру на чертеже или по масштабу), обводит линией плинтус или стены, и получает длину в метрах.
// Окно измеряет ОДНУ задачу для одной квартиры типа — значение потом подставляется во все квартиры этого типа.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import TakeoffCanvas from "../takeoff/TakeoffCanvas";
import { distance, metersPerUnitFromDistance, metersPerUnitFromScale } from "../takeoff/model";
import { findAxisRows } from "./plan";
import { suggestScale, taskTotal } from "./measure";

const SCALES = [20, 25, 50, 75, 100, 150, 200, 250, 500];
const fmt = (v) => Number(v).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export default function MeasureDialog({
  doc, numPages, task, flatsHint, initialPage, itemsOf, lines, onLinesChange, calibrations, onCalibrate, height, onHeightChange, onClose,
}) {
  const [pageNo, setPageNo] = useState(String(initialPage || 1));
  const [mode, setMode] = useState("select"); // select | line | calibrate
  const [selectedId, setSelectedId] = useState(null);
  const [calibPoints, setCalibPoints] = useState(null);
  const [calibMeters, setCalibMeters] = useState("");
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");

  const page = Number(pageNo);
  const pageValid = Number.isInteger(page) && page >= 1 && page <= numPages;
  const mpu = pageValid ? calibrations[page] || null : null;
  const isWalls = task.kind === "walls";

  // предложение масштаба по размеру между крайними осями — пользователь подтверждает
  const suggestion = useMemo(() => {
    if (!pageValid) return null;
    const items = itemsOf(page);
    const rows = findAxisRows(items, 0);
    return rows[0] ? suggestScale(items, rows[0].labels) : null;
  }, [page, pageValid, itemsOf]);

  const total = useMemo(() => taskTotal(lines, calibrations, { kind: task.kind, height }), [lines, calibrations, task.kind, height]);
  const pageLines = useMemo(() => lines.filter((l) => l.page === page).map((l) => ({ ...l, calc: isWalls ? "wall" : "length", height: isWalls ? height : undefined })), [lines, page, isWalls, height]);

  const labelFor = useCallback((m) => {
    const t = taskTotal([m], calibrations, { kind: task.kind, height });
    return t.uncounted ? "" : `${fmt(t.total)} ${task.unit}`;
  }, [calibrations, task.kind, task.unit, height]);

  const onFinish = useCallback(({ kind, points }) => {
    if (mode !== "line" || kind !== "line") return;
    onLinesChange([...lines, { id: newId(), page, kind: "line", points, count: 1 }]);
  }, [mode, lines, page, onLinesChange]);

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
            <div style={s.sub}>Квартира типа {task.code} · {task.roomNo}. {task.roomName} · результат {task.unit} — подставится во все квартиры этого типа</div>
          </div>
          <button type="button" onClick={onClose} style={s.done}>Готово</button>
        </div>

        <div style={s.hint}>
          {flatsHint}
          {isWalls
            ? " Обведите линией стены помещения по периметру (щёлкайте по углам, двойной щелчок или Enter — конец линии); площадь = длина × высота."
            : " Обведите линией плинтус вдоль стен без дверных проёмов (щёлкайте по углам, двойной щелчок или Enter — конец линии). Линий может быть несколько — они сложатся."}
        </div>

        <div style={s.bar}>
          <label style={s.row}>
            Лист
            <input type="number" min={1} max={numPages} value={pageNo} onChange={(e) => { setPageNo(e.target.value); setSelectedId(null); }} style={s.num} />
            <span style={s.muted}>из {numPages}</span>
          </label>
          <span style={mpu ? s.ok : s.warn}>{mpu ? "✓ лист откалиброван" : "лист не откалиброван — без этого длины не считаются"}</span>
          {toolBtn("calibrate", "📏 Калибровка по размеру", "Щёлкните по двум концам размера с известной длиной (например, 3200 мм между осями)")}
          <label style={s.row}>
            или масштаб 1:
            <select value="" onChange={(e) => e.target.value && onCalibrate(page, metersPerUnitFromScale(Number(e.target.value)))} style={s.sel}>
              <option value="">—</option>
              {SCALES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {toolBtn("line", "✏️ Обвести", "Линия по точкам")}
          {toolBtn("select", "✋ Прокрутка / выбор", "Перетаскивание листа; выбор линии — Delete удалит")}
          <button type="button" style={s.tool} disabled={!selectedId} onClick={() => removeLine(selectedId)}>Удалить выбранную</button>
          <button type="button" style={s.tool} disabled={!lines.length} onClick={() => { onLinesChange([]); setSelectedId(null); }}>Очистить всё</button>
        </div>

        {suggestion && !mpu && (
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
              mode={mode}
              deduct={false}
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

        <div style={s.bottom}>
          {isWalls && (
            <label style={s.row}>
              Высота стен, м
              <input value={height} onChange={(e) => onHeightChange(e.target.value)} style={{ ...s.num, width: 80 }} />
            </label>
          )}
          <span style={s.total}>Итого по задаче: {total.total ? `${fmt(total.total)} ${task.unit}` : "—"}</span>
          {total.uncounted > 0 && <span style={s.warn}>{total.uncounted} лин. не посчитано (нет калибровки{isWalls ? " или высоты" : ""})</span>}
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
  bottom: { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", fontSize: 14 },
  total: { fontWeight: 700 },
};
