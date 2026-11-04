// Личный кабинет админа → «Использование ЛЗК и М-29»: кто загружал ВДЦ, как часто,
// какие работы чаще всего не находятся (их пора добавлять в словарь норм) и
// последние запросы с ошибками. Бэкенд: server/lzk/usage.js.
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAuth } from "firebase/auth";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

async function apiFetch(path) {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  const token = await user.getIdToken();
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

// created_at в базе — UTC без часового пояса («2026-11-04 09:22:10»)
const fmtDateTime = (sqlUtc) => {
  if (!sqlUtc) return "—";
  try {
    return new Date(`${sqlUtc.replace(" ", "T")}Z`).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return sqlUtc;
  }
};

const LzkUsageAdminPage = () => {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch("/api/admin/lzk-usage?limit=300"));
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const recent = (data?.recent || []).filter((r) => !onlyProblems || r.error || r.unmatched.length > 0);

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => navigate("/admin")} style={s.back}>← Назад</button>
        <h1 style={s.title}>Использование ЛЗК и М-29</h1>
        <button onClick={load} disabled={loading} style={s.refresh}>{loading ? "Обновляем…" : "Обновить"}</button>
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      {data && (
        <>
          <div style={s.cards}>
            <Card label="Запросов" value={data.totals.requests} color="#2f6db5" />
            <Card label="Пользователей" value={data.totals.users} color="#2e8b57" />
            <Card label="С ошибкой" value={data.totals.errors} color={data.totals.errors ? "#c0392b" : "#888"} />
          </div>

          <Section title="Кто пользовался" color="#2e8b57">
            {data.perUser.length === 0 ? (
              <p style={s.empty}>Пока никто не пользовался.</p>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr><th style={s.th}>Email</th><th style={{ ...s.th, ...s.num }}>Запросов</th><th style={{ ...s.th, ...s.num }}>С ошибкой</th><th style={s.th}>Последний раз</th></tr>
                </thead>
                <tbody>
                  {data.perUser.map((u) => (
                    <tr key={u.email}>
                      <td style={s.td}>{u.email || "—"}</td>
                      <td style={{ ...s.td, ...s.num }}>{u.requests}</td>
                      <td style={{ ...s.td, ...s.num, color: u.errors ? "#c0392b" : undefined }}>{u.errors}</td>
                      <td style={s.td}>{fmtDateTime(u.last_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Какие работы чаще всего не находятся" color="#e4701e" hint="Эти работы нужно добавить в словарь/нормы (server/lzk/norms.json). По последним 1000 запросам.">
            {data.topUnmatched.length === 0 ? (
              <p style={s.empty}>Все работы находились.</p>
            ) : (
              <table style={s.table}>
                <thead><tr><th style={s.th}>Название в ВДЦ</th><th style={s.th}>Ед.</th><th style={{ ...s.th, ...s.num }}>Раз</th></tr></thead>
                <tbody>
                  {data.topUnmatched.map((u, i) => (
                    <tr key={i}><td style={s.td}>{u.name}</td><td style={s.td}>{u.unit}</td><td style={{ ...s.td, ...s.num }}>{u.count}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Последние запросы" color="#2f6db5">
            <label style={s.check}>
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> только с ошибкой или с ненайденными работами
            </label>
            {recent.length === 0 ? (
              <p style={s.empty}>Нет записей.</p>
            ) : (
              <div style={s.scroll}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Когда</th><th style={s.th}>Email</th>
                      <th style={{ ...s.th, ...s.num }}>Строк ВДЦ</th><th style={{ ...s.th, ...s.num }}>Работ</th><th style={{ ...s.th, ...s.num }}>Материалов</th>
                      <th style={s.th}>Результат</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => (
                      <tr key={r.id}>
                        <td style={s.td}>{fmtDateTime(r.created_at)}</td>
                        <td style={s.td}>{r.email || "—"}</td>
                        <td style={{ ...s.td, ...s.num }}>{r.rows_count ?? "—"}</td>
                        <td style={{ ...s.td, ...s.num }}>{r.works_count ?? "—"}</td>
                        <td style={{ ...s.td, ...s.num }}>{r.materials_count ?? "—"}</td>
                        <td style={s.td}>
                          {r.error ? (
                            <span style={s.bad}>Ошибка: {r.error}</span>
                          ) : r.unmatched.length ? (
                            <span style={s.warn}>Не найдено: {r.unmatched.map((u) => u.name).join("; ")}</span>
                          ) : (
                            <span style={s.ok}>Успешно</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
};

const Card = ({ label, value, color }) => (
  <div style={{ ...s.card, borderTop: `4px solid ${color}` }}>
    <div style={{ ...s.cardValue, color }}>{value}</div>
    <div style={s.cardLabel}>{label}</div>
  </div>
);

const Section = ({ title, color, hint, children }) => (
  <section style={s.section}>
    <h2 style={{ ...s.h2, color }}>{title}</h2>
    {hint && <p style={s.hint}>{hint}</p>}
    {children}
  </section>
);

const s = {
  page: { padding: "24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "1000px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px", flexWrap: "wrap" },
  back: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" },
  refresh: { marginLeft: "auto", background: "#fff", color: "#1a5fb4", border: "1px solid #1a5fb4", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontWeight: 600 },
  title: { margin: 0, fontSize: "22px" },
  errorBox: { background: "#fdecec", color: "#c0392b", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", marginBottom: "12px" },

  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px", marginBottom: "8px" },
  card: { background: "#fff", borderRadius: "10px", padding: "14px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" },
  cardValue: { fontSize: "28px", fontWeight: 700 },
  cardLabel: { fontSize: "13px", color: "#666" },

  section: { background: "#fff", borderRadius: "12px", padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", marginTop: "16px" },
  h2: { fontSize: "16px", margin: "0 0 10px" },
  hint: { fontSize: "12px", color: "#777", margin: "0 0 8px" },
  empty: { fontSize: "13px", color: "#888", margin: "4px 0" },
  check: { display: "block", fontSize: "13px", color: "#555", marginBottom: "8px" },

  scroll: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
  th: { textAlign: "left", padding: "6px 8px", borderBottom: "2px solid #e5e5e5", color: "#555", whiteSpace: "nowrap" },
  td: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" },
  num: { textAlign: "right", whiteSpace: "nowrap" },
  ok: { color: "#1a7f37" },
  warn: { color: "#8a5a00" },
  bad: { color: "#c0392b" },
};

export default LzkUsageAdminPage;
