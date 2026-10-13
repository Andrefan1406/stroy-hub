// Схемы расположения бытовок — список схем (проектов), создание новой и, для
// главного админа, список тех, кому разрешено открывать и править схемы.
// Сама схема — SiteLayoutEditorPage.jsx.
import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { layoutsApi } from "../siteLayout/api";

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function SiteLayoutsPage() {
  const navigate = useNavigate();
  const [access, setAccess] = useState(null); // { canEdit, isAdmin }
  const [layouts, setLayouts] = useState([]);
  const [editors, setEditors] = useState([]);
  const [newName, setNewName] = useState("");
  const [newEditor, setNewEditor] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const acc = await layoutsApi("/access");
      setAccess(acc);
      if (!acc.canEdit) return;
      setLayouts((await layoutsApi("/")).layouts);
      if (acc.isAdmin) setEditors((await layoutsApi("/editors/list")).editors);
    } catch (err) {
      setError(err.message || "Не удалось загрузить схемы");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const { layout } = await layoutsApi("/", { method: "POST", body: { name: newName.trim() } });
      navigate(`/site-layouts/${layout.id}`);
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (layout) => {
    if (!window.confirm(`Удалить схему «${layout.name}» целиком? Это нельзя отменить.`)) return;
    try {
      await layoutsApi(`/${layout.id}`, { method: "DELETE" });
      setLayouts((prev) => prev.filter((l) => l.id !== layout.id));
    } catch (err) {
      setError(err.message);
    }
  };

  const addEditor = async (e) => {
    e.preventDefault();
    try {
      setEditors((await layoutsApi("/editors/list", { method: "POST", body: { email: newEditor } })).editors);
      setNewEditor("");
    } catch (err) {
      setError(err.message);
    }
  };

  const removeEditor = async (email) => {
    if (!window.confirm(`Убрать доступ к схемам у ${email}?`)) return;
    try {
      setEditors((await layoutsApi(`/editors/list/${encodeURIComponent(email)}`, { method: "DELETE" })).editors);
    } catch (err) {
      setError(err.message);
    }
  };

  if (!access) return <div style={s.page}>{error ? <div style={s.error}>{error}</div> : "Загрузка..."}</div>;
  if (!access.canEdit) {
    return (
      <div style={s.page}>
        <h1 style={s.title}>Схемы бытовок</h1>
        <p>У вас нет доступа к схемам бытовок. Попросите администратора добавить вас в список.</p>
        <Link to="/" style={s.link}>← На главную</Link>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <Link to="/" style={s.link}>← На главную</Link>
      <h1 style={s.title}>Схемы расположения бытовок</h1>
      {error && <div style={s.error}>{error}</div>}

      <form onSubmit={create} style={s.createRow}>
        <input style={s.input} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Название новой схемы, например «Нурлы Жол 4 — площадка»" />
        <button type="submit" style={s.primary} disabled={!newName.trim()}>Создать схему</button>
      </form>

      {layouts.length === 0 ? (
        <p style={s.muted}>Схем пока нет — создайте первую.</p>
      ) : (
        <div style={s.list}>
          {layouts.map((l) => (
            <div key={l.id} style={s.card}>
              <Link to={`/site-layouts/${l.id}`} style={s.cardTitle}>{l.name}</Link>
              <div style={s.muted}>Бытовок: {l.cabins} · изменена {formatDate(l.updatedAt)}</div>
              {access.isAdmin && (
                <button type="button" style={s.dangerLink} onClick={() => remove(l)}>Удалить</button>
              )}
            </div>
          ))}
        </div>
      )}

      {access.isAdmin && (
        <section style={s.section}>
          <h2 style={s.subtitle}>Доступ к схемам</h2>
          <p style={s.muted}>Кроме вас, открывать и править схемы могут сотрудники из этого списка.</p>
          <form onSubmit={addEditor} style={s.createRow}>
            <input style={s.input} value={newEditor} onChange={(e) => setNewEditor(e.target.value)} placeholder="email сотрудника" />
            <button type="submit" style={s.secondary} disabled={!newEditor.trim()}>Добавить</button>
          </form>
          {editors.length === 0 ? (
            <p style={s.muted}>Список пуст.</p>
          ) : (
            <ul style={s.editors}>
              {editors.map((e) => (
                <li key={e.email} style={s.editor}>
                  <span>{e.email}</span>
                  <button type="button" style={s.dangerLink} onClick={() => removeEditor(e.email)}>Убрать</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

const s = {
  page: { maxWidth: 900, margin: "0 auto", padding: "24px 16px 40px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", boxSizing: "border-box" },
  title: { fontSize: 24, margin: "12px 0 16px" },
  subtitle: { fontSize: 18, margin: "0 0 6px" },
  link: { color: "#1976d2", textDecoration: "none", fontSize: 14 },
  error: { background: "#fff0f0", color: "#c00", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 14 },
  createRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 },
  input: { flex: "1 1 260px", padding: "9px 12px", border: "1px solid #c8d0da", borderRadius: 6, fontSize: 14 },
  primary: { background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "9px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  secondary: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "9px 16px", fontSize: 14, cursor: "pointer" },
  list: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 },
  card: { border: "1px solid #dfe5ec", borderRadius: 10, padding: "12px 14px", background: "#fff", display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" },
  cardTitle: { fontSize: 16, fontWeight: 700, color: "#1f5fa8", textDecoration: "none" },
  muted: { color: "#667", fontSize: 13 },
  dangerLink: { background: "none", border: "none", color: "#c62828", padding: 0, fontSize: 13, cursor: "pointer" },
  section: { marginTop: 32, borderTop: "1px solid #e3e8ee", paddingTop: 20 },
  editors: { listStyle: "none", padding: 0, margin: 0 },
  editor: { display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #eef1f4", fontSize: 14 },
};
