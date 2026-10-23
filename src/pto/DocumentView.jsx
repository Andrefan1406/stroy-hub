// Открытый документ ПТО: шапка (объект, статус, Excel, подтверждение) и вкладки
// «Ведомость» / «Виды работ» / «Итого» / «Отчёт разбора».
import React, { useCallback, useEffect, useState } from "react";
import { ptoDownloadExcel, ptoGet, ptoPost } from "./api";
import { DOC_STATUS } from "./format";
import ItemsTab from "./ItemsTab";
import ReportTab from "./ReportTab";
import TotalsTab from "./TotalsTab";
import WorksTab from "./WorksTab";
import { s } from "./styles";

export default function DocumentView({ id, onBack }) {
  const [doc, setDoc] = useState(null);
  const [items, setItems] = useState([]);
  const [works, setWorks] = useState([]);
  const [tab, setTab] = useState("items");
  const [version, setVersion] = useState(0); // меняется при любой правке — вкладка «Итого» пересчитывается
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, i, w] = await Promise.all([ptoGet(`/documents/${id}`), ptoGet(`/documents/${id}/items`), ptoGet(`/documents/${id}/works`)]);
      setDoc(d.document);
      setItems(i.items);
      setWorks(w.works);
      setVersion((v) => v + 1);
      setError("");
    } catch (err) {
      setError(err.message || "Не удалось загрузить документ");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Пока документ ещё разбирается (открыли сразу после загрузки) — ждём.
  const parsing = doc && doc.status === "parsing";
  useEffect(() => {
    if (!parsing) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [parsing, load]);

  const confirm = async () => {
    if (!window.confirm("Подтвердить ведомость и виды работ? Все строки получат статус «проверено». Любая последующая правка вернёт документ в «черновик».")) return;
    setBusy(true);
    try {
      await ptoPost(`/documents/${id}/confirm`);
      setNotice("Ведомость подтверждена");
      await load();
    } catch (err) {
      setError(err.message || "Не удалось подтвердить");
    } finally {
      setBusy(false);
    }
  };
  const excel = async () => {
    setBusy(true);
    try {
      await ptoDownloadExcel(id, `Ведомость ${doc.section} ${doc.object}.xlsx`);
    } catch (err) {
      setError(err.message || "Не удалось скачать Excel");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={s.muted}>Загрузка…</div>;
  if (!doc) return <div><button style={s.back} onClick={onBack}>← К списку</button><div style={{ ...s.error, marginTop: 12 }}>{error || "Документ не найден"}</div></div>;
  const st = DOC_STATUS[doc.status] || DOC_STATUS.draft;
  const draftCount = items.filter((i) => i.status === "draft").length + works.filter((w) => w.status === "draft").length;
  const tabs = [
    ["items", `Ведомость (${items.length})`],
    ["works", `Виды работ (${works.length})`],
    ["totals", "Итого"],
    ["report", `Отчёт разбора${doc.report && doc.report.issues.filter((i) => i.level !== "info").length ? ` (${doc.report.issues.filter((i) => i.level !== "info").length})` : ""}`],
  ];

  return (
    <div>
      <div style={{ ...s.header, marginBottom: 8 }}>
        <button style={s.back} onClick={onBack}>← К списку</button>
        <h2 style={{ margin: 0, fontSize: 20 }}>
          {doc.section}: {[doc.object, doc.position && `поз. ${doc.position}`].filter(Boolean).join(" · ")}
        </h2>
        <span style={s.chip(st.color, st.bg)}>{st.label}</span>
      </div>
      <div style={{ ...s.muted, marginBottom: 12 }}>Файл: {doc.fileName} · листов: {doc.pageCount ?? "—"}</div>

      {error && <div style={s.error}>{error}</div>}
      {notice && <div style={s.notice} onClick={() => setNotice("")}>{notice}</div>}
      {doc.status === "error" && <div style={s.error}>{doc.error}</div>}
      {parsing && <div style={s.warn}>Документ разбирается — страница обновится сама.</div>}

      {doc.status !== "error" && !parsing && (
        <>
          <div style={{ marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button style={busy ? { ...s.primary, ...s.disabled } : s.primary} disabled={busy || doc.status === "confirmed"} onClick={confirm}>
              {doc.status === "confirmed" ? "Ведомость подтверждена ✓" : "Подтвердить ведомость"}
            </button>
            <button style={s.secondary} disabled={busy} onClick={excel}>Скачать Excel</button>
            {doc.status !== "confirmed" && draftCount > 0 && <span style={s.muted}>Строк в статусе «черновик»: {draftCount} — проверьте перед подтверждением</span>}
          </div>
          <div style={s.tabs}>
            {tabs.map(([key, label]) => (
              <button key={key} style={tab === key ? s.tabActive : s.tab} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          {tab === "items" && <ItemsTab doc={doc} items={items} reload={load} onError={setError} />}
          {tab === "works" && <WorksTab doc={doc} works={works} reload={load} onError={setError} onNotice={setNotice} />}
          {tab === "totals" && <TotalsTab doc={doc} version={version} onError={setError} />}
          {tab === "report" && <ReportTab doc={doc} />}
        </>
      )}
    </div>
  );
}
