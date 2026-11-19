// Заявка на бурение и резку: статус согласования, строки, журнал всех кругов,
// действия по роли — принять/отклонить (ответственный), править/перезапустить/
// отменить и отмечать выполнение по строкам (инициатор), скачать Word.
import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import {
  acceptRequest, cancelRequest, downloadDocx, fetchRequest, markItemDone, rejectRequest, restartRequest,
  STATUS_LABELS, UNITS, WORK_LABELS, fmtDateTime, fmtNum, sanitizeNumber,
} from "./drillingApi";

const sizeOf = (i) => (i.workType === "drill" ? `Ø ${i.diameterMm} мм` : `толщина ${fmtNum(i.thicknessCm)} см`);

function eventText(e) {
  const who = e.companyName || "";
  switch (e.type) {
    case "created": return "Заявка создана";
    case "restarted": return "Заявка отправлена заново";
    case "edited": return "Заявка исправлена автором";
    case "rejected": return <>{who} отклонила. Причина: <span className={styles.reason}>{e.reason}</span></>;
    case "forwarded": return "Передана субподрядчикам";
    case "returned": return "Возвращена автору — отказали все исполнители";
    case "accepted": return `${who} приняла в работу (${e.actor})`;
    case "completed": return "Все строки отмечены — заявка выполнена";
    case "cancelled": return "Заявка отменена автором";
    default: return e.type;
  }
}

const RejectDialog = ({ onCancel, onSubmit, busy }) => {
  const [reason, setReason] = useState("");
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Отказ по заявке">
      <div className={styles.modal}>
        <h2 className={css.cardTitle}>Причина отказа</h2>
        <textarea className={css.textarea} rows={4} maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Например: вышло из строя оборудование" />
        <div className={styles.actionsBar}>
          <button className={styles.btnDanger} disabled={busy || !reason.trim()} onClick={() => onSubmit(reason.trim())}>Отклонить</button>
          <button className={css.btnGhost} style={{ marginRight: 0 }} onClick={onCancel}>Назад</button>
        </div>
      </div>
    </div>
  );
};

// Строка таблицы с полем «факт» — только когда заявка принята и строка ещё не отмечена.
const ItemRow = ({ item, canMark, onMark }) => {
  const [fact, setFact] = useState(String(item.quantity).replace(".", ","));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const integer = item.workType === "drill";

  const submit = async () => {
    const n = Number(fact.replace(",", "."));
    if (fact === "" || Number.isNaN(n)) return setErr("Введите число");
    if (n > item.quantity) return setErr(`Не больше ${fmtNum(item.quantity)}`);
    setBusy(true);
    setErr("");
    try {
      await onMark(item.id, fact);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td>{item.lineNo}</td>
      <td>{item.object}<br />поз. {item.position}</td>
      <td>{WORK_LABELS[item.workType]}</td>
      <td>{sizeOf(item)}</td>
      <td>{item.material}</td>
      <td>{fmtNum(item.quantity)} {UNITS[item.workType]}</td>
      <td>{item.reason || "—"}</td>
      <td>
        {item.doneAt ? (
          <span className={styles.done}>Выполнено: {fmtNum(item.factQuantity)} {UNITS[item.workType]}</span>
        ) : canMark ? (
          <>
            <input className={styles.factInput} inputMode={integer ? "numeric" : "decimal"} value={fact} aria-label={`Фактически, строка ${item.lineNo}`}
              onChange={(e) => setFact(sanitizeNumber(e.target.value, integer))} />{" "}
            <button className={styles.smallBtn} disabled={busy} onClick={submit}>Выполнено</button>
            {err && <div className={css.fieldError}>{err}</div>}
          </>
        ) : "—"}
      </td>
    </tr>
  );
};

const DrillingRequestDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [req, setReq] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const load = useCallback(async () => {
    try {
      setReq(await fetchRequest(id));
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const next = await fn();
      if (next) setReq(next);
      setRejecting(false);
    } catch (err) {
      setError(err.message);
      load(); // состояние могло измениться (например, другой исполнитель уже ответил)
    } finally {
      setBusy(false);
    }
  };

  if (!req) {
    return (
      <div className={css.page}><div className={css.content}>
        <Link to="/drilling-requests" className={css.back}>← К списку</Link>
        {error ? <div className={styles.error}>{error}</div> : <div className={styles.empty}>Загрузка…</div>}
      </div></div>
    );
  }

  const p = req.permissions;
  const showFact = ["accepted", "completed"].includes(req.status);
  const rounds = [...new Set(req.events.map((e) => e.round))];

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to="/drilling-requests" className={css.back}>← К списку заявок</Link>
        <div className={styles.head}>
          <h1 className={css.title}>Заявка № {req.id}</h1>
          <span className={`${styles.badge} ${styles[`st_${req.status}`]}`}>{STATUS_LABELS[req.status]}</span>
        </div>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>
          Автор: {req.initiator.fullName}{req.initiator.position ? `, ${req.initiator.position}` : ""} · создана {fmtDateTime(req.createdAt)}
          {req.acceptedCompany && <> · исполнитель: <b>{req.acceptedCompany.name}</b></>}
        </div>

        {error && <div className={styles.error} role="alert">{error}</div>}
        {req.status === "returned" && (
          <div className={styles.error}>Все исполнители отказали (причины — в журнале ниже). Можно исправить заявку и отправить заново или отменить её.</div>
        )}

        <div className={styles.actionsBar}>
          {p.accept && <button className={css.btnPrimary} disabled={busy} onClick={() => act(() => acceptRequest(id), "Принять заявку в работу?")}>Принять в работу</button>}
          {p.reject && <button className={styles.btnDanger} disabled={busy} onClick={() => setRejecting(true)}>Отклонить</button>}
          {p.edit && <button className={css.btnPrimary} disabled={busy} onClick={() => navigate(`/drilling-request/${id}/edit`)}>Исправить и отправить заново</button>}
          {p.restart && <button className={css.btnGhost} style={{ marginRight: 0 }} disabled={busy} onClick={() => act(() => restartRequest(id), "Отправить заявку заново без изменений?")}>Отправить заново как есть</button>}
          {p.cancel && <button className={styles.btnDanger} disabled={busy} onClick={() => act(() => cancelRequest(id), "Отменить заявку?")}>Отменить заявку</button>}
          {p.download && <button className={css.btnGhost} style={{ marginRight: 0 }} onClick={() => downloadDocx(id).catch((e) => setError(e.message))}>Скачать Word</button>}
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>№</th><th>Объект, позиция</th><th>Вид работ</th><th>Размер</th><th>Материал</th><th>Кол-во</th><th>Причина</th>{showFact && <th>Выполнение</th>}</tr>
            </thead>
            <tbody>
              {req.items.map((i) => showFact
                ? <ItemRow key={i.id} item={i} canMark={p.markDone} onMark={(itemId, fact) => markItemDone(id, itemId, fact).then(setReq)} />
                : (
                  <tr key={i.id}>
                    <td>{i.lineNo}</td><td>{i.object}<br />поз. {i.position}</td><td>{WORK_LABELS[i.workType]}</td>
                    <td>{sizeOf(i)}</td><td>{i.material}</td><td>{fmtNum(i.quantity)} {UNITS[i.workType]}</td><td>{i.reason || "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {p.markDone && <p className={styles.hint}>Отметьте выполнение по каждой строке. Если сделано меньше заявленного — укажите фактическое количество (больше заявленного нельзя).</p>}

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Журнал согласования</h2>
          {rounds.map((r) => (
            <React.Fragment key={r}>
              {rounds.length > 1 && <div className={styles.round}>Круг {r}{r === req.round ? " (текущий)" : ""}</div>}
              <ul className={styles.timeline}>
                {req.events.filter((e) => e.round === r).map((e) => (
                  <li key={e.id}><span className={styles.time}>{fmtDateTime(e.at)}</span>{eventText(e)}</li>
                ))}
              </ul>
            </React.Fragment>
          ))}
        </div>
      </div>
      {rejecting && <RejectDialog busy={busy} onCancel={() => setRejecting(false)} onSubmit={(reason) => act(() => rejectRequest(id, reason))} />}
    </div>
  );
};

export default DrillingRequestDetailPage;
