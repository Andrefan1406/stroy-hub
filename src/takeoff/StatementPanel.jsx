// Ведомость на странице: работы из справочника (группа → работа → объём →
// материал → расход → суммы), свод материалов и прочие работы.
import React from "react";

const fmt = (v, d = 2) => (v == null ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) }));
const money = (v) => (v == null ? null : `${v.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} тг`);

export default function StatementPanel({ masonry, statement, onExport, onClear, hasMeasurements }) {
  const skipped = statement.skipped.length + masonry.skipped.length;
  const groups = [];
  for (const r of masonry.rows) {
    const last = groups[groups.length - 1];
    if (last && last.name === r.groupName) last.rows.push(r);
    else groups.push({ name: r.groupName, rows: [r] });
  }
  const workSum = masonry.rows.reduce((s, r) => s + (r.workSum || 0), 0);
  const matSum = masonry.rows.reduce((s, r) => s + (r.materialSum || 0), 0);
  const empty = !masonry.rows.length && !statement.rows.length;

  return (
    <div style={s.list}>
      <div style={s.row}>
        <button type="button" style={s.primary} disabled={empty} onClick={onExport}>Скачать Excel</button>
        <button type="button" style={s.small} disabled={!hasMeasurements} onClick={onClear}>Очистить чертёж</button>
      </div>
      {skipped > 0 && (
        <div style={s.warn}>
          Не вошли в итог: {skipped} — лист не откалиброван, не выбрана работа или не указана высота/толщина.
          {masonry.skipped.slice(0, 3).map(({ m, warnings }) => (
            <div key={m.id}>· лист {m.page}, {m.snapshot?.name || "без работы"}: {warnings[0]}</div>
          ))}
        </div>
      )}
      {empty && <p style={s.muted}>Обведите контуры и выберите работу — ведомость соберётся сама.</p>}

      {groups.map((g) => (
        <section key={g.name} style={s.group}>
          <div style={s.groupName}>{g.name}</div>
          {g.rows.map((r) => (
            <div key={r.workId} style={s.card}>
              <div style={{ fontWeight: 600 }}>{r.work}</div>
              <div style={s.qty}>{fmt(r.quantity, 3)} {r.unit}</div>
              {r.material != null && (
                <div style={s.material}>
                  {r.materialName}: {fmt(r.material, r.materialUnit === "шт" ? 0 : 3)} {r.materialUnit}
                  {r.materialExact != null && r.material !== r.materialExact && <span style={s.muted}> (точно {fmt(r.materialExact, 2)})</span>}
                </div>
              )}
              {(r.workSum != null || r.materialSum != null) && (
                <div style={s.muted}>
                  {r.workSum != null && `Работы: ${money(r.workSum)}`}{r.workSum != null && r.materialSum != null && " · "}
                  {r.materialSum != null && `Материал: ${money(r.materialSum)}`}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
      {(workSum > 0 || matSum > 0) && (
        <div style={s.total}>Итого: работы {money(workSum) || "—"}, материалы {money(matSum) || "—"}</div>
      )}

      {masonry.materials.length > 0 && (
        <section style={s.group}>
          <div style={s.groupName}>Материалы — свод</div>
          <table style={s.table}>
            <tbody>
              {masonry.materials.map((t) => (
                <tr key={`${t.materialName}|${t.materialUnit}`}>
                  <td style={s.td}>{t.materialName}</td>
                  <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmt(t.quantity, t.materialUnit === "шт" ? 0 : 3)} {t.materialUnit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {statement.rows.length > 0 && (
        <section style={s.group}>
          <div style={s.groupName}>Прочие работы</div>
          <table style={s.table}>
            <thead><tr><th style={s.th}>Вид работ</th><th style={s.th}>Ед.</th><th style={{ ...s.th, textAlign: "right" }}>Кол-во</th></tr></thead>
            <tbody>
              {statement.rows.map((r) => (
                <tr key={`${r.work}|${r.unit}`}>
                  <td style={s.td}>{r.work}</td>
                  <td style={s.td}>{r.unit}</td>
                  <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmt(r.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const s = {
  list: { padding: 10, overflowY: "auto", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 },
  row: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  primary: { background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  small: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" },
  warn: { fontSize: 12, color: "#8a5a00", background: "#fff6e0", borderRadius: 6, padding: "6px 8px" },
  muted: { fontSize: 11, color: "#667" },
  group: { display: "flex", flexDirection: "column", gap: 6 },
  groupName: { fontWeight: 700, fontSize: 13, color: "#1f5fa8", borderBottom: "1px solid #e1e6ec", paddingBottom: 3 },
  card: { border: "1px solid #e3e8ee", borderRadius: 6, padding: "6px 8px", fontSize: 12, display: "flex", flexDirection: "column", gap: 2 },
  qty: { fontSize: 14, fontWeight: 700, color: "#0d47a1" },
  material: { fontSize: 12, fontWeight: 600, color: "#2e7d32" },
  total: { fontSize: 13, fontWeight: 700, color: "#1d2b3a", background: "#f3f6f9", borderRadius: 6, padding: "6px 8px" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { textAlign: "left", background: "#f3f6f9", padding: 6, borderBottom: "1px solid #dde3ea" },
  td: { padding: 6, borderBottom: "1px solid #eef1f4" },
};
