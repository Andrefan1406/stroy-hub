// Подсчёт объёмов работ по PDF-чертежу.
//
// 1. Загрузить многостраничный PDF, выбрать лист (номер страницы).
// 2. Откалибровать лист: по известному размеру (две точки + длина в
//    метрах) или по масштабу листа 1:N.
// 3. Обвести: «Площадь» (пол, потолок), «Длина» (стены по плану — × высота,
//    плинтус), «Прямоугольник» (вентшахта и её каналы), «Проём на плане»
//    (дверь/окно по ширине в выделенной стене).
// 4. У замера — работа из справочника (общие нормы на сервере, кладка:
//    этаж/высота, толщина, проёмы, расход материала) или свой вид работ
//    (отделка: способ расчёта, высота/толщина, вычеты).
// 5. Ведомость — по группам и работам, расход материалов; выгрузка в Excel.
//
// Всё считается в браузере. Замеры, калибровка, этажи и проёмы сохраняются
// на этом компьютере для этого PDF (по имени и размеру файла).
//
// Новая редакция чертежа — «Заменить чертёж»: замеры переносятся на новый
// PDF (сопоставление листов, совмещение по двум точкам), старый проект
// остаётся под старым файлом. До перезагрузки страницы можно подсветить
// изменения между редакциями.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { openPdf } from "../takeoff/pdf";
import TakeoffCanvas from "../takeoff/TakeoffCanvas";
import CatalogEditor from "../takeoff/CatalogEditor";
import MeasurementProps from "../takeoff/MeasurementProps";
import StatementPanel from "../takeoff/StatementPanel";
import { FloorsPanel, OpeningsPanel } from "../takeoff/ProjectPanels";
import RevisionPanel, { Legend } from "../takeoff/RevisionPanel";
import {
  IDENTITY, applyT, invertT, pagesToMap, scaleOf, similarityFromPairs, transferProject, transformMeasurement,
} from "../takeoff/revision";
import { fetchCatalog, markWorkUsed } from "../takeoff/api";
import { SHOW_CATALOG_EDITOR } from "../takeoff/config";
import { exportTakeoffExcel } from "../takeoff/excel";
import {
  CALCS, WORK_SUGGESTIONS, buildStatement, defaultCalc, distance, measurementQuantity, metersPerUnitFromDistance,
  metersPerUnitFromScale, unitOf,
} from "../takeoff/model";
import {
  OPENING_TYPES, buildMasonryStatement, isSnapshotStale, masonryMeasure, placeRect, workSnapshot,
} from "../takeoff/masonry";

const STORAGE_PREFIX = "takeoff:v1:";
const SCALES = [10, 20, 25, 50, 75, 100, 200, 500];
// Яркие насыщенные цвета (без красного и оранжевого — это вычеты и «не посчитано»).
const PALETTE = ["#2962ff", "#00c853", "#aa00ff", "#00b8d4", "#c51162", "#64dd17", "#6200ea", "#00bfa5"];

const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fmt = (v, d = 2) => (v == null ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: 2 }));

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
  const [floors, setFloors] = useState([]);
  const [openings, setOpenings] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("select"); // select | area | line | rect | opening | calibrate
  const [deduct, setDeduct] = useState(false);
  const [lastWork, setLastWork] = useState({ area: "", line: "" }); // свой вид работ
  const [lastCatalog, setLastCatalog] = useState({}); // kind -> id работы из справочника
  const [lastFloorId, setLastFloorId] = useState(null);
  const [openingMarkId, setOpeningMarkId] = useState("");
  const [calibPoints, setCalibPoints] = useState(null); // ждём длину в метрах
  const [calibMeters, setCalibMeters] = useState("");
  const [scaleN, setScaleN] = useState("");
  const [tab, setTab] = useState("page"); // page | floors | openings | statement
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [catalog, setCatalog] = useState({ groups: [], works: [], canEdit: false });
  const [catalogError, setCatalogError] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [history, setHistory] = useState([]); // прежние редакции чертежа
  const [rev, setRev] = useState(null); // идёт замена чертежа
  const [prevRev, setPrevRev] = useState(null); // прошлая редакция — для подсветки изменений
  const [compare, setCompare] = useState(false);
  const canvasRef = useRef(null);
  const revInputRef = useRef(null);
  const projectKey = file ? `${STORAGE_PREFIX}${file.name}:${file.size}` : null;

  // --- справочник работ (общий, с сервера) ---
  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await fetchCatalog());
      setCatalogError("");
    } catch (err) {
      setCatalogError(`Справочник работ не загрузился: ${err.message}`);
    }
  }, []);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  const worksById = useMemo(() => Object.fromEntries(catalog.works.map((w) => [w.id, w])), [catalog]);
  const groupsById = useMemo(() => Object.fromEntries(catalog.groups.map((g) => [g.id, g])), [catalog]);

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
      setFloors(saved?.floors || []);
      setOpenings(saved?.openings || []);
      setHistory(saved?.history || []);
      setPrevRev(null);
      setCompare(false);
      setRev(null);
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
      localStorage.setItem(projectKey, JSON.stringify({ calibrations, measurements, pageNumber, floors, openings, history }));
    } catch {
      // нет места или хранилище недоступно — работаем без сохранения
    }
  }, [projectKey, calibrations, measurements, pageNumber, floors, openings, history]);

  // --- замена чертежа новой редакцией ---
  const startRevision = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const pages = pagesToMap({ measurements, calibrations });
    if (!pages.length) {
      setError("В этом чертеже нет замеров и калибровки — просто откройте новый PDF.");
      return;
    }
    setStatus("Открываем новую редакцию…");
    try {
      const doc = await openPdf(f);
      const pageMap = Object.fromEntries(pages.map((p) => [p, p <= doc.numPages ? p : null]));
      setRev({ file: f, pdf: doc, numPages: doc.numPages, pageMap, transforms: {}, oldPage: pages.includes(pageNumber) ? pageNumber : pages[0], align: null, diff: true });
      setSelectedId(null);
      setMode("select");
      setError("");
      setStatus("");
    } catch (err) {
      setError(`Не удалось открыть PDF: ${err.message}`);
      setStatus("");
    }
  };

  const applyRevision = () => {
    const res = transferProject({ measurements, calibrations }, { pageMap: rev.pageMap, transforms: rev.transforms });
    if (res.dropped.length && !window.confirm(`Не переносятся замеров: ${res.dropped.length} (их листы — «не переносить»). Продолжить?`)) return;
    const existing = loadProject(`${STORAGE_PREFIX}${rev.file.name}:${rev.file.size}`);
    if (existing?.measurements?.length && !window.confirm(`У файла «${rev.file.name}» уже есть свои сохранённые замеры (${existing.measurements.length}) — они будут заменены перенесёнными. Продолжить?`)) return;
    setPrevRev({ pdf, file, pageMap: rev.pageMap, transforms: rev.transforms });
    setHistory((h) => [...h, { file: file.name, replacedAt: new Date().toISOString() }]);
    setFile(rev.file);
    setPdf(rev.pdf);
    setNumPages(rev.numPages);
    setMeasurements(res.measurements);
    setCalibrations(res.calibrations);
    const p = rev.pageMap[rev.oldPage] || 1;
    setPageNumber(p);
    setPageInput(String(p));
    setCompare(rev.diff);
    setRev(null);
    setStatus(`Замеры перенесены на новую редакцию: ${res.measurements.length}. Красным подсвечено то, что изменилось, — поправьте замеры там.`);
  };

  // Совмещение: на «старой» стороне точка — вершина замера (прилипание) или
  // место на старом листе (обратное текущему совмещению), на «новой» — щелчок.
  const revT = rev ? rev.transforms[rev.oldPage] || IDENTITY : null;
  const revOldPage = rev?.oldPage;
  const revOld = useMemo(() => (revOldPage ? measurements.filter((m) => m.page === revOldPage) : []), [measurements, revOldPage]);
  const revShown = useMemo(() => revOld.map((m) => transformMeasurement(m, revT)), [revOld, revT]);
  const vertices = (m) => (m.kind === "rect"
    ? [m.points, ...(m.channels || [])].flatMap((pts) => {
      const xs = [pts[0].x, pts[1].x];
      const ys = [pts[0].y, pts[1].y];
      return [{ x: xs[0], y: ys[0] }, { x: xs[1], y: ys[0] }, { x: xs[1], y: ys[1] }, { x: xs[0], y: ys[1] }];
    })
    : m.points);
  const alignSnap = rev?.align ? revShown.flatMap(vertices) : null;
  const alignOrig = rev?.align ? revOld.flatMap(vertices) : null;
  const onAlignClick = ({ point, snapIndex }) => {
    const { step, pairs: prev } = rev.align;
    const pairs = [...prev];
    if (step % 2 === 0) {
      // У прямоугольника после поворота вершины не совпадают по порядку —
      // для него берём обратное преобразование точки, а не прилипание.
      const oldPt = snapIndex != null && isIdentityT(revT) ? alignOrig[snapIndex] : applyT(invertT(revT), point);
      pairs.push({ old: oldPt, shown: point });
    } else {
      pairs[pairs.length - 1] = { ...pairs[pairs.length - 1], new: point };
    }
    if (step < 3) {
      setRev({ ...rev, align: { step: step + 1, pairs } });
      return;
    }
    const t = similarityFromPairs(pairs[0].old, pairs[0].new, pairs[1].old, pairs[1].new);
    if (!t) {
      setError("Точки совмещения слишком близко друг к другу — выберите точки подальше.");
      setRev({ ...rev, align: null });
      return;
    }
    setRev({ ...rev, transforms: { ...rev.transforms, [rev.oldPage]: t }, align: null });
  };
  const alignMarks = rev?.align ? rev.align.pairs.flatMap((pr, i) => [
    { ...pr.shown, color: "#ff6d00", label: `${i + 1} было` },
    ...(pr.new ? [{ ...pr.new, color: "#00a152", label: `${i + 1} стало` }] : []),
  ]) : null;
  useEffect(() => {
    if (!rev?.align) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setRev((r) => (r ? { ...r, align: null } : r)); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rev?.align]);

  // Подсветка изменений: слои «было» (красный, с совмещением) и «стало» (синий).
  const revNewPage = rev ? rev.pageMap[rev.oldPage] : null;
  const prevOldPage = prevRev ? Number(Object.keys(prevRev.pageMap).find((k) => prevRev.pageMap[k] === pageNumber)) || null : null;
  const compareLayers = rev
    ? (rev.diff && revNewPage ? [
      { key: `n${revNewPage}`, pdf: rev.pdf, pageNumber: revNewPage, color: [0, 90, 255], transform: null },
      { key: `o${rev.oldPage}`, pdf, pageNumber: rev.oldPage, color: [230, 0, 0], transform: revT },
    ] : null)
    : (compare && prevOldPage ? [
      { key: `n${pageNumber}`, pdf, pageNumber, color: [0, 90, 255], transform: null },
      { key: `o${prevOldPage}`, pdf: prevRev.pdf, pageNumber: prevOldPage, color: [230, 0, 0], transform: prevRev.transforms[prevOldPage] || null },
    ] : null);

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
  const isIdentityT = (t) => !t || (t.a === 1 && t.b === 0 && t.tx === 0 && t.ty === 0);
  const update = useCallback((id, patch) => {
    setMeasurements((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    if (patch.floorId) setLastFloorId(patch.floorId);
  }, []);
  // Вместе со стеной удаляются и обведённые в ней проёмы.
  const remove = (id) => {
    setMeasurements((list) => list.filter((m) => m.id !== id && m.wallId !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  // Работа из справочника -> снимок нормы в замер; работу помечаем
  // использованной (её больше нельзя удалить из справочника, только в архив).
  const catalogPatch = useCallback((m, workId) => {
    const work = worksById[workId];
    if (!work) return { workId: null, snapshot: null };
    markWorkUsed(work.id).catch(() => {});
    const known = (id) => id && floors.some((f) => f.id === id);
    const floorId = known(m.floorId) ? m.floorId : known(lastFloorId) ? lastFloorId : floors[0]?.id ?? null;
    return { workId: work.id, snapshot: workSnapshot(work, groupsById[work.groupId]), work: work.name, floorId, deduct: false };
  }, [worksById, groupsById, floors, lastFloorId]);

  const onPickWork = (m, workId) => {
    update(m.id, workId ? catalogPatch(m, workId) : { workId: null, snapshot: null });
    setLastCatalog((l) => ({ ...l, [m.kind]: workId }));
  };
  const onRefresh = (m) => {
    const work = worksById[m.workId];
    if (work) update(m.id, { snapshot: workSnapshot(work, groupsById[work.groupId]) });
  };
  const refreshAll = () => setMeasurements((list) => list.map((m) => {
    const work = isSnapshotStale(m, worksById) ? worksById[m.workId] : null;
    return work ? { ...m, snapshot: workSnapshot(work, groupsById[work.groupId]) } : m;
  }));

  const selected = measurements.find((m) => m.id === selectedId) || null;
  const pageMeasurements = measurements.filter((m) => m.page === pageNumber);
  const selectedWall = selected && selected.kind === "line" && selected.snapshot?.method === "wall_length" ? selected : null;

  const onFinish = useCallback(({ kind, points }) => {
    if (mode === "opening") {
      if (!selectedWall) return;
      const o = { id: newId(), page: pageNumber, kind: "line", role: "opening", wallId: selectedWall.id, openingId: openingMarkId || openings[0]?.id || null, points, count: 1 };
      setMeasurements((list) => [...list, o]);
      return;
    }
    if (kind === "rect") {
      const shafts = measurements.filter((m) => m.page === pageNumber && m.kind === "rect");
      const place = placeRect(points, shafts);
      if (place.error) {
        setError(place.error);
        return;
      }
      setError("");
      if (place.channelOf) {
        setMeasurements((list) => list.map((m) => (m.id === place.channelOf ? { ...m, channels: [...(m.channels || []), points] } : m)));
        setSelectedId(place.channelOf);
        return;
      }
      const workId = worksById[lastCatalog.rect] && !worksById[lastCatalog.rect].archived
        ? lastCatalog.rect
        : catalog.works.find((w) => w.method === "rect_channels" && !w.archived)?.id;
      const base = { id: newId(), page: pageNumber, kind: "rect", points, channels: [], work: "", room: "", count: 1 };
      const m = workId ? { ...base, ...catalogPatch(base, workId) } : base;
      setMeasurements((list) => [...list, m]);
      setSelectedId(m.id);
      return;
    }
    const work = lastWork[kind] || "";
    const suggested = WORK_SUGGESTIONS.find((w) => w.work === work);
    const base = {
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
    const workId = !deduct && worksById[lastCatalog[kind]] && !worksById[lastCatalog[kind]].archived ? lastCatalog[kind] : null;
    const m = workId ? { ...base, ...catalogPatch(base, workId) } : base;
    setMeasurements((list) => [...list, m]);
    setSelectedId(m.id);
  }, [mode, selectedWall, pageNumber, openingMarkId, openings, measurements, worksById, lastCatalog, catalog.works, catalogPatch, lastWork, deduct]);

  useEffect(() => {
    const onKey = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.key === "Delete" && selectedId && mode === "select") remove(selectedId);
      if (e.key === "Escape" && mode === "select") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Цвет — по виду работ: одинаковые работы одним цветом.
  const colorFor = useCallback((m) => {
    let h = 0;
    for (const ch of m.snapshot?.name || m.work || "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }, []);
  const masonryCtx = useMemo(() => ({ floors, openings, measurements }), [floors, openings, measurements]);
  const labelFor = useCallback((m) => {
    if (m.role === "opening") return openings.find((o) => o.id === m.openingId)?.mark || "проём?";
    if (m.workId) {
      const r = masonryMeasure(m, { ...masonryCtx, metersPerUnit: calibrations[m.page] });
      return r.quantity == null ? "" : `${fmt(r.quantity, 3)} ${m.snapshot.unit}`;
    }
    if (m.kind === "rect") return "";
    const q = measurementQuantity(m, calibrations[m.page]);
    return q == null ? "" : `${fmt(q)} ${unitOf(m)}`;
  }, [calibrations, masonryCtx, openings]);

  const freeMeasurements = useMemo(() => measurements.filter((m) => !m.workId && m.role !== "opening" && m.kind !== "rect"), [measurements]);
  const statement = useMemo(() => buildStatement(freeMeasurements, calibrations), [freeMeasurements, calibrations]);
  const masonry = useMemo(() => buildMasonryStatement(measurements, { calibrations, floors, openings }), [measurements, calibrations, floors, openings]);
  const staleCount = measurements.filter((m) => isSnapshotStale(m, worksById)).length;
  const floorUsage = useMemo(() => {
    const u = {};
    for (const m of measurements) if (m.workId && m.floorId && !m.heightOverride) u[m.floorId] = (u[m.floorId] || 0) + 1;
    return u;
  }, [measurements]);

  const exportExcel = () => exportTakeoffExcel({ fileName: file?.name, masonry, statement, measurements, floors, openings });

  const clearProject = () => {
    if (!window.confirm("Удалить все замеры и калибровку этого чертежа? Этажи и ведомость проёмов останутся.")) return;
    setMeasurements([]);
    setCalibrations({});
    setSelectedId(null);
  };

  const pickMode = (m) => {
    if (m === "opening" && mode !== "opening") {
      if (!selectedWall) {
        setError("Сначала выберите замер стены — работа из справочника со способом «стена/перегородка по длине».");
        return;
      }
      if (!openings.length) {
        setError("Ведомость проёмов пуста — добавьте марки на вкладке «Проёмы».");
        return;
      }
      if (!openings.some((o) => o.id === openingMarkId)) setOpeningMarkId(openings[0].id);
    }
    setError("");
    setMode(mode === m ? "select" : m);
  };
  const tool = (m, label, title) => (
    <button type="button" title={title} style={mode === m ? { ...s.tool, ...s.toolActive } : s.tool}
      onClick={() => pickMode(m)} disabled={!pdf}>{label}</button>
  );

  const itemTitle = (m) => {
    if (m.role === "opening") return `Проём ${openings.find((o) => o.id === m.openingId)?.mark || "без марки"}`;
    return `${m.snapshot?.name || m.work || "Без названия"}${m.room ? ` · ${m.room}` : ""}${m.deduct ? " (вычет)" : ""}`;
  };

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
          {rev && (
            <RevisionPanel rev={rev} oldFileName={file?.name} setRev={setRev} onApply={applyRevision} onCancel={() => setRev(null)}
              counts={measurements.reduce((c, m) => ({ ...c, [m.page]: (c[m.page] || 0) + 1 }), {})} />
          )}
          {!rev && (<>
          <section style={s.block}>
            <div style={s.blockTitle}>1. Чертёж (PDF)</div>
            <input type="file" accept="application/pdf,.pdf" onChange={onFile} style={{ fontSize: 12, width: "100%" }} />
            {file && <div style={s.muted}>{file.name}</div>}
            {file && (
              <>
                <input ref={revInputRef} type="file" accept="application/pdf,.pdf" onChange={startRevision} style={{ display: "none" }} />
                <button type="button" style={s.small} disabled={!!rev} onClick={() => revInputRef.current?.click()}
                  title="Тот же чертёж с правками: замеры переносятся на новый PDF">🔁 Заменить чертёж (новая редакция)</button>
              </>
            )}
            {history.length > 0 && <div style={s.hint}>Редакций до этой: {history.length} (последняя — {history[history.length - 1].file})</div>}
            {prevRev && (
              <>
                <label style={s.check}>
                  <input type="checkbox" checked={compare} disabled={!prevOldPage} onChange={(e) => setCompare(e.target.checked)} /> Подсветить изменения с прошлой редакцией
                </label>
                {compare && prevOldPage && <Legend />}
                {!prevOldPage && <div style={s.hint}>Этот лист не сопоставлен с прошлой редакцией.</div>}
              </>
            )}
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
            {tool("line", "〰 Длина (линия)", "Стены и перегородки по плану (× высота), плинтус")}
            {tool("rect", "▭ Прямоугольник", "Вентшахта: два щелчка по диагонали; внутри шахты — канал")}
            {tool("opening", "🚪 Проём на плане", "Дверь/окно линией по ширине в выделенной стене")}
            {mode === "rect" && <div style={s.hint}>Два щелчка по диагонали — шахта. Прямоугольник внутри шахты — её канал.</div>}
            {mode === "opening" && (
              <div style={s.toolBox}>
                <div style={s.hint}>Стена: <b>{selectedWall?.room || selectedWall?.snapshot?.name}</b>. Проведите линию по ширине проёма.</div>
                <label style={s.muted}>Марка</label>
                <select style={s.input} value={openingMarkId} onChange={(e) => setOpeningMarkId(e.target.value)}>
                  {openings.map((o) => <option key={o.id} value={o.id}>{o.mark} — {OPENING_TYPES[o.type]} {fmt(o.width)} × {fmt(o.height)}</option>)}
                </select>
              </div>
            )}
            {(mode === "area" || mode === "line") && (
              <label style={s.check}>
                <input type="checkbox" checked={deduct} onChange={(e) => setDeduct(e.target.checked)} /> Новый замер — вычет (отделка)
              </label>
            )}
            <div style={s.hint}>
              Щелчок — точка, Shift — строго по горизонтали/вертикали, двойной щелчок или Enter — готово, Backspace — убрать точку, Esc — отменить.
              Колесо — масштаб, средняя кнопка или пробел + мышь — прокрутка.
              Правка выделенного замера: тянуть точку, «+» на отрезке — новая точка, правый щелчок по точке — удалить.
            </div>
            <button type="button" style={s.small} disabled={!pdf} onClick={() => canvasRef.current?.fit()}>Весь лист</button>
          </section>

          {catalogError && <div style={s.warn}>{catalogError} <button type="button" style={s.small} onClick={loadCatalog}>Повторить</button></div>}
          {SHOW_CATALOG_EDITOR && catalog.canEdit && (
            <button type="button" style={s.tool} onClick={() => setCatalogOpen(true)}>📚 Справочник работ</button>
          )}
          </>)}
        </aside>

        <main style={s.center}>
          {rev ? (
            revNewPage ? (
              <TakeoffCanvas ref={canvasRef} pdf={rev.pdf} pageNumber={revNewPage} measurements={revShown}
                selectedId={null} mode={rev.align ? "align" : "select"} deduct={false}
                metersPerUnit={calibrations[rev.oldPage] ? calibrations[rev.oldPage] / scaleOf(revT) : null}
                labelFor={labelFor} colorFor={colorFor} onSelect={() => {}} onFinish={() => {}} onCalibrated={() => {}} onStatus={setStatus}
                revisionView compareLayers={compareLayers} alignSnap={alignSnap} onAlignClick={onAlignClick} marks={alignMarks} />
            ) : (
              <div style={s.empty}>Лист {rev.oldPage} не переносится — его замеры будут удалены из новой редакции.</div>
            )
          ) : pdf ? (
            <TakeoffCanvas ref={canvasRef} pdf={pdf} pageNumber={pageNumber} measurements={pageMeasurements}
              selectedId={selectedId} mode={mode} deduct={(deduct && (mode === "area" || mode === "line")) || mode === "opening"} metersPerUnit={metersPerUnit}
              labelFor={labelFor} colorFor={colorFor} onSelect={setSelectedId} onFinish={onFinish}
              onCalibrated={onCalibrated} onStatus={setStatus} onEdit={update} compareLayers={compareLayers} />
          ) : (
            <div style={s.empty}>Загрузите PDF с чертежом — слева, «Чертёж (PDF)».</div>
          )}
        </main>

        <aside style={s.right}>
          <div style={s.tabs}>
            {[["page", `Замеры (${pageMeasurements.length})`], ["floors", "Этажи"], ["openings", `Проёмы (${openings.length})`], ["statement", "Ведомость"]].map(([key, label]) => (
              <button key={key} type="button" style={tab === key ? s.tabActive : s.tab} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>

          {tab === "page" && (
            <>
              {selected && (
                <MeasurementProps m={selected} measurements={measurements} catalog={catalog} floors={floors} openings={openings}
                  metersPerUnit={calibrations[selected.page] || null} update={update} remove={remove} onPickWork={onPickWork}
                  onRefresh={onRefresh} onFreeWork={(kind, work) => setLastWork((l) => ({ ...l, [kind]: work }))} labelFor={labelFor} />
              )}
              <div style={s.list}>
                {pageMeasurements.length === 0 && <p style={s.muted}>На этом листе замеров нет.</p>}
                {pageMeasurements.map((m) => (
                  <button key={m.id} type="button" style={{ ...s.item, ...(m.id === selectedId ? s.itemActive : null), ...(m.role === "opening" ? s.itemChild : null) }}
                    onClick={() => { setSelectedId(m.id); setMode("select"); }}>
                    <span style={{ ...s.dot, background: m.deduct || m.role === "opening" ? "#c62828" : colorFor(m) }} />
                    <span style={{ flex: 1, textAlign: "left" }}>
                      {isSnapshotStale(m, worksById) && <span title="Норма в справочнике изменилась">⚠ </span>}
                      {itemTitle(m)}
                    </span>
                    <b>{labelFor(m) || "—"}</b>
                  </button>
                ))}
              </div>
            </>
          )}

          {tab === "floors" && <FloorsPanel floors={floors} setFloors={setFloors} usage={floorUsage} />}
          {tab === "openings" && <OpeningsPanel openings={openings} setOpenings={setOpenings} usage={masonry.openingsUsage} />}

          {tab === "statement" && (
            <>
              {staleCount > 0 && (
                <div style={{ ...s.warn, margin: "10px 10px 0" }}>
                  У {staleCount} замер(ов) норма в справочнике изменилась — посчитано по прежней.
                  <button type="button" style={{ ...s.small, marginLeft: 6 }} onClick={refreshAll}>Пересчитать все по текущим нормам</button>
                </div>
              )}
              <StatementPanel masonry={masonry} statement={statement} onExport={exportExcel} onClear={clearProject} hasMeasurements={measurements.length > 0} />
            </>
          )}
        </aside>
      </div>

      {catalogOpen && <CatalogEditor catalog={catalog} onChanged={loadCatalog} onClose={() => setCatalogOpen(false)} />}

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
  right: { width: 370, flexShrink: 0, background: "#fff", borderLeft: "1px solid #e1e6ec", display: "flex", flexDirection: "column", minHeight: 0 },
  block: { display: "flex", flexDirection: "column", gap: 6, paddingBottom: 10, borderBottom: "1px solid #eef1f4" },
  blockTitle: { fontWeight: 700, fontSize: 13, color: "#1f5fa8" },
  row: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  input: { padding: "6px 8px", border: "1px solid #c8d0da", borderRadius: 6, fontSize: 13, boxSizing: "border-box", width: "100%" },
  tool: { textAlign: "left", background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "7px 10px", fontSize: 13, cursor: "pointer" },
  toolActive: { background: "#1976d2", borderColor: "#1976d2", color: "#fff" },
  toolBox: { background: "#fff6f6", border: "1px solid #f2b8b5", borderRadius: 6, padding: 6, display: "flex", flexDirection: "column", gap: 4 },
  small: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
  primary: { background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  check: { fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginTop: 4 },
  hint: { fontSize: 11, color: "#667", lineHeight: 1.4 },
  muted: { fontSize: 12, color: "#667" },
  ok: { fontSize: 12, color: "#2e7d32", fontWeight: 600 },
  warn: { fontSize: 12, color: "#8a5a00", background: "#fff6e0", borderRadius: 6, padding: "6px 8px", margin: "4px 0" },
  empty: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#667", fontSize: 15 },
  tabs: { display: "flex", borderBottom: "1px solid #e1e6ec" },
  tab: { flex: 1, background: "none", border: "none", borderBottom: "2px solid transparent", padding: "10px 4px", fontSize: 12, cursor: "pointer", color: "#555" },
  tabActive: { flex: 1, background: "none", border: "none", borderBottom: "2px solid #1976d2", padding: "10px 4px", fontSize: 12, cursor: "pointer", color: "#1976d2", fontWeight: 600 },
  list: { padding: 10, overflowY: "auto", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 },
  item: { display: "flex", alignItems: "center", gap: 8, background: "#fff", border: "1px solid #e3e8ee", borderRadius: 6, padding: "7px 8px", fontSize: 12, cursor: "pointer" },
  itemActive: { borderColor: "#1976d2", background: "#eef6ff" },
  itemChild: { marginLeft: 16 },
  dot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modal: { background: "#fff", borderRadius: 10, padding: 20, width: 340, maxWidth: "92vw", boxSizing: "border-box" },
};
