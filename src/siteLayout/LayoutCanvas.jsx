// Холст схемы бытовок — SVG в метрах (1 единица = 1 м), белый фон с сеткой.
// Прокрутка — перетаскиванием пустого места, зум — колесом (вокруг курсора),
// поворот выделенной бытовки на 45° — Shift+колесо или ручкой над ней.
// Новые объекты перетаскиваются сюда с панели (HTML5 drag-and-drop).
//
// Состоянием объектов холст не владеет: перемещение «на лету» сообщает
// через onLiveMove([{ id, x, y | rotation }]), итог — через onCommit, чтобы
// страница разослала правку и запомнила её для отмены.
//
// Перетаскивание с клавишами (решают клавиши в момент отпускания мыши):
//   Ctrl             — копия (оригинал на месте, копия едет полупрозрачной);
//   Shift            — за заголовок: весь объект (заголовок и его бытовки);
//   Ctrl+Shift       — за заголовок: копия всего объекта.
// Итог: onCommit([{ object, origin }]) — перенос (один объект или группа),
// onCopy([оригиналы], { dx, dy }) — копия одного объекта или группы.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { CABIN_SIZES, cabinLabels } from "./model";

export const DRAG_KIND = "text/x-layout-kind";
const SNAP = 0.5; // м — объекты встают ровно
const MIN_SCALE = 0.5; // px на метр
const MAX_SCALE = 200;
const TITLE_FONT = 2.2; // м
// Подписи в бытовке высотой 2,5 м — до двух строк, остальные — «(+N)».
const LABEL_FONT = 0.8;
const LABEL_LINE = 0.95;
const MAX_LABEL_LINES = 2;

const snap = (v) => Math.round(v / SNAP) * SNAP;
const snapAngle = (deg) => ((Math.round(deg / 45) * 45) % 360 + 360) % 360;
const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// Заголовок: примерная ширина текста — для рамки выделения и попадания мышью.
const titleWidth = (text) => Math.max(4, (text || "").length * TITLE_FONT * 0.6);

function bounds(objects) {
  const pts = [];
  for (const o of objects) {
    if (o.type === "cabin") {
      const { w } = CABIN_SIZES[o.size] || { w: 6 };
      pts.push([o.x - w / 2, o.y - w / 2], [o.x + w / 2, o.y + w / 2]);
    } else if (o.type === "title") {
      const half = titleWidth(o.text) / 2;
      pts.push([o.x - half, o.y - TITLE_FONT], [o.x + half, o.y + TITLE_FONT]);
    }
  }
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const LayoutCanvas = forwardRef(function LayoutCanvas(
  { objects, links, selectedId, peers, onSelect, onLiveMove, onCommit, onCopy, onDropNew, onCursor, onEdit, onRotate },
  ref
) {
  const svgRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ tx: 400, ty: 300, scale: 8 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef(null);
  const [ghosts, setGhosts] = useState([]); // копии, которые тянут с Ctrl: [{ ...оригинал, x, y }]
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const onRotateRef = useRef(onRotate);
  onRotateRef.current = onRotate;

  const byId = Object.fromEntries(objects.map((o) => [o.id, o]));

  const toWorld = useCallback((clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.tx) / v.scale, y: (clientY - r.top - v.ty) / v.scale };
  }, []);

  const fit = useCallback((list) => {
    const b = bounds(list);
    const { w, h } = size;
    if (!b) {
      setView({ tx: w / 2, ty: h / 2, scale: 8 });
      return;
    }
    const pad = 40;
    const scale = clampScale(Math.min((w - pad * 2) / Math.max(b.maxX - b.minX, 10), (h - pad * 2) / Math.max(b.maxY - b.minY, 10)));
    setView({ scale, tx: w / 2 - ((b.minX + b.maxX) / 2) * scale, ty: h / 2 - ((b.minY + b.maxY) / 2) * scale });
  }, [size]);

  useImperativeHandle(ref, () => ({
    fit: () => fit(objects),
    // Показать точку (заголовок выбранного объекта) в центре, не меняя масштаб.
    centerOn: (x, y) => {
      const v = viewRef.current;
      setView({ ...v, tx: size.w / 2 - x * v.scale, ty: size.h / 2 - y * v.scale });
    },
    // Центр видимой области в метрах — куда ставить объект по клику на панели.
    center: () => {
      const v = viewRef.current;
      return { x: snap((size.w / 2 - v.tx) / v.scale), y: snap((size.h / 2 - v.ty) / v.scale) };
    },
  }), [fit, objects, size]);

  useEffect(() => {
    const el = svgRef.current;
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Колесо: зум вокруг курсора; Shift+колесо — поворот выделенной бытовки.
  // Свой обработчик с passive: false — иначе браузер прокрутит страницу.
  useEffect(() => {
    const el = svgRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      if (e.shiftKey && selectedRef.current) {
        onRotateRef.current(selectedRef.current, (e.deltaY || e.deltaX) > 0 ? 45 : -45);
        return;
      }
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const scale = clampScale(v.scale * Math.exp(-e.deltaY * 0.0015));
        return { scale, tx: px - ((px - v.tx) * scale) / v.scale, ty: py - ((py - v.ty) * scale) / v.scale };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const startPan = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    onSelect(null);
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
    svgRef.current.setPointerCapture(e.pointerId);
  };

  const startMove = (e, obj) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!(e.ctrlKey || e.metaKey)) onSelect(obj.id);
    const w = toWorld(e.clientX, e.clientY);
    // Режим (перенос / копия / весь объект) решается по ходу перетаскивания
    // и окончательно — по клавишам в момент отпускания (см. dragMode).
    // Бытовки объекта запоминаем сразу: пока объект едет целиком, его
    // состав не меняется.
    const members = obj.type === "title"
      ? objects.filter((o) => o.type === "cabin" && links[o.id]?.titleId === obj.id)
      : [];
    drag.current = { kind: "move", id: obj.id, origin: obj, members, dx: w.x - obj.x, dy: w.y - obj.y, moved: false, delta: { dx: 0, dy: 0 } };
    svgRef.current.setPointerCapture(e.pointerId);
  };

  const startRotate = (e, obj) => {
    e.stopPropagation();
    drag.current = { kind: "rotate", id: obj.id, origin: obj, moved: false };
    svgRef.current.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const w = toWorld(e.clientX, e.clientY);
    onCursor(w.x, w.y);
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({ ...v, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy }));
    } else if (d.kind === "move") {
      const x = snap(w.x - d.dx);
      const y = snap(w.y - d.dy);
      if (x !== d.origin.x || y !== d.origin.y) d.moved = true;
      d.delta = { dx: x - d.origin.x, dy: y - d.origin.y };
      const { copy, group } = dragMode(d, e);
      const involved = [d.origin, ...d.members];
      const shifted = (o) => ({ ...o, x: o.x + d.delta.dx, y: o.y + d.delta.dy });
      // Что едет «вживую»: при копии — ничего (оригиналы на месте, едут
      // полупрозрачные копии), при переносе группы — все, иначе — только сам объект.
      onLiveMove(involved.map((o, i) => {
        const moving = !copy && (group || i === 0);
        return { id: o.id, x: moving ? o.x + d.delta.dx : o.x, y: moving ? o.y + d.delta.dy : o.y };
      }));
      setGhosts(copy && d.moved ? (group ? involved : [d.origin]).map(shifted) : []);
    } else if (d.kind === "rotate") {
      // Ручка над бытовкой: «вверх» = 0°.
      const rotation = snapAngle((Math.atan2(w.y - d.origin.y, w.x - d.origin.x) * 180) / Math.PI + 90);
      if (rotation !== d.origin.rotation) d.moved = true;
      onLiveMove([{ id: d.id, rotation }]);
    }
  };

  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    setGhosts([]);
    if (!d) return;
    if (d.kind === "rotate") {
      if (d.moved) onCommit([{ object: byId[d.id], origin: d.origin }]);
      return;
    }
    if (d.kind !== "move") return;
    if (!d.moved) {
      onSelect(d.id);
      return;
    }
    const { copy, group } = dragMode(d, e);
    const involved = group ? [d.origin, ...d.members] : [d.origin];
    // Сначала всё «живое» — на исходные места: итог применит страница.
    onLiveMove([d.origin, ...d.members].map((o) => ({ id: o.id, x: o.x, y: o.y })));
    if (copy) onCopy(involved, d.delta);
    else onCommit(involved.map((o) => ({ object: { ...o, x: o.x + d.delta.dx, y: o.y + d.delta.dy }, origin: o })));
  };

  // Клавиши решают по состоянию на этот момент (и при отпускании мыши).
  // Весь объект — только при перетаскивании заголовка.
  function dragMode(d, e) {
    return { copy: e.ctrlKey || e.metaKey, group: e.shiftKey && d.origin.type === "title" };
  }

  const onDrop = (e) => {
    const kind = e.dataTransfer.getData(DRAG_KIND);
    if (!kind) return;
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    onDropNew(kind, snap(w.x), snap(w.y));
  };

  const { tx, ty, scale } = view;
  const px = (n) => n / scale; // экранные пиксели -> метры (толщина линий, ручки)
  const visible = { x: -tx / scale, y: -ty / scale, w: size.w / scale, h: size.h / scale };
  const selected = byId[selectedId];
  const peerSelections = peers.filter((p) => p.selectedId && byId[p.selectedId]);

  // ghost — полупрозрачная копия под мышью: без выделения и обработчиков,
  // подписи — от оригинала.
  const renderCabin = (c, ghostOf = null) => {
    const dims = CABIN_SIZES[c.size] || CABIN_SIZES["6x2.5"];
    const labels = cabinLabels(objects, ghostOf || c.id).map((l) => l.text).filter((t) => t && t.trim());
    const maxChars = Math.max(4, Math.floor(dims.w / (LABEL_FONT * 0.58)));
    const upsideDown = c.rotation > 90 && c.rotation <= 270; // подписи всегда читаются не вверх ногами
    const isSelected = !ghostOf && c.id === selectedId;
    const peerSel = !ghostOf && peerSelections.find((p) => p.selectedId === c.id);
    return (
      <g key={ghostOf ? `ghost-${ghostOf}` : c.id} transform={`translate(${c.x} ${c.y}) rotate(${c.rotation})`}
        style={ghostOf ? { opacity: 0.55, pointerEvents: "none" } : { cursor: "move" }}
        onPointerDown={(e) => startMove(e, c)} onDoubleClick={() => onEdit(c.id)}>
        <rect x={-dims.w / 2} y={-dims.h / 2} width={dims.w} height={dims.h} rx={0.15}
          fill={c.size === "12x2.5" ? "#e6f0fb" : "#eaf6ec"}
          stroke={isSelected ? "#1976d2" : peerSel ? peerSel.color : "#3b5f8a"}
          strokeWidth={px(isSelected ? 3 : peerSel ? 2.5 : 1.4)}
          strokeDasharray={!isSelected && peerSel ? `${px(6)} ${px(4)}` : undefined} />
        <g transform={upsideDown ? "rotate(180)" : undefined}>
          {labels.length === 0 ? (
            <text textAnchor="middle" dominantBaseline="central" fontSize={LABEL_FONT} fill="#9aa6b5">
              {c.size === "12x2.5" ? "12×2,5" : "6×2,5"}
            </text>
          ) : (
            labels.slice(0, MAX_LABEL_LINES).map((t, i) => (
              <text key={i} y={(i - (Math.min(labels.length, MAX_LABEL_LINES) - 1) / 2) * LABEL_LINE} textAnchor="middle"
                dominantBaseline="central" fontSize={LABEL_FONT} fill="#1d2b3a">
                {t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t}
                {i === MAX_LABEL_LINES - 1 && labels.length > MAX_LABEL_LINES ? ` (+${labels.length - MAX_LABEL_LINES})` : ""}
              </text>
            ))
          )}
        </g>
        {isSelected && (
          <g onPointerDown={(e) => startRotate(e, c)} style={{ cursor: "grab" }}>
            <line x1={0} y1={-dims.h / 2} x2={0} y2={-dims.h / 2 - px(22)} stroke="#1976d2" strokeWidth={px(1.5)} />
            <circle cx={0} cy={-dims.h / 2 - px(22)} r={px(7)} fill="#fff" stroke="#1976d2" strokeWidth={px(2)} />
          </g>
        )}
      </g>
    );
  };

  const renderTitle = (t, ghostOf = null) => {
    const isSelected = !ghostOf && t.id === selectedId;
    const peerSel = !ghostOf && peerSelections.find((p) => p.selectedId === t.id);
    const width = titleWidth(t.text);
    return (
      <g key={ghostOf ? `ghost-${ghostOf}` : t.id} transform={`translate(${t.x} ${t.y})`}
        style={ghostOf ? { opacity: 0.55, pointerEvents: "none" } : { cursor: "move" }}
        onPointerDown={(e) => startMove(e, t)} onDoubleClick={() => onEdit(t.id)}>
        <rect x={-width / 2 - 0.5} y={-TITLE_FONT * 0.75} width={width + 1} height={TITLE_FONT * 1.5}
          fill={isSelected ? "rgba(25,118,210,0.06)" : "transparent"}
          stroke={isSelected ? "#1976d2" : peerSel ? peerSel.color : "none"}
          strokeWidth={px(isSelected ? 2 : 2)} strokeDasharray={isSelected ? undefined : `${px(6)} ${px(4)}`} />
        <text textAnchor="middle" dominantBaseline="central" fontSize={TITLE_FONT} fontWeight={700} fill="#14325c">
          {(t.text || "").trim() || "Без названия"}
        </text>
      </g>
    );
  };

  // Цепочка привязки для выделенного объекта: у заголовка — все его
  // бытовки (каждая линия — от бытовки к соседу, через которого она
  // привязана), у бытовки — её путь до заголовка. Видно, почему бытовка
  // попала в этот объект таблицы.
  const bindingLines = [];
  if (selected?.type === "title") {
    for (const c of objects) {
      const link = c.type === "cabin" && links[c.id];
      if (link && link.titleId === selected.id && byId[link.via]) bindingLines.push([byId[link.via], c]);
    }
  } else if (selected?.type === "cabin") {
    let cur = selected;
    for (let guard = 0; guard < 500 && links[cur.id] && byId[links[cur.id].via]; guard++) {
      const prev = byId[links[cur.id].via];
      bindingLines.push([prev, cur]);
      if (prev.type === "title") break;
      cur = prev;
    }
  }

  return (
    <svg ref={svgRef} width="100%" height="100%"
      style={{ display: "block", background: "#fff", touchAction: "none", userSelect: "none", cursor: ghosts.length ? "copy" : undefined }}
      onPointerDown={startPan} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <defs>
        <pattern id="grid1" width={1} height={1} patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#f1f4f8" strokeWidth={px(1)} />
        </pattern>
        <pattern id="grid10" width={10} height={10} patternUnits="userSpaceOnUse">
          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#dde4ec" strokeWidth={px(1)} />
        </pattern>
      </defs>
      <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
        {scale >= 6 && <rect x={visible.x} y={visible.y} width={visible.w} height={visible.h} fill="url(#grid1)" pointerEvents="none" />}
        <rect x={visible.x} y={visible.y} width={visible.w} height={visible.h} fill="url(#grid10)" pointerEvents="none" />

        {bindingLines.map(([t, c]) => (
          <line key={c.id} x1={t.x} y1={t.y} x2={c.x} y2={c.y} stroke="#5c9ae0" strokeWidth={px(1.5)}
            strokeDasharray={`${px(5)} ${px(4)}`} pointerEvents="none" />
        ))}

        {objects.filter((o) => o.type === "cabin").map((c) => renderCabin(c))}
        {objects.filter((o) => o.type === "title").map((t) => renderTitle(t))}
        {ghosts.map((g) => (g.type === "cabin" ? renderCabin(g, g.id) : renderTitle(g, g.id)))}

        {peers.filter((p) => p.x != null).map((p) => (
          <g key={p.socketId} transform={`translate(${p.x} ${p.y}) scale(${1 / scale})`} pointerEvents="none">
            <path d="M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7 11 L13 11 Z" fill={p.color} stroke="#fff" strokeWidth={1} />
            <rect x={14} y={12} width={p.name.length * 7 + 10} height={18} rx={4} fill={p.color} />
            <text x={19} y={25} fontSize={12} fill="#fff">{p.name}</text>
          </g>
        ))}
      </g>
      <text x={size.w - 10} y={size.h - 10} textAnchor="end" fontSize={11} fill="#9aa6b5" pointerEvents="none">
        {`1 клетка = ${scale >= 6 ? "1 м" : "10 м"} · масштаб ${Math.round(scale * 10) / 10} px/м`}
      </text>
    </svg>
  );
});

export default LayoutCanvas;
