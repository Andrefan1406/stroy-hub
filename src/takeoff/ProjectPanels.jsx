// Общие данные чертежа: этажи с высотами и ведомость проёмов. Пока живут в
// проекте чертежа (в браузере); структура — та же, что потом переедет в
// объект → проект → дом.
import React, { useState } from "react";
import { OPENING_TYPES, importOpenings } from "./masonry";
import { toNumber } from "./model";

const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 3 }));

export function FloorsPanel({ floors, setFloors, usage }) {
  const update = (id, patch) => setFloors((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const remove = (f) => {
    const n = usage[f.id] || 0;
    if (n && !window.confirm(`Этаж «${f.name}» выбран в ${n} замер(ах). У них пропадёт высота (кроме заданной вручную). Удалить?`)) return;
    setFloors((list) => list.filter((x) => x.id !== f.id));
  };
  const add = () => {
    const last = floors[floors.length - 1];
    setFloors((list) => [...list, { id: newId("f"), name: `${list.length + 1} этаж`, height: last?.height ?? "3" }]);
  };
  return (
    <div style={s.wrap}>
      <div style={s.title}>Этажи и высоты</div>
      <p style={s.hint}>Высота этажа подставляется в замеры кладки. Если в замере высоту изменили вручную, она подсвечена и при смене высоты этажа не меняется.</p>
      <table style={s.table}>
        <thead><tr><th style={s.th}>Этаж</th><th style={s.th}>Высота, м</th><th style={s.th}>Замеров</th><th style={s.th} /></tr></thead>
        <tbody>
          {floors.map((f) => (
            <tr key={f.id}>
              <td style={s.td}><input style={s.input} value={f.name} onChange={(e) => update(f.id, { name: e.target.value })} /></td>
              <td style={s.td}>
                <input style={{ ...s.input, width: 70, ...(toNumber(f.height) > 0 ? null : s.bad) }} inputMode="decimal" value={f.height}
                  onChange={(e) => update(f.id, { height: e.target.value })} />
              </td>
              <td style={{ ...s.td, textAlign: "center" }}>{usage[f.id] || 0}</td>
              <td style={s.td}><button type="button" style={s.x} title="Удалить этаж" onClick={() => remove(f)}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {floors.length === 0 && <p style={s.muted}>Этажей нет — добавьте, чтобы высота подставлялась сама.</p>}
      <button type="button" style={s.small} onClick={add}>+ Этаж</button>
    </div>
  );
}

const emptyRow = { mark: "", type: "door", width: "", height: "", qty: "1" };

export function OpeningsPanel({ openings, setOpenings, usage }) {
  const [row, setRow] = useState(emptyRow);
  const [message, setMessage] = useState("");

  // Ручной ввод идёт через тот же импорт, что и будущий разбор спецификации:
  // та же марка — обновление, а не дубль.
  const add = (e) => {
    e.preventDefault();
    const res = importOpenings(openings, "manual", [row]);
    if (res.errors.length) {
      setMessage(res.errors[0].error);
      return;
    }
    setOpenings(res.openings);
    setMessage(res.updated ? `Марка ${row.mark.trim()} уже была — обновлена` : "");
    setRow(emptyRow);
  };
  const update = (id, patch) => setOpenings((list) => list.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const setNum = (id, key, raw) => {
    const n = toNumber(raw);
    if (n > 0 || (key === "qty" && n === 0)) update(id, { [key]: key === "qty" ? Math.round(n) : n });
  };
  const remove = (o) => {
    const u = usage.find((x) => x.id === o.id);
    if (u?.uses.length && !window.confirm(`Марка ${o.mark} используется в ${u.uses.length} замер(ах). Удалить — проёмы перестанут вычитаться.`)) return;
    setOpenings((list) => list.filter((x) => x.id !== o.id));
  };

  return (
    <div style={s.wrap}>
      <div style={s.title}>Ведомость проёмов</div>
      <p style={s.hint}>Проёмы назначаются на стены в свойствах замера (марка × количество) или обводятся на плане инструментом «Проём на плане».</p>
      <form style={s.addForm} onSubmit={add}>
        <input style={{ ...s.input, width: 64 }} placeholder="Д-1" value={row.mark} onChange={(e) => setRow({ ...row, mark: e.target.value })} />
        <select style={{ ...s.input, width: 76 }} value={row.type} onChange={(e) => setRow({ ...row, type: e.target.value })}>
          {Object.entries(OPENING_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input style={{ ...s.input, width: 52 }} inputMode="decimal" placeholder="шир." value={row.width} onChange={(e) => setRow({ ...row, width: e.target.value })} />
        <input style={{ ...s.input, width: 52 }} inputMode="decimal" placeholder="выс." value={row.height} onChange={(e) => setRow({ ...row, height: e.target.value })} />
        <input style={{ ...s.input, width: 40 }} inputMode="numeric" placeholder="шт" value={row.qty} onChange={(e) => setRow({ ...row, qty: e.target.value })} />
        <button type="submit" style={s.primary}>+</button>
      </form>
      {message && <div style={s.warn}>{message}</div>}
      <table style={s.table}>
        <thead><tr><th style={s.th}>Марка</th><th style={s.th}>Тип</th><th style={s.th}>Ш × В, м</th><th style={s.th}>Кол-во</th><th style={s.th}>Исп.</th><th style={s.th} /></tr></thead>
        <tbody>
          {openings.map((o) => {
            const u = usage.find((x) => x.id === o.id);
            const over = u && u.used > o.qty;
            return (
              <tr key={o.id}>
                <td style={s.td}><input style={{ ...s.input, width: 56 }} value={o.mark} onChange={(e) => update(o.id, { mark: e.target.value })} /></td>
                <td style={s.td}>
                  <select style={{ ...s.input, width: 70 }} value={o.type} onChange={(e) => update(o.id, { type: e.target.value })}>
                    {Object.entries(OPENING_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </td>
                <td style={s.td}>
                  <NumInput value={o.width} onCommit={(v) => setNum(o.id, "width", v)} /> × <NumInput value={o.height} onCommit={(v) => setNum(o.id, "height", v)} />
                </td>
                <td style={s.td}><NumInput value={o.qty} width={36} onCommit={(v) => setNum(o.id, "qty", v)} /></td>
                <td style={{ ...s.td, color: over ? "#c62828" : "#445", fontWeight: over ? 700 : 400 }} title={over ? "Назначено больше, чем в ведомости" : o.source === "spec" ? "из спецификации" : "введено вручную"}>
                  {u?.used || 0}
                </td>
                <td style={s.td}><button type="button" style={s.x} title="Удалить марку" onClick={() => remove(o)}>×</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {openings.length === 0 && <p style={s.muted}>Проёмов нет. Добавьте марку: Д-1, дверь, 0,8 × 2,1, 4 шт.</p>}
    </div>
  );
}

// Числовое поле, которое принимает «0,8» и применяет значение при уходе из поля.
function NumInput({ value, onCommit, width = 44 }) {
  const [draft, setDraft] = useState(null);
  return (
    <input style={{ ...s.input, width, padding: "4px 4px" }} inputMode="decimal" value={draft ?? fmt(value)}
      onFocus={() => setDraft(fmt(value))} onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft != null) onCommit(draft); setDraft(null); }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
  );
}

const s = {
  wrap: { padding: 10, display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", flex: 1, minHeight: 0 },
  title: { fontWeight: 700, fontSize: 13, color: "#1f5fa8" },
  hint: { fontSize: 11, color: "#667", lineHeight: 1.4, margin: 0 },
  muted: { fontSize: 12, color: "#667", margin: 0 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { textAlign: "left", background: "#f3f6f9", padding: "4px 3px", borderBottom: "1px solid #dde3ea", fontSize: 11 },
  td: { padding: "3px 3px", borderBottom: "1px solid #eef1f4", whiteSpace: "nowrap" },
  input: { padding: "5px 6px", border: "1px solid #c8d0da", borderRadius: 5, fontSize: 12, boxSizing: "border-box", width: "100%" },
  bad: { borderColor: "#c62828", background: "#fff0f0" },
  addForm: { display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", background: "#f8fbff", padding: 6, borderRadius: 6 },
  small: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", alignSelf: "flex-start" },
  primary: { background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  x: { background: "none", border: "none", color: "#c62828", fontSize: 16, cursor: "pointer", padding: "0 4px" },
  warn: { fontSize: 12, color: "#8a5a00", background: "#fff6e0", borderRadius: 6, padding: "6px 8px" },
};
