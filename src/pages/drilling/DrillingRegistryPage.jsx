// Реестр заявок на бурение и резку: таблица по строкам работ (статус, содержимое,
// заявленное и фактическое количество), фильтры и выгрузка в Excel с теми же
// фильтрами. Каждый видит свой срез: автор — свои заявки, ответственный — заявки
// своей линии, админ — все (права проверяет сервер, server/drilling/service.js).
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import DrillingNav from "./DrillingNav";
import { downloadRegistryXlsx, fetchRegistry, fmtDateTime, fmtDue, fmtNum, positionLabel, STATUS_LABELS, WORK_LABELS } from "./drillingApi";

const EMPTY = { from: "", to: "", status: "", object: "", workType: "", company: "", author: "", onlyMine: false };
const STATUS_ORDER = ["engineer", "director", "director_decide", "line1", "line2", "returned", "accepted", "completed", "cancelled"];

const sizeOf = (r) => (r.workType === "drill" ? `Ø ${r.diameterMm} мм` : `толщина ${fmtNum(r.thicknessCm)} см`);

const Select = ({ label, value, onChange, options, id }) => (
  <div className={css.field}>
    <label className={css.label} htmlFor={id}>{label}</label>
    <select id={id} className={css.input} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Все</option>
      {options.map((o) => (typeof o === "string"
        ? <option key={o} value={o}>{o}</option>
        : <option key={o.value} value={o.value}>{o.label}</option>))}
    </select>
  </div>
);

const DrillingRegistryPage = () => {
  const [filters, setFilters] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  // Значения для списков фильтров берём из ответа без фильтров и дальше не сужаем.
  const [facets, setFacets] = useState({ objects: [], companies: [], authors: [] });

  const load = useCallback(async (f) => {
    try {
      const res = await fetchRegistry(f);
      setData(res);
      setFacets((cur) => (res.facets.objects.length >= cur.objects.length ? res.facets : cur));
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(filters); }, [filters, load]);

  const set = (name) => (value) => setFilters((cur) => ({ ...cur, [name]: value }));
  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      await downloadRegistryXlsx(filters);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const rows = data?.rows || [];
  const units = Object.keys(data?.totals || {});

  return (
    <div className={css.page}>
      <div className={css.content} style={{ maxWidth: 1280 }}>
        <DrillingNav />
        <div className={styles.head}>
          <h1 className={css.title}>Реестр заявок на бурение и резку</h1>
        </div>
        {data && (
          <p className={styles.hint}>
            {{ all: "Все заявки.", company: "Заявки, выполненные вашей компанией (ждущие ответа — на странице «Заявки», во «Входящих»).", own: "Ваши заявки." }[data.scope]}
          </p>
        )}

        <div className={css.card}>
          <div className={styles.gridFilters}>
            <div className={css.field}>
              <label className={css.label} htmlFor="f-from">Создана с</label>
              <input id="f-from" type="date" className={css.input} value={filters.from} max={filters.to || undefined} onChange={(e) => set("from")(e.target.value)} />
            </div>
            <div className={css.field}>
              <label className={css.label} htmlFor="f-to">по</label>
              <input id="f-to" type="date" className={css.input} value={filters.to} min={filters.from || undefined} onChange={(e) => set("to")(e.target.value)} />
            </div>
            <Select id="f-status" label="Статус" value={filters.status} onChange={set("status")}
              options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
            <Select id="f-object" label="Объект" value={filters.object} onChange={set("object")} options={facets.objects} />
            <Select id="f-work" label="Вид работ" value={filters.workType} onChange={set("workType")}
              options={[{ value: "drill", label: WORK_LABELS.drill }, { value: "cut", label: WORK_LABELS.cut }]} />
            <Select id="f-company" label="Исполнитель" value={filters.company} onChange={set("company")} options={facets.companies} />
            {facets.authors.length > 1 && <Select id="f-author" label="Автор" value={filters.author} onChange={set("author")} options={facets.authors} />}
          </div>
          <div className={styles.filterBar}>
            {data?.scope === "all" && (
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={filters.onlyMine} onChange={(e) => set("onlyMine")(e.target.checked)} /> Только поданные мной
              </label>
            )}
            {dirty && (
              <button type="button" className={css.btnGhost} style={{ marginRight: 0, minHeight: 40 }} onClick={() => setFilters(EMPTY)}>
                Сбросить фильтры
              </button>
            )}
            <button type="button" className={css.btnPrimary} style={{ marginLeft: "auto", minHeight: 40 }} disabled={exporting || !rows.length} onClick={exportXlsx}>
              {exporting ? "Формирую…" : "Скачать в Excel"}
            </button>
          </div>
        </div>

        {error && <div className={styles.error}>{error}</div>}
        {!data && !error && <div className={styles.empty}>Загрузка…</div>}

        {data && (
          <>
            <p className={styles.hint}>
              Заявок: {data.requestsCount}, строк работ: {rows.length}.
              {units.map((u) => ` ${u}: заявлено ${fmtNum(data.totals[u].plan)}, выполнено ${fmtNum(data.totals[u].fact)}.`)}
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>№</th><th>Создана</th><th>Срок</th><th>Автор</th><th>Статус</th><th>Исполнитель</th>
                    <th>Объект, позиция</th><th>Вид работ</th><th>Размер</th><th>Материал</th>
                    <th>Заявлено</th><th>Выполнено</th><th>Причина</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.itemId}>
                      <td><Link to={`/drilling-requests/${r.requestId}`} title={`Открыть заявку № ${r.requestId}`}>{r.requestId}</Link></td>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(r.createdAt)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDue(r.dueDate) || "—"}{r.overdue && <span className={styles.overdueBadge}>просрочена</span>}</td>
                      <td>{r.author}</td>
                      <td><span className={`${styles.badge} ${styles[`st_${r.status}`]}`}>{STATUS_LABELS[r.status]}</span></td>
                      <td>{r.company || "—"}</td>
                      <td>{r.object}<br />{positionLabel(r.position)}</td>
                      <td>{WORK_LABELS[r.workType]}</td>
                      <td>{sizeOf(r)}</td>
                      <td>{r.material}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtNum(r.quantity)} {r.unit}</td>
                      <td>
                        <span style={{ whiteSpace: "nowrap" }}>{r.doneAt ? `${fmtNum(r.factQuantity)} ${r.unit}` : "—"}</span>
                        {r.factComment && <div style={{ fontSize: 12, color: "var(--muted)" }}>{r.factComment}</div>}
                      </td>
                      <td>{r.reason || "—"}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={12} className={styles.empty}>Заявок по этим условиям нет.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DrillingRegistryPage;
