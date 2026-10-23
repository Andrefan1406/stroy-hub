// Вкладка «Ведомость»: материалы раздела по видам, у каждой строки — листы-
// источники, статус (черновик / проверено), пометка ручной правки. Любую строку
// можно изменить, подтвердить, удалить, можно добавить свою.
import React, { useState } from "react";
import { ptoDelete, ptoPatch, ptoPost } from "./api";
import { KIND_TITLE, fmtNum, formatSources } from "./format";
import { s } from "./styles";

const KIND_ORDER = ["steel", "embedded", "concrete", "metal"];
const EMPTY_NEW = { kind: "steel", element: "", name: "", markClass: "", unit: "кг", quantity: "" };

// block — дом (блок) документа: столбец «Блок» показывается, когда у здания есть блоки.
function ItemRow({ item, block, onChange, onError }) {
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showSources, setShowSources] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (err) { onError(err.message || "Не удалось сохранить"); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    await ptoPatch(`/items/${item.id}`, { element: edit.element, name: edit.name, markClass: edit.markClass, unit: edit.unit, quantity: edit.quantity, note: edit.note });
    setEdit(null);
    onChange();
  });
  const patch = (body) => run(async () => { await ptoPatch(`/items/${item.id}`, body); onChange(); });
  const remove = () => {
    if (!window.confirm(`Удалить строку «${item.name}» (${item.element || "без элемента"})?`)) return Promise.resolve();
    return run(async () => { await ptoDelete(`/items/${item.id}`); onChange(); });
  };

  if (edit) {
    const set = (k) => (e) => setEdit((x) => ({ ...x, [k]: e.target.value }));
    return (
      <tr style={{ background: "#fffdf0" }}>
        {block ? <td style={s.td}>{block}</td> : null}
        <td style={s.td}><input style={s.inputSmall} value={edit.element} onChange={set("element")} /></td>
        <td style={s.td}><input style={s.inputSmall} value={edit.name} onChange={set("name")} /><input style={{ ...s.inputSmall, marginTop: 4 }} placeholder="Примечание" value={edit.note} onChange={set("note")} /></td>
        <td style={s.td}><input style={s.inputSmall} value={edit.markClass} onChange={set("markClass")} /></td>
        <td style={s.td}><input style={{ ...s.inputSmall, width: 60 }} value={edit.unit} onChange={set("unit")} /></td>
        <td style={s.td}><input style={{ ...s.inputSmall, width: 90 }} inputMode="decimal" value={edit.quantity} onChange={set("quantity")} /></td>
        <td style={s.td} colSpan={3}>
          <button style={busy ? { ...s.smallPrimary, ...s.disabled } : s.smallPrimary} disabled={busy} onClick={save}>Сохранить</button>
          <button style={s.small} onClick={() => setEdit(null)}>Отмена</button>
        </td>
      </tr>
    );
  }

  const muted = !item.counted ? { color: "#888" } : null;
  return (
    <tr style={muted}>
      {block ? <td style={s.td}>{block}</td> : null}
      <td style={s.td}>{item.element || "—"}</td>
      <td style={s.td}>
        {item.name}
        {item.manual && <span style={s.tag}>＋ вручную</span>}
        {item.edited && !item.manual && <span style={{ ...s.tag, background: "#fff1c9", color: "#8a5a00" }}>✎ изменено</span>}
        {item.note && <div style={{ ...s.muted, fontSize: 12 }}>{item.note}</div>}
      </td>
      <td style={s.td}>{item.markClass}</td>
      <td style={s.td}>{item.unit}</td>
      <td style={s.tdNum}>{fmtNum(item.quantity)}</td>
      <td style={s.td}>
        {item.sources.length > 1 ? (
          <button style={{ ...s.small, border: "none", background: "none", color: "#0b5cad", textDecoration: "underline", padding: 0 }} onClick={() => setShowSources((v) => !v)}>
            {item.sources.length} листов
          </button>
        ) : formatSources(item.sources)}
        {showSources && <div style={{ ...s.muted, fontSize: 12 }}>{formatSources(item.sources)}</div>}
      </td>
      <td style={s.td}>
        <label style={{ fontSize: 12, whiteSpace: "nowrap" }} title="Учитывается в объёмах работ и стоимости">
          <input type="checkbox" checked={item.counted} disabled={busy} onChange={(e) => patch({ counted: e.target.checked })} /> в расчёте
        </label>
        <div>
          <span
            style={s.chip(item.status === "confirmed" ? "#1a7f37" : "#b45309", item.status === "confirmed" ? "#e6f4ea" : "#fff3e0")}
          >{item.status === "confirmed" ? "проверено" : "черновик"}</span>
        </div>
      </td>
      <td style={s.td}>
        <button style={s.small} disabled={busy} onClick={() => setEdit({ element: item.element, name: item.name, markClass: item.markClass, unit: item.unit, quantity: String(item.quantity), note: item.note || "" })}>Править</button>
        <button style={s.small} disabled={busy} onClick={() => patch({ status: item.status === "confirmed" ? "draft" : "confirmed" })}>
          {item.status === "confirmed" ? "В черновик" : "Проверено"}
        </button>
        <button style={s.smallDanger} disabled={busy} onClick={remove}>×</button>
      </td>
    </tr>
  );
}

function ReconciliationBanner({ doc, onApplied, onError }) {
  const [busy, setBusy] = useState(false);
  const list = (doc.report && doc.report.reconciliation) || [];
  if (!list.length) return null;
  const apply = async (r) => {
    if (!window.confirm(`Умножить на ${r.factor} объёмы группы «${r.title}», которые даны на один элемент? Виды работ будут пересчитаны.`)) return;
    setBusy(true);
    try {
      await ptoPost(`/documents/${doc.id}/apply-multiplier`, { group: r.id, factor: r.factor });
      onApplied();
    } catch (err) {
      onError(err.message || "Не удалось применить коэффициент");
    } finally {
      setBusy(false);
    }
  };
  const t = (v) => `${fmtNum(Math.round(v / 100) / 10)} т`;
  return (
    <div style={s.info}>
      <b>Сверка со сводной «Ведомостью расхода стали»</b>
      {list.map((r) => (
        <div key={r.id} style={{ marginTop: 6 }}>
          {r.title}: по спецификациям {t(r.specKg)}, по ведомости {t(r.summaryKg)}
          {r.status === "ok" && " — сходится ✓"}
          {r.status === "mismatch" && ` — расхождение в ${fmtNum(r.ratio)} раза, причина неясна: проверьте количество элементов вручную`}
          {r.status === "factor" && (
            r.applied ? ` — применён коэффициент ×${r.applied}` : (
              <>
                {` — отличается в ${fmtNum(r.ratio)} раза: спецификации даны на один элемент, а элементов, вероятно, ${r.factor}. `}
                <button style={busy ? { ...s.smallPrimary, ...s.disabled } : s.smallPrimary} disabled={busy} onClick={() => apply(r)}>
                  Умножить объёмы «{r.title}» на {r.factor}
                </button>
              </>
            )
          )}
        </div>
      ))}
    </div>
  );
}

export default function ItemsTab({ doc, items, reload, onError }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_NEW);
  const [busy, setBusy] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await ptoPost(`/documents/${doc.id}/items`, form);
      setForm(EMPTY_NEW);
      setAdding(false);
      reload();
    } catch (err) {
      onError(err.message || "Не удалось добавить строку");
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const total = (kind) => {
    const rows = items.filter((i) => i.kind === kind && i.counted);
    return [...new Set(rows.map((r) => r.unit))].map((u) => `${fmtNum(rows.filter((r) => r.unit === u).reduce((sum, r) => sum + r.quantity, 0))} ${u}`).join(", ");
  };

  return (
    <div>
      <ReconciliationBanner doc={doc} onApplied={reload} onError={onError} />
      {items.length === 0 ? (
        <div style={s.warn}>В документе не найдено материалов. Причины — в отчёте разбора. Строки можно добавить вручную.</div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {doc.block ? <th style={s.th}>Блок</th> : null}
                <th style={s.th}>Конструктивный элемент</th><th style={s.th}>Наименование</th><th style={s.th}>Марка / класс</th>
                <th style={s.th}>Ед.</th><th style={s.th}>Количество</th><th style={s.th}>Листы</th><th style={s.th}>Статус</th><th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {KIND_ORDER.map((kind) => {
                const rows = items.filter((i) => i.kind === kind);
                if (!rows.length) return null;
                return (
                  <React.Fragment key={kind}>
                    <tr><td style={s.group} colSpan={doc.block ? 9 : 8}>{KIND_TITLE[kind]}{kind !== "metal" && total(kind) ? <span style={{ fontWeight: 400, marginLeft: 12 }}>в расчёте: {total(kind)}</span> : null}</td></tr>
                    {rows.map((it) => <ItemRow key={it.id} item={it} block={doc.block} onChange={reload} onError={onError} />)}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ ...s.muted, marginTop: 8 }}>
        Серые строки — справочные (не входят в расчёт): арматура по спецификациям, когда есть сводная ведомость, и прочий металл (на него нет цены).
        Одинаковые позиции с разных листов объединены — листы-источники видны в колонке «Листы».
      </div>
      <div style={{ marginTop: 12 }}>
        {!adding ? <button style={s.secondary} onClick={() => setAdding(true)}>+ Добавить строку</button> : (
          <form onSubmit={add} style={{ ...s.card, background: "#fafafa" }}>
            <div style={s.formGrid}>
              <label style={s.label}>Вид
                <select style={s.input} value={form.kind} onChange={set("kind")}>
                  {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_TITLE[k]}</option>)}
                </select>
              </label>
              <label style={s.label}>Конструктивный элемент<input style={s.input} value={form.element} onChange={set("element")} /></label>
              <label style={s.label}>Наименование *<input style={s.input} required value={form.name} onChange={set("name")} /></label>
              <label style={s.label}>Марка / класс<input style={s.input} value={form.markClass} onChange={set("markClass")} /></label>
              <label style={s.label}>Ед. изм. *<input style={s.input} required value={form.unit} onChange={set("unit")} /></label>
              <label style={s.label}>Количество *<input style={s.input} required inputMode="decimal" value={form.quantity} onChange={set("quantity")} /></label>
            </div>
            <button type="submit" style={busy ? { ...s.primary, ...s.disabled } : s.primary} disabled={busy}>Добавить</button>
            <button type="button" style={{ ...s.secondary, marginLeft: 8 }} onClick={() => setAdding(false)}>Отмена</button>
          </form>
        )}
      </div>
    </div>
  );
}
