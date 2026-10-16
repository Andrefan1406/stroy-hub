// Чертёж и замеры поверх него. Страница PDF рисуется в canvas, замеры — в
// SVG того же размера; оба в единицах страницы PDF, зум и прокрутка —
// общим CSS-преобразованием.
//
// Управление:
//   колесо — масштаб вокруг курсора;
//   средняя кнопка или пробел + перетаскивание — прокрутка (в режиме
//   «Выбор» — и левой кнопкой по пустому месту);
//   в режимах «Площадь», «Длина», «Проём», «Калибровка» — щелчок ставит
//   точку, Shift — строго по горизонтали/вертикали, двойной щелчок или
//   Enter — готово, Backspace — убрать последнюю точку, Esc — отменить;
//   «Прямоугольник» — два щелчка по диагонали (оси параллельны листу).
//
// Правка выделенного замера (режим «Выбор»): тянуть точку — переместить,
// тянуть «+» на середине отрезка — добавить точку, правый щелчок (или
// Alt + щелчок) по точке — удалить. У прямоугольника — углы шахты и каналов.
//
// Новая редакция чертежа: режим «align» — щелчки для совмещения по двум
// точкам (прилипают к вершинам замеров); compareLayers — слои подсветки
// изменений (старый лист красным, новый синим).
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { renderPage, renderTinted } from "./pdf";
import { centroid, polygonArea, polylineLength } from "./model";
import { placeRect, rectOf } from "./masonry";

const SELECTED = "#0040ff"; // выделенный замер
const UNCOUNTED = "#ff6d00"; // замер, не вошедший в итог
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
  {
    pdf, pageNumber, measurements, selectedId, mode, deduct, metersPerUnit, labelFor, colorFor, onSelect, onFinish, onCalibrated, onStatus,
    onEdit, revisionView, compareLayers, alignSnap, onAlignClick, marks,
  },
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
  const drag = useRef(null); // перетаскивание точки выделенного замера

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

  const drawing = ["area", "line", "rect", "opening", "calibrate"].includes(mode);

  const finish = useCallback((points) => {
    // Двойной щелчок сначала ставит две одинаковые точки — убираем дубли.
    const clean = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5);
    if (mode === "area" && clean.length >= 3) onFinish({ kind: "area", points: clean });
    else if ((mode === "line" || mode === "opening") && clean.length >= 2) onFinish({ kind: "line", points: clean });
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

  // Ближайшая точка для прилипания при совмещении (в пределах 12 px экрана).
  const snapAt = (p) => {
    let best = null;
    (alignSnap || []).forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y) * viewRef.current.k;
      if (d <= 12 && (!best || d < best.d)) best = { d, i, q };
    });
    return best;
  };

  // --- правка точек ---
  const startDrag = (e, info) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button === 2 || e.altKey) {
      if (info.type === "vertex") removeVertex(info);
      return;
    }
    if (e.button !== 0) return;
    boxRef.current.setPointerCapture(e.pointerId);
    drag.current = info;
  };
  const removeVertex = ({ m, index }) => {
    const min = m.kind === "area" ? 3 : 2;
    if (m.points.length <= min) return;
    onEdit(m.id, { points: m.points.filter((_, i) => i !== index) });
  };
  const insertVertex = (e, m, index, at) => {
    if (e.button !== 0) return;
    const points = [...m.points.slice(0, index + 1), at, ...m.points.slice(index + 1)];
    onEdit(m.id, { points });
    startDrag(e, { type: "vertex", m: { ...m, points }, index: index + 1 });
  };
  const moveDrag = (e) => {
    const d = drag.current;
    const m = measurements.find((x) => x.id === d.m.id);
    if (!m) return;
    let p = toWorld(e.clientX, e.clientY);
    if (d.type === "vertex") {
      const prev = m.points[d.index - 1] || (m.kind === "area" ? m.points[m.points.length - 1] : m.points[d.index + 1]);
      if (e.shiftKey) p = snapOrtho(p, prev);
      onEdit(m.id, { points: m.points.map((q, i) => (i === d.index ? p : q)) });
    } else if (d.type === "rect") {
      const next = [d.fixed, p];
      const outer = rectOf(next);
      const fits = (m.channels || []).every((c) => {
        const r = rectOf(c);
        return r.x0 >= outer.x0 && r.y0 >= outer.y0 && r.x1 <= outer.x1 && r.y1 <= outer.y1;
      });
      if (fits && outer.x1 - outer.x0 > 0.5 && outer.y1 - outer.y0 > 0.5) onEdit(m.id, { points: next });
    } else if (d.type === "channel") {
      const ch = [d.fixed, p];
      const others = (m.channels || []).filter((_, i) => i !== d.ci);
      if (placeRect(ch, [{ ...m, channels: others }]).channelOf === m.id) {
        onEdit(m.id, { channels: m.channels.map((c, i) => (i === d.ci ? ch : c)) });
      }
    }
  };
  const corners = (pts) => {
    const r = rectOf(pts);
    return [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  };

  const onPointerDown = (e) => {
    if (mode === "align" && e.button === 0 && !space && page) {
      const p = toWorld(e.clientX, e.clientY);
      const snap = snapAt(p);
      onAlignClick?.({ point: snap ? snap.q : p, snapIndex: snap ? snap.i : null });
      return;
    }
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
    if (mode === "rect" && next.length === 2) {
      setDraft([]);
      const r = rectOf(next);
      if (r.x1 - r.x0 > 0.5 && r.y1 - r.y0 > 0.5) onFinish({ kind: "rect", points: next });
      return;
    }
    setDraft(next);
  };

  const onPointerMove = (e) => {
    if (drag.current) {
      moveDrag(e);
      return;
    }
    if (mode === "align") {
      setHover(toWorld(e.clientX, e.clientY));
      return;
    }
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
    if (drag.current) {
      drag.current = null;
      return;
    }
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
    else if (mode === "rect") {
      const r = rectOf(live);
      liveText = metersPerUnit ? `${fmt((r.x1 - r.x0) * metersPerUnit, 3)} × ${fmt((r.y1 - r.y0) * metersPerUnit, 3)} м` : "лист не откалиброван";
    }
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
        <canvas ref={canvasRef} style={{ display: "block", width: page?.width, height: page?.height, boxShadow: "0 2px 10px rgba(0,0,0,0.15)", visibility: compareLayers?.length ? "hidden" : "visible" }} />
        {page && compareLayers?.length > 0 && (
          <div style={{ position: "absolute", left: 0, top: 0, width: page.width, height: page.height, background: "#fff", isolation: "isolate" }}>
            {compareLayers.map((l) => <TintLayer key={l.key} layer={l} />)}
          </div>
        )}
        {page && (
          <svg width={page.width} height={page.height} viewBox={`0 0 ${page.width} ${page.height}`}
            style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
            <g opacity={revisionView ? 0.7 : 1} pointerEvents={revisionView ? "none" : undefined}>
            {measurements.map((m) => {
              const selected = m.id === selectedId;
              const color = m.deduct ? "#c62828" : colorFor(m);
              const pts = m.points.map((p) => `${p.x},${p.y}`).join(" ");
              if (m.kind === "rect") {
                return <RectShape key={m.id} m={m} selected={selected} color={colorFor(m)} label={revisionView ? null : labelFor(m)} metersPerUnit={metersPerUnit}
                  px={px} mode={mode} onSelect={onSelect} />;
              }
              const opening = m.role === "opening";
              const at = m.kind === "area" ? centroid(m.points) : lineLabelPoint(m.points);
              // Не вошёл в итог (лист не откалиброван, нет работы/высоты) —
              // оранжевый пунктир с подписью, чтобы сразу было видно, что не посчитано.
              const counted = revisionView || !!labelFor(m);
              const label = revisionView ? "" : counted ? labelFor(m) : "не посчитано";
              const stroke = selected ? SELECTED : counted ? color : UNCOUNTED;
              // Толщина в экранных пикселях — одинаково заметна при любом масштабе.
              const width = px(opening ? (selected ? 5 : 4.5) : m.kind === "area" ? (selected ? 4.5 : 3) : selected ? 5 : 3.5);
              const dash = !counted ? `${px(9)} ${px(5)}` : m.deduct ? `${px(7)} ${px(4)}` : undefined;
              const select = (e) => {
                if (mode !== "select" || e.button !== 0) return;
                e.stopPropagation();
                onSelect(m.id);
              };
              return (
                <g key={m.id} onPointerDown={select} style={{ cursor: mode === "select" ? "pointer" : undefined }}>
                  {m.kind === "area" ? (
                    <>
                      <polygon points={pts} fill="none" stroke="#fff" strokeOpacity={0.9} strokeWidth={width + px(3)} strokeLinejoin="round" />
                      <polygon points={pts} fill={counted ? color : UNCOUNTED} fillOpacity={selected ? 0.42 : counted ? 0.28 : 0.12} stroke={stroke}
                        strokeWidth={width} strokeLinejoin="round" strokeDasharray={dash} />
                    </>
                  ) : (
                    <>
                      <polyline points={pts} fill="none" stroke="#fff" strokeOpacity={0.9} strokeWidth={width + px(3)} strokeLinejoin="round" strokeLinecap="round" />
                      <polyline points={pts} fill="none" stroke={opening && !selected ? "#d50000" : stroke} strokeWidth={width}
                        strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dash} />
                    </>
                  )}
                  {label && (
                    <g transform={`translate(${at.x} ${at.y}) scale(${px(1)})`} pointerEvents="none">
                      <rect x={-label.length * 3.7 - 7} y={-11} width={label.length * 7.4 + 14} height={22} rx={5}
                        fill={counted ? "#fff" : "#fff3e0"} stroke={stroke} strokeWidth={2} />
                      <text textAnchor="middle" dominantBaseline="central" fontSize={12.5} fontWeight={700} fill={counted ? (selected ? SELECTED : "#111") : "#e65100"}>{label}</text>
                    </g>
                  )}
                </g>
              );
            })}
            </g>
            {mode === "select" && onEdit && !revisionView && (() => {
              const m = measurements.find((x) => x.id === selectedId);
              if (!m) return null;
              const handle = (key, at, onDown, extra = {}) => (
                <circle key={key} cx={at.x} cy={at.y} r={px(extra.r || 6)} fill={extra.fill || "#fff"} stroke={SELECTED} strokeWidth={px(2.5)}
                  style={{ cursor: extra.cursor || "move" }} onPointerDown={onDown}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                  {extra.title && <title>{extra.title}</title>}
                </circle>
              );
              if (m.kind === "rect") {
                const outer = corners(m.points);
                return (
                  <g>
                    {outer.map((c, i) => handle(`o${i}`, c, (e) => startDrag(e, { type: "rect", m, fixed: outer[(i + 2) % 4] }), { title: "Тянуть — изменить размер шахты" }))}
                    {(m.channels || []).flatMap((ch, ci) => {
                      const cc = corners(ch);
                      return cc.map((c, i) => handle(`c${ci}-${i}`, c, (e) => startDrag(e, { type: "channel", m, ci, fixed: cc[(i + 2) % 4] }), { r: 4.5, title: "Тянуть — изменить размер канала" }));
                    })}
                  </g>
                );
              }
              const n = m.points.length;
              const edges = m.kind === "area" ? n : n - 1;
              return (
                <g>
                  {Array.from({ length: edges }, (_, i) => {
                    const a = m.points[i];
                    const b = m.points[(i + 1) % n];
                    const at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                    return (
                      <g key={`mid${i}`} style={{ cursor: "copy" }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); insertVertex(e, m, i, at); }}>
                        <circle cx={at.x} cy={at.y} r={px(5)} fill={SELECTED} fillOpacity={0.85} stroke="#fff" strokeWidth={px(1.5)} />
                        <path d={`M ${at.x - px(2.5)} ${at.y} H ${at.x + px(2.5)} M ${at.x} ${at.y - px(2.5)} V ${at.y + px(2.5)}`} stroke="#fff" strokeWidth={px(1.5)} pointerEvents="none" />
                        <title>Тянуть — добавить точку</title>
                      </g>
                    );
                  })}
                  {m.points.map((pt, i) => handle(`v${i}`, pt, (e) => startDrag(e, { type: "vertex", m, index: i }), { title: "Тянуть — переместить; правый щелчок — удалить точку" }))}
                </g>
              );
            })()}
            {mode === "align" && hover && (() => {
              const snap = snapAt(hover);
              return snap ? <circle cx={snap.q.x} cy={snap.q.y} r={px(9)} fill="none" stroke="#ff6d00" strokeWidth={px(2.5)} pointerEvents="none" /> : null;
            })()}
            {(marks || []).map((mk, i) => (
              <g key={`mk${i}`} pointerEvents="none">
                <circle cx={mk.x} cy={mk.y} r={px(7)} fill={mk.color} fillOpacity={0.25} stroke={mk.color} strokeWidth={px(3)} />
                <circle cx={mk.x} cy={mk.y} r={px(1.8)} fill={mk.color} />
                <g transform={`translate(${mk.x} ${mk.y}) scale(${px(1)})`}>
                  <rect x={9} y={-22} width={mk.label.length * 7.5 + 10} height={18} rx={4} fill={mk.color} />
                  <text x={14} y={-9} fontSize={12} fontWeight={700} fill="#fff">{mk.label}</text>
                </g>
              </g>
            ))}
            {drawing && live.length > 0 && (
              <g pointerEvents="none">
                {mode === "rect" && live.length === 2 && (() => {
                  const r = rectOf(live);
                  return <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill={draftColor} fillOpacity={0.12} stroke={draftColor}
                    strokeWidth={0.6} vectorEffect="non-scaling-stroke" strokeDasharray="6 3" />;
                })()}
                {mode === "area" && live.length >= 3 && (
                  <polygon points={live.map((p) => `${p.x},${p.y}`).join(" ")} fill={draftColor} fillOpacity={0.12} stroke="none" />
                )}
                {mode !== "rect" && (
                  <polyline points={live.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={draftColor}
                    strokeWidth={0.6} vectorEffect="non-scaling-stroke" strokeDasharray="6 3" />
                )}
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

// Слой подсветки изменений: лист PDF одним цветом, белое прозрачно; старый
// лист — с совмещением (transform) поверх нового в режиме multiply.
function TintLayer({ layer }) {
  const ref = useRef(null);
  const [size, setSize] = useState(null);
  const color = layer.color.join(",");
  useEffect(() => {
    let cancelled = false;
    const box = ref.current;
    renderTinted(layer.pdf, layer.pageNumber, layer.color).then((res) => {
      if (cancelled) return;
      res.canvas.style.width = "100%";
      res.canvas.style.height = "100%";
      res.canvas.style.display = "block";
      box.replaceChildren(res.canvas);
      setSize({ width: res.width, height: res.height });
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.pdf, layer.pageNumber, color]);
  const t = layer.transform;
  return (
    <div ref={ref} style={{
      position: "absolute", left: 0, top: 0, width: size?.width, height: size?.height, transformOrigin: "0 0",
      transform: t ? `matrix(${t.a}, ${t.b}, ${-t.b}, ${t.a}, ${t.tx}, ${t.ty})` : undefined, mixBlendMode: "multiply",
    }} />
  );
}

// Подпись постоянного экранного размера в точке листа.
function Tag({ x, y, px, text, color, dx = 0, dy = 0, anchor = "middle", bold }) {
  const w = text.length * (bold ? 7.2 : 6.4) + 10;
  const x0 = anchor === "middle" ? -w / 2 : anchor === "end" ? -w : 0;
  return (
    <g transform={`translate(${x} ${y}) scale(${px(1)}) translate(${dx} ${dy})`} pointerEvents="none">
      <rect x={x0} y={-9} width={w} height={18} rx={4} fill="#fff" fillOpacity={0.9} stroke={color} strokeWidth={1} />
      <text x={x0 + w / 2} textAnchor="middle" dominantBaseline="central" fontSize={bold ? 12 : 11} fontWeight={bold ? 600 : 500} fill="#1d2b3a">{text}</text>
    </g>
  );
}

// Вентшахта: внешний прямоугольник, каналы внутри, размеры в метрах. Шахта
// на плане мелкая и рассматривается крупным планом — толщина линий в
// экранных пикселях, чтобы рамка не закрывала каналы.
function RectShape({ m, selected, color, label, metersPerUnit, px, mode, onSelect }) {
  const r = rectOf(m.points);
  const w = (q) => fmt((q.x1 - q.x0) * metersPerUnit, 2);
  const h = (q) => fmt((q.y1 - q.y0) * metersPerUnit, 2);
  // label === null — подписи не нужны (просмотр при замене чертежа).
  const counted = label !== "";
  const stroke = selected ? SELECTED : counted ? color : UNCOUNTED;
  const select = (e) => {
    if (mode !== "select" || e.button !== 0) return;
    e.stopPropagation();
    onSelect(m.id);
  };
  return (
    <g onPointerDown={select} style={{ cursor: mode === "select" ? "pointer" : undefined }}>
      <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill="none" stroke="#fff" strokeOpacity={0.9} strokeWidth={px(selected ? 6 : 5)} />
      <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill={counted ? color : UNCOUNTED} fillOpacity={selected ? 0.42 : counted ? 0.3 : 0.12}
        stroke={stroke} strokeWidth={px(selected ? 3.5 : 2.5)} strokeDasharray={counted ? undefined : `${px(9)} ${px(5)}`} />
      {(m.channels || []).map((c, i) => {
        const q = rectOf(c);
        return (
          <g key={i}>
            <rect x={q.x0} y={q.y0} width={q.x1 - q.x0} height={q.y1 - q.y0} fill="#fff" fillOpacity={0.85}
              stroke={stroke} strokeWidth={px(2)} strokeDasharray={`${px(5)} ${px(3)}`} />
            {selected && metersPerUnit && <Tag x={(q.x0 + q.x1) / 2} y={(q.y0 + q.y1) / 2} px={px} text={`${w(q)}×${h(q)}`} color={stroke} />}
          </g>
        );
      })}
      {metersPerUnit && (
        <>
          <Tag x={(r.x0 + r.x1) / 2} y={r.y0} px={px} dy={-12} text={w(r)} color={stroke} />
          <Tag x={r.x0} y={(r.y0 + r.y1) / 2} px={px} dx={-6} anchor="end" text={h(r)} color={stroke} />
        </>
      )}
      {label !== null && <Tag x={(r.x0 + r.x1) / 2} y={r.y1} px={px} dy={14} text={label || "не посчитано"} color={stroke} bold />}
    </g>
  );
}

export default TakeoffCanvas;
