// Справочник работ: группы и работы карточками. Видит только админ (флаг
// SHOW_CATALOG_EDITOR + canEdit с сервера); сохраняет сервер, он же
// проверяет права. Работа, уже использованная в замерах, при удалении
// уходит в архив.
import React, { useState } from "react";
import { createGroup, createWork, deleteGroup, deleteWork, updateGroup, updateWork } from "./api";
import { METHODS, WORK_UNITS } from "./masonry";

const emptyWork = (groupId) => ({
  groupId, name: "", unit: "м²", method: "wall_length", thickness: "", materialName: "", materialUnit: "шт", materialRate: "",
  workPrice: "", materialPrice: "", countOpenings: true, archived: false,
});
const str = (v) => (v == null ? "" : String(v).replace(".", ","));
const fmt = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 4 }));

export default function CatalogEditor({ catalog, onChanged, onClose }) {
  const [editing, setEditing] = useState(null); // {type: group|work, value}
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const run = async (fn, okText) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fn();
      await onChanged();
      setEditing(null);
      if (okText) setNotice(typeof okText === "function" ? okText(res) : okText);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveGroup = (e) => {
    e.preventDefault();
    const v = editing.value;
    run(() => (v.id ? updateGroup(v.id, v) : createGroup(v)), "Группа сохранена");
  };
  const saveWork = (e) => {
    e.preventDefault();
    const v = editing.value;
    run(() => (v.id ? updateWork(v.id, v) : createWork(v)), v.id ? "Работа сохранена — замеры с прежней нормой получат пометку «норма изменилась»" : "Работа добавлена");
  };
  const removeWork = (w) => {
    if (!window.confirm(`Удалить работу «${w.name}»? Если она уже использовалась в замерах, она уйдёт в архив.`)) return;
    run(() => deleteWork(w.id), (res) => (res.archived ? "Работа использовалась в замерах — отправлена в архив" : "Работа удалена"));
  };
  const removeGroup = (g) => {
    if (!window.confirm(`Удалить группу «${g.name}»?`)) return;
    run(() => deleteGroup(g.id), "Группа удалена");
  };

  const groups = catalog.groups.filter((g) => showArchived || !g.archived);
  const setV = (patch) => setEditing((ed) => ({ ...ed, value: { ...ed.value, ...patch } }));

  return (
    <div style={s.overlay}>
      <div style={s.panel}>
        <header style={s.header}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Справочник работ</h2>
          <label style={s.check}><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Показывать архив</label>
          <button type="button" style={s.primary} disabled={busy} onClick={() => setEditing({ type: "group", value: { name: "", sort: (catalog.groups.length + 1) * 10, archived: false } })}>+ Группа</button>
          <button type="button" style={s.small} onClick={onClose}>Закрыть</button>
        </header>
        <p style={s.hint}>Нормы и расценки общие для всех пользователей. Правка нормы не меняет уже сделанные замеры — у них появится пометка и кнопка «пересчитать по текущим нормам».</p>
        {error && <div style={s.error}>{error}</div>}
        {notice && <div style={s.notice}>{notice}</div>}

        {editing?.type === "group" && (
          <form style={s.form} onSubmit={saveGroup}>
            <b>{editing.value.id ? "Группа" : "Новая группа"}</b>
            <div style={s.grid}>
              <Field label="Название"><input style={s.input} autoFocus value={editing.value.name} onChange={(e) => setV({ name: e.target.value })} /></Field>
              <Field label="Порядок сортировки"><input style={s.input} inputMode="numeric" value={editing.value.sort} onChange={(e) => setV({ sort: e.target.value })} /></Field>
            </div>
            <label style={s.check}><input type="checkbox" checked={!!editing.value.archived} onChange={(e) => setV({ archived: e.target.checked })} /> В архиве (не предлагается в новых замерах)</label>
            <FormButtons busy={busy} onCancel={() => setEditing(null)} />
          </form>
        )}

        <div style={s.groups}>
          {groups.map((g) => {
            const works = catalog.works.filter((w) => w.groupId === g.id && (showArchived || !w.archived));
            return (
              <section key={g.id} style={{ ...s.group, ...(g.archived ? s.archived : null) }}>
                <div style={s.groupHead}>
                  <b style={{ fontSize: 15 }}>{g.name}</b>
                  <span style={s.muted}>порядок {g.sort}{g.archived ? " · архив" : ""}</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" style={s.small} onClick={() => setEditing({ type: "group", value: { ...g } })}>Изменить</button>
                  <button type="button" style={s.small} onClick={() => removeGroup(g)}>Удалить</button>
                  <button type="button" style={s.primary} onClick={() => setEditing({ type: "work", value: emptyWork(g.id) })}>+ Работа</button>
                </div>
                {editing?.type === "work" && editing.value.groupId === g.id && !editing.value.id && (
                  <WorkForm value={editing.value} groups={catalog.groups} setV={setV} onSubmit={saveWork} busy={busy} onCancel={() => setEditing(null)} />
                )}
                <div style={s.cards}>
                  {works.length === 0 && <p style={s.muted}>Работ нет.</p>}
                  {works.map((w) => (editing?.type === "work" && editing.value.id === w.id ? (
                    <WorkForm key={w.id} value={editing.value} groups={catalog.groups} setV={setV} onSubmit={saveWork} busy={busy} onCancel={() => setEditing(null)} />
                  ) : (
                    <div key={w.id} style={{ ...s.card, ...(w.archived ? s.archived : null) }}>
                      <div style={{ fontWeight: 600 }}>{w.name}</div>
                      <div style={s.muted}>{METHODS[w.method]?.label || w.method}</div>
                      <table style={s.kv}><tbody>
                        <tr><td>Ед. работы</td><td>{w.unit}</td></tr>
                        <tr><td>Толщина</td><td>{w.thickness ? `${fmt(w.thickness)} м` : "—"}</td></tr>
                        <tr><td>Материал</td><td>{w.materialName ? `${w.materialName}: ${fmt(w.materialRate)} ${w.materialUnit} на 1 ${w.unit}` : "—"}</td></tr>
                        <tr><td>Расценка</td><td>{w.workPrice != null ? `${fmt(w.workPrice)} тг/${w.unit}` : "—"}</td></tr>
                        <tr><td>Цена материала</td><td>{w.materialPrice != null ? `${fmt(w.materialPrice)} тг/${w.materialUnit}` : "—"}</td></tr>
                        <tr><td>Проёмы</td><td>{w.countOpenings ? "вычитаются" : "не учитываются"}</td></tr>
                      </tbody></table>
                      <div style={s.muted}>версия {w.version}{w.used ? " · использовалась" : ""}{w.archived ? " · архив" : ""}</div>
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <button type="button" style={s.small} onClick={() => setEditing({ type: "work", value: { ...w, thickness: str(w.thickness), materialRate: str(w.materialRate), workPrice: str(w.workPrice), materialPrice: str(w.materialPrice) } })}>Изменить</button>
                        {w.archived
                          ? <button type="button" style={s.small} onClick={() => run(() => updateWork(w.id, { archived: false }), "Работа возвращена из архива")}>Из архива</button>
                          : <button type="button" style={s.small} onClick={() => removeWork(w)}>Удалить</button>}
                      </div>
                    </div>
                  )))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <label style={s.field}><span style={s.label}>{label}</span>{children}</label>;
}

function FormButtons({ busy, onCancel }) {
  return (
    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
      <button type="button" style={s.small} onClick={onCancel}>Отмена</button>
      <button type="submit" style={s.primary} disabled={busy}>{busy ? "Сохранение…" : "Сохранить"}</button>
    </div>
  );
}

function WorkForm({ value: v, groups, setV, onSubmit, busy, onCancel }) {
  return (
    <form style={{ ...s.form, ...s.card }} onSubmit={onSubmit}>
      <b>{v.id ? "Работа" : "Новая работа"}</b>
      <Field label="Группа">
        <select style={s.input} value={v.groupId} onChange={(e) => setV({ groupId: Number(e.target.value) })}>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}{g.archived ? " (архив)" : ""}</option>)}
        </select>
      </Field>
      <Field label="Наименование"><input style={s.input} autoFocus value={v.name} onChange={(e) => setV({ name: e.target.value })} /></Field>
      <div style={s.grid}>
        <Field label="Ед. работы">
          <select style={s.input} value={v.unit} onChange={(e) => setV({ unit: e.target.value })}>{WORK_UNITS.map((u) => <option key={u}>{u}</option>)}</select>
        </Field>
        <Field label="Толщина по умолчанию, м"><input style={s.input} inputMode="decimal" value={v.thickness} placeholder="0,25" onChange={(e) => setV({ thickness: e.target.value })} /></Field>
      </div>
      <Field label="Способ замера">
        <select style={s.input} value={v.method} onChange={(e) => setV({ method: e.target.value })}>
          {Object.entries(METHODS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
      </Field>
      <div style={s.grid}>
        <Field label="Материал"><input style={s.input} value={v.materialName} placeholder="Кирпич" onChange={(e) => setV({ materialName: e.target.value })} /></Field>
        <Field label="Ед. материала"><input style={s.input} value={v.materialUnit} placeholder="шт, м³" onChange={(e) => setV({ materialUnit: e.target.value })} /></Field>
        <Field label={`Норма на 1 ${v.unit}`}><input style={s.input} inputMode="decimal" value={v.materialRate} placeholder="305" onChange={(e) => setV({ materialRate: e.target.value })} /></Field>
      </div>
      <div style={s.grid}>
        <Field label={`Расценка работы, тг/${v.unit}`}><input style={s.input} inputMode="decimal" value={v.workPrice} placeholder="необязательно" onChange={(e) => setV({ workPrice: e.target.value })} /></Field>
        <Field label="Цена материала, тг/ед."><input style={s.input} inputMode="decimal" value={v.materialPrice} placeholder="необязательно" onChange={(e) => setV({ materialPrice: e.target.value })} /></Field>
      </div>
      <label style={s.check}><input type="checkbox" checked={!!v.countOpenings} onChange={(e) => setV({ countOpenings: e.target.checked })} /> Учитывать проёмы (вычитать двери и окна)</label>
      <label style={s.check}><input type="checkbox" checked={!!v.archived} onChange={(e) => setV({ archived: e.target.checked })} /> В архиве</label>
      <FormButtons busy={busy} onCancel={onCancel} />
    </form>
  );
}

const s = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 120, display: "flex", justifyContent: "center", alignItems: "stretch", padding: 16 },
  panel: { background: "#f5f7fa", borderRadius: 10, width: 1100, maxWidth: "100%", display: "flex", flexDirection: "column", overflow: "auto", padding: 16, boxSizing: "border-box" },
  header: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  groups: { display: "flex", flexDirection: "column", gap: 14, marginTop: 10 },
  group: { background: "#fff", border: "1px solid #e1e6ec", borderRadius: 10, padding: 12 },
  groupHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10, marginTop: 10 },
  card: { border: "1px solid #e3e8ee", borderRadius: 8, padding: 10, background: "#fbfcfe", fontSize: 13, display: "flex", flexDirection: "column", gap: 4 },
  archived: { opacity: 0.6 },
  kv: { fontSize: 12, borderCollapse: "collapse", width: "100%" },
  form: { display: "flex", flexDirection: "column", gap: 6, background: "#eef6ff", border: "1px solid #bcd6f5", borderRadius: 8, padding: 10, marginTop: 10 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 },
  field: { display: "flex", flexDirection: "column", gap: 2 },
  label: { fontSize: 11, fontWeight: 600, color: "#445" },
  input: { padding: "6px 8px", border: "1px solid #c8d0da", borderRadius: 6, fontSize: 13, boxSizing: "border-box", width: "100%" },
  check: { fontSize: 12, display: "flex", gap: 6, alignItems: "center" },
  small: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
  primary: { background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  hint: { fontSize: 12, color: "#667", margin: "8px 0 0" },
  muted: { fontSize: 11, color: "#778" },
  error: { background: "#fff0f0", color: "#c00", padding: "8px 10px", borderRadius: 6, fontSize: 13, marginTop: 8 },
  notice: { background: "#eaf7ea", color: "#1b5e20", padding: "8px 10px", borderRadius: 6, fontSize: 13, marginTop: 8 },
};
