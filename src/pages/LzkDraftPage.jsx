// «Черновик ЛЗК по ведомости договорной цены»: пользователь загружает Excel
// с ВДЦ, сервер (server/lzk/) группирует работы, считает материалы по нормам
// расхода и возвращает Excel с лимитно-заборной картой. Ничего не хранится.
import React, { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAuth } from "firebase/auth";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const currentMonth = () => {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Almaty" }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const fmtNum = (n) => Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 3 });

function base64ToBlob(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: XLSX_MIME });
}

const LzkDraftPage = () => {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [month, setMonth] = useState(currentMonth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { fileName, blob, summary }

  const pickFile = (f) => {
    setFile(f || null);
    setResult(null);
    setError("");
  };

  const download = (res) => {
    const url = URL.createObjectURL(res.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleGenerate = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const user = getAuth().currentUser;
      if (!user) throw new Error("Не авторизован");
      const token = await user.getIdToken();
      const res = await fetch(`${API_URL}/api/lzk/generate?month=${encodeURIComponent(month)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
      const out = { fileName: data.fileName, blob: base64ToBlob(data.fileBase64), summary: data.summary };
      setResult(out);
      download(out);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const summary = result?.summary;
  const fileLabel = useMemo(() => (file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} КБ)` : "Файл не выбран"), [file]);

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => navigate("/")} style={s.back}>← Назад</button>
        <h1 style={s.title}>Черновики ЛЗК и М-29 по ВДЦ</h1>
      </div>

      <p style={s.intro}>
        Загрузите ведомость договорной цены в Excel. Работы из столбцов «Наименование работ», «Ед. изм.»,
        «Кол-во» будут сгруппированы и просуммированы, по нормам расхода рассчитаются материалы, и вы
        получите Excel с двумя листами: лимитно-заборная карта (столбцы по дням — на год, начиная с первого числа
        выбранного месяца) и отчёт М-29 (заполнены лимиты и нормы, факт вносят на участке, столбцы на год). Пока поддерживается только каменная кладка (газоблок, кирпич, вентшахты, пазогребень): работы без норм
        расхода в расчёт не попадут и будут показаны отдельным списком. Результат — черновик, проверьте его перед использованием.
      </p>

      <div style={s.card}>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xlsm,.xls"
          style={{ display: "none" }}
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        <div style={s.fileRow}>
          <button onClick={() => inputRef.current?.click()} style={s.btnGhost} disabled={busy}>
            Выбрать файл ВДЦ
          </button>
          <span style={s.fileName}>{fileLabel}</span>
        </div>

        <label style={s.monthRow}>
          <span style={s.label}>Начало карты — месяц</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={s.monthInput} disabled={busy} />
        </label>

        {error && <div style={s.errorBox}>{error}</div>}

        <button
          onClick={handleGenerate}
          disabled={!file || busy || !month}
          style={{ ...s.btn, ...(!file || busy || !month ? s.btnDisabled : null) }}
        >
          {busy ? "Формируем…" : "Сформировать ЛЗК и М-29"}
        </button>
      </div>

      {summary && (
        <div style={{ ...s.card, marginTop: "16px" }}>
          <div style={s.okBox}>
            Готово: {summary.rows} строк ВДЦ → {summary.works.length} видов работ → {summary.materials.length} материалов.
            Файл скачан.
          </div>
          <button onClick={() => download(result)} style={s.btnGhost}>Скачать ещё раз</button>

          {summary.meta?.object && <div style={s.meta}>Объект: «{summary.meta.object}»</div>}

          {summary.unmatched.length > 0 && (
            <div style={s.warnBox}>
              <strong>Не учтено в лимитах ({summary.unmatched.length}):</strong>
              <ul style={s.list}>
                {summary.unmatched.map((u, i) => (
                  <li key={i}>
                    {u.name} — {fmtNum(u.qty)} {u.unit} ({u.reason})
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h2 style={s.h2}>Объёмы работ</h2>
          <table style={s.table}>
            <tbody>
              {summary.works.map((w, i) => (
                <tr key={i}>
                  <td style={s.td}>{w.priceName}</td>
                  <td style={{ ...s.td, ...s.num }}>
                    {fmtNum(w.qty)} {w.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 style={s.h2}>Лимиты материалов</h2>
          <table style={s.table}>
            <tbody>
              {summary.materials.map((m, i) => (
                <tr key={i}>
                  <td style={s.td}>{m.name}</td>
                  <td style={{ ...s.td, ...s.num }}>
                    {fmtNum(m.limit)} {m.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const s = {
  page: { padding: "24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "720px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px" },
  back: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" },
  title: { margin: 0, fontSize: "22px" },
  intro: { fontSize: "14px", color: "#555", lineHeight: 1.5, marginBottom: "16px" },

  card: { background: "#fff", borderRadius: "12px", padding: "18px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", display: "flex", flexDirection: "column", gap: "12px" },
  fileRow: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
  fileName: { fontSize: "13px", color: "#555", wordBreak: "break-all" },
  monthRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", fontSize: "14px" },
  monthInput: { padding: "8px 10px", border: "1px solid #ccc", borderRadius: "6px", fontSize: "14px" },
  label: { color: "#555" },
  meta: { fontSize: "13px", color: "#555" },

  okBox: { background: "#e7f6ec", color: "#1a7f37", borderRadius: "8px", padding: "10px 12px", fontSize: "13px" },
  errorBox: { background: "#fdecec", color: "#c0392b", borderRadius: "8px", padding: "10px 12px", fontSize: "13px" },
  warnBox: { background: "#fff6e0", color: "#8a5a00", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", lineHeight: 1.5 },
  list: { margin: "6px 0", paddingLeft: "20px" },

  h2: { fontSize: "15px", margin: "8px 0 0" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
  td: { padding: "6px 4px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" },
  num: { textAlign: "right", whiteSpace: "nowrap", fontWeight: 600 },

  btn: { background: "#1a5fb4", color: "#fff", border: "none", borderRadius: "8px", padding: "12px 16px", fontSize: "14px", fontWeight: 600, cursor: "pointer" },
  btnDisabled: { background: "#c8c8c8", cursor: "default" },
  btnGhost: { background: "#fff", color: "#1a5fb4", border: "1px solid #1a5fb4", borderRadius: "8px", padding: "10px 14px", fontSize: "14px", fontWeight: 600, cursor: "pointer", alignSelf: "flex-start" },
};

export default LzkDraftPage;
