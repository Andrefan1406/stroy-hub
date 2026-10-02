// Личный кабинет админа → «Пересинк финплана». Финпланы объектов считаются
// заранее (сметы из Google Sheets + пересинк ГПР) — ночью по расписанию, а
// отсюда — принудительно, когда правки в смете/ГПР нужны сразу. Бэкенд:
// services/financing-api/plan_cache.py.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchResyncStatus, startFinancingResync } from "./financingPlanApi";

const fmtDateTime = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" });
  } catch {
    return iso;
  }
};

const FinancingResyncAdminPage = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const pollRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchResyncStatus();
      setStatus(data);
      setError("");
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, []);

  useEffect(() => {
    loadStatus();
    return () => clearInterval(pollRef.current);
  }, [loadStatus]);

  // Пока идёт пересчёт — опрашиваем статус раз в 3 сек.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (status?.running) {
      pollRef.current = setInterval(loadStatus, 3000);
    }
    return () => clearInterval(pollRef.current);
  }, [status?.running, loadStatus]);

  const handleResync = async () => {
    if (starting || status?.running) return;
    if (!window.confirm("Пересчитать финпланы всех объектов? Займёт пару минут.")) return;
    setStarting(true);
    setError("");
    try {
      setStatus(await startFinancingResync());
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const running = status?.running;
  const lastRun = status?.last_run;

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => navigate("/admin")} style={s.back}>← Назад</button>
        <h1 style={s.title}>Пересинк финплана</h1>
      </div>

      <p style={s.intro}>
        Финпланы объектов (сметы и графики ГПР) пересчитываются автоматически каждую ночь в{" "}
        {String(status?.nightly_hour ?? 3).padStart(2, "0")}:00 — страница финплана открывается из готовых данных.
        Если правки в смете или ГПР нужны сразу, запустите пересчёт вручную.
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      <div style={s.card}>
        {status &&
          Object.entries(status.objects).map(([key, obj]) => (
            <div key={key} style={s.row}>
              <span style={s.label}>{obj.name}</span>
              <span style={s.value}>{obj.built_at ? `обновлён ${fmtDateTime(obj.built_at)}` : "ещё не посчитан"}</span>
            </div>
          ))}

        {running && (
          <div style={s.runningBox}>
            <span style={s.spinner} /> Идёт пересчёт… (запущен {fmtDateTime(status.started_at)}, {status.reason})
          </div>
        )}

        {!running && lastRun && lastRun.ok && (
          <div style={s.okBox}>
            Готово: {lastRun.reason}, {fmtDateTime(lastRun.finished_at)}
          </div>
        )}
        {!running && lastRun && !lastRun.ok && (
          <div style={s.errorBox}>
            Пересчёт прошёл с ошибками ({fmtDateTime(lastRun.finished_at)}): {lastRun.error}
          </div>
        )}

        <button
          onClick={handleResync}
          disabled={starting || running}
          style={{ ...s.btn, ...(starting || running ? s.btnDisabled : null) }}
        >
          {running ? "Идёт пересчёт…" : starting ? "Запуск…" : "Пересчитать финплан сейчас"}
        </button>
      </div>

      <style>{`
        @keyframes finResyncSpin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

const s = {
  page: { padding: "24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "640px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px" },
  back: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" },
  title: { margin: 0, fontSize: "22px" },
  intro: { fontSize: "14px", color: "#555", lineHeight: 1.5, marginBottom: "16px" },

  card: { background: "#fff", borderRadius: "12px", padding: "18px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", display: "flex", flexDirection: "column", gap: "10px" },
  row: { display: "flex", justifyContent: "space-between", fontSize: "14px", borderBottom: "1px solid #f0f0f0", paddingBottom: "8px" },
  label: { color: "#888" },
  value: { fontWeight: 600, color: "#222" },

  runningBox: { display: "flex", alignItems: "center", gap: "10px", background: "#eef5ff", color: "#1a5fb4", borderRadius: "8px", padding: "10px 12px", fontSize: "13px" },
  okBox: { background: "#e7f6ec", color: "#1a7f37", borderRadius: "8px", padding: "10px 12px", fontSize: "13px" },
  errorBox: { background: "#fdecec", color: "#c0392b", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", marginTop: "8px" },

  spinner: { width: "14px", height: "14px", border: "2px solid #b3d1ff", borderTopColor: "#1a5fb4", borderRadius: "50%", display: "inline-block", animation: "finResyncSpin 0.8s linear infinite" },

  btn: { marginTop: "6px", background: "#1a5fb4", color: "#fff", border: "none", borderRadius: "8px", padding: "12px 16px", fontSize: "14px", fontWeight: 600, cursor: "pointer" },
  btnDisabled: { background: "#c8c8c8", cursor: "default" },
};

export default FinancingResyncAdminPage;
