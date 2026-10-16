// Подсчёт объёмов отделочных работ по PDF-чертежу.
//
// 1. Загрузить многостраничный PDF, выбрать лист (номер страницы).
// 2. Откалибровать лист: по известному размеру (две точки + длина в
//    метрах) или по масштабу листа 1:N.
// 3. Обвести контуры: «Площадь» (пол, потолок, проёмы), «Длина» (стены по
//    контуру на плане — × высота, плинтус). Проём — с отметкой «Вычет».
// 4. У замера указать вид работ, помещение, способ расчёта, высоту или
//    толщину, число одинаковых.
// 5. Ведомость объёмов — итог по видам работ; выгрузка в Excel.
//
// Всё считается в браузере; замеры и калибровка сохраняются на этом
// компьютере для этого PDF (по имени и размеру файла) и подставляются при
// следующем открытии того же файла.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { openPdf } from "../takeoff/pdf";
import TakeoffCanvas from "../takeoff/TakeoffCanvas";
import {
  CALCS, WORK_SUGGESTIONS, buildStatement, defaultCalc, distance, measurementQuantity, metersPerUnitFromDistance,
  metersPerUnitFromScale, unitOf,
} from "../takeoff/model";

const STORAGE_PREFIX = "takeoff:v1:";
const SCALES = [10, 20, 25, 50, 75, 100, 200, 500];
const PALETTE = ["#1565c0", "#2e7d32", "#6a1b9a", "#00838f", "#ef6c00", "#5d4037", "#ad1457", "#558b2f"];

const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fmt = (v) => (v == null ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: 2, minimumFractionDigits: 2 }));

function loadProject(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

export default function TakeoffPage() {
  const [file, setFile] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [calibrations, setCalibrations] = useState({}); // страница -> метров в единице PDF
  const [measurements, setMeasurements] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("select"); // select | area | line | calibrate
  const [deduct, setDeduct] = useState(false);
  const [lastWork, setLastWork] = useState({ area: "", line: "" });
  const [calibPoints, setCalibPoints] = useState(null); // ждём длину в метрах
  const [calibMeters, setCalibMeters] = useState("");
  const [scaleN, setScaleN] = useState("");
  const [tab, setTab] = useState("page"); // page | statement
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const canvasRef = useRef(null);
  const projectKey = file ? `${STORAGE_PREFIX}${file.name}:${file.size}` : null;

  // --- файл ---
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError("");
    setStatus("Открываем PDF…");
    try {
      const doc = await openPdf(f);
      const saved = loadProject(`${STORAGE_PREFIX}${f.name}:${f.size}`);
      setFile(f);
      setPdf(doc);
      setNumPages(doc.numPages);
      setCalibrations(saved?.calibrations || {});
      setMeasurements(saved?.measurements || []);
      const startPage = Math.min(saved?.pageNumber || 1, doc.numPages);
      setPageNumber(startPage);
      setPageInput(String(startPage));
      setSelectedId(null);
      setMode("select");
      setStatus(saved?.measurements?.length ? `Восстановлено замеров: ${saved.measurements.length}` : "");
    } catch (err) {
      setError(`Не удалось открыть PDF: ${err.message}`);
      setStatus("");
    }
  };

  // Автосохранение на этом компьютере.
  useEffect(() => {
    if (!projectKey) return;
    try {
      localStorage.setItem(projectKey, JSON.stringify({ calibrations, measurements, pageNumber }));
    } catch {
      // нет места или хранилище недоступно — работаем без сохранения
    }
  }, [projectKey, calibrations, measurements, pageNumber]);

  const goPage = (n) => {
    const p = Math.max(1, Math.min(numPages, Number(n) || 1));
    setPageNumber(p);
    setPageInput(String(p));
    setSelectedId(null);
  };

  // --- калибровка ---
  const metersPerUnit = calibrations[pageNumber] || null;
  const onCalibrated = (points) => {
    setCalibPoints(points);
    setCalibMeters("");
  };
  const applyCalibration = (e) => {
    e.preventDefault();
    const meters = Number(String(calibMeters).replace(",", "."));
    const mpu = metersPerUnitFromDistance(distance(calibPoints[0], calibPoints[1]), meters);
    if (!mpu) {
      setError("Укажите длину отрезка в метрах — больше нуля");
      return;
    }
    setCalibrations((c) => ({ ...c, [pageNumber]: mpu }));
    setCalibPoints(null);
    setMode("select");
    setError("");
  };
  const applyScale = (n) => {
    const v = Number(n);
    if (!(v > 0)) return;
    setCalibrations((c) => ({ ...c, [pageNumber]: metersPerUnitFromScale(v) }));
    setScaleN("");
  };

  // --- замеры ---
  const onFinish = useCallback(({ kind, points }) => {
    const work = lastWork[kind] || "";
    const suggested = WORK_SUGGESTIONS.find((w) => w.work === work);
    const m = {
      id: newId(),
      page: pageNumber,
      kind,
      points,
      work,
      room: "",
      // Проём на плане (вычет линией по его ширине) — сразу «длина × высота»
      // с высотой двери; у стен — высота этажа.
      calc: kind === "line" && deduct ? "wall" : suggested && CALCS[suggested.calc].kind === kind ? suggested.calc : defaultCalc(kind),
      height: kind === "line" ? (deduct ? "2,1" : "2,7") : undefined,
      thickness: undefined,
      count: 1,
      deduct,
    };
    setMeasurements((list) => [...list, m]);
    setSelectedId(m.id);
  }, [lastWork, pageNumber, deduct]);

  const update = (id, patch) => setMeasurements((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const remove = (id) => {
    setMeasurements((list) => list.filter((m) => m.id !== id));
    setSelectedId(null);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.key === "Delete" && selectedId && mode === "select") remove(selectedId);
      if (e.key === "Escape" && mode === "select") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pageMeasurements = measurements.filter((m) => m.page === pageNumber);
  const selected = measurements.find((m) => m.id === selectedId) || null;

  // Цвет — по виду работ: одинаковые работы одним цветом.
  const colorFor = useCallback((m) => {
    let h = 0;
    for (const ch of m.work || "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }, []);
  const labelFor = useCallback((m) => {
    const q = measurementQuantity(m, calibrations[m.page]);
    return q == null ? "" : `${fmt(q)} ${unitOf(m)}`;
  }, [calibrations]);

  const statement = useMemo(() => buildStatement(measurements, calibrations), [measurements, calibrations]);

  const exportExcel = () => {
    const book = XLSX.utils.book_new();
    const total = XLSX.utils.aoa_to_sheet([
      ["Ведомость объёмов работ"],
      [file ? `Чертёж: ${file.name}` : ""],
      [],
      ["№", "Вид работ", "Ед. изм.", "Количество"],
      ...statement.rows.map((r, i) => [i + 1, r.work, r.unit, r.quantity]),
    ]);
    total["!cols"] = [{ wch: 5 }, { wch: 40 }, { wch: 10 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(book, total, "Ведомость");
    const details = XLSX.utils.aoa_to_sheet([
      ["Вид работ", "Помещение", "Лист PDF", "Ед. изм.", "Количество", "Вычет", "× одинаковых"],
      ...statement.details.map((d) => [d.work, d.room, d.page, d.unit, d.quantity, d.deduct ? "да" : "", d.count]),
    ]);
    details["!cols"] = [{ wch: 36 }, { wch: 20 }, { wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 7 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(book, details, "Замеры");
    XLSX.writeFile(book, `Ведомость объёмов — ${file ? file.name.replace(/\.pdf$/i, "") : "чертёж"}.xlsx`);
  };

  const clearProject = () => {
    if (!window.confirm("Удалить все замеры и калибровку этого чертежа?")) return;
    setMeasurements([]);
    setCalibrations({});
    setSelectedId(null);
  };

  const tool = (m, label, title) => (
    <button type="button" title={title} style={mode === m ? { ...s.tool, ...s.toolActive } : s.tool}
      onClick={() => setMode(mode === m ? "select" : m)} disabled={!pdf}>{label}</button>
  );

  return (
    <div style={s.page}>
      <header style={s.header}>
        <Link to="/" style={s.back}>← На главную</Link>
        <h1 style={s.title}>Подсчёт объёмов по чертежам</h1>
        {status && <span style={s.status}>{status}</span>}
      </header>
      {error && <div style={s.error} onClick={() => setError("")}>{error}</div>}

      <div style={s.body}>
        <aside style={s.left}>
          <section style={s.block}>
            <div style={s.blockTitle}>1. Чертёж (PDF)</div>
            <input type="file" accept="application/pdf,.pdf" onChange={onFile} style={{ fontSize: 12, width: "100%" }} />
            {file && <div style={s.muted}>{file.name}</div>}
          </section>

          <section style={s.block}>
            <div style={s.blockTitle}>2. Лист</div>
            <div style={s.row}>
              <button type="button" style={s.small} disabled={!pdf || pageNumber <= 1} onClick={() => goPage(pageNumber - 1)}>‹</button>
              <input style={{ ...s.input, width: 56, textAlign: "center" }} value={pageInput} disabled={!pdf}
                onChange={(e) => setPageInput(e.target.value)} onBlur={() => goPage(pageInput)}
                onKeyDown={(e) => e.key === "Enter" && goPage(pageInput)} />
              <span style={s.muted}>из {numPages || "—"}</span>
              <button type="button" style={s.small} disabled={!pdf || pageNumber >= numPages} onClick={() => goPage(pageNumber + 1)}>›</button>
            </div>
          </section>

          <section style={s.block}>
            <div style={s.blockTitle}>3. Калибровка листа</div>
            {metersPerUnit ? (
              <div style={s.ok}>✓ Лист откалиброван</div>
            ) : (
              <div style={s.warn}>Лист не откалиброван — объёмы не считаются</div>
            )}
            {tool("calibrate", "📏 По размеру на чертеже", "Щёлкните по двум концам размера с известной длиной")}
            {mode === "calibrate" && <div style={s.hint}>Щёлкните по началу и концу размера, длина которого известна (например, ось 6000 мм).</div>}
            <div style={{ ...s.row, marginTop: 6 }}>
              <span style={s.muted}>или масштаб 1:</span>
              <select style={{ ...s.input, width: 80 }} value={scaleN} disabled={!pdf} onChange={(e) => applyScale(e.target.value)}>
                <option value="">—</option>
                {SCALES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div style={s.hint}>Масштаб верен, если PDF сохранён в натуральный размер листа. Надёжнее — по размеру.</div>
          </section>

          <section style={s.block}>
            <div style={s.blockTitle}>4. Обвести</div>
            {tool("select", "🖐 Выбор / прокрутка")}
            {tool("area", "⬛ Площадь (контур)", "Пол, потолок, проём — щелчками по углам, двойной щелчок — готово")}
            {tool("line", "〰 Длина (линия)", "Стены по контуру помещения (× высота), плинтус")}
            <label style={s.check}>
              <input type="checkbox" checked={deduct} onChange={(e) => setDeduct(e.target.checked)} /> Новый замер — вычет (проём)
            </label>
            <div style={s.hint}>
              Щелчок — точка, Shift — строго по горизонтали/вертикали, двойной щелчок или Enter — готово, Backspace — убрать точку, Esc — отменить.
              Колесо — масштаб, средняя кнопка или пробел + мышь — прокрутка.
            </div>
            <button type="button" style={s.small} disabled={!pdf} onClick={() => canvasRef.current?.fit()}>Весь лист</button>
          </section>
        </aside>

        <main style={s.center}>
          {pdf ? (
            <TakeoffCanvas ref={canvasRef} pdf={pdf} pageNumber={pageNumber} measurements={pageMeasurements}
              selectedId={selectedId} mode={mode} deduct={deduct} metersPerUnit={metersPerUnit}
              labelFor={labelFor} colorFor={colorFor} onSelect={setSelectedId} onFinish={onFinish}
              onCalibrated={onCalibrated} onStatus={setStatus} />
          ) : (
            <div style={s.empty}>Загрузите PDF с чертежом — слева, «Чертёж (PDF)».</div>
          )}
        </main>

        <aside style={s.right}>
          <div style={s.tabs}>
            <button type="button" style={tab === "page" ? s.tabActive : s.tab} onClick={() => setTab("page")}>Замеры листа ({pageMeasurements.length})</button>
            <button type="button" style={tab === "statement" ? s.tabActive : s.tab} onClick={() => setTab("statement")}>Ведомость</button>
          </div>

          {tab === "page" && (
            <>
              {selected && (
                <section style={s.props}>
                  <div style={s.blockTitle}>Замер {selected.deduct ? "(вычет)" : ""}</div>
                  <label style={s.label}>Вид работ</label>
                  <input style={s.input} list="takeoff-works" value={selected.work} placeholder="Например: Штукатурка стен"
                    onChange={(e) => {
                      const work = e.target.value;
                      const sug = WORK_SUGGESTIONS.find((w) => w.work === work);
                      const patch = { work };
                      if (sug && CALCS[sug.calc].kind === selected.kind) patch.calc = sug.calc;
                      update(selected.id, patch);
                      setLastWork((l) => ({ ...l, [selected.kind]: work }));
                    }} />
                  <datalist id="takeoff-works">{WORK_SUGGESTIONS.map((w) => <option key={w.work} value={w.work} />)}</datalist>
                  <label style={s.label}>Помещение</label>
                  <input style={s.input} value={selected.room} placeholder="Например: Кухня, кв. 12" onChange={(e) => update(selected.id, { room: e.target.value })} />
                  <label style={s.label}>Считать</label>
                  <select style={s.input} value={selected.calc} onChange={(e) => update(selected.id, { calc: e.target.value })}>
                    {Object.entries(CALCS).filter(([, c]) => c.kind === selected.kind).map(([key, c]) => (
                      <option key={key} value={key}>{c.label}, {c.unit}</option>
                    ))}
                  </select>
                  {selected.calc === "wall" && (
                    <>
                      <label style={s.label}>{selected.deduct ? "Высота проёма, м" : "Высота стен, м"}</label>
                      <input style={s.input} inputMode="decimal" value={selected.height ?? ""} onChange={(e) => update(selected.id, { height: e.target.value })} />
                    </>
                  )}
                  {selected.calc === "volume" && (
                    <>
                      <label style={s.label}>Толщина, м</label>
                      <input style={s.input} inputMode="decimal" value={selected.thickness ?? ""} placeholder="например 0,05" onChange={(e) => update(selected.id, { thickness: e.target.value })} />
                    </>
                  )}
                  <div style={s.row}>
                    <label style={{ ...s.label, margin: 0 }}>× одинаковых</label>
                    <input style={{ ...s.input, width: 60 }} inputMode="numeric" value={selected.count}
                      onChange={(e) => update(selected.id, { count: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                  </div>
                  <label style={s.check}>
                    <input type="checkbox" checked={!!selected.deduct} onChange={(e) => update(selected.id, { deduct: e.target.checked })} />
                    {selected.kind === "area" ? " Вычет (проём, колонна)" : " Вычет (дверь, окно: ширина × высота проёма)"}
                  </label>
                  <div style={s.qty}>
                    = {labelFor(selected) || (metersPerUnit ? "укажите высоту / толщину" : "лист не откалиброван")}
                  </div>
                  <button type="button" style={s.danger} onClick={() => remove(selected.id)}>Удалить замер</button>
                </section>
              )}
              <div style={s.list}>
                {pageMeasurements.length === 0 && <p style={s.muted}>На этом листе замеров нет.</p>}
                {pageMeasurements.map((m) => (
                  <button key={m.id} type="button" style={m.id === selectedId ? { ...s.item, ...s.itemActive } : s.item}
                    onClick={() => { setSelectedId(m.id); setMode("select"); }}>
                    <span style={{ ...s.dot, background: m.deduct ? "#c62828" : colorFor(m) }} />
                    <span style={{ flex: 1, textAlign: "left" }}>
                      {m.work || "Без названия"}{m.room ? ` · ${m.room}` : ""}{m.deduct ? " (вычет)" : ""}
                    </span>
                    <b>{labelFor(m) || "—"}</b>
                  </button>
                ))}
              </div>
            </>
          )}

          {tab === "statement" && (
            <div style={s.list}>
              <div style={s.row}>
                <button type="button" style={s.primary} disabled={!statement.rows.length} onClick={exportExcel}>Скачать Excel</button>
                <button type="button" style={s.small} disabled={!measurements.length} onClick={clearProject}>Очистить чертёж</button>
              </div>
              {statement.skipped.length > 0 && (
                <div style={s.warn}>
                  Не вошли в итог: {statement.skipped.length} — лист не откалиброван или не указана высота/толщина.
                </div>
              )}
              {statement.rows.length === 0 ? (
                <p style={s.muted}>Обведите контуры и укажите вид работ — ведомость соберётся сама.</p>
              ) : (
                <table style={s.table}>
                  <thead><tr><th style={s.th}>Вид работ</th><th style={s.th}>Ед.</th><th style={{ ...s.th, textAlign: "right" }}>Кол-во</th></tr></thead>
                  <tbody>
                    {statement.rows.map((r) => (
                      <tr key={`${r.work}|${r.unit}`}>
                        <td style={s.td}>{r.work}</td>
                        <td style={s.td}>{r.unit}</td>
                        <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmt(r.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </aside>
      </div>

      {calibPoints && (
        <div style={s.overlay}>
          <form style={s.modal} onSubmit={applyCalibration}>
            <h3 style={{ marginTop: 0 }}>Калибровка листа {pageNumber}</h3>
            <p style={s.muted}>Какая настоящая длина у отмеченного отрезка?</p>
            <div style={s.row}>
              <input autoFocus style={{ ...s.input, flex: 1, width: "auto" }} inputMode="decimal" value={calibMeters} onChange={(e) => setCalibMeters(e.target.value)} placeholder="например 6 или 6,0" />
              <span>м</span>
            </div>
            <div style={{ ...s.row, justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" style={s.small} onClick={() => setCalibPoints(null)}>Отмена</button>
              <button type="submit" style={s.primary}>Применить</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const s = {
  page: { height: "100vh", display: "flex", flexDirection: "column", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: "#f5f7fa" },
  // Справа место под кнопку входа/выхода (AccountBar, position: fixed).
  header: { display: "flex", alignItems: "center", gap: 14, padding: "8px 170px 8px 14px", background: "#fff", borderBottom: "1px solid #e1e6ec", flexWrap: "wrap" },
  back: { color: "#1976d2", textDecoration: "none", fontSize: 14 },
  title: { fontSize: 17, margin: 0 },
  status: { fontSize: 12, color: "#667" },
  error: { background: "#fff0f0", color: "#c00", padding: "8px 14px", fontSize: 13, cursor: "pointer" },
  body: { flex: 1, minHeight: 0, display: "flex" },
  left: { width: 230, flexShrink: 0, background: "#fff", borderRight: "1px solid #e1e6ec", padding: 10, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 },
  center: { flex: 1, minWidth: 0, position: "relative" },
  right: { width: 340, flexShrink: 0, background: "#fff", borderLeft: "1px solid #e1e6ec", display: "flex", flexDirection: "column", minHeight: 0 },
  block: { display: "flex", flexDirection: "column", gap: 6, paddingBottom: 10, borderBottom: "1px solid #eef1f4" },
  blockTitle: { fontWeight: 700, fontSize: 13, color: "#1f5fa8" },
  row: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  input: { padding: "6px 8px", border: "1px solid #c8d0da", borderRadius: 6, fontSize: 13, boxSizing: "border-box", width: "100%" },
  tool: { textAlign: "left", background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "7px 10px", fontSize: 13, cursor: "pointer" },
  toolActive: { background: "#1976d2", borderColor: "#1976d2", color: "#fff" },
  small: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
  primary: { background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  danger: { background: "#fff0f0", color: "#c62828", border: "1px solid #f2b8b5", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer", marginTop: 8 },
  check: { fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginTop: 4 },
  hint: { fontSize: 11, color: "#667", lineHeight: 1.4 },
  muted: { fontSize: 12, color: "#667" },
  ok: { fontSize: 12, color: "#2e7d32", fontWeight: 600 },
  warn: { fontSize: 12, color: "#8a5a00", background: "#fff6e0", borderRadius: 6, padding: "6px 8px", margin: "4px 0" },
  empty: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#667", fontSize: 15 },
  tabs: { display: "flex", borderBottom: "1px solid #e1e6ec" },
  tab: { flex: 1, background: "none", border: "none", borderBottom: "2px solid transparent", padding: "10px 6px", fontSize: 13, cursor: "pointer", color: "#555" },
  tabActive: { flex: 1, background: "none", border: "none", borderBottom: "2px solid #1976d2", padding: "10px 6px", fontSize: 13, cursor: "pointer", color: "#1976d2", fontWeight: 600 },
  props: { padding: 10, borderBottom: "1px solid #eef1f4", display: "flex", flexDirection: "column", gap: 4, background: "#f8fbff" },
  label: { fontSize: 12, fontWeight: 600, color: "#445", marginTop: 4 },
  qty: { fontSize: 15, fontWeight: 700, color: "#0d47a1", marginTop: 6 },
  list: { padding: 10, overflowY: "auto", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 },
  item: { display: "flex", alignItems: "center", gap: 8, background: "#fff", border: "1px solid #e3e8ee", borderRadius: 6, padding: "7px 8px", fontSize: 12, cursor: "pointer" },
  itemActive: { borderColor: "#1976d2", background: "#eef6ff" },
  dot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 6 },
  th: { textAlign: "left", background: "#f3f6f9", padding: 6, borderBottom: "1px solid #dde3ea" },
  td: { padding: 6, borderBottom: "1px solid #eef1f4" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modal: { background: "#fff", borderRadius: 10, padding: 20, width: 340, maxWidth: "92vw", boxSizing: "border-box" },
};
