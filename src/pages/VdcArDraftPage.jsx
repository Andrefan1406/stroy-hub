// «Черновик ВДЦ на внутреннюю отделку по чертежам АР». Пошаговый мастер: пользователь загружает PDF с
// чертежами АР и указывает листы — мы читаем с них данные. Всё считается в браузере, файл не уходит на сервер.
// ТЭП → секции → экспликации этажей и оси квартир → ведомость отделки → таблица «квартира → виды отделки с
// объёмами» отдельно для первого блока (секция №1) и для остальных секций.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openPdf, renderPage, scanDocument } from "../vdc/pdf";
import { parseTep } from "../vdc/tepParser";
import { detectSections, firstSectionId, parseSectionIds } from "../vdc/sections";
import { findExplicationTitle, parseExplication } from "../vdc/explication";
import { planFlats } from "../vdc/plan";
import { assembleBlocks, attachFinishing, splitFirstBlock, typeCodeFromName } from "../vdc/blocks";
import { checkFinishing, checkRoomNames, parseFinishing, parseLegend } from "../vdc/finishing";
import { attachLoggias, checkLoggiaAreas, findLoggiaFloorAreas, proposeLoggias } from "../vdc/loggias";
import { CEILINGS_EXCLUDED_UP_TO, collectMeasureTasks, summarizeWorks, totalsOf, worksForFlat } from "../vdc/works";
import { findCeilingHeight, parseManual, taskTotal } from "../vdc/measure";
import MeasureDialog from "../vdc/MeasureDialog";

const TEP_TITLE = "тэп по типам квартир";
const FINISHING_TITLE = "ведомость отделки помещений";
const ELEMENT = { ceiling: "Потолок", walls: "Стены и перегородки", loggia: "Лоджия / балкон" };

// «0,5» / «0.5» → 0.5; не число или вне (0; 1] → null
const parseK = (v) => {
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
};

const STEPS = [
  { n: 1, title: "Файл" },
  { n: 2, title: "ТЭП" },
  { n: 3, title: "Секции" },
  { n: 4, title: "Планы этажей" },
  { n: 5, title: "Оси квартир" },
  { n: 6, title: "Лоджии" },
  { n: 7, title: "Отделка" },
  { n: 8, title: "Обмер" },
  { n: 9, title: "Результат" },
];

const floorsLabel = (floors) => (floors.length === 1 ? `${floors[0]}-й этаж` : `${floors[0]}–${floors[floors.length - 1]} этажи`);
const fmtMoney = (n) => Number(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtArea = (n) => Number(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Сводка по видам отделки для набора квартир: (элемент, вид) → общая площадь.
function sumFinish(rows) {
  const acc = new Map();
  for (const r of rows) {
    for (const f of r.finish || []) {
      const key = `${f.element}|${f.id}`;
      const cur = acc.get(key) || { element: f.element, id: f.id, title: f.title, area: 0 };
      cur.area += f.area;
      acc.set(key, cur);
    }
  }
  const order = { ceiling: 0, walls: 1 };
  return [...acc.values()]
    .map((x) => ({ ...x, area: round2(x.area) }))
    .sort((a, b) => order[a.element] - order[b.element] || a.id.localeCompare(b.id, "ru", { numeric: true }));
}

function Checks({ checks }) {
  if (!checks.length) return null;
  return (
    <ul style={s.checks}>
      {checks.map((c, i) => (
        <li key={i} style={{ color: c.ok ? "#1a7f37" : "#8a5a00" }}>
          {c.ok ? "✓" : "⚠"} {c.text}
        </li>
      ))}
    </ul>
  );
}

// Строки одной квартиры: помещение (номер и название) → потолок и стены с видами отделки и объёмами.
function roomLines(row) {
  const lines = [];
  for (const room of row.rooms || []) {
    const parts = [];
    if (room.ceiling) parts.push({ element: "ceiling", ...room.ceiling });
    for (const w of room.walls) parts.push({ element: "walls", ...w });
    parts.forEach((part, i) => lines.push({ key: `${room.no}|${part.element}|${part.id}|${i}`, room: i === 0 ? room : null, ...part }));
  }
  // лоджии и балконы: фактическая площадь = площадь по экспликации ÷ подтверждённый коэффициент
  for (const l of row.loggias || []) {
    lines.push({
      key: `loggia|${l.no}`, room: { no: l.no, name: l.name }, element: "loggia", id: "—", area: l.area,
      title: `по экспликации ${fmtArea(l.reduced)} м² ÷ к ${String(l.k).replace(".", ",")}`,
    });
  }
  return lines;
}

// Одна ВДЦ: квартиры по этажам, под каждой — помещения с видами отделки и объёмами; в конце — сводка по видам.
function VdcTable({ rows, showSection }) {
  const flats = [];
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.section}|${r.floor}|${r.flatIndex}`;
    if (!byKey.has(key)) {
      const flat = { key, row: r };
      byKey.set(key, flat);
      flats.push(flat);
    }
  }
  const summary = sumFinish(rows);
  const loggiaTotal = round2(rows.reduce((acc, r) => acc + (r.loggias || []).reduce((a, l) => a + l.area, 0), 0));
  return (
    <>
      <div style={s.scroll}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, textAlign: "left" }}>Помещение</th>
              <th style={s.th}>Элемент</th>
              <th style={s.th}>Вид</th>
              <th style={{ ...s.th, textAlign: "left" }}>Вид отделки</th>
              <th style={s.th}>Объём, м²</th>
            </tr>
          </thead>
          <tbody>
            {flats.map(({ key, row }) => (
              <React.Fragment key={key}>
                <tr>
                  <td colSpan={5} style={s.flatRow}>
                    {showSection ? `Секция ${row.section} · ` : ""}Этаж {row.floor} · {row.label}
                    <span style={s.dim}> — {row.type}</span>
                  </td>
                </tr>
                {row.finish === null && (
                  <tr><td colSpan={5} style={{ ...s.td, color: "#8a5a00" }}>Для типа {row.code} нет данных в ведомости отделки</td></tr>
                )}
                {roomLines(row).map((l) => (
                  <tr key={l.key} style={l.room ? s.roomStart : null}>
                    <td style={s.td}>{l.room ? `${l.room.no}. ${l.room.name || "помещение"}` : ""}</td>
                    <td style={s.td}>{ELEMENT[l.element]}</td>
                    <td style={{ ...s.td, textAlign: "center" }}>{l.id}</td>
                    <td style={{ ...s.td, color: "#444" }} title={l.title}>{l.title || "—"}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmtArea(l.area)}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={s.h3}>Сводно по ВДЦ</h3>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Элемент</th>
            <th style={s.th}>Вид</th>
            <th style={{ ...s.th, textAlign: "left" }}>Вид отделки</th>
            <th style={s.th}>Объём, м²</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((f) => (
            <tr key={`${f.element}|${f.id}`}>
              <td style={s.td}>{ELEMENT[f.element]}</td>
              <td style={{ ...s.td, textAlign: "center" }}>{f.id}</td>
              <td style={{ ...s.td, color: "#444" }}>{f.title || "—"}</td>
              <td style={{ ...s.td, textAlign: "right", fontWeight: 700 }}>{fmtArea(f.area)}</td>
            </tr>
          ))}
          {loggiaTotal > 0 && (
            <tr>
              <td style={s.td}>{ELEMENT.loggia}</td>
              <td style={{ ...s.td, textAlign: "center" }}>—</td>
              <td style={{ ...s.td, color: "#444" }}>Фактическая площадь лоджий и балконов</td>
              <td style={{ ...s.td, textAlign: "right", fontWeight: 700 }}>{fmtArea(loggiaTotal)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

// Одна ВДЦ в виде работ: квартиры по этажам, под каждой — помещения с работами, объёмами, ценами и суммами.
function WorksTable({ rows, showSection }) {
  const flats = [];
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.section}|${r.floor}|${r.flatIndex}`;
    if (!byKey.has(key)) {
      const flat = { key, row: r };
      byKey.set(key, flat);
      flats.push(flat);
    }
  }
  const summary = summarizeWorks(rows);
  const totals = totalsOf(rows);
  return (
    <>
      <div style={s.scroll}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, textAlign: "left" }}>Помещение</th>
              <th style={{ ...s.th, textAlign: "left" }}>Наименование работ</th>
              <th style={s.th}>Ед.</th>
              <th style={s.th}>Кол-во</th>
              <th style={s.th}>Цена с НДС, тг</th>
              <th style={s.th}>Сумма с НДС, тг</th>
            </tr>
          </thead>
          <tbody>
            {flats.map(({ key, row }) => {
              const flatTotal = totalsOf([row]);
              let lastRoom = null;
              return (
                <React.Fragment key={key}>
                  <tr>
                    <td colSpan={5} style={s.flatRow}>
                      {showSection ? `Секция ${row.section} · ` : ""}Этаж {row.floor} · {row.label}
                      <span style={s.dim}> — {row.type}</span>
                    </td>
                    <td style={{ ...s.flatRow, textAlign: "right" }}>{fmtMoney(flatTotal.sumVat)}</td>
                  </tr>
                  {row.works.lines.map((l, i) => {
                    const first = lastRoom !== l.roomNo;
                    lastRoom = l.roomNo;
                    return (
                      <tr key={`${l.roomNo}|${i}`} style={first ? s.roomStart : null}>
                        <td style={s.td}>{first ? `${l.roomNo}. ${l.roomName}` : ""}</td>
                        <td style={s.td} title={l.rateName ? `Расценка ${l.rateNo}: ${l.rateName}` : "Расценка не найдена"}>
                          {l.work}
                          {l.note && <div style={s.small}>{l.note}</div>}
                        </td>
                        <td style={{ ...s.td, textAlign: "center" }}>{l.unit}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{l.qty === null ? "—" : fmtArea(l.qty)}</td>
                        <td style={{ ...s.td, textAlign: "right" }}>{l.priceVat === null ? "—" : fmtMoney(l.priceVat)}</td>
                        <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{l.sum === null ? "—" : fmtMoney(l.sum)}</td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 style={s.h3}>Сводно по ВДЦ</h3>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={{ ...s.th, textAlign: "left" }}>Наименование работ</th>
            <th style={s.th}>Ед.</th>
            <th style={s.th}>Объём</th>
            <th style={s.th}>Цена с НДС, тг</th>
            <th style={s.th}>Сумма с НДС, тг</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((x) => (
            <tr key={`${x.work}|${x.rateNo}`}>
              <td style={s.td}>
                {x.work}
                {x.pending > 0 && <div style={s.small}>в {x.pending} позициях объём не определён (нужен обмер)</div>}
              </td>
              <td style={{ ...s.td, textAlign: "center" }}>{x.unit}</td>
              <td style={{ ...s.td, textAlign: "right" }}>{fmtArea(x.qty)}</td>
              <td style={{ ...s.td, textAlign: "right" }}>{x.priceVat === null ? "—" : fmtMoney(x.priceVat)}</td>
              <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmtMoney(x.sum)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={4} style={{ ...s.td, fontWeight: 700 }}>Итого с НДС</td>
            <td style={{ ...s.td, textAlign: "right", fontWeight: 700 }}>{fmtMoney(totals.sumVat)}</td>
          </tr>
          <tr>
            <td colSpan={4} style={{ ...s.td, color: "#555" }}>Итого без НДС</td>
            <td style={{ ...s.td, textAlign: "right", color: "#555" }}>{fmtMoney(totals.sumNoVat)}</td>
          </tr>
        </tbody>
      </table>
      {totals.pending > 0 && <div style={s.warnBox}>В {totals.pending} позициях объём не определён («требуется обмер», стены лоджий) — они в сумму не вошли.</div>}
    </>
  );
}

const VdcArDraftPage = () => {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const canvasRef = useRef(null);
  const renderToken = useRef(0);

  const [step, setStep] = useState(1);
  const [fileName, setFileName] = useState("");
  const [doc, setDoc] = useState(null);
  const [scan, setScan] = useState(null); // [{ page, items, text }] — весь текст файла
  const [scanProgress, setScanProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState("");

  const [tepPageNo, setTepPageNo] = useState("");
  const [tep, setTep] = useState(null);

  const [sectionsText, setSectionsText] = useState("");
  const [explPicked, setExplPicked] = useState({});
  const [manualExpl, setManualExpl] = useState("");

  const [layout, setLayout] = useState(null); // экспликации этажей с квартирами и осями (правятся на шаге 5)
  const [layoutNotes, setLayoutNotes] = useState([]);

  const [finPicked, setFinPicked] = useState({});
  const [manualFin, setManualFin] = useState("");
  const [finishing, setFinishing] = useState(null); // { apartments, legend, checks }

  const [loggias, setLoggias] = useState([]); // [{ key, no, name, k (строка), proposed, source, areas }]
  const [loggiasConfirmed, setLoggiasConfirmed] = useState(false);

  const [tasks, setTasks] = useState([]); // что нужно обмерить (на тип квартиры и помещение)
  const [typeCounts, setTypeCounts] = useState({});
  const [measureLines, setMeasureLines] = useState({}); // ключ задачи → линии, обведённые на чертеже
  const [manualValues, setManualValues] = useState({}); // ключ задачи → число, введённое вручную
  const [calibrations, setCalibrations] = useState({}); // лист → метров в пункте PDF
  const [wallHeight, setWallHeight] = useState("");
  const [dialogKey, setDialogKey] = useState(null);

  const [result, setResult] = useState(null);
  const [view, setView] = useState("works"); // works — работы с ценами; finish — виды отделки с объёмами
  const [copied, setCopied] = useState("");

  const numPages = doc?.numPages || 0;
  const tepPageValid = Number.isInteger(Number(tepPageNo)) && Number(tepPageNo) >= 1 && Number(tepPageNo) <= numPages;

  // ---------- Шаг 1: файл ----------
  const pickFile = async (file) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setTep(null);
    setLayout(null);
    setFinishing(null);
    setResult(null);
    setScan(null);
    setTepPageNo("");
    setExplPicked({});
    setFinPicked({});
    setSectionsText("");
    try {
      const opened = await openPdf(file);
      setDoc(opened);
      setFileName(file.name);
      setStep(2);
      setScanProgress({ done: 0, total: opened.numPages });
      // читаем текст всех листов один раз: из него берём подсказки, секции, экспликации и ведомость отделки
      scanDocument(opened, (done, total) => setScanProgress({ done, total }))
        .then((pages) => {
          setScan(pages);
          setScanProgress(null);
          const withTep = pages.find((p) => p.text.toLowerCase().includes(TEP_TITLE));
          if (withTep) setTepPageNo((cur) => cur || String(withTep.page));
        })
        .catch((e) => {
          setScanProgress(null);
          setError(`Не удалось прочитать текст листов: ${e.message || e}`);
        });
    } catch (e) {
      setDoc(null);
      setError(`Не удалось открыть PDF: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // ---------- Шаг 2: ТЭП ----------
  useEffect(() => {
    if (step !== 2 || !doc || !tepPageValid || !canvasRef.current) return undefined;
    const token = ++renderToken.current;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      renderPage(doc, Number(tepPageNo), canvasRef.current, 900)
        .catch(() => {})
        .finally(() => {
          if (renderToken.current === token) setPreviewBusy(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [step, doc, tepPageNo, tepPageValid]);

  const handleParseTep = () => {
    if (!scan || !tepPageValid) return;
    setError("");
    try {
      setTep({ ...parseTep(scan[Number(tepPageNo) - 1].items), page: Number(tepPageNo) });
      setLayout(null);
      setResult(null);
      setStep(3);
    } catch (e) {
      setError(`Лист ${tepPageNo}: ${e.message || e}`);
    }
  };

  // ---------- Шаг 3: секции ----------
  const sectionsInfo = useMemo(() => (scan ? detectSections(scan.map((p) => ({ page: p.page, text: p.text }))) : null), [scan]);
  useEffect(() => {
    if (step === 3 && sectionsInfo && sectionsText === "") setSectionsText(sectionsInfo.ids.join(", "));
  }, [step, sectionsInfo, sectionsText]);
  const sectionIds = useMemo(() => parseSectionIds(sectionsText), [sectionsText]);
  const firstId = firstSectionId(sectionIds);

  // ---------- Шаг 4: экспликации этажей ----------
  const explCandidates = useMemo(() => {
    if (!scan) return [];
    return scan
      .map((p) => ({ page: p.page, title: findExplicationTitle(p.items) }))
      .filter((c) => c.title)
      .map((c) => ({ page: c.page, text: c.title.text, floors: c.title.floors, scope: c.title.scope }));
  }, [scan]);
  useEffect(() => {
    if (step === 4 && explCandidates.length && Object.keys(explPicked).length === 0) {
      setExplPicked(Object.fromEntries(explCandidates.map((c) => [c.page, true])));
    }
  }, [step, explCandidates, explPicked]);

  const addPage = (value, setPicked, clear) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > numPages) {
      setError(`В файле нет листа ${value}: укажите число от 1 до ${numPages}.`);
      return;
    }
    setError("");
    setPicked((cur) => ({ ...cur, [n]: true }));
    clear("");
  };

  const handleBuildLayout = () => {
    setError("");
    const pages = Object.keys(explPicked).filter((p) => explPicked[p]).map(Number).sort((a, b) => a - b);
    if (!pages.length) {
      setError("Выберите хотя бы один лист с экспликацией этажа.");
      return;
    }
    const built = [];
    const notes = [];
    for (const page of pages) {
      try {
        const e = parseExplication(scan[page - 1].items);
        const plan = planFlats({ items: scan[page - 1].items, explication: e, sections: sectionIds });
        built.push({ page, ...e, flats: plan.flats });
        plan.warnings.forEach((w) => notes.push(`Лист ${page}: ${w}`));
      } catch (e) {
        notes.push(`Лист ${page}: ${e.message || e}`);
      }
    }
    if (!built.length) {
      setError(notes.join(" "));
      return;
    }
    setLayout(built);
    setLayoutNotes(notes);
    setLoggias(proposeLoggias(Object.fromEntries(built.map((e) => [e.page, e.rooms || []]))).map((l) => ({ ...l, proposed: l.k, k: String(l.k).replace(".", ",") })));
    setLoggiasConfirmed(false);
    setResult(null);
    setStep(5);
  };

  // ---------- Шаг 5: оси квартир (правка подписей) ----------
  const setAxis = (pageIdx, flatIdx, section, value) => {
    setLayout((cur) => cur.map((e, i) => (i !== pageIdx ? e : {
      ...e,
      flats: e.flats.map((f, k) => (k !== flatIdx ? f : { ...f, labels: { ...f.labels, [section]: value } })),
    })));
  };

  // ---------- Шаг 6: лоджии и балконы ----------
  const setLoggiaK = (key, value) => {
    setLoggias((cur) => cur.map((l) => (l.key === key ? { ...l, k: value } : l)));
    setLoggiasConfirmed(false);
  };
  const loggiasValid = loggias.every((l) => parseK(l.k) !== null);

  // ---------- Шаг 7: ведомость отделки ----------
  // заголовок таблицы — отдельный элемент листа; упоминание «ведомости отделки» в тексте примечаний не считается
  const finCandidates = useMemo(
    () => (scan ? scan.filter((p) => p.items.some((i) => i.str.trim().toLowerCase().startsWith(FINISHING_TITLE))).map((p) => p.page) : []),
    [scan],
  );
  useEffect(() => {
    if (step === 7 && finCandidates.length && Object.keys(finPicked).length === 0) {
      setFinPicked(Object.fromEntries(finCandidates.map((p) => [p, true])));
    }
  }, [step, finCandidates, finPicked]);

  const handleParseFinishing = () => {
    setError("");
    const pages = Object.keys(finPicked).filter((p) => finPicked[p]).map(Number).sort((a, b) => a - b);
    if (!pages.length) {
      setError("Выберите лист с ведомостью отделки помещений.");
      return;
    }
    const apartments = {};
    let legend = {};
    let group = null;
    for (const page of pages) {
      const parsed = parseFinishing(scan[page - 1].items, group);
      group = parsed.groupAtEnd;
      for (const [code, apt] of Object.entries(parsed.apartments)) {
        (apartments[code] ||= { rooms: [] }).rooms.push(...apt.rooms);
      }
      legend = { ...legend, ...parseLegend(scan[page - 1].items) };
    }
    if (!Object.keys(apartments).length) {
      setError("На выбранных листах не найдены таблицы «Квартира – тип N». Проверьте номер листа.");
      return;
    }
    const checks = [...checkFinishing(apartments, tep?.types, typeCodeFromName), ...checkRoomNames(apartments, layout?.[0]?.rooms)];
    setFinishing({ apartments, legend, checks });
    setResult(null);
  };

  const roomsByPage = useMemo(() => Object.fromEntries((layout || []).map((e) => [e.page, e.rooms || []])), [layout]);

  // ---------- Шаг 8: обмер; шаг 9: результат ----------
  // Квартиры с видами отделки и лоджиями (без работ): из них считаем, что нужно обмерить, и собираем результат.
  const buildBase = () => {
    const built = assembleBlocks({ sections: sectionIds, explications: layout, tep });
    const coefficients = Object.fromEntries(loggias.map((l) => [l.key, parseK(l.k)]));
    const rows = attachLoggias(attachFinishing(built.rows, finishing.apartments, finishing.legend, roomsByPage), roomsByPage, coefficients);
    return { built, rows };
  };

  // Значение задачи обмера: введённое вручную важнее обмера на чертеже
  const taskValue = (task) => {
    const manual = parseManual(manualValues[task.key]);
    if (manual) return manual;
    const drawn = taskTotal(measureLines[task.key] || [], calibrations, { kind: task.kind, height: wallHeight });
    return drawn.total > 0 ? drawn.total : null;
  };

  const handleToMeasure = () => {
    setError("");
    const { rows } = buildBase();
    const found = collectMeasureTasks(rows.map((r) => ({ ...r, works: worksForFlat(r) })));
    setTasks(found);
    setTypeCounts(rows.reduce((acc, r) => ({ ...acc, [r.code]: (acc[r.code] || 0) + 1 }), {}));
    if (!found.length) finalize({}, []);
    else setStep(8);
  };

  const finalize = (measured, taskList) => {
    setError("");
    const { built, rows } = buildBase();
    const withWorks = rows.map((r) => ({ ...r, works: worksForFlat(r, { measured }) }));
    const workWarnings = [...new Set(withWorks.flatMap((r) => r.works.warnings))];
    const loggiaChecks = loggias.length ? checkLoggiaAreas(rows, sectionIds, findLoggiaFloorAreas(scan)) : [];
    const warnings = [...layoutNotes, ...built.warnings, ...workWarnings];
    const missing = [...new Set(rows.filter((r) => r.finish === null).map((r) => r.code))];
    if (missing.length) warnings.push(`В ведомости отделки нет типов квартир: ${missing.join(", ")} — для них виды отделки не добавлены.`);
    const unfilled = taskList.filter((t) => !measured[t.key]);
    if (unfilled.length) warnings.push(`Не задан обмер (${unfilled.length}): ${unfilled.map((t) => `тип ${t.code}, ${t.roomName} — ${t.kind === "plinth" ? "плинтус" : "стены"}`).join("; ")}. Эти позиции без объёма и в сумму не вошли.`);
    setResult({ ...built, rows: withWorks, warnings, checks: [...built.checks, ...finishing.checks, ...loggiaChecks], sections: sectionIds, firstId });
    setStep(9);
  };

  const handleBuildResult = () => {
    const measured = {};
    for (const t of tasks) {
      const v = taskValue(t);
      if (v) measured[t.key] = v;
    }
    finalize(measured, tasks);
  };

  const itemsOf = useCallback((p) => scan?.[p - 1]?.items || [], [scan]);
  const ceilingHeight = useMemo(() => findCeilingHeight(scan), [scan]);
  useEffect(() => {
    if (ceilingHeight && wallHeight === "") setWallHeight(String(ceilingHeight.value).replace(".", ","));
  }, [ceilingHeight, wallHeight]);
  const dialogTask = tasks.find((t) => t.key === dialogKey) || null;
  // где на плане искать квартиры типа: подписи осей первой секции с листа первой экспликации
  const flatsHintFor = (code) => {
    const e = layout?.[0];
    if (!e) return "";
    const labels = e.flats.filter((f) => f.code === code).map((f) => f.labels[firstId]).filter(Boolean);
    return labels.length ? `на плане листа ${e.page}: ${[...new Set(labels)].join(", ")} (достаточно одной)` : `план — лист ${e.page}`;
  };

  const split = useMemo(() => (result ? splitFirstBlock(result.rows, result.firstId) : null), [result]);
  const viewSwitch = (
    <div style={s.row}>
      <button onClick={() => setView("works")} style={view === "works" ? s.tabActive : s.tab}>Работы и расценки</button>
      <button onClick={() => setView("finish")} style={view === "finish" ? s.tabActive : s.tab}>Виды отделки (объёмы)</button>
    </div>
  );
  const otherIds = result ? result.sections.filter((id) => id !== result.firstId) : [];

  const copyRows = async (key, rows) => {
    const num = (v) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
    let lines;
    if (view === "works") {
      lines = [["Секция", "Этаж", "Квартира", "№ помещения", "Помещение", "Наименование работ", "Ед.", "Кол-во", "Цена с НДС, тг", "Сумма с НДС, тг", "Примечание"]];
      for (const r of rows) {
        for (const l of r.works.lines) lines.push([r.section, r.floor, r.label, l.roomNo, l.roomName, l.work, l.unit, num(l.qty), num(l.priceVat), num(l.sum), l.note]);
      }
    } else {
      lines = [["Секция", "Этаж", "Квартира", "№ помещения", "Помещение", "Элемент", "Вид отделки", "Описание", "Объём, м²"]];
      for (const r of rows) {
        for (const l of roomLines(r)) lines.push([r.section, r.floor, r.label, l.room ? l.room.no : "", l.room ? l.room.name : "", ELEMENT[l.element], l.id, l.title, num(l.area)]);
      }
    }
    try {
      await navigator.clipboard.writeText(lines.map((l) => l.join("\t")).join("\n"));
      setCopied(key);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Не удалось скопировать: браузер запретил доступ к буферу обмена.");
    }
  };

  const reset = () => {
    setStep(1);
    setDoc(null);
    setScan(null);
    setScanProgress(null);
    setFileName("");
    setTepPageNo("");
    setTep(null);
    setSectionsText("");
    setExplPicked({});
    setLayout(null);
    setFinPicked({});
    setFinishing(null);
    setTasks([]);
    setMeasureLines({});
    setManualValues({});
    setCalibrations({});
    setDialogKey(null);
    setResult(null);
    setError("");
  };

  const scanLabel = scanProgress ? `Читаем листы: ${scanProgress.done} из ${scanProgress.total}…` : null;
  const finPreview = useMemo(() => {
    if (!finishing) return [];
    const codes = Object.keys(finishing.apartments);
    const page = layout?.[0]?.page;
    return attachFinishing(codes.map((code) => ({ code, page })), finishing.apartments, finishing.legend, roomsByPage).map((r) => ({ code: r.code, rooms: r.rooms || [] }));
  }, [finishing, layout, roomsByPage]);

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => navigate("/")} style={s.back}>← Назад</button>
        <h1 style={s.title}>Черновик ВДЦ на внутреннюю отделку по чертежам АР</h1>
      </div>

      <ol style={s.steps}>
        {STEPS.map((st) => (
          <li key={st.n} style={{ ...s.step, ...(step === st.n ? s.stepActive : null), ...(step > st.n ? s.stepDone : null) }}>
            <span style={s.stepNum}>{step > st.n ? "✓" : st.n}</span> {st.title}
          </li>
        ))}
      </ol>

      {error && <div style={s.errorBox}>{error}</div>}

      {/* ---------- 1. Файл ---------- */}
      {step === 1 && (
        <div style={s.card}>
          <h2 style={s.h2}>Шаг 1. Загрузите чертежи АР</h2>
          <div style={s.hint}>
            Подсказка: подайте PDF с чертежами раздела АР целиком, в нём может быть много листов — нужные листы вы
            выберете на следующих шагах. Файл обрабатывается в браузере и никуда не отправляется.
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button onClick={() => inputRef.current?.click()} style={{ ...s.btn, ...(busy ? s.btnDisabled : null) }} disabled={busy}>
            {busy ? "Открываем…" : "Выбрать PDF"}
          </button>
        </div>
      )}

      {/* ---------- 2. ТЭП ---------- */}
      {step === 2 && doc && (
        <div style={s.card}>
          <h2 style={s.h2}>Шаг 2. Лист с ТЭП по типам квартир</h2>
          <div style={s.meta}>{fileName} · листов в файле: {numPages}</div>
          <div style={s.hint}>
            Подсказка: нужен лист, где есть таблица «ТЭП по типам квартир» (столбцы «Кол-во на этаж», «Этаж размещения»),
            обычно это «Общие данные». Номер — это номер листа в PDF, он может отличаться от номера в штампе чертежа.
            ТЭП даёт квартиры на весь дом — по нему мы потом сверим расчёт по секциям.
            {scanLabel ? ` ${scanLabel}` : tepPageNo ? ` Такая таблица найдена на листе ${tepPageNo}, он уже подставлен.` : ""}
          </div>

          <label style={s.row}>
            <span style={s.label}>Номер листа (1–{numPages})</span>
            <input type="number" min={1} max={numPages} value={tepPageNo} onChange={(e) => setTepPageNo(e.target.value)} style={s.input} />
          </label>
          {tepPageNo !== "" && !tepPageValid && <div style={s.warnBox}>В файле нет листа {tepPageNo}: укажите число от 1 до {numPages}.</div>}

          {tepPageValid && (
            <div style={s.previewWrap}>
              <div style={s.previewLabel}>Лист {tepPageNo} {previewBusy ? "— загружается…" : ""}</div>
              <canvas ref={canvasRef} style={s.canvas} />
            </div>
          )}

          <div style={s.actions}>
            <button onClick={reset} style={s.btnGhost}>Другой файл</button>
            <button onClick={handleParseTep} disabled={!tepPageValid || !scan} style={{ ...s.btn, ...(!tepPageValid || !scan ? s.btnDisabled : null) }}>
              {!scan ? "Читаем листы…" : "Найти таблицу ТЭП"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- 3. Секции ---------- */}
      {step === 3 && tep && (
        <div style={s.card}>
          <h2 style={s.h2}>Шаг 3. Секции (блоки) дома</h2>
          <div style={s.meta}>ТЭП прочитан (лист {tep.page}): типов квартир — {tep.types.length}, всего квартир — {tep.total}.</div>

          <div style={s.hint}>
            Подсказка: секции ищем по «Схеме блокировки» на планах и по колонкам «блок-секция №N». Проверьте номера: первая
            ВДЦ будет на секцию №1, вторая — на все остальные секции вместе.
            {sectionsInfo?.source === "scheme" && ` «Схема блокировки» найдена на листах: ${sectionsInfo.schemePages.join(", ")}.`}
            {sectionsInfo?.source === "all" && " «Схемы блокировки» в файле нет, номера собраны из текста всех листов — проверьте их особенно внимательно."}
            {sectionsInfo?.source === "none" && " Номера секций в файле не найдены — введите их вручную."}
          </div>

          <label style={s.row}>
            <span style={s.label}>Номера секций (через запятую)</span>
            <input type="text" value={sectionsText} onChange={(e) => setSectionsText(e.target.value)} style={{ ...s.input, width: "200px" }} />
          </label>
          {sectionIds.length > 0 && (
            <div style={s.meta}>
              Первый блок: секция {firstId}.{" "}
              {sectionIds.length > 1 ? `Остальные: ${sectionIds.filter((id) => id !== firstId).map((id) => `№${id}`).join(", ")}.` : "Других секций нет."}
            </div>
          )}

          <div style={s.actions}>
            <button onClick={() => setStep(2)} style={s.btnGhost}>← К ТЭП</button>
            <button onClick={() => setStep(4)} disabled={!sectionIds.length} style={{ ...s.btn, ...(!sectionIds.length ? s.btnDisabled : null) }}>
              Дальше: планы этажей
            </button>
          </div>
        </div>
      )}

      {/* ---------- 4. Планы этажей ---------- */}
      {step === 4 && (
        <div style={s.card}>
          <h2 style={s.h2}>Шаг 4. Листы с планами этажей</h2>
          <div style={s.hint}>
            Подсказка: нужны маркировочные планы этажей — на них справа таблица «Экспликация помещений … этажа на секцию» со
            строкой «Количество квартир на этаже», а на самом плане выноски квартир и цифровые оси. Обычно это три листа:
            1-й этаж, средние этажи и верхние. Планы подвала, чердака и кровли не нужны — в списке их нет.
          </div>

          {explCandidates.length === 0 && <div style={s.warnBox}>Подходящие листы автоматически не найдены — добавьте номера листов вручную.</div>}
          <div style={s.list}>
            {explCandidates.map((c) => (
              <label key={c.page} style={s.checkRow}>
                <input type="checkbox" checked={!!explPicked[c.page]} onChange={(e) => setExplPicked((cur) => ({ ...cur, [c.page]: e.target.checked }))} />
                <span>
                  Лист {c.page} — {c.text} <span style={s.dim}>({floorsLabel(c.floors)})</span>
                  {c.scope.kind !== "section" && <span style={s.warnInline}> · относится к нескольким секциям, будет пропущен</span>}
                </span>
              </label>
            ))}
            {Object.keys(explPicked).filter((p) => explPicked[p] && !explCandidates.some((c) => String(c.page) === p)).map((p) => (
              <label key={p} style={s.checkRow}>
                <input type="checkbox" checked onChange={() => setExplPicked((cur) => ({ ...cur, [p]: false }))} />
                <span>Лист {p} — добавлен вручную</span>
              </label>
            ))}
          </div>

          <div style={s.row}>
            <span style={s.label}>Добавить лист вручную</span>
            <input type="number" min={1} max={numPages} value={manualExpl} onChange={(e) => setManualExpl(e.target.value)} style={s.input} />
            <button onClick={() => addPage(manualExpl, setExplPicked, setManualExpl)} style={s.btnGhost} disabled={manualExpl === ""}>Добавить</button>
          </div>

          <div style={s.actions}>
            <button onClick={() => setStep(3)} style={s.btnGhost}>← К секциям</button>
            <button onClick={handleBuildLayout} style={s.btn}>Дальше: оси квартир</button>
          </div>
        </div>
      )}

      {/* ---------- 5. Оси квартир ---------- */}
      {step === 5 && layout && (
        <div style={s.card}>
          <h2 style={s.h2}>Шаг 5. Квартиры и их оси</h2>
          <div style={s.hint}>
            Подсказка: каждая квартира показывается отдельно, к типу дописывается, в каких осях она стоит («в/о 1-6»). Оси
            определены по выноскам квартир и подписям цифровых осей на плане; у каждой секции своя линия осей. Проверьте и при
            необходимости поправьте подписи — они попадут в таблицу как есть.
          </div>
          {layoutNotes.map((n, i) => <div key={i} style={s.warnBox}>{n}</div>)}

          {layout.map((e, pi) => (
            <div key={e.page} style={s.group}>
              <div style={s.groupTitle}>{floorsLabel(e.floors)} <span style={s.dim}>· лист {e.page}</span></div>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={{ ...s.th, textAlign: "left" }}>Квартира</th>
                    {sectionIds.map((id) => <th key={id} style={s.th}>Секция {id}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {e.flats.map((f, fi) => (
                    <tr key={fi}>
                      <td style={s.td}>Тип {f.code}</td>
                      {sectionIds.map((id) => (
                        <td key={id} style={{ ...s.td, textAlign: "center" }}>
                          <input
                            type="text"
                            value={f.labels[id] || ""}
                            placeholder="в/о 1-6"
                            onChange={(ev) => setAxis(pi, fi, id, ev.target.value)}
                            style={{ ...s.input, width: "120px" }}
                            aria-label={`Оси, секция ${id}, тип ${f.code}`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <div style={s.actions}>
            <button onClick={() => setStep(4)} style={s.btnGhost}>← К листам этажей</button>
            <button onClick={() => setStep(loggias.length ? 6 : 7)} style={s.btn}>{loggias.length ? "Дальше: лоджии и балконы" : "Дальше: ведомость отделки"}</button>
          </div>
        </div>
      )}

      {/* ---------- 6. Лоджии и балконы ---------- */}
      {step === 6 && (
        <div style={s.card}>
          <h2 style={s.h2}>Шаг 6. Лоджии и балконы: коэффициенты</h2>
          <div style={s.hint}>
            Подсказка: в экспликации помещений площадь лоджий и балконов приведённая — она уже умножена на коэффициент,
            который написан в скобках в названии («к=0,5»). Фактическая площадь = площадь по экспликации ÷ коэффициент.
            Мы предлагаем коэффициенты по названиям из чертежа, а если в названии коэффициента нет — типовые (лоджия 0,5;
            балкон и терраса 0,3). Проверьте их и подтвердите — без вашего подтверждения дальше не пускаем.
          </div>

          <div style={s.scroll}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={{ ...s.th, textAlign: "left" }}>Помещение</th>
                  <th style={{ ...s.th, textAlign: "left" }}>Площадь по экспликации → фактическая</th>
                  <th style={s.th}>Предложено</th>
                  <th style={s.th}>Коэффициент</th>
                </tr>
              </thead>
              <tbody>
                {loggias.map((l) => {
                  const k = parseK(l.k);
                  return (
                    <tr key={l.key}>
                      <td style={s.td}>{l.no}. {l.name}</td>
                      <td style={s.td}>
                        {Object.entries(l.areas).filter(([, v]) => v != null).map(([code, v]) => (
                          <div key={code}>
                            Тип {code}: {fmtArea(v)} м² → <b>{k ? `${fmtArea(round2(v / k))} м²` : "—"}</b>
                          </div>
                        ))}
                      </td>
                      <td style={{ ...s.td, textAlign: "center", color: l.source === "drawing" ? "#1a7f37" : "#8a5a00" }}>
                        {String(l.proposed).replace(".", ",")}
                        <div style={s.small}>{l.source === "drawing" ? "из названия в чертеже" : "типовой — уточните"}</div>
                      </td>
                      <td style={{ ...s.td, textAlign: "center" }}>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={l.k}
                          onChange={(e) => setLoggiaK(l.key, e.target.value)}
                          style={{ ...s.input, width: "80px", borderColor: k ? "#ccc" : "#c0392b" }}
                          aria-label={`Коэффициент: ${l.name}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!loggiasValid && <div style={s.warnBox}>Коэффициент должен быть числом больше 0 и не больше 1 (например, 0,5).</div>}

          <label style={s.checkRow}>
            <input type="checkbox" checked={loggiasConfirmed} disabled={!loggiasValid} onChange={(e) => setLoggiasConfirmed(e.target.checked)} />
            <span>Я проверил(а) коэффициенты и подтверждаю их</span>
          </label>

          <div style={s.actions}>
            <button onClick={() => setStep(5)} style={s.btnGhost}>← К осям квартир</button>
            <button onClick={() => setStep(7)} disabled={!loggiasConfirmed || !loggiasValid} style={{ ...s.btn, ...(!loggiasConfirmed || !loggiasValid ? s.btnDisabled : null) }}>
              Дальше: ведомость отделки
            </button>
          </div>
        </div>
      )}

      {/* ---------- 7. Ведомость отделки ---------- */}
      {step === 7 && (
        <div style={s.card}>
          <h2 style={s.h2}>Шаг 7. Ведомость отделки помещений</h2>
          <div style={s.hint}>
            Подсказка: нужен лист «Ведомость отделки помещений» — в ней по каждому типу квартиры расписаны помещения с видом
            отделки потолка и стен и площадями «на 1 кв-ру». Там же справа расшифровка «Виды отделки помещений». Таблица может
            идти в две колонки («начало» и «окончание») — читаются обе.
          </div>
          <div style={s.hint}>
            Расценки (утверждённые в ТОО VK development group, внутренняя отделка) и правила «помещение → работы» подставятся
            автоматически. Потолки в помещениях 1–{CEILINGS_EXCLUDED_UP_TO} в эту ВДЦ не входят — для них будет отдельная ВДЦ на натяжные потолки.
          </div>
          {finCandidates.length === 0 && <div style={s.warnBox}>Лист с таким заголовком не найден — добавьте номер листа вручную.</div>}
          <div style={s.list}>
            {finCandidates.map((p) => (
              <label key={p} style={s.checkRow}>
                <input type="checkbox" checked={!!finPicked[p]} onChange={(e) => setFinPicked((cur) => ({ ...cur, [p]: e.target.checked }))} />
                <span>Лист {p} — Ведомость отделки помещений</span>
              </label>
            ))}
            {Object.keys(finPicked).filter((p) => finPicked[p] && !finCandidates.includes(Number(p))).map((p) => (
              <label key={p} style={s.checkRow}>
                <input type="checkbox" checked onChange={() => setFinPicked((cur) => ({ ...cur, [p]: false }))} />
                <span>Лист {p} — добавлен вручную</span>
              </label>
            ))}
          </div>
          <div style={s.row}>
            <span style={s.label}>Добавить лист вручную</span>
            <input type="number" min={1} max={numPages} value={manualFin} onChange={(e) => setManualFin(e.target.value)} style={s.input} />
            <button onClick={() => addPage(manualFin, setFinPicked, setManualFin)} style={s.btnGhost} disabled={manualFin === ""}>Добавить</button>
          </div>
          <button onClick={handleParseFinishing} style={{ ...s.btnGhost, alignSelf: "flex-start" }}>Прочитать ведомость</button>

          {finishing && (
            <>
              <Checks checks={finishing.checks} />
              {finPreview.map((t) => (
                <div key={t.code} style={s.group}>
                  <div style={s.groupTitle}>Квартира — тип {t.code} <span style={s.dim}>· помещений: {t.rooms.length}</span></div>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={{ ...s.th, textAlign: "left" }}>Помещение</th>
                        <th style={s.th}>Потолок</th>
                        <th style={{ ...s.th, textAlign: "left" }}>Стены и перегородки</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.rooms.map((r) => (
                        <tr key={r.no}>
                          <td style={s.td}>{r.no}. {r.name || "помещение"}</td>
                          <td style={{ ...s.td, textAlign: "center" }}>{r.ceiling ? `вид ${r.ceiling.id} — ${fmtArea(r.ceiling.area)} м²` : "—"}</td>
                          <td style={s.td}>{r.walls.length ? r.walls.map((w) => `вид ${w.id} — ${fmtArea(w.area)} м²`).join("; ") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}

          <div style={s.actions}>
            <button onClick={() => setStep(loggias.length ? 6 : 5)} style={s.btnGhost}>← Назад</button>
            <button onClick={handleToMeasure} disabled={!finishing} style={{ ...s.btn, ...(!finishing ? s.btnDisabled : null) }}>
              Дальше: обмер
            </button>
          </div>
        </div>
      )}

      {/* ---------- 8. Обмер ---------- */}
      {step === 8 && (
        <div style={s.card}>
          <h2 style={s.h2}>Шаг 8. Обмер</h2>
          <div style={s.hint}>
            Подсказка: у части работ в чертежах нет готового объёма — плинтус (его длину нужно обмерить по плану) и стены лоджий
            (в ведомости отделки их нет). Квартиры одного типа одинаковые, поэтому достаточно обмерить ОДНУ квартиру каждого типа:
            значение подставится во все квартиры этого типа. Введите число вручную или нажмите «Обмерить на чертеже» — откроется
            нужный лист с инструментом замеров (сначала калибровка листа, потом обводка линией).
          </div>

          {tasks.some((t) => t.kind === "walls") && (
            <label style={s.row}>
              <span style={s.label}>Высота стен лоджий, м</span>
              <input type="text" inputMode="decimal" value={wallHeight} onChange={(e) => setWallHeight(e.target.value)} style={s.input} aria-label="Высота стен лоджий, м" />
              <span style={s.small}>
                {ceilingHeight ? `предложено из общих данных (лист ${ceilingHeight.page}): «высота от пола до потолка» ${String(ceilingHeight.value).replace(".", ",")} м — проверьте` : "укажите высоту"}
              </span>
            </label>
          )}

          {[...new Set(tasks.map((t) => t.code))].map((code) => (
            <div key={code} style={s.group}>
              <div style={s.groupTitle}>
                Квартира типа {code} <span style={s.dim}>· таких квартир в доме: {typeCounts[code] || 0}{flatsHintFor(code) ? ` · ${flatsHintFor(code)}` : ""}</span>
              </div>
              <div style={s.scroll}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={{ ...s.th, textAlign: "left" }}>Помещение</th>
                      <th style={{ ...s.th, textAlign: "left" }}>Что обмерить</th>
                      <th style={s.th}>По чертежу</th>
                      <th style={s.th}>Вручную</th>
                      <th style={s.th}>Принято</th>
                      <th style={s.th} />
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.filter((t) => t.code === code).map((t) => {
                      const drawn = taskTotal(measureLines[t.key] || [], calibrations, { kind: t.kind, height: wallHeight });
                      const value = taskValue(t);
                      return (
                        <tr key={t.key}>
                          <td style={s.td}>{t.roomNo}. {t.roomName}</td>
                          <td style={s.td}>
                            {t.label}
                            <div style={s.small}>{[...new Set(t.works)].length > 1 ? `для работ: ${[...new Set(t.works)].length}` : ""}</div>
                          </td>
                          <td style={{ ...s.td, textAlign: "center" }}>
                            {drawn.total ? `${fmtArea(drawn.total)} ${t.unit}` : "—"}
                            {drawn.uncounted > 0 && <div style={s.small}>не посчитано: {drawn.uncounted} лин.</div>}
                          </td>
                          <td style={{ ...s.td, textAlign: "center" }}>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={manualValues[t.key] || ""}
                              placeholder={t.unit}
                              onChange={(e) => setManualValues((cur) => ({ ...cur, [t.key]: e.target.value }))}
                              style={{ ...s.input, width: "90px", borderColor: manualValues[t.key] && !parseManual(manualValues[t.key]) ? "#c0392b" : "#ccc" }}
                              aria-label={`Вручную: ${t.roomName}, ${t.label}`}
                            />
                          </td>
                          <td style={{ ...s.td, textAlign: "center", fontWeight: 700, color: value ? "#1a7f37" : "#8a5a00" }}>
                            {value ? `${fmtArea(value)} ${t.unit}` : "не задано"}
                          </td>
                          <td style={{ ...s.td, textAlign: "center" }}>
                            <button type="button" style={s.btnGhost} onClick={() => setDialogKey(t.key)}>Обмерить на чертеже</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div style={s.meta}>Задано {tasks.filter((t) => taskValue(t)).length} из {tasks.length}. Позиции без обмера останутся без объёма и в сумму не войдут.</div>

          <div style={s.actions}>
            <button onClick={() => setStep(7)} style={s.btnGhost}>← К ведомости отделки</button>
            <button onClick={handleBuildResult} style={s.btn}>Собрать черновик ВДЦ на внутреннюю отделку</button>
          </div>
        </div>
      )}

      {/* ---------- 9. Результат ---------- */}
      {step === 9 && result && split && (
        <>
          <div style={s.card}>
            <h2 style={s.h2}>Проверка</h2>
            <div style={s.meta}>{fileName} · секции: {result.sections.join(", ")} · этажи: {result.floors.length ? `${result.floors[0]}–${result.floors[result.floors.length - 1]}` : "—"} · квартир: {result.rows.length}</div>
            <Checks checks={result.checks} />
            {result.warnings.map((w, i) => <div key={i} style={s.warnBox}>{w}</div>)}
            {result.checks.some((c) => !c.ok) && (
              <div style={s.warnBox}>Есть расхождения — проверьте номера секций, листы и оси, прежде чем использовать таблицы.</div>
            )}
          </div>

          <div style={{ ...s.card, marginTop: "16px" }}>
            <h2 style={s.h2}>ВДЦ 1 — внутренняя отделка, первый блок (секция №{result.firstId})</h2>
            {viewSwitch}
            {view === "works" ? <WorksTable rows={split.first} showSection={false} /> : <VdcTable rows={split.first} showSection={false} />}
            <div style={s.actions}>
              <span />
              <button onClick={() => copyRows("first", split.first)} style={s.btn}>{copied === "first" ? "Скопировано ✓" : "Скопировать таблицу"}</button>
            </div>
          </div>

          {otherIds.length > 0 && (
            <div style={{ ...s.card, marginTop: "16px" }}>
              <h2 style={s.h2}>ВДЦ 2 — внутренняя отделка, остальные секции ({otherIds.map((id) => `№${id}`).join(", ")})</h2>
              {view === "works" ? <WorksTable rows={split.others} showSection /> : <VdcTable rows={split.others} showSection />}
              <div style={s.actions}>
                <span />
                <button onClick={() => copyRows("others", split.others)} style={s.btn}>{copied === "others" ? "Скопировано ✓" : "Скопировать таблицу"}</button>
              </div>
            </div>
          )}

          <div style={{ ...s.actions, marginTop: "16px" }}>
            <button onClick={() => setStep(tasks.length ? 8 : 7)} style={s.btnGhost}>{tasks.length ? "← К обмеру" : "← К ведомости отделки"}</button>
            <button onClick={reset} style={s.btnGhost}>Начать заново</button>
          </div>
        </>
      )}
      {dialogTask && (
        <MeasureDialog
          key={dialogTask.key}
          doc={doc}
          numPages={numPages}
          task={dialogTask}
          flatsHint={flatsHintFor(dialogTask.code) ? `Квартира типа ${dialogTask.code} ${flatsHintFor(dialogTask.code)}.` : ""}
          initialPage={layout?.[0]?.page}
          itemsOf={itemsOf}
          lines={measureLines[dialogTask.key] || []}
          onLinesChange={(lines) => setMeasureLines((cur) => ({ ...cur, [dialogTask.key]: lines }))}
          calibrations={calibrations}
          onCalibrate={(pageNo, k) => setCalibrations((cur) => ({ ...cur, [pageNo]: k }))}
          height={wallHeight}
          onHeightChange={setWallHeight}
          onClose={() => setDialogKey(null)}
        />
      )}
    </div>
  );
};

const s = {
  page: { padding: "24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "1040px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px", flexWrap: "wrap" },
  back: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" },
  title: { margin: 0, fontSize: "22px" },

  steps: { display: "flex", gap: "8px", listStyle: "none", padding: 0, margin: "0 0 16px", flexWrap: "wrap" },
  step: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 12px", borderRadius: "999px", background: "#f1f1f1", color: "#777", fontSize: "13px" },
  stepActive: { background: "#e3eefb", color: "#1a5fb4", fontWeight: 600 },
  stepDone: { background: "#e7f6ec", color: "#1a7f37" },
  stepNum: { fontWeight: 700 },

  card: { background: "#fff", borderRadius: "12px", padding: "18px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", display: "flex", flexDirection: "column", gap: "12px" },
  h2: { fontSize: "16px", margin: 0 },
  h3: { fontSize: "14px", margin: "8px 0 0" },
  meta: { fontSize: "13px", color: "#555", wordBreak: "break-all" },
  hint: { background: "#eef5ff", color: "#27415f", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", lineHeight: 1.5 },
  row: { display: "flex", alignItems: "center", gap: "12px", fontSize: "14px", flexWrap: "wrap" },
  label: { color: "#555" },
  input: { padding: "8px 10px", border: "1px solid #ccc", borderRadius: "6px", fontSize: "14px", width: "90px" },

  previewWrap: { border: "1px solid #e3e3e3", borderRadius: "8px", padding: "8px", overflow: "auto", maxHeight: "480px", background: "#fafafa" },
  previewLabel: { fontSize: "12px", color: "#777", marginBottom: "6px" },
  canvas: { maxWidth: "100%", height: "auto", display: "block", background: "#fff" },

  list: { display: "flex", flexDirection: "column", gap: "8px" },
  checkRow: { display: "flex", alignItems: "flex-start", gap: "10px", fontSize: "14px", lineHeight: 1.4 },
  dim: { color: "#777", fontWeight: 400 },
  warnInline: { color: "#8a5a00" },
  group: { border: "1px solid #ececec", borderRadius: "8px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" },
  groupTitle: { fontSize: "14px", fontWeight: 600 },

  errorBox: { background: "#fdecec", color: "#c0392b", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", marginBottom: "12px" },
  warnBox: { background: "#fff6e0", color: "#8a5a00", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", lineHeight: 1.5 },
  checks: { margin: 0, paddingLeft: "18px", fontSize: "13px", lineHeight: 1.7, listStyle: "none" },

  scroll: { maxHeight: "560px", overflow: "auto", border: "1px solid #f0f0f0", borderRadius: "8px" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
  th: { textAlign: "center", padding: "8px 6px", borderBottom: "2px solid #ddd", background: "#f7f7f7", fontSize: "13px", position: "sticky", top: 0 },
  td: { padding: "6px 6px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" },
  tab: { background: "#fff", color: "#1a5fb4", border: "1px solid #1a5fb4", borderRadius: "999px", padding: "6px 14px", fontSize: "13px", cursor: "pointer" },
  tabActive: { background: "#1a5fb4", color: "#fff", border: "1px solid #1a5fb4", borderRadius: "999px", padding: "6px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer" },
  small: { fontSize: "11px", color: "#777", marginTop: "2px" },
  roomStart: { borderTop: "1px solid #e4e4e4" },
  flatRow: { padding: "8px 6px", background: "#eef5ff", color: "#1a3a63", fontWeight: 600, fontSize: "13px", borderBottom: "1px solid #dbe8fa" },

  actions: { display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" },
  btn: { background: "#1a5fb4", color: "#fff", border: "none", borderRadius: "8px", padding: "12px 16px", fontSize: "14px", fontWeight: 600, cursor: "pointer" },
  btnDisabled: { background: "#c8c8c8", cursor: "default" },
  btnGhost: { background: "#fff", color: "#1a5fb4", border: "1px solid #1a5fb4", borderRadius: "8px", padding: "10px 14px", fontSize: "14px", fontWeight: 600, cursor: "pointer" },
};

export default VdcArDraftPage;
