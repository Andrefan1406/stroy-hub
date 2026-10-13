// Схема расположения бытовок — совместная правка в реальном времени.
//
// Слева — панель: бытовки 12×2,5 и 6×2,5 и заголовок перетаскиваются на
// холст (или ставятся по клику в центр). В центре — холст (LayoutCanvas).
// Справа — свойства выделенного объекта (подписи бытовки, текст заголовка)
// и сводная таблица, которая пересчитывается из схемы при любой правке.
//
// Синхронизация — сокет '/layouts' (server/layouts/socket.js): каждая
// правка — объект целиком (upsert) или удаление; применяется сразу у себя
// и откатывается, если сервер её не принял. Перетаскивание рассылается
// «на лету», курсоры и выделения других участников видны на холсте.
// Ctrl+Z отменяет свои действия.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as XLSX from "xlsx";
import { layoutsApi, createLayoutSocket, emitWithAck } from "../siteLayout/api";
import LayoutCanvas, { DRAG_KIND } from "../siteLayout/LayoutCanvas";
import { CABIN_SIZES, LINK_DISTANCE_M, bindCabinsDetailed, buildSummary, cabinLabels, newId, titleText, NO_OBJECT } from "../siteLayout/model";

const PALETTE = [
  { kind: "cabin12", label: "Бытовка 12×2,5", w: 96, h: 20 },
  { kind: "cabin6", label: "Бытовка 6×2,5", w: 48, h: 20 },
  { kind: "title", label: "Заголовок объекта" },
];
const MOVE_THROTTLE_MS = 60;
const CURSOR_THROTTLE_MS = 80;
const REMOTE_MOVE_TTL_MS = 3000;
const NUDGE = 0.5;

const isTyping = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

export default function SiteLayoutEditorPage() {
  const { id } = useParams();
  const layoutId = Number(id);
  const [layoutName, setLayoutName] = useState("");
  const [objects, setObjects] = useState({}); // id -> объект
  const [remoteMoves, setRemoteMoves] = useState({}); // id -> { x, y, rotation, at } — чужое перетаскивание
  const [peers, setPeers] = useState({}); // socketId -> { name, color, x, y, selectedId }
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState("connecting"); // connecting | online | offline
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState({}); // id -> текст в поле ввода, пока не сохранён
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [focusId, setFocusId] = useState(null); // поле, в которое поставить курсор
  const socketRef = useRef(null);
  const canvasRef = useRef(null);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const undoStack = useRef([]);
  const lastMoveSent = useRef(0);
  const lastCursorSent = useRef(0);
  const fittedOnce = useRef(false);

  // --- сокет ---
  useEffect(() => {
    const socket = createLayoutSocket();
    socketRef.current = socket;
    const join = async () => {
      const res = await emitWithAck(socket, "join", { layoutId });
      if (res.error) {
        setError(res.error);
        return;
      }
      setLayoutName(res.layout.name);
      setObjects(Object.fromEntries(res.layout.objects.map((o) => [o.id, o])));
      setPeers(Object.fromEntries(res.peers.map((p) => [p.socketId, p])));
      setStatus("online");
      setError("");
    };
    socket.on("connect", join); // и при переподключении — снимок заново
    socket.on("disconnect", () => setStatus("offline"));
    socket.on("connect_error", (err) => {
      setStatus("offline");
      setError(err.message || "Нет связи с сервером");
    });
    socket.on("op", (res) => {
      setObjects((prev) => {
        const next = { ...prev };
        if (res.object) next[res.object.id] = res.object;
        for (const d of res.deletedIds || []) delete next[d];
        return next;
      });
      const touched = res.object ? [res.object.id] : res.deletedIds || [];
      setRemoteMoves((prev) => {
        const next = { ...prev };
        for (const t of touched) delete next[t];
        return next;
      });
    });
    socket.on("move", (m) => setRemoteMoves((prev) => ({ ...prev, [m.id]: { x: m.x, y: m.y, rotation: m.rotation, at: Date.now() } })));
    socket.on("cursor", (c) => setPeers((prev) => ({ ...prev, [c.socketId]: { ...prev[c.socketId], ...c } })));
    socket.on("peer:joined", (p) => setPeers((prev) => ({ ...prev, [p.socketId]: p })));
    socket.on("peer:left", ({ socketId }) => setPeers((prev) => {
      const next = { ...prev };
      delete next[socketId];
      return next;
    }));
    const cleanup = setInterval(() => {
      setRemoteMoves((prev) => {
        const now = Date.now();
        const next = Object.fromEntries(Object.entries(prev).filter(([, m]) => now - m.at < REMOTE_MOVE_TTL_MS));
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 1000);
    return () => {
      clearInterval(cleanup);
      socket.disconnect();
    };
  }, [layoutId]);

  // Объекты с учётом чужого перетаскивания «на лету».
  const list = useMemo(
    () => Object.values(objects).map((o) => (remoteMoves[o.id] ? { ...o, ...remoteMoves[o.id], at: undefined } : o)),
    [objects, remoteMoves]
  );
  const links = useMemo(() => bindCabinsDetailed(list), [list]); // cabinId -> { titleId, via } | null
  const binding = useMemo(() => Object.fromEntries(Object.entries(links).map(([cid, l]) => [cid, l ? l.titleId : null])), [links]);
  const summary = useMemo(() => buildSummary(list), [list]);
  const peerList = Object.values(peers);

  useEffect(() => {
    if (!fittedOnce.current && status === "online" && canvasRef.current) {
      fittedOnce.current = true;
      canvasRef.current.fit();
    }
  }, [status]);

  // --- правки ---
  // ops — по порядку; before — состояние до правки (для отката и отмены).
  const sendOps = useCallback(async (ops, { before, undoable = true } = {}) => {
    const prev = before || objectsRef.current;
    const affected = new Set(ops.flatMap((op) => (op.kind === "delete"
      ? [op.id, ...Object.values(prev).filter((o) => o.parentId === op.id).map((o) => o.id)]
      : [op.object.id])));
    const snapshot = [...affected].map((oid) => [oid, prev[oid] || null]);
    // У себя — сразу.
    setObjects((cur) => {
      const next = { ...cur };
      for (const op of ops) {
        if (op.kind === "upsert") next[op.object.id] = op.object;
        else {
          delete next[op.id];
          for (const o of Object.values(next)) if (o.parentId === op.id) delete next[o.id];
        }
      }
      return next;
    });
    for (const op of ops) {
      const res = await emitWithAck(socketRef.current, "op", { layoutId, op });
      if (res.error) {
        setError(res.error);
        setObjects((cur) => {
          const next = { ...cur };
          for (const [oid, was] of snapshot) {
            if (was) next[oid] = was;
            else delete next[oid];
          }
          return next;
        });
        return false;
      }
      if (res.object) setObjects((cur) => ({ ...cur, [res.object.id]: res.object }));
    }
    if (undoable) {
      // Обратные правки: что было — вернуть, чего не было — удалить.
      // Бытовка восстанавливается раньше своих подписей.
      const restore = snapshot.filter(([, was]) => was).map(([, was]) => was)
        .sort((a, b) => (a.type === "label") - (b.type === "label"))
        .map((was) => ({ kind: "upsert", object: was }));
      const remove = snapshot.filter(([, was]) => !was).map(([oid]) => ({ kind: "delete", id: oid }));
      undoStack.current.push([...remove, ...restore]);
      if (undoStack.current.length > 100) undoStack.current.shift();
    }
    setError("");
    return true;
  }, [layoutId]);

  const upsert = (object, opts) => sendOps([{ kind: "upsert", object }], opts);

  const undo = useCallback(() => {
    const ops = undoStack.current.pop();
    if (ops) sendOps(ops, { undoable: false });
  }, [sendOps]);

  const addObject = (kind, x, y) => {
    let object;
    if (kind === "title") object = { id: newId("title"), type: "title", x, y, rotation: 0, text: "Новый объект" };
    else object = { id: newId("cabin"), type: "cabin", size: kind === "cabin12" ? "12x2.5" : "6x2.5", x, y, rotation: 0, text: "" };
    upsert(object);
    setSelectedId(object.id);
    if (kind === "title") setFocusId(object.id);
  };

  const rotateBy = useCallback((oid, delta) => {
    const o = objectsRef.current[oid];
    if (!o || o.type !== "cabin") return;
    upsert({ ...o, rotation: (((o.rotation + delta) % 360) + 360) % 360 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendOps]);

  const removeObject = useCallback((oid) => {
    if (!objectsRef.current[oid]) return;
    sendOps([{ kind: "delete", id: oid }]);
    setSelectedId((cur) => (cur === oid ? null : cur));
  }, [sendOps]);

  const addLabel = (cabinId) => {
    const labels = cabinLabels(Object.values(objectsRef.current), cabinId);
    const label = { id: newId("label"), type: "label", parentId: cabinId, text: "", sort: labels.length ? labels[labels.length - 1].sort + 1 : 0 };
    upsert(label);
    setFocusId(label.id);
  };

  // Текст сохраняется по Enter / уходу из поля; пустая подпись удаляется.
  const commitText = (oid) => {
    const draft = draftsRef.current[oid];
    setDrafts((d) => {
      const next = { ...d };
      delete next[oid];
      return next;
    });
    const o = objectsRef.current[oid];
    if (draft === undefined || !o || draft === o.text) return;
    if (o.type === "label" && !draft.trim()) removeObject(oid);
    else upsert({ ...o, text: draft });
  };

  // --- холст ---
  const dragOrigin = useRef(null);
  const onLiveMove = (oid, patch) => {
    if (!dragOrigin.current || dragOrigin.current.id !== oid) dragOrigin.current = objectsRef.current[oid];
    const moved = { ...objectsRef.current[oid], ...patch };
    setObjects((cur) => ({ ...cur, [oid]: moved }));
    const now = Date.now();
    if (now - lastMoveSent.current > MOVE_THROTTLE_MS) {
      lastMoveSent.current = now;
      socketRef.current.emit("move", { layoutId, id: oid, x: moved.x, y: moved.y, rotation: moved.rotation });
    }
  };
  const onCommit = (finalObj, origin) => {
    dragOrigin.current = null;
    upsert(finalObj, { before: { ...objectsRef.current, [origin.id]: origin } });
  };
  const onCursor = (x, y) => {
    const now = Date.now();
    if (now - lastCursorSent.current < CURSOR_THROTTLE_MS || !socketRef.current) return;
    lastCursorSent.current = now;
    socketRef.current.emit("cursor", { layoutId, x, y, selectedId });
  };
  const onEdit = (oid) => {
    const o = objectsRef.current[oid];
    if (!o) return;
    setSelectedId(oid);
    if (o.type === "title") setFocusId(oid);
    else {
      const first = cabinLabels(Object.values(objectsRef.current), oid)[0];
      if (first) setFocusId(first.id);
      else addLabel(oid);
    }
  };

  // Выделение видно другим сразу, не только при движении мыши.
  useEffect(() => {
    socketRef.current?.emit("cursor", { layoutId, selectedId });
  }, [selectedId, layoutId]);

  // --- клавиши ---
  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(document.activeElement)) return;
      const sel = selectedId && objectsRef.current[selectedId];
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
        e.preventDefault();
        undo();
      } else if (!sel) {
        // без выделения остальные клавиши ничего не делают
      } else if (e.code === "KeyR") {
        rotateBy(sel.id, e.shiftKey ? -45 : 45);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeObject(sel.id);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? NUDGE * 10 : NUDGE;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        upsert({ ...sel, x: sel.x + dx, y: sel.y + dy });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, undo, rotateBy, removeObject]);

  const renameLayout = async () => {
    const name = layoutName.trim();
    if (!name) return;
    try {
      await layoutsApi(`/${layoutId}`, { method: "PATCH", body: { name } });
    } catch (err) {
      setError(err.message);
    }
  };

  const exportExcel = () => {
    const aoa = [["Объект", "Бытовка", "Кол-во", "Что в ней находится"], ...summary.map((r) => [r.object, r.cabinType, r.count, r.content])];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = [{ wch: 28 }, { wch: 18 }, { wch: 8 }, { wch: 40 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Бытовки");
    XLSX.writeFile(book, `Бытовки — ${layoutName || "схема"}.xlsx`);
  };

  const selected = selectedId ? list.find((o) => o.id === selectedId) : null;
  const textValue = (o) => (drafts[o.id] !== undefined ? drafts[o.id] : o.text);
  const textProps = (o) => ({
    value: textValue(o),
    onChange: (e) => setDrafts((d) => ({ ...d, [o.id]: e.target.value })),
    onBlur: () => commitText(o.id),
    onKeyDown: (e) => {
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") {
        // Отказ от правки: черновик выбрасываем до blur, иначе он сохранится.
        draftsRef.current = { ...draftsRef.current, [o.id]: undefined };
        e.currentTarget.blur();
      }
    },
    ref: focusId === o.id ? (el) => { if (el) { el.focus(); el.select(); setFocusId(null); } } : undefined,
  });

  return (
    <div style={s.page}>
      <header style={s.header}>
        <Link to="/site-layouts" style={s.back}>← Схемы</Link>
        <input style={s.nameInput} value={layoutName} onChange={(e) => setLayoutName(e.target.value)}
          onBlur={renameLayout} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} title="Название схемы" />
        <span style={{ ...s.status, color: status === "online" ? "#2e7d32" : "#c62828" }}>
          ● {status === "online" ? "на связи" : status === "connecting" ? "подключение…" : "нет связи — правки не сохраняются"}
        </span>
        <div style={s.peers}>
          {peerList.map((p) => (
            <span key={p.socketId} style={{ ...s.peer, background: p.color }} title={p.email}>{p.name}</span>
          ))}
        </div>
      </header>
      {error && <div style={s.error} onClick={() => setError("")}>{error}</div>}

      <div style={s.body}>
        <aside style={s.palette}>
          <div style={s.paletteTitle}>Перетащите на схему</div>
          {PALETTE.map((p) => (
            <div key={p.kind} draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_KIND, p.kind)}
              onClick={() => { const c = canvasRef.current.center(); addObject(p.kind, c.x, c.y); }}
              style={s.paletteItem} title="Перетащите на холст или нажмите — появится в центре">
              {p.kind === "title" ? (
                <span style={s.paletteTitleSample}>Аа</span>
              ) : (
                <span style={{ ...s.paletteCabin, width: p.w, height: p.h, background: p.kind === "cabin12" ? "#e6f0fb" : "#eaf6ec" }} />
              )}
              <span style={s.paletteLabel}>{p.label}</span>
            </div>
          ))}
          <button type="button" style={s.tool} onClick={() => canvasRef.current.fit()}>Показать всю схему</button>
          <button type="button" style={s.tool} onClick={undo}>Отменить (Ctrl+Z)</button>
          <div style={s.hints}>
            <b>Управление</b>
            <div>Колесо — масштаб, перетаскивание пустого места — прокрутка</div>
            <div>R / Shift+R или Shift+колесо — поворот на 45°</div>
            <div>Стрелки — сдвиг на 0,5 м (с Shift — на 5 м)</div>
            <div>Двойной щелчок — подпись / текст</div>
            <div>Delete — удалить</div>
            <div>Бытовка входит в объект, если до соседней бытовки этого объекта (или до заголовка) не больше {LINK_DISTANCE_M} м</div>
          </div>
        </aside>

        <main style={s.canvasWrap}>
          <LayoutCanvas ref={canvasRef} objects={list} links={links} selectedId={selectedId} peers={peerList}
            onSelect={setSelectedId} onLiveMove={onLiveMove} onCommit={onCommit} onDropNew={addObject}
            onCursor={onCursor} onEdit={onEdit} onRotate={rotateBy} />
        </main>

        <aside style={s.side}>
          <section style={s.panel}>
            <h3 style={s.panelTitle}>Свойства</h3>
            {!selected && <p style={s.muted}>Выберите бытовку или заголовок на схеме.</p>}
            {selected?.type === "title" && (
              <>
                <label style={s.fieldLabel}>Название объекта (крупный текст)</label>
                <input style={s.input} {...textProps(selected)} placeholder="Например: Поз. 59" />
                <p style={s.muted}>
                  Бытовок в объекте: {list.filter((o) => o.type === "cabin" && binding[o.id] === selected.id).length}
                  {" "}— цепочка соседних бытовок с промежутками до {LINK_DISTANCE_M} м, первая — не дальше {LINK_DISTANCE_M} м от заголовка
                </p>
                <button type="button" style={s.danger} onClick={() => removeObject(selected.id)}>Удалить заголовок</button>
              </>
            )}
            {selected?.type === "cabin" && (
              <>
                <div style={s.row}>
                  <select style={s.input} value={selected.size} onChange={(e) => upsert({ ...objects[selected.id], size: e.target.value })}>
                    {Object.entries(CABIN_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                  <button type="button" style={s.iconBtn} title="Повернуть на −45°" onClick={() => rotateBy(selected.id, -45)}>⟲</button>
                  <button type="button" style={s.iconBtn} title="Повернуть на +45°" onClick={() => rotateBy(selected.id, 45)}>⟳</button>
                  <span style={s.muted}>{selected.rotation}°</span>
                </div>
                <p style={s.muted}>
                  Объект: <b>{binding[selected.id] && objects[binding[selected.id]] ? titleText(objects[binding[selected.id]]) : NO_OBJECT}</b>
                  {" "}(через соседние бытовки: до соседней не больше {LINK_DISTANCE_M} м)
                </p>
                <label style={s.fieldLabel}>Что находится в бытовке (мелкий текст)</label>
                {cabinLabels(list, selected.id).map((l) => (
                  <div key={l.id} style={s.row}>
                    <input style={s.input} {...textProps(l)} placeholder="Например: кабинет прораба" />
                    <button type="button" style={s.iconBtn} title="Убрать подпись" onClick={() => removeObject(l.id)}>×</button>
                  </div>
                ))}
                <button type="button" style={s.tool} onClick={() => addLabel(selected.id)}>+ Добавить подпись</button>
                <button type="button" style={s.danger} onClick={() => removeObject(selected.id)}>Удалить бытовку</button>
              </>
            )}
          </section>

          <section style={{ ...s.panel, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={s.tableHead}>
              <h3 style={s.panelTitle}>Таблица бытовок</h3>
              <button type="button" style={s.tool} disabled={!summary.length} onClick={exportExcel}>Excel</button>
            </div>
            <div style={s.tableWrap}>
              {summary.length === 0 ? (
                <p style={s.muted}>Расставьте бытовки — таблица соберётся сама.</p>
              ) : (
                <table style={s.table}>
                  <thead>
                    <tr><th style={s.th}>Объект</th><th style={s.th}>Бытовка</th><th style={s.th}>Кол-во</th><th style={s.th}>Что в ней находится</th></tr>
                  </thead>
                  <tbody>
                    {summary.map((r, i) => (
                      <tr key={i}>
                        <td style={{ ...s.td, color: r.object === NO_OBJECT ? "#c62828" : undefined }}>{r.object}</td>
                        <td style={s.td}>{r.cabinType}</td>
                        <td style={{ ...s.td, textAlign: "center" }}>{r.count}</td>
                        <td style={s.td}>{r.content}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

const s = {
  page: { height: "100vh", display: "flex", flexDirection: "column", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: "#f5f7fa" },
  // Справа место под кнопку входа/выхода (AccountBar, position: fixed).
  header: { display: "flex", alignItems: "center", gap: 12, padding: "8px 170px 8px 14px", background: "#fff", borderBottom: "1px solid #e1e6ec", flexWrap: "wrap" },
  back: { color: "#1976d2", textDecoration: "none", fontSize: 14 },
  nameInput: { fontSize: 17, fontWeight: 700, border: "1px solid transparent", borderRadius: 6, padding: "4px 8px", minWidth: 200, flex: "0 1 420px" },
  status: { fontSize: 12 },
  peers: { display: "flex", gap: 6, flexWrap: "wrap" },
  peer: { color: "#fff", fontSize: 12, borderRadius: 10, padding: "2px 8px" },
  error: { background: "#fff0f0", color: "#c00", padding: "8px 14px", fontSize: 13, cursor: "pointer" },
  body: { flex: 1, minHeight: 0, display: "flex" },
  palette: { width: 190, flexShrink: 0, background: "#fff", borderRight: "1px solid #e1e6ec", padding: 12, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" },
  paletteTitle: { fontSize: 12, color: "#667", fontWeight: 600 },
  paletteItem: { border: "1px solid #dfe5ec", borderRadius: 8, padding: "10px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "grab", background: "#fafcfe" },
  paletteCabin: { display: "block", border: "1.5px solid #3b5f8a", borderRadius: 2 },
  paletteTitleSample: { fontSize: 20, fontWeight: 800, color: "#14325c" },
  paletteLabel: { fontSize: 12, color: "#334" },
  tool: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer" },
  hints: { fontSize: 11, color: "#667", display: "flex", flexDirection: "column", gap: 4, marginTop: 6 },
  canvasWrap: { flex: 1, minWidth: 0, position: "relative" },
  side: { width: 380, flexShrink: 0, background: "#fff", borderLeft: "1px solid #e1e6ec", display: "flex", flexDirection: "column", minHeight: 0 },
  panel: { padding: 12, borderBottom: "1px solid #eef1f4" },
  panelTitle: { margin: "0 0 8px", fontSize: 14 },
  muted: { color: "#667", fontSize: 12, margin: "6px 0" },
  fieldLabel: { display: "block", fontSize: 12, fontWeight: 600, color: "#445", margin: "8px 0 4px" },
  input: { flex: 1, minWidth: 0, width: "100%", boxSizing: "border-box", padding: "6px 8px", border: "1px solid #c8d0da", borderRadius: 6, fontSize: 13 },
  row: { display: "flex", gap: 6, alignItems: "center", marginBottom: 6 },
  iconBtn: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, width: 30, height: 30, cursor: "pointer", fontSize: 15, flexShrink: 0 },
  danger: { display: "block", marginTop: 10, background: "#fff0f0", color: "#c62828", border: "1px solid #f2b8b5", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer" },
  tableHead: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  tableWrap: { overflow: "auto", flex: 1, minHeight: 0 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { textAlign: "left", background: "#f3f6f9", padding: "6px", borderBottom: "1px solid #dde3ea", position: "sticky", top: 0 },
  td: { padding: "6px", borderBottom: "1px solid #eef1f4", verticalAlign: "top" },
};
