// Свойства выбранного замера: работа из справочника (кладка — этаж, высота,
// толщина, проёмы, каналы шахты, расход материала) или свой вид работ
// (отделка, как раньше); у проёма на плане — марка.
import React from "react";
import { CALCS, WORK_SUGGESTIONS, polylineLength } from "./model";
import { METHODS, OPENING_TYPES, effectiveHeight, isSnapshotStale, masonryMeasure, rectOf } from "./masonry";

const fmt = (v, d = 2) => (v == null ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) }));
const str = (v) => (v == null ? "" : String(v).replace(".", ","));

export default function MeasurementProps({
  m, measurements, catalog, floors, openings, metersPerUnit, update, remove, onPickWork, onRefresh, onFreeWork, labelFor,
}) {
  if (m.role === "opening") return <OpeningProps m={m} measurements={measurements} openings={openings} metersPerUnit={metersPerUnit} update={update} remove={remove} />;

  const worksById = Object.fromEntries(catalog.works.map((w) => [w.id, w]));
  const groups = catalog.groups.filter((g) => !g.archived);
  const fitting = (w) => METHODS[w.method]?.kind === m.kind && (!w.archived || w.id === m.workId);

  return (
    <section style={s.props}>
      <div style={s.blockTitle}>Замер {m.kind === "rect" ? "(прямоугольник)" : m.deduct ? "(вычет)" : ""}</div>
      <label style={s.label}>Работа из справочника</label>
      <select style={s.input} value={m.workId ?? ""} onChange={(e) => onPickWork(m, e.target.value ? Number(e.target.value) : null)}>
        {m.kind !== "rect" && <option value="">— свой вид работ (без справочника) —</option>}
        {m.kind === "rect" && !m.workId && <option value="">— выберите работу —</option>}
        {groups.map((g) => {
          const works = catalog.works.filter((w) => w.groupId === g.id && fitting(w));
          return works.length ? (
            <optgroup key={g.id} label={g.name}>
              {works.map((w) => <option key={w.id} value={w.id}>{w.name}{w.archived ? " (архив)" : ""}</option>)}
            </optgroup>
          ) : null;
        })}
      </select>
      {m.workId ? (
        <CatalogProps m={m} measurements={measurements} work={worksById[m.workId]} floors={floors} openings={openings}
          metersPerUnit={metersPerUnit} update={update} onRefresh={onRefresh} />
      ) : (
        <FreeProps m={m} update={update} onFreeWork={onFreeWork} />
      )}
      <div style={s.row}>
        <label style={{ ...s.label, margin: 0 }}>× одинаковых</label>
        <input style={{ ...s.input, width: 60 }} inputMode="numeric" value={m.count}
          onChange={(e) => update(m.id, { count: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
      </div>
      {!m.workId && (
        <div style={s.qty}>= {labelFor(m) || (metersPerUnit ? "укажите высоту / толщину" : "лист не откалиброван")}</div>
      )}
      <button type="button" style={s.danger} onClick={() => remove(m.id)}>Удалить замер</button>
    </section>
  );
}

function FreeProps({ m, update, onFreeWork }) {
  return (
    <>
      <label style={s.label}>Вид работ</label>
      <input style={s.input} list="takeoff-works" value={m.work} placeholder="Например: Штукатурка стен"
        onChange={(e) => {
          const work = e.target.value;
          const sug = WORK_SUGGESTIONS.find((w) => w.work === work);
          const patch = { work };
          if (sug && CALCS[sug.calc].kind === m.kind) patch.calc = sug.calc;
          update(m.id, patch);
          onFreeWork(m.kind, work);
        }} />
      <datalist id="takeoff-works">{WORK_SUGGESTIONS.map((w) => <option key={w.work} value={w.work} />)}</datalist>
      <label style={s.label}>Помещение</label>
      <input style={s.input} value={m.room} placeholder="Например: Кухня, кв. 12" onChange={(e) => update(m.id, { room: e.target.value })} />
      <label style={s.label}>Считать</label>
      <select style={s.input} value={m.calc} onChange={(e) => update(m.id, { calc: e.target.value })}>
        {Object.entries(CALCS).filter(([, c]) => c.kind === m.kind).map(([key, c]) => (
          <option key={key} value={key}>{c.label}, {c.unit}</option>
        ))}
      </select>
      {m.calc === "wall" && (
        <>
          <label style={s.label}>{m.deduct ? "Высота проёма, м" : "Высота стен, м"}</label>
          <input style={s.input} inputMode="decimal" value={m.height ?? ""} onChange={(e) => update(m.id, { height: e.target.value })} />
        </>
      )}
      {m.calc === "volume" && (
        <>
          <label style={s.label}>Толщина, м</label>
          <input style={s.input} inputMode="decimal" value={m.thickness ?? ""} placeholder="например 0,05" onChange={(e) => update(m.id, { thickness: e.target.value })} />
        </>
      )}
      <label style={s.check}>
        <input type="checkbox" checked={!!m.deduct} onChange={(e) => update(m.id, { deduct: e.target.checked })} />
        {m.kind === "area" ? " Вычет (проём, колонна)" : " Вычет (дверь, окно: ширина × высота проёма)"}
      </label>
    </>
  );
}

function CatalogProps({ m, measurements, work, floors, openings, metersPerUnit, update, onRefresh }) {
  const w = m.snapshot;
  const r = masonryMeasure(m, { metersPerUnit, floors, openings, measurements });
  const floor = floors.find((f) => f.id === m.floorId);
  const heightShown = m.heightOverride ? m.height ?? "" : str(floor?.height);
  const needsThickness = w.unit === "м³" && w.method !== "rect_channels";
  const thicknessShown = m.thicknessOverride ? m.thickness ?? "" : str(w.thickness);
  const usesOpenings = w.method === "wall_length" && w.countOpenings;
  const drawn = measurements.filter((d) => d.role === "opening" && d.wallId === m.id);
  const byId = Object.fromEntries(openings.map((o) => [o.id, o]));
  const assigned = m.openings || [];
  const setAssigned = (list) => update(m.id, { openings: list });

  return (
    <>
      {!work && <div style={s.warn}>Работы больше нет в справочнике — считается по сохранённой норме.</div>}
      {work?.archived && <div style={s.warn}>Работа в архиве — для новых замеров не предлагается.</div>}
      {work && isSnapshotStale(m, { [work.id]: work }) && (
        <div style={s.warn}>
          Норма в справочнике изменилась после замера (версия {m.snapshot.version} → {work.version}). Сейчас посчитано по прежней.
          <button type="button" style={{ ...s.small, marginTop: 4 }} onClick={() => onRefresh(m)}>Пересчитать по текущим нормам</button>
        </div>
      )}
      <div style={s.muted}>
        {METHODS[w.method]?.label}; ед. {w.unit}
        {w.materialName ? `; ${w.materialName} ${fmt(w.materialRate, 4)} ${w.materialUnit} на 1 ${w.unit}` : ""}
        {w.method === "wall_length" ? (w.countOpenings ? "; проёмы вычитаются" : "; проёмы не учитываются") : ""}
      </div>
      <label style={s.label}>Помещение / место</label>
      <input style={s.input} value={m.room} placeholder="Например: оси 1–3, секция А" onChange={(e) => update(m.id, { room: e.target.value })} />

      <div style={s.row2}>
        <div style={{ flex: 1 }}>
          <label style={s.label}>Этаж</label>
          <select style={s.input} value={m.floorId ?? ""} onChange={(e) => update(m.id, { floorId: e.target.value || null })}>
            <option value="">—</option>
            {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div style={{ width: 110 }}>
          <label style={s.label}>Высота, м {m.heightOverride && <span style={s.overrideTag}>вручную</span>}</label>
          <div style={{ display: "flex", gap: 2 }}>
            <input style={{ ...s.input, ...(m.heightOverride ? s.override : null) }} inputMode="decimal" value={heightShown}
              placeholder={floors.length ? "из этажа" : "укажите"}
              onChange={(e) => update(m.id, { height: e.target.value, heightOverride: true })} />
            {m.heightOverride && floor && (
              <button type="button" style={s.reset} title={`Вернуть высоту этажа (${str(floor.height)} м)`} onClick={() => update(m.id, { heightOverride: false })}>↺</button>
            )}
          </div>
        </div>
      </div>
      {floors.length === 0 && !m.heightOverride && <div style={s.hint}>Этажей нет — добавьте на вкладке «Этажи» или укажите высоту вручную.</div>}

      {needsThickness && (
        <>
          <label style={s.label}>Толщина, м {m.thicknessOverride && <span style={s.overrideTag}>вручную</span>}</label>
          <div style={{ display: "flex", gap: 2 }}>
            <input style={{ ...s.input, ...(m.thicknessOverride ? s.override : null) }} inputMode="decimal" value={thicknessShown}
              onChange={(e) => update(m.id, { thickness: e.target.value, thicknessOverride: true })} />
            {m.thicknessOverride && (
              <button type="button" style={s.reset} title={`Вернуть толщину из справочника (${str(w.thickness)} м)`} onClick={() => update(m.id, { thicknessOverride: false })}>↺</button>
            )}
          </div>
        </>
      )}

      {usesOpenings && (
        <>
          <label style={s.label}>Проёмы в этой стене</label>
          {assigned.map((a, i) => (
            <div key={i} style={s.row}>
              <select style={{ ...s.input, flex: 1, width: "auto" }} value={a.openingId}
                onChange={(e) => setAssigned(assigned.map((x, j) => (j === i ? { ...x, openingId: e.target.value } : x)))}>
                {!byId[a.openingId] && <option value={a.openingId}>(марка удалена)</option>}
                {openings.map((o) => <option key={o.id} value={o.id}>{o.mark} — {OPENING_TYPES[o.type]} {fmt(o.width)} × {fmt(o.height)}</option>)}
              </select>
              <span>×</span>
              <input style={{ ...s.input, width: 44 }} inputMode="numeric" value={a.qty}
                onChange={(e) => setAssigned(assigned.map((x, j) => (j === i ? { ...x, qty: Math.max(0, parseInt(e.target.value, 10) || 0) } : x)))} />
              <button type="button" style={s.x} onClick={() => setAssigned(assigned.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          {openings.length ? (
            <button type="button" style={s.small} onClick={() => setAssigned([...assigned, { openingId: openings[0].id, qty: 1 }])}>+ Проём из ведомости</button>
          ) : (
            <div style={s.hint}>Ведомость проёмов пуста — заполните на вкладке «Проёмы».</div>
          )}
          {drawn.length > 0 && (
            <div style={s.hint}>На плане: {drawn.map((d) => byId[d.openingId]?.mark || "без марки").join(", ")}</div>
          )}
        </>
      )}
      {w.method === "wall_length" && !w.countOpenings && (assigned.length > 0 || drawn.length > 0) && (
        <div style={s.hint}>У этой работы проёмы не учитываются — назначенные проёмы не вычитаются.</div>
      )}

      {m.kind === "rect" && (
        <>
          <label style={s.label}>Каналы ({(m.channels || []).length})</label>
          {(m.channels || []).map((c, i) => {
            const q = rectOf(c);
            return (
              <div key={i} style={s.row}>
                <span style={{ flex: 1, fontSize: 12 }}>Канал {i + 1}: {metersPerUnit ? `${fmt((q.x1 - q.x0) * metersPerUnit, 3)} × ${fmt((q.y1 - q.y0) * metersPerUnit, 3)} м` : "—"}</span>
                <button type="button" style={s.x} onClick={() => update(m.id, { channels: m.channels.filter((_, j) => j !== i) })}>×</button>
              </div>
            );
          })}
          <div style={s.hint}>Канал — тем же инструментом «Прямоугольник», двумя щелчками внутри шахты.</div>
        </>
      )}

      <div style={s.result}>
        {r.quantity != null ? (
          <>
            <div style={s.qty}>= {fmt(r.quantity, 4)} {w.unit}</div>
            {r.gross != null && (
              <div style={s.muted}>
                Стена {fmt(r.gross, 3)} м²{r.openingsArea ? ` − проёмы ${fmt(r.openingsArea, 3)} м²` : ""} = {fmt(r.net, 3)} м²
                {w.unit === "м³" ? ` × ${str(effectiveThicknessShown(m))} м` : ""}{m.count > 1 ? `; × ${m.count}` : ""}
              </div>
            )}
            {r.outerArea != null && (
              <div style={s.muted}>
                Шахта {fmt(r.outerArea, 4)} м²{r.channelsArea ? ` − каналы ${fmt(r.channelsArea, 4)} м²` : ""} × {str(effectiveHeight(m, floors))} м{m.count > 1 ? `; × ${m.count}` : ""}
              </div>
            )}
            {r.material != null && <div style={s.material}>{w.materialName}: {fmt(r.material, 2)} {w.materialUnit}</div>}
          </>
        ) : (
          <div style={s.qty}>= —</div>
        )}
        {r.warnings.map((t) => <div key={t} style={s.warn}>{t}</div>)}
      </div>
    </>
  );
}

const effectiveThicknessShown = (m) => (m.thicknessOverride ? m.thickness : m.snapshot?.thickness);

function OpeningProps({ m, measurements, openings, metersPerUnit, update, remove }) {
  const wall = measurements.find((x) => x.id === m.wallId);
  const o = openings.find((x) => x.id === m.openingId);
  return (
    <section style={s.props}>
      <div style={s.blockTitle}>Проём на плане</div>
      <div style={s.muted}>Стена: {wall ? wall.snapshot?.name || wall.work || "без названия" : "удалена"}{wall?.room ? ` · ${wall.room}` : ""}</div>
      <label style={s.label}>Марка</label>
      <select style={s.input} value={m.openingId ?? ""} onChange={(e) => update(m.id, { openingId: e.target.value || null })}>
        <option value="">—</option>
        {openings.map((x) => <option key={x.id} value={x.id}>{x.mark} — {OPENING_TYPES[x.type]} {fmt(x.width)} × {fmt(x.height)}</option>)}
      </select>
      <div style={s.muted}>
        Ширина по плану: {metersPerUnit ? `${fmt(polylineLength(m.points) * metersPerUnit, 3)} м` : "—"}; высота из марки: {o ? `${fmt(o.height)} м` : "—"}
      </div>
      <button type="button" style={s.danger} onClick={() => remove(m.id)}>Удалить проём</button>
    </section>
  );
}

const s = {
  props: { padding: 10, borderBottom: "1px solid #eef1f4", display: "flex", flexDirection: "column", gap: 4, background: "#f8fbff", overflowY: "auto", maxHeight: "60%" },
  blockTitle: { fontWeight: 700, fontSize: 13, color: "#1f5fa8" },
  label: { fontSize: 12, fontWeight: 600, color: "#445", marginTop: 4, display: "block" },
  input: { padding: "6px 8px", border: "1px solid #c8d0da", borderRadius: 6, fontSize: 13, boxSizing: "border-box", width: "100%" },
  override: { background: "#fff3c4", borderColor: "#e0a800", fontWeight: 600 },
  overrideTag: { fontSize: 10, color: "#8a5a00", background: "#fff3c4", borderRadius: 4, padding: "0 4px", fontWeight: 600 },
  reset: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, cursor: "pointer", fontSize: 13, padding: "0 6px" },
  row: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  row2: { display: "flex", gap: 6, alignItems: "flex-end" },
  check: { fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginTop: 4 },
  small: { background: "#fff", border: "1px solid #c8d0da", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", alignSelf: "flex-start" },
  danger: { background: "#fff0f0", color: "#c62828", border: "1px solid #f2b8b5", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer", marginTop: 8 },
  x: { background: "none", border: "none", color: "#c62828", fontSize: 16, cursor: "pointer", padding: "0 4px" },
  hint: { fontSize: 11, color: "#667", lineHeight: 1.4 },
  muted: { fontSize: 11, color: "#667", lineHeight: 1.4 },
  warn: { fontSize: 12, color: "#8a5a00", background: "#fff6e0", borderRadius: 6, padding: "6px 8px", margin: "2px 0", display: "flex", flexDirection: "column" },
  result: { marginTop: 6, display: "flex", flexDirection: "column", gap: 2 },
  qty: { fontSize: 15, fontWeight: 700, color: "#0d47a1" },
  material: { fontSize: 13, fontWeight: 600, color: "#2e7d32" },
};
