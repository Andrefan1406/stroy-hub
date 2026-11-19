// Заявка на технологическое бурение и резку: форма в стиле заявки на бетон.
// Режим правки (/drilling-request/:id/edit) — для возвращённой заявки: после
// сохранения правок она сразу уходит на новый круг согласования.
// Бэкенд и правила: server/drilling/. Числа проверяются так же, как на сервере.
import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import { Field, SelectField } from "../../components/RequestFormFields";
import { objectPositionOptions } from "../../data/constructionData";
import { createRequest, fetchRequest, restartRequest, sanitizeNumber, updateRequest } from "./drillingApi";

const OBJECTS = Object.keys(objectPositionOptions);
const MATERIALS = ["кирпич", "бетон"];
const WORKS = [{ value: "drill", label: "Сверление" }, { value: "cut", label: "Резка" }];

const emptyRow = () => ({ object: "", position: "", workType: "", material: "", diameterMm: "", thicknessCm: "", quantity: "", reason: "" });

const INT_RE = /^\d+$/;
const DEC_RE = /^\d+([.,]\d)?$/;

// Ошибки строки: { поле: текст }.
function rowErrors(r) {
  const e = {};
  if (!r.object) e.object = "Выберите объект";
  if (!r.position) e.position = "Выберите позицию";
  if (!r.workType) e.workType = "Выберите вид работ";
  if (!r.material) e.material = "Выберите материал";
  const drill = r.workType === "drill";
  if (r.workType) {
    const ok = drill ? INT_RE.test(r.quantity) : DEC_RE.test(r.quantity);
    if (!ok || Number(r.quantity.replace(",", ".")) <= 0) e.quantity = drill ? "Целое число штук" : "Число, не больше одного знака после запятой";
    if (drill && !(INT_RE.test(r.diameterMm) && Number(r.diameterMm) > 0)) e.diameterMm = "Диаметр в мм, целое число";
    if (!drill && !(DEC_RE.test(r.thicknessCm) && Number(r.thicknessCm.replace(",", ".")) > 0)) e.thicknessCm = "Толщина в см, не больше одного знака после запятой";
  }
  return e;
}

const DrillingRequestPage = () => {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const [rows, setRows] = useState([emptyRow()]);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(editing);

  useEffect(() => {
    if (!editing) return;
    fetchRequest(id)
      .then((req) => {
        if (!req.permissions.edit) throw new Error("Эту заявку сейчас нельзя править");
        setRows(req.items.map((i) => ({
          object: i.object, position: i.position, workType: i.workType, material: i.material,
          diameterMm: i.diameterMm == null ? "" : String(i.diameterMm),
          thicknessCm: i.thicknessCm == null ? "" : String(i.thicknessCm).replace(".", ","),
          quantity: String(i.quantity).replace(".", ","), reason: i.reason,
        })));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [editing, id]);

  const setField = (index, name, value) => setRows((cur) => cur.map((r, i) => {
    if (i !== index) return r;
    const next = { ...r, [name]: value };
    if (name === "object") next.position = "";
    if (name === "workType") { next.diameterMm = ""; next.thicknessCm = ""; next.quantity = ""; }
    return next;
  }));
  const setNumber = (index, name, value, integer) => setField(index, name, sanitizeNumber(value, integer));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (sending) return;
    setError("");
    if (rows.some((r) => Object.keys(rowErrors(r)).length)) {
      setShowErrors(true);
      setError("Проверьте поля, отмеченные красным.");
      return;
    }
    setSending(true);
    try {
      let req;
      if (editing) {
        await updateRequest(id, rows);
        req = await restartRequest(id);
      } else {
        req = await createRequest(rows);
      }
      navigate(`/drilling-requests/${req.id}`);
    } catch (err) {
      setError(err.message);
      setSending(false);
    }
  };

  if (loading) return <div className={css.page}><div className={css.content}>Загрузка…</div></div>;

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to={editing ? `/drilling-requests/${id}` : "/"} className={css.back}>← {editing ? "К заявке" : "На главную"}</Link>
        <h1 className={css.title}>{editing ? `Заявка № ${id}: правка` : "Заявка на бурение и резку"}</h1>
        <p className={css.legend}><span className={css.required} aria-hidden="true">*</span> — обязательное поле.</p>

        <form onSubmit={handleSubmit} noValidate>
          {rows.map((row, index) => {
            const errs = showErrors ? rowErrors(row) : {};
            const drill = row.workType === "drill";
            const cut = row.workType === "cut";
            const idOf = (n) => `d${index}-${n}`;
            const inputCls = (n) => `${css.input} ${errs[n] ? css.inputError : ""}`;
            return (
              <section key={index} className={css.card}>
                <div className={css.cardHeader}>
                  <h2 className={css.cardTitle}>{rows.length > 1 ? `Строка ${index + 1}` : "Работы"}</h2>
                  {rows.length > 1 && (
                    <button type="button" className={css.removeBtn} onClick={() => setRows((cur) => cur.filter((_, i) => i !== index))}>Удалить</button>
                  )}
                </div>

                <div className={css.group}>
                  <div className={styles.gridTwo}>
                    <SelectField label="Объект" name="object" id={idOf("object")} required options={OBJECTS} value={row.object}
                      onChange={(e) => setField(index, "object", e.target.value)} error={errs.object} />
                    <SelectField label="Позиция" name="position" id={idOf("position")} required options={objectPositionOptions[row.object] || []}
                      value={row.position} onChange={(e) => setField(index, "position", e.target.value)}
                      isDisabled={!row.object} disabledHint="Сначала выберите объект" error={errs.position} />
                  </div>
                </div>

                <div className={css.group}>
                  <div className={styles.gridWork}>
                    <SelectField label="Вид работ" name="workType" id={idOf("workType")} required options={WORKS.map((w) => w.label)}
                      value={WORKS.find((w) => w.value === row.workType)?.label || ""}
                      onChange={(e) => setField(index, "workType", WORKS.find((w) => w.label === e.target.value)?.value || "")} error={errs.workType} />
                    <SelectField label="Материал" name="material" id={idOf("material")} required options={MATERIALS} value={row.material}
                      onChange={(e) => setField(index, "material", e.target.value)} error={errs.material} />
                  </div>
                </div>

                {(drill || cut) && (
                  <div className={css.group}>
                    <div className={styles.gridWork}>
                      {drill && (
                        <Field label="Диаметр, мм" required htmlFor={idOf("diameterMm")} error={errs.diameterMm} errorId={`${idOf("diameterMm")}-err`}>
                          <input id={idOf("diameterMm")} className={inputCls("diameterMm")} inputMode="numeric" autoComplete="off"
                            value={row.diameterMm} onChange={(e) => setNumber(index, "diameterMm", e.target.value, true)} placeholder="Например, 100" />
                        </Field>
                      )}
                      {cut && (
                        <Field label="Толщина реза, см" required htmlFor={idOf("thicknessCm")} error={errs.thicknessCm} errorId={`${idOf("thicknessCm")}-err`}>
                          <input id={idOf("thicknessCm")} className={inputCls("thicknessCm")} inputMode="decimal" autoComplete="off"
                            value={row.thicknessCm} onChange={(e) => setNumber(index, "thicknessCm", e.target.value, false)} placeholder="Например, 20,5" />
                        </Field>
                      )}
                      <Field label={drill ? "Количество, шт" : "Длина реза, м.п."} required htmlFor={idOf("quantity")} error={errs.quantity} errorId={`${idOf("quantity")}-err`}>
                        <input id={idOf("quantity")} className={inputCls("quantity")} inputMode={drill ? "numeric" : "decimal"} autoComplete="off"
                          value={row.quantity} onChange={(e) => setNumber(index, "quantity", e.target.value, drill)}
                          placeholder={drill ? "Например, 12" : "Например, 11,5"} />
                      </Field>
                    </div>
                  </div>
                )}

                <div className={css.group}>
                  <Field label="Причина / комментарий" optional htmlFor={idOf("reason")}>
                    <textarea id={idOf("reason")} className={css.textarea} rows={3} maxLength={500} value={row.reason}
                      onChange={(e) => setField(index, "reason", e.target.value)} placeholder="Например: для ливневой канализации, отсутствует в проекте" />
                  </Field>
                </div>
              </section>
            );
          })}

          <button type="button" className={css.addBtn} onClick={() => setRows((cur) => [...cur, emptyRow()])}>+ Добавить строку</button>

          {error && <div className={styles.error} role="alert">{error}</div>}

          <div className={css.actions}>
            <button type="submit" className={css.btnPrimary} disabled={sending}>
              {sending ? "Отправка…" : editing ? "Сохранить и отправить заново" : "Отправить заявку"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default DrillingRequestPage;
