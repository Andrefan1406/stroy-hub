// Чертёж и замеры поверх него. Страница PDF рисуется в canvas, замеры — в
// SVG того же размера; оба в единицах страницы PDF, зум и прокрутка —
// общим CSS-преобразованием.
//
// Управление:
//   колесо — масштаб вокруг курсора;
//   средняя кнопка или пробел + перетаскивание — прокрутка (в режиме
//   «Выбор» — и левой кнопкой по пустому месту);
//   в режимах «Площадь», «Длина», «Калибровка» — щелчок ставит точку,
//   Shift — строго по горизонтали/вертикали, двойной щелчок или Enter —
//   готово, Backspace — убрать последнюю точку, Esc — отменить.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { renderPage } from "./pdf";
import { centroid, polygonArea, polylineLength } from "./model";

const MIN_K = 0.05;
const MAX_K = 40;
const clampK = (k) => Math.min(MAX_K, Math.max(MIN_K, k));
const fmt = (v, d = 2) => v.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d });

function snapOrtho(p, last) {
  if (!last) return p;
  return Math.abs(p.x - last.x) >= Math.abs(p.y - last.y) ? { x: p.x, y: last.y } : { x: last.x, y: p.y };
}

// Подпись линии — у середины самого длинного отрезка.
function lineLabelPoint(points) {
  let best = 0;
  let at = points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) {
      best = len;
      at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return at;
}

const TakeoffCanvas = forwardRef(function TakeoffCanvas(
  { pdf, pageNumber, measurements, selectedId, mode, deduct, metersPerUnit, labelFor, colorFor, onSelect, onFinish, onCalibrated, onStatus },
  ref
) {
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const [page, setPage] = useState(null); // { width, height } в единицах PDF
  const [view, setView] = useState({ tx: 0, ty: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [draft, setDraft] = useState([]);
  const [hover, setHover] = useState(null);
  const [space, setSpace] = useState(false);
  const pan = useRef(null);

  const fit = useCallback((size = page) => {
    const box = boxRef.current;
    if (!box || !size) return;
    const pad = 20;
    const k = clampK(Math.min((box.clientWidth - pad * 2) / size.width, (box.clientHeight - pad * 2) / size.height));
    setView({ k, tx: (box.clientWidth - size.width * k) / 2, ty: (box.clientHeight - size.height * k) / 2 });
  }, [page]);

  useImperativeHandle(ref, () => ({ fit: () => fit() }), [fit]);

  // Отрисовка страницы.
  useEffect(() => {
    if (!pdf || !pageNumber) return undefined;
    let cancelled = false;
    let task = null;
    onStatus?.("Отрисовка страницы…");
    renderPage(pdf, pageNumber, canvasRef.current)
      .then((res) => {
        if (cancelled) {
          // Лист уже сменили: отменяем, а отказ отменённой отрисовки гасим —
          // иначе он всплывает как необработанная ошибка.
          res.task.promise.catch(() => {});
          res.task.cancel();
          return null;
        }
        task = res.task;
        const size = { width: res.width, height: res.height };
        setPage(size);
        fit(size);
        return res.task.promise;
      })
      .then(() => { if (!cancelled) onStatus?.(""); })
      .catch((err) => { if (!cancelled && err?.name !== "RenderingCancelledException") onStatus?.(`Не удалось отрисовать страницу: ${err.message}`); });
    setDraft([]);
    return () => {
      cancelled = true;
      if (task) task.cancel();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageNumber]);

  // Смена режима — начатый контур отменяется.
  useEffect(() => setDraft([]), [mode]);

  const toWorld = useCallback((clientX, clientY) => {
    const r = boxRef.current.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.tx) / v.k, y: (clientY - r.top - v.ty) / v.k };
  }, []);

  // Колесо — масштаб вокруг курсора (свой обработчик: passive: false).
  useEffect(() => {
    const el = boxRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const k = clampK(v.k * Math.exp(-e.deltaY * 0.0015));
        return { k, tx: px - ((px - v.tx) * k) / v.k, ty: py - ((py - v.ty) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const drawing = mode === "area" || mode === "line" || mode === "calibrate";

  const finish = useCallback((points) => {
    // Двойной щелчок сначала ставит две одинаковые точки — убираем дубли.
    const clean = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5);
    if (mode === "area" && clean.length >= 3) onFinish({ kind: "area", points: clean });
    else if (mode === "line" && clean.length >= 2) onFinish({ kind: "line", points: clean });
    else return false;
    setDraft([]);
    return true;
  }, [mode, onFinish]);

  // Клавиши рисования и пробел для прокрутки.
  useEffect(() => {
    const isTyping = () => ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    const down = (e) => {
      if (isTyping()) return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpace(true);
      } else if (drawing && e.key === "Escape") setDraft([]);
      else if (drawing && e.key === "Backspace") {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
      } else if (drawing && e.key === "Enter") finish(draft);
    };
    const up = (e) => { if (e.code === "Space") setSpace(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [drawing, draft, finish]);

  const onPointerDown = (e) => {
    const panButton = e.button === 1 || (e.button === 0 && (space || mode === "select"));
    if (panButton) {
      e.preventDefault();
      pan.current = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty, moved: false };
      boxRef.current.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 || !drawing || !page) return;
    let p = toWorld(e.clientX, e.clientY);
    if (e.shiftKey) p = snapOrtho(p, draft[draft.length - 1]);
    const next = [...draft, p];
    if (mode === "calibrate" && next.length === 2) {
      setDraft([]);
      onCalibrated(next);
      return;
    }
    setDraft(next);
  };

  const onPointerMove = (e) => {
    if (pan.current) {
      const d = pan.current;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      setView((v) => ({ ...v, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy }));
      return;
    }
    if (drawing) {
      let p = toWorld(e.clientX, e.clientY);
      if (e.shiftKey) p = snapOrtho(p, draft[draft.length - 1]);
      setHover(p);
    }
  };

  const onPointerUp = () => {
    const d = pan.current;
    pan.current = null;
    // Щелчок по пустому месту в режиме «Выбор» снимает выделение.
    if (d && !d.moved && mode === "select") onSelect(null);
  };

  const { tx, ty, k } = view;
  const px = (n) => n / k; // экранные пиксели -> единицы страницы
  const live = hover && draft.length ? [...draft, hover] : draft;
  let liveText = "";
  if (drawing && live.length >= 2) {
    const units = mode === "area" && live.length >= 3 ? polygonArea(live) : polylineLength(live);
    if (mode === "calibrate") liveText = `${fmt(polylineLength(live), 1)} ед. PDF`;
    else if (!metersPerUnit) liveText = "лист не откалиброван";
    else if (mode === "area" && live.length >= 3) liveText = `${fmt(units * metersPerUnit * metersPerUnit)} м²`;
    else liveText = `${fmt(units * metersPerUnit)} м`;
  }
  const draftColor = mode === "calibrate" ? "#e65100" : deduct ? "#c62828" : "#1565c0";

  return (
    <div
      ref={boxRef}
      style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#e9edf2", cursor: space || mode === "select" ? "grab" : "crosshair", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={() => drawing && finish(draft)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${k})`, width: page?.width, height: page?.height }}>
        <canvas ref={canvasRef} style={{ display: "block", width: page?.width, height: page?.height, boxShadow: "0 2px 10px rgba(0,0,0,0.15)" }} />
        {page && (
          <svg width={page.width} height={page.height} viewBox={`0 0 ${page.width} ${page.height}`}
            style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
            {measurements.map((m) => {
              const selected = m.id === selectedId;
              const color = m.deduct ? "#c62828" : colorFor(m);
              const pts = m.points.map((p) => `${p.x},${p.y}`).join(" ");
              const at = m.kind === "area" ? centroid(m.points) : lineLabelPoint(m.points);
              const label = labelFor(m);
              const select = (e) => {
                if (mode !== "select" || e.button !== 0) return;
                e.stopPropagation();
                onSelect(m.id);
              };
              return (
                <g key={m.id} onPointerDown={select} style={{ cursor: mode === "select" ? "pointer" : undefined }}>
                  {m.kind === "area" ? (
                    <polygon points={pts} fill={color} fillOpacity={selected ? 0.32 : 0.18} stroke={selected ? "#0d47a1" : color}
                      strokeWidth={selected ? 0.9 : 0.5} vectorEffect="non-scaling-stroke" strokeDasharray={m.deduct ? "6 4" : undefined} />
                  ) : (
                    <polyline points={pts} fill="none" stroke={selected ? "#0d47a1" : color} strokeWidth={selected ? 1.2 : 0.75}
                      strokeOpacity={0.9} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeDasharray={m.deduct ? "5 3" : undefined} />
                  )}
                  {label && (
                    <g transform={`translate(${at.x} ${at.y}) scale(${px(1)})`} pointerEvents="none">
                      <rect x={-label.length * 3.6 - 6} y={-10} width={label.length * 7.2 + 12} height={20} rx={4}
                        fill="#fff" fillOpacity={0.9} stroke={color} strokeWidth={1} />
                      <text textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600} fill={selected ? "#0d47a1" : "#1d2b3a"}>{label}</text>
                    </g>
                  )}
                </g>
              );
            })}
            {drawing && live.length > 0 && (
              <g pointerEvents="none">
                {mode === "area" && live.length >= 3 && (
                  <polygon points={live.map((p) => `${p.x},${p.y}`).join(" ")} fill={draftColor} fillOpacity={0.12} stroke="none" />
                )}
                <polyline points={live.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={draftColor}
                  strokeWidth={0.6} vectorEffect="non-scaling-stroke" strokeDasharray="6 3" />
                {draft.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={px(2)} fill="#fff" stroke={draftColor} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
                ))}
              </g>
            )}
            {drawing && hover && liveText && (
              <g transform={`translate(${hover.x} ${hover.y}) scale(${px(1)})`} pointerEvents="none">
                <rect x={14} y={8} width={liveText.length * 7.4 + 12} height={22} rx={4} fill={draftColor} />
                <text x={20} y={23} fontSize={12} fontWeight={600} fill="#fff">{liveText}</text>
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  );
});

export default TakeoffCanvas;
