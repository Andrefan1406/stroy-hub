// Сводная админ-панель: кто из пользователей ПРЯМО СЕЙЧАС заблокирован от
// подачи заявок и по какой причине — объединяет оба независимых источника
// блокировки (пропуски в отчётах по людям и пропуски в ГПР, см.
// server/blockedUsersAdmin.js). Причины показываем ТЕМИ ЖЕ формулировками,
// что видит сам заблокированный пользователь (gapWarningMessage/
// gprBlockMessage — те же функции, что используются в самой форме заявки),
// чтобы администратор читал ровно то сообщение, из-за которого человеку
// недоступна подача, а не отдельный пересказ той же логики. Здесь же —
// ручная блокировка администратором (server/manualBlock.js): переключатель +
// комментарий, который пользователь видит на главной выше остальных причин.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAuth } from "firebase/auth";
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import { gapWarningMessage } from "../peopleGapsGate";
import { gprBlockMessage } from "../gprReportGate";
import { manualBlockMessage } from "../manualBlockGate";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

async function getIdToken() {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  return user.getIdToken();
}

async function apiFetch(path, options = {}) {
  const token = await getIdToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

// Группирует gpr-пропуски пользователя по источнику (poz64_72/nz3/...) — у
// gprBlockMessage нет понятия источника, ему на вход нужны gap-объекты
// ОДНОГО источника за раз, иначе сообщение будет смешивать позиции из
// разных, не связанных друг с другом источников.
function groupGprGapsBySource(gprGaps) {
  const bySource = new Map();
  for (const g of gprGaps) {
    if (!bySource.has(g.source_key)) bySource.set(g.source_key, { label: g.source_label, gaps: [] });
    bySource.get(g.source_key).gaps.push(g);
  }
  return [...bySource.values()];
}

function buildReasons(user) {
  const reasons = [];
  if (user.manualBlock) {
    reasons.push({ kind: "manual", text: `Вручную: ${manualBlockMessage(user.manualBlock.comment)}` });
  }
  for (const pg of user.peopleGaps) {
    reasons.push({ kind: "people", text: `Люди, участок «${pg.site}»: ${gapWarningMessage(pg.missingDates)}` });
  }
  for (const { label, gaps } of groupGprGapsBySource(user.gprGaps)) {
    reasons.push({ kind: "gpr", text: `${label}: ${gprBlockMessage(gaps)}` });
  }
  return reasons;
}

const Toggle = ({ checked, disabled, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    style={{ ...s.toggle, background: checked ? "#c0392b" : "#ccc", opacity: disabled ? 0.6 : 1 }}
    title={checked ? "Заблокирован — нажмите, чтобы разблокировать" : "Не заблокирован — нажмите, чтобы заблокировать"}
  >
    <span style={{ ...s.toggleKnob, left: checked ? "22px" : "2px" }} />
  </button>
);

// Одна запись manual_user_blocks: переключатель сохраняется сразу,
// комментарий — по кнопке «Сохранить» (чтобы не слать запрос на каждый символ).
const ManualBlockRow = ({ block, onSave, onDelete }) => {
  const [comment, setComment] = useState(block.comment || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setComment(block.comment || "");
  }, [block.comment]);

  const save = async (blocked) => {
    setSaving(true);
    try {
      await onSave({ email: block.email, blocked, comment });
    } finally {
      setSaving(false);
    }
  };

  const commentChanged = comment.trim() !== (block.comment || "");

  return (
    <tr>
      <td style={{ ...s.td, ...s.tdEmail }}>{block.email}</td>
      <td style={s.td}>
        <Toggle checked={block.blocked} disabled={saving} onChange={save} />
      </td>
      <td style={s.td}>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          style={s.textarea}
          placeholder="Комментарий для пользователя"
        />
        <div style={s.meta}>
          {block.updated_by || "—"}, {(block.updated_at || "").replace("T", " ").slice(0, 16)}
        </div>
      </td>
      <td style={{ ...s.td, whiteSpace: "nowrap" }}>
        <button onClick={() => save(block.blocked)} disabled={saving || !commentChanged} style={s.saveBtn}>
          Сохранить
        </button>{" "}
        <button onClick={() => onDelete(block.email)} disabled={saving} style={s.deleteBtn}>
          Удалить
        </button>
      </td>
    </tr>
  );
};

// Подсказки для поля email — все, кто заходил в приложение (page_views, как в
// AdminStatistics). Отдельного списка пользователей нет (Firebase Auth без
// сервисного аккаунта не перечислить), поэтому это только подсказка: email
// можно ввести и вручную.
async function loadKnownEmails() {
  const snapshot = await getDocs(query(collection(db, "page_views"), orderBy("timestamp", "desc"), limit(5000)));
  const emails = snapshot.docs.map((d) => (d.data().email || "").toLowerCase()).filter(Boolean);
  return [...new Set(emails)].sort();
}

const ManualBlocksSection = ({ onChanged }) => {
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newBlocked, setNewBlocked] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [knownEmails, setKnownEmails] = useState([]);

  useEffect(() => {
    loadKnownEmails()
      .then(setKnownEmails)
      .catch((err) => console.error("Не удалось загрузить список пользователей:", err));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/blocked-users/manual");
      setBlocks(data.blocks || []);
    } catch (err) {
      setError(err.message || "Не удалось загрузить ручные блокировки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (payload) => {
    setError("");
    try {
      const data = await apiFetch("/api/admin/blocked-users/manual", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setBlocks(data.blocks || []);
      onChanged();
      return true;
    } catch (err) {
      setError(err.message || "Не удалось сохранить");
      return false;
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    const ok = await save({ email: newEmail.trim(), blocked: newBlocked, comment: newComment });
    setSaving(false);
    if (ok) {
      setNewEmail("");
      setNewComment("");
      setNewBlocked(true);
    }
  };

  const handleDelete = async (email) => {
    if (!window.confirm(`Удалить запись о ручной блокировке ${email}?`)) return;
    setError("");
    try {
      const data = await apiFetch(`/api/admin/blocked-users/manual/${encodeURIComponent(email)}`, { method: "DELETE" });
      setBlocks(data.blocks || []);
      onChanged();
    } catch (err) {
      setError(err.message || "Не удалось удалить");
    }
  };

  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>Ручная блокировка</h2>
      <p style={s.hint}>
        Блокирует подачу заявки на технику и на бетон/раствор независимо от отчётов по людям и ГПР.
        Комментарий пользователь увидит на главной — выше сообщений об остальных блокировках.
      </p>

      <form onSubmit={handleAdd} style={s.form}>
        <input
          type="email"
          placeholder="email пользователя"
          list="manual-block-known-emails"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          style={s.input}
        />
        <datalist id="manual-block-known-emails">
          {knownEmails.map((email) => (
            <option key={email} value={email} />
          ))}
        </datalist>
        <label style={s.toggleLabel}>
          <Toggle checked={newBlocked} onChange={setNewBlocked} />
          {newBlocked ? "Заблокирован" : "Не заблокирован"}
        </label>
        <textarea
          placeholder="Комментарий (будет показан пользователю)"
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          rows={2}
          style={{ ...s.textarea, flex: "1 1 100%" }}
        />
        <button type="submit" disabled={saving} style={s.addBtn}>
          {saving ? "Сохраняю..." : "Сохранить"}
        </button>
      </form>

      {error && <div style={s.error}>{error}</div>}

      {loading ? (
        <p>Загрузка...</p>
      ) : blocks.length === 0 ? (
        <p style={s.muted}>Ручных блокировок нет.</p>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Email</th>
              <th style={s.th}>Блокировка</th>
              <th style={s.th}>Комментарий</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => (
              <ManualBlockRow key={b.email} block={b} onSave={save} onDelete={handleDelete} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};

const fmtChecked = (utc) => {
  if (!utc) return "ещё не опрашивался";
  const d = new Date(utc.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? utc : d.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "short", timeStyle: "short" });
};

// Блокировка из-за просроченных замечаний PlanRadar (server/planradar.js).
// Общий выключатель: пока он выключен, опрос идёт и список ниже виден, но
// пользователям подача заявок не закрывается — это «кого заблокировало бы».
const PlanradarSection = () => {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiFetch("/api/admin/planradar/block"));
      setError("");
    } catch (err) {
      setError(err.message || "Не удалось загрузить данные PlanRadar");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (enabled) => {
    if (enabled && !window.confirm(
      `Включить блокировку? Сотрудники из списка ниже (${state?.users.length || 0}) сразу не смогут подать заявки на технику и бетон, пока не закроют замечания.`
    )) return;
    setBusy(true);
    try {
      setState(await apiFetch("/api/admin/planradar/block", { method: "PUT", body: JSON.stringify({ enabled }) }));
      setError("");
    } catch (err) {
      setError(err.message || "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  };

  const resync = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/admin/planradar/resync", { method: "POST" });
      await load();
    } catch (err) {
      setError(err.message || "Не удалось опросить PlanRadar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>Замечания PlanRadar</h2>
      <p style={s.hint}>
        Сотрудник, закреплённый за объектом, не может подать заявку на технику и бетон, пока по объекту есть незакрытые
        замечания со сроком, истёкшим {state?.overdueDays ?? 3} дня назад и раньше. PlanRadar опрашивается раз в час.
      </p>
      {error && <div style={s.error}>{error}</div>}
      {!state ? (
        !error && <p>Загрузка...</p>
      ) : (
        <>
          <label style={{ ...s.toggleLabel, marginBottom: "6px" }}>
            <Toggle checked={state.enabled} disabled={busy} onChange={toggle} />
            <b>{state.enabled ? "Блокировка включена для всех" : "Блокировка выключена"}</b>
          </label>
          {!state.enabled && (
            <p style={s.hint}>Сейчас никому не мешает: список ниже — это те, кого заблокирует включение.</p>
          )}
          {!state.configured && (
            <div style={s.error}>На сервере не задан PLANRADAR_API_KEY — опрос не работает, данные не обновляются.</div>
          )}
          <div style={{ ...s.actions, marginTop: "10px" }}>
            <button onClick={resync} disabled={busy}>Опросить PlanRadar сейчас</button>
            <span style={s.meta}>Последний опрос: {fmtChecked(state.lastChecked)}</span>
          </div>
          {state.users.length === 0 ? (
            <p style={s.muted}>Просроченных замечаний у закреплённых сотрудников нет.</p>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Email</th>
                  <th style={s.th}>Объекты с просроченными замечаниями</th>
                </tr>
              </thead>
              <tbody>
                {state.users.map((u) => (
                  <tr key={u.email}>
                    <td style={{ ...s.td, ...s.tdEmail }}>{u.email}</td>
                    <td style={s.td}>{u.items.map((i) => `${i.project} — ${i.count} шт.`).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
};

const BlockedUsersAdminPage = () => {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiFetch("/api/admin/blocked-users");
      setData(result);
    } catch (err) {
      setError(err.message || "Не удалось загрузить список заблокированных пользователей");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const blockedUsers = useMemo(() => data?.blockedUsers || [], [data]);

  const summary = useMemo(
    () => ({
      total: blockedUsers.length,
      byManual: blockedUsers.filter((u) => u.manualBlock).length,
      byPeople: blockedUsers.filter((u) => u.peopleGaps.length).length,
      byGpr: blockedUsers.filter((u) => u.gprGaps.length).length,
    }),
    [blockedUsers]
  );

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => navigate("/admin")} style={s.back}>← Назад</button>
        <h1 style={s.title}>Заблокированные пользователи</h1>
      </div>

      <div style={s.cards}>
        <div style={s.card}>
          <div style={s.cardLabel}>Заблокировано сейчас</div>
          <div style={{ ...s.cardValue, color: summary.total ? "#c0392b" : "#1a7f37" }}>{summary.total}</div>
        </div>
        <div style={s.card}>
          <div style={s.cardLabel}>Вручную</div>
          <div style={s.cardValue}>{summary.byManual}</div>
        </div>
        <div style={s.card}>
          <div style={s.cardLabel}>Из-за пропусков по людям</div>
          <div style={s.cardValue}>{summary.byPeople}</div>
        </div>
        <div style={s.card}>
          <div style={s.cardLabel}>Из-за пропусков в ГПР</div>
          <div style={s.cardValue}>{summary.byGpr}</div>
        </div>
      </div>

      <PlanradarSection />

      <ManualBlocksSection onChanged={load} />

      <div style={s.actions}>
        <button onClick={load} disabled={loading}>Обновить</button>
      </div>

      {error && <div style={s.error}>{error}</div>}

      {loading ? (
        <p>Загрузка...</p>
      ) : blockedUsers.length === 0 ? (
        <p style={s.muted}>Сейчас никто не заблокирован.</p>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Email</th>
              <th style={s.th}>Причина блокировки</th>
            </tr>
          </thead>
          <tbody>
            {blockedUsers.map((user) => (
              <tr key={user.email}>
                <td style={{ ...s.td, ...s.tdEmail }}>{user.email}</td>
                <td style={s.td}>
                  <ul style={s.reasonList}>
                    {buildReasons(user).map((r, i) => (
                      <li key={i} style={r.kind === "manual" ? { ...s.reasonItem, ...s.reasonManual } : s.reasonItem}>
                        {r.text}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const s = {
  page: { padding: "24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "1100px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "16px", marginBottom: "20px" },
  back: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" },
  title: { margin: 0, fontSize: "22px" },

  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px", marginBottom: "20px" },
  card: { background: "#fff", borderRadius: "10px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  cardLabel: { fontSize: "12px", color: "#888", marginBottom: "6px" },
  cardValue: { fontSize: "24px", fontWeight: 700 },

  actions: { display: "flex", gap: "10px", marginBottom: "16px", alignItems: "center" },

  error: { background: "#fff0f0", color: "#c00", borderRadius: "8px", padding: "10px 14px", marginBottom: "14px", fontSize: "13px" },
  muted: { color: "#888", fontSize: "14px" },

  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "10px", borderBottom: "2px solid #ddd", background: "#fafafa" },
  td: { padding: "10px", borderBottom: "1px solid #eee", verticalAlign: "top" },
  tdEmail: { fontWeight: 600, whiteSpace: "nowrap" },

  reasonList: { margin: 0, paddingLeft: "18px" },
  reasonItem: { marginBottom: "4px", fontSize: "13px", color: "#444" },
  reasonManual: { color: "#c0392b", fontWeight: 600, whiteSpace: "pre-wrap" },

  section: { background: "#fff", borderRadius: "12px", padding: "20px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", marginBottom: "24px" },
  sectionTitle: { margin: "0 0 6px", fontSize: "17px" },
  hint: { color: "#666", fontSize: "13px", margin: "0 0 16px", lineHeight: 1.5 },
  form: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", marginBottom: "16px" },
  input: { padding: "8px 10px", border: "1px solid #ccc", borderRadius: "6px", fontSize: "13px", minWidth: "220px" },
  textarea: { width: "100%", boxSizing: "border-box", padding: "8px 10px", border: "1px solid #ccc", borderRadius: "6px", fontSize: "13px", fontFamily: "inherit", resize: "vertical" },
  meta: { fontSize: "11px", color: "#999", marginTop: "4px" },
  addBtn: { background: "#007bff", color: "#fff", border: "none", borderRadius: "6px", padding: "8px 16px", cursor: "pointer", fontSize: "13px" },
  saveBtn: { background: "#007bff", color: "#fff", border: "none", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "12px" },
  deleteBtn: { background: "none", border: "1px solid #f0b0b0", color: "#c00", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "12px" },
  toggleLabel: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" },
  toggle: { position: "relative", width: "44px", height: "24px", borderRadius: "12px", border: "none", cursor: "pointer", padding: 0, flexShrink: 0, transition: "background 0.15s" },
  toggleKnob: { position: "absolute", top: "2px", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.3)", transition: "left 0.15s" },
};

export default BlockedUsersAdminPage;
