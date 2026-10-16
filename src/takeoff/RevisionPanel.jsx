// Замена чертежа новой редакцией: сопоставление листов, совмещение каждого
// листа по двум точкам, подсветка изменений, применение. Замеры и
// калибровка переносятся (src/takeoff/revision.js).
import React from "react";
import { angleOf, isIdentity, pageMapConflicts, scaleOf } from "./revision";

const ALIGN_STEPS = [
  "1) Щёлкните точку на старом: угол замера (прилипает) или, например, пересечение осей А/1 на красном слое.",
  "2) Щёлкните ту же точку на новом чертеже (синий слой).",
  "3) Вторая точка на старом — подальше от первой, например пересечение осей Г/5.",
  "4) Та же вторая точка на новом чертеже.",
];
const fmt = (v, d = 3) => v.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d });

export default function RevisionPanel({ rev, oldFileName, counts, setRev, onApply, onCancel }) {
  const pages = Object.keys(rev.pageMap).map(Number).sort((a, b) => a - b);
  const conflicts = pageMapConflicts(rev.pageMap);
  const t = rev.transforms[rev.oldPage];
  const set = (patch) => setRev((r) => ({ ...r, ...patch }));

  return (
    <div style={s.wrap}>
      <div style={s.title}>Замена чертежа — новая редакция</div>
      <div style={s.muted}>Было: {oldFileName}<br />Стало: <b>{rev.file.name}</b> ({rev.numPages} л.)</div>
      <div style={s.hint}>
        Замеры, калибровка, этажи и проёмы перейдут на новый чертёж. Проверьте каждый лист: замеры (полупрозрачные) должны лечь на новый чертёж.
        Если лист сдвинут или в другом масштабе — «Совместить по двум точкам».
      </div>

      <div style={s.blockTitle}>Листы</div>
      {pages.map((p) => {
        const tp = rev.transforms[p];
        return (
          <div key={p} style={{ ...s.pageRow, ...(p === rev.oldPage ? s.pageActive : null) }} onClick={() => set({ oldPage: p, align: null })}>
            <div style={{ flex: 1 }}>
              <b>Лист {p}</b> <span style={s.muted}>({counts[p] || 0} зам.)</span>
              <div style={s.small}>{tp && !isIdentity(tp) ? `совмещён: ×${fmt(scaleOf(tp))}, ${fmt(angleOf(tp), 1)}°` : "без сдвига"}</div>
            </div>
            <span>→</span>
            <select style={{ ...s.input, width: 92, ...(conflicts.includes(rev.pageMap[p]) ? s.bad : null) }} value={rev.pageMap[p] ?? ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => set({ pageMap: { ...rev.pageMap, [p]: e.target.value ? Number(e.target.value) : null }, oldPage: p, align: null })}>
              <option value="">не переносить</option>
              {Array.from({ length: rev.numPages }, (_, i) => <option key={i + 1} value={i + 1}>лист {i + 1}</option>)}
            </select>
          </div>
        );
      })}
      {conflicts.length > 0 && <div style={s.error}>Два старых листа на один новый (лист {conflicts.join(", ")}) — выберите разные.</div>}

      {rev.pageMap[rev.oldPage] != null && (
        <>
          <div style={s.blockTitle}>Лист {rev.oldPage} → лист {rev.pageMap[rev.oldPage]}</div>
          {rev.align ? (
            <div style={s.alignBox}>
              <div style={{ fontWeight: 600 }}>{ALIGN_STEPS[rev.align.step]}</div>
              <button type="button" style={s.btn} onClick={() => set({ align: null })}>Отменить (Esc)</button>
            </div>
          ) : (
            <div style={s.row}>
              <button type="button" style={s.primary} onClick={() => set({ align: { step: 0, pairs: [] }, diff: true })}>Совместить по двум точкам</button>
              {t && !isIdentity(t) && <button type="button" style={s.btn} onClick={() => set({ transforms: { ...rev.transforms, [rev.oldPage]: null } })}>Сбросить</button>}
            </div>
          )}
        </>
      )}

      <label style={s.check}>
        <input type="checkbox" checked={rev.diff} onChange={(e) => set({ diff: e.target.checked })} /> Подсветка изменений
      </label>
      {rev.diff && <Legend />}

      <div style={{ ...s.row, marginTop: 8 }}>
        <button type="button" style={s.primary} disabled={conflicts.length > 0 || !!rev.align} onClick={onApply}>Применить замену</button>
        <button type="button" style={s.btn} onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}

export function Legend() {
  return (
    <div style={s.legend}>
      <div><span style={{ ...s.sw, background: "#e60000" }} /> было, в новой редакции нет</div>
      <div><span style={{ ...s.sw, background: "#005aff" }} /> новое в этой редакции</div>
      <div><span style={{ ...s.sw, background: "#222" }} /> без изменений</div>
    </div>
  );
}

const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 8 },
  title: { fontWeight: 700, fontSize: 14, color: "#b71c1c" },
  blockTitle: { fontWeight: 700, fontSize: 13, color: "#1f5fa8", marginTop: 4 },
  muted: { fontSize: 12, color: "#556", lineHeight: 1.4 },
  small: { fontSize: 11, color: "#667" },
  hint: { fontSize: 11, color: "#667", lineHeight: 1.4 },
  row: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" },
  pageRow: { display: "flex", alignItems: "center", gap: 6, border: "1px solid #e1e6ec", borderRadius: 6, padding: 6, fontSize: 12, cursor: "pointer" },
  pageActive: { borderColor: "#1976d2", background: "#eef6ff" },
  input: { padding: "4px 6px", border: "1px solid #c8d0da", borderRadius: 6, fontSize: 12, boxSizing: "border-box" },
  bad: { borderColor: "#c62828", background: "#fff0f0" },
  alignBox: { background: "#fff3e0", border: "1px solid #ffb74d", borderRadius: 6, padding: 8, fontSize: 12, display: "flex", flexDirection: "column", gap: 6, lineHeight: 1.4 },
  btn: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", alignSelf: "flex-start" },
  primary: { background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  check: { fontSize: 12, display: "flex", gap: 6, alignItems: "center" },
  error: { fontSize: 12, color: "#c00", background: "#fff0f0", borderRadius: 6, padding: 6 },
  legend: { fontSize: 11, color: "#445", display: "flex", flexDirection: "column", gap: 2 },
  sw: { display: "inline-block", width: 14, height: 4, borderRadius: 2, verticalAlign: "middle", marginRight: 4 },
};
