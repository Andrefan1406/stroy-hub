// Вкладка «Виды работ и расценки»: объёмы работ по элементам и подобранные
// расценки (цена с НДС). Система предлагает расценку с уверенностью; пользователь
// подтверждает, выбирает другую из свода или вводит свою. Подтверждённые
// соответствия запоминаются и подставляются в следующих документах.
import React, { useEffect, useState } from "react";
import { ptoDelete, ptoGet, ptoPatch, ptoPost } from "./api";
import { RATE_STATUS, fmtMoney, fmtNum } from "./format";
import { s } from "./styles";

function RatePicker({ work, onClose, onPicked, onError }) {
  const [query, setQuery] = useState(work.name);
  const [list, setList] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ name: "", price: "" });

  const search = async (q) => {
    setBusy(true);
    setMessage("");
    try {
      const { rates } = await ptoGet(`/rates/search?q=${encodeURIComponent(q)}&unit=${encodeURIComponent(work.unit)}`);
      setList(rates);
    } catch (err) {
      setList([]);
      setMessage(err.message || "Поиск недоступен");
    } finally {
      setBusy(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { search(work.name); }, []);

  const pick = async (body) => {
    setBusy(true);
    try {
      await ptoPost(`/works/${work.id}/rate`, body);
      onPicked();
      onClose();
    } catch (err) {
      onError(err.message || "Не удалось сохранить расценку");
      setBusy(false);
    }
  };

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px" }}>Расценка на «{work.name}»</h3>
        <div style={s.muted}>{work.element || "—"} · {fmtNum(work.quantity)} {work.unit}. Сначала «утверждённые в VK», затем «ЕНиР для фирм»; цена — с НДС.</div>
        <form style={{ display: "flex", gap: 8, margin: "12px 0" }} onSubmit={(e) => { e.preventDefault(); search(query); }}>
          <input style={s.input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Что искать в своде расценок" />
          <button type="submit" style={s.secondary} disabled={busy}>Найти</button>
        </form>
        {message && <div style={s.warn}>{message}</div>}
        {busy && !list && <div style={s.muted}>Ищем…</div>}
        {list && list.length === 0 && !message && <div style={s.muted}>Ничего не найдено.</div>}
        {list && list.length > 0 && (
          <div style={{ ...s.tableWrap, maxHeight: "42vh", overflowY: "auto" }}>
            <table style={s.table}>
              <thead><tr><th style={s.th}>Категория</th><th style={s.th}>Расценка</th><th style={s.th}>Ед.</th><th style={s.th}>Цена с НДС</th><th style={s.th}>Близость</th><th style={s.th} /></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={`${c.tier}-${c.id}`} style={c.unitMatch ? null : { color: "#999" }}>
                    <td style={s.td}>{c.tierTitle}</td>
                    <td style={s.td}>{c.name}{c.object && c.object !== "Все объекты" ? <span style={s.tag}>{c.object}</span> : null}{c.section ? <div style={{ ...s.muted, fontSize: 12 }}>{c.section}</div> : null}</td>
                    <td style={s.td}>{c.unit}{!c.unitMatch && <div style={{ fontSize: 11, color: "#c00" }}>другая единица</div>}</td>
                    <td style={s.tdNum}>{c.price == null ? "—" : fmtMoney(c.price)}{c.vatEstimated && <div style={{ fontSize: 11, color: "#888" }}>пересчитана с НДС</div>}</td>
                    <td style={s.tdNum}>{Math.round(c.score * 100)}%</td>
                    <td style={s.td}>
                      <button style={c.price == null || busy ? { ...s.smallPrimary, ...s.disabled } : s.smallPrimary} disabled={c.price == null || busy} onClick={() => pick({ rateId: c.id })}>Выбрать</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ ...s.card, background: "#fafafa", marginTop: 14, marginBottom: 0 }}>
          <b style={{ fontSize: 14 }}>Своя расценка</b>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <input style={{ ...s.input, flex: "2 1 220px", width: "auto" }} placeholder="Название расценки" value={manual.name} onChange={(e) => setManual((m) => ({ ...m, name: e.target.value }))} />
            <input style={{ ...s.input, flex: "1 1 120px", width: "auto" }} inputMode="decimal" placeholder={`Цена с НДС, ₸ за ${work.unit}`} value={manual.price} onChange={(e) => setManual((m) => ({ ...m, price: e.target.value }))} />
            <button style={s.secondary} disabled={busy || !manual.name.trim() || !manual.price} onClick={() => pick({ manual: { name: manual.name, unit: work.unit, price: manual.price } })}>Сохранить</button>
          </div>
        </div>
        <div style={{ textAlign: "right", marginTop: 12 }}><button style={s.secondary} onClick={onClose}>Закрыть</button></div>
      </div>
    </div>
  );
}

function WorkRow({ work, onChange, onError, onPick }) {
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (err) { onError(err.message || "Не удалось сохранить"); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    await ptoPatch(`/works/${work.id}`, { element: edit.element, name: edit.name, unit: edit.unit, quantity: edit.quantity });
    setEdit(null);
    onChange();
  });

  const rate = work.rate;
  const st = RATE_STATUS[work.rateStatus] || RATE_STATUS.none;
  const cost = rate && rate.price != null && work.quantity != null ? rate.price * work.quantity : null;

  if (edit) {
    const set = (k) => (e) => setEdit((x) => ({ ...x, [k]: e.target.value }));
    return (
      <tr style={{ background: "#fffdf0" }}>
        <td style={s.td}><input style={s.inputSmall} value={edit.element} onChange={set("element")} /></td>
        <td style={s.td}><input style={s.inputSmall} value={edit.name} onChange={set("name")} /></td>
        <td style={s.td}><input style={{ ...s.inputSmall, width: 60 }} value={edit.unit} onChange={set("unit")} /></td>
        <td style={s.td}><input style={{ ...s.inputSmall, width: 90 }} inputMode="decimal" value={edit.quantity} onChange={set("quantity")} /></td>
        <td style={s.td} colSpan={4}>
          <button style={s.smallPrimary} disabled={busy} onClick={save}>Сохранить</button>
          <button style={s.small} onClick={() => setEdit(null)}>Отмена</button>
          <span style={{ ...s.muted, marginLeft: 8 }}>при смене названия или единицы расценка сбрасывается</span>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td style={s.td}>{work.element || "—"}</td>
      <td style={s.td}>
        {work.name}
        {work.manual && <span style={s.tag}>＋ вручную</span>}
        {work.edited && !work.manual && <span style={{ ...s.tag, background: "#fff1c9", color: "#8a5a00" }}>✎ изменено</span>}
        {work.basisNote && <div style={{ ...s.muted, fontSize: 12 }}>{work.basisNote}</div>}
      </td>
      <td style={s.td}>{work.unit}</td>
      <td style={s.tdNum}>{fmtNum(work.quantity)}</td>
      <td style={s.td}>
        {rate ? (
          <>
            {rate.name}
            <div style={{ fontSize: 12 }}>
              <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>
              {work.rateStatus === "suggested" && rate.confidence != null && <span style={s.muted}> · уверенность {Math.round(rate.confidence * 100)}%</span>}
              <span style={s.muted}> · {rate.manual ? "введена вручную" : rate.class}</span>
            </div>
          </>
        ) : <span style={{ color: "#c00" }}>не подобрана</span>}
      </td>
      <td style={s.tdNum}>{rate && rate.price != null ? fmtMoney(rate.price) : "—"}</td>
      <td style={s.tdNum}>{cost != null ? fmtMoney(cost) : "—"}</td>
      <td style={s.td}>
        {work.status === "confirmed"
          ? <span style={s.chip("#1a7f37", "#e6f4ea")}>проверено</span>
          : <span style={s.chip("#b45309", "#fff3e0")}>черновик</span>}
      </td>
      <td style={s.td}>
        {work.rateStatus === "suggested" && (
          <button style={s.smallPrimary} disabled={busy} onClick={() => run(async () => { await ptoPost(`/works/${work.id}/rate`, { rateId: rate.id }); onChange(); })}>Подтвердить</button>
        )}
        <button style={s.small} disabled={busy} onClick={() => onPick(work)}>{rate ? "Другая…" : "Подобрать…"}</button>
        {rate && <button style={s.small} disabled={busy} onClick={() => run(async () => { await ptoDelete(`/works/${work.id}/rate`); onChange(); })}>Сбросить</button>}
        <button style={s.small} disabled={busy} onClick={() => setEdit({ element: work.element, name: work.name, unit: work.unit, quantity: work.quantity == null ? "" : String(work.quantity) })}>Править</button>
        <button style={s.smallDanger} disabled={busy} onClick={() => {
          if (window.confirm(`Удалить работу «${work.name}» (${work.element || "без элемента"})?`)) run(async () => { await ptoDelete(`/works/${work.id}`); onChange(); });
        }}>×</button>
      </td>
    </tr>
  );
}

export default function WorksTab({ doc, works, reload, onError, onNotice }) {
  const [picker, setPicker] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ element: "", name: "", unit: "м²", quantity: "" });
  const [busy, setBusy] = useState(false);

  const call = async (fn, done) => {
    setBusy(true);
    try { const r = await fn(); if (done) done(r); await reload(); } catch (err) { onError(err.message || "Ошибка"); } finally { setBusy(false); }
  };
  const rebuild = () => {
    if (!window.confirm("Пересчитать виды работ по текущей ведомости? Работы, выведенные из материалов, будут созданы заново (добавленные вручную останутся).")) return;
    return call(() => ptoPost(`/documents/${doc.id}/works/rebuild`));
  };
  const applyRates = () => call(() => ptoPost(`/documents/${doc.id}/rates/apply`), (r) => (r.warning ? onError(r.warning) : onNotice("Расценки подобраны для работ без подтверждённой расценки")));
  const add = (e) => {
    e.preventDefault();
    return call(() => ptoPost(`/documents/${doc.id}/works`, form), () => { setAdding(false); setForm({ element: "", name: "", unit: "м²", quantity: "" }); });
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      {doc.worksStale && (
        <div style={s.warn}>
          Ведомость изменена после расчёта видов работ — объёмы работ могли устареть.{" "}
          <button style={s.smallPrimary} disabled={busy} onClick={rebuild}>Пересчитать виды работ</button>
        </div>
      )}
      <div style={{ marginBottom: 10 }}>
        <button style={s.secondary} disabled={busy} onClick={applyRates}>Подобрать расценки заново</button>
        <button style={{ ...s.secondary, marginLeft: 8 }} disabled={busy} onClick={rebuild}>Пересчитать виды работ</button>
      </div>
      {works.length === 0 ? <div style={s.warn}>Видов работ нет — для них нет материалов в расчёте. Работу можно добавить вручную.</div> : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Конструктивный элемент</th><th style={s.th}>Вид работ</th><th style={s.th}>Ед.</th><th style={s.th}>Объём</th>
                <th style={s.th}>Расценка</th><th style={s.th}>Цена с НДС</th><th style={s.th}>Стоимость</th><th style={s.th}>Статус</th><th style={s.th} />
              </tr>
            </thead>
            <tbody>{works.map((w) => <WorkRow key={w.id} work={w} onChange={reload} onError={onError} onPick={setPicker} />)}</tbody>
          </table>
        </div>
      )}
      <div style={{ ...s.muted, marginTop: 8 }}>
        Расценки: сначала «утверждённые в VK», затем «ЕНиР для фирм», цена с НДС. Подтверждённое соответствие запоминается и подставится в следующих документах.
        Опалубка: площади опалубки в ведомостях КЖ не приводятся — добавьте работу вручную, если нужна.
      </div>
      <div style={{ marginTop: 12 }}>
        {!adding ? <button style={s.secondary} onClick={() => setAdding(true)}>+ Добавить работу</button> : (
          <form onSubmit={add} style={{ ...s.card, background: "#fafafa" }}>
            <div style={s.formGrid}>
              <label style={s.label}>Конструктивный элемент<input style={s.input} value={form.element} onChange={set("element")} /></label>
              <label style={s.label}>Вид работ *<input style={s.input} required value={form.name} onChange={set("name")} placeholder="Например, Устройство опалубки" /></label>
              <label style={s.label}>Ед. изм. *<input style={s.input} required value={form.unit} onChange={set("unit")} /></label>
              <label style={s.label}>Объём<input style={s.input} inputMode="decimal" value={form.quantity} onChange={set("quantity")} /></label>
            </div>
            <button type="submit" style={s.primary} disabled={busy}>Добавить</button>
            <button type="button" style={{ ...s.secondary, marginLeft: 8 }} onClick={() => setAdding(false)}>Отмена</button>
          </form>
        )}
      </div>
      {picker && <RatePicker work={picker} onClose={() => setPicker(null)} onPicked={reload} onError={onError} />}
    </div>
  );
}
