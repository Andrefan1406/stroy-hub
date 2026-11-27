// Заявка на бурение и резку: статус согласования, строки, журнал всех кругов, действия по
// роли — согласовать/принять/отклонить (ответственный), править/перезапустить/отменить и
// отмечать выполнение (автор: по строке или сразу все), скачать чертежи, распечатать / сохранить в PDF.
import React, { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import DrillingNav from "./DrillingNav";
import { AttachmentAdder, AttachmentGallery } from "./Attachments";
import RejectDialog from "./RejectDialog";
import { useConfirm } from "../../components/ConfirmDialog";
import {
  acceptRequest, cancelRequest, downloadAttachments, fetchRequest, markItemsDone, rejectRequest, restartRequest,
  STATUS_LABELS, UNITS, WORK_LABELS, fmtDateTime, fmtNum, positionLabel, sanitizeNumber,
} from "./drillingApi";

const sizeOf = (i) => (i.workType === "drill" ? `Ø ${i.diameterMm} мм` : `толщина ${fmtNum(i.thicknessCm)} см`);

function eventText(e) {
  const who = e.companyName || "";
  switch (e.type) {
    case "created": return "Заявка создана";
    case "engineer_approved": return `Главный инженер согласовал (${e.actorName || e.actor})`;
    case "engineer_rejected": return <>Главный инженер отклонил — заявка возвращена автору. Причина: <span className={styles.reason}>{e.reason}</span></>;
    case "restarted": return "Заявка отправлена заново";
    case "edited": return "Заявка исправлена автором";
    case "attached": return `Прикреплён файл: ${e.reason}`;
    case "detached": return `Файл удалён: ${e.reason}`;
    case "rejected": return <>{who} отклонила. Причина: <span className={styles.reason}>{e.reason}</span></>;
    case "forwarded": return "Передана субподрядчикам";
    case "returned": return "Возвращена автору — отказали все исполнители";
    case "accepted": return `${who} приняла в работу (${e.actor})`;
    case "completed": return "Все строки отмечены — заявка выполнена";
    case "cancelled": return "Заявка отменена автором";
    default: return e.type;
  }
}

// Проверка факта на стороне страницы (те же правила, что на сервере): число, не больше заявленного.
function factError(item, fact) {
  const integer = item.workType === "drill";
  if (!(integer ? /^\d+$/ : /^\d+([.,]\d)?$/).test(fact)) return integer ? "Целое число" : "Число, до одного знака после запятой";
  if (Number(fact.replace(",", ".")) > item.quantity) return `Не больше ${fmtNum(item.quantity)}`;
  return "";
}

const DrillingRequestDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [req, setReq] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [facts, setFacts] = useState({}); // itemId -> { fact, comment } для ещё не отмеченных строк
  const [rowErrors, setRowErrors] = useState({}); // itemId -> текст ошибки
  const [confirm, confirmDialog] = useConfirm();
  const location = useLocation();
  const uploadErrors = location.state?.uploadErrors || []; // файлы, которые не ушли при подаче заявки

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

  // по умолчанию в поле факта — заявленное количество; введённое не затираем при обновлении
  useEffect(() => {
    if (!req) return;
    setFacts((cur) => {
      const next = {};
      for (const i of req.items) {
        if (i.doneAt) continue;
        next[i.id] = cur[i.id] || { fact: String(i.quantity).replace(".", ","), comment: "" };
      }
      return next;
    });
  }, [req]);

  const act = async (fn, ask) => {
    if (ask && !(await confirm(ask))) return;
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

  const setFact = (itemId, patch) => {
    setFacts((cur) => ({ ...cur, [itemId]: { ...cur[itemId], ...patch } }));
    setRowErrors((cur) => (cur[itemId] ? { ...cur, [itemId]: "" } : cur));
  };

  // Отметить выполнение: одну строку или все ещё не отмеченные разом (все проверяются до отправки).
  const complete = async (items) => {
    const errs = {};
    for (const i of items) {
      const e = factError(i, facts[i.id]?.fact ?? "");
      if (e) errs[i.id] = e;
    }
    setRowErrors(errs);
    if (Object.keys(errs).length) return;
    await act(() => markItemsDone(id, items.map((i) => ({ itemId: i.id, factQuantity: facts[i.id].fact, comment: facts[i.id].comment }))));
  };

  if (!req) {
    return (
      <div className={css.page}><div className={css.content}>
        <DrillingNav />
        {error ? <div className={styles.error}>{error}</div> : <div className={styles.empty}>Загрузка…</div>}
      </div></div>
    );
  }

  const p = req.permissions;
  const showFact = ["accepted", "completed"].includes(req.status);
  const rounds = [...new Set(req.events.map((e) => e.round))];
  const undone = req.items.filter((i) => !i.doneAt);

  return (
    <div className={css.page}>
      <div className={css.content}>
        <DrillingNav />
        <div className={styles.head}>
          <h1 className={css.title}>Заявка № {req.id}</h1>
          <span className={`${styles.badge} ${styles[`st_${req.status}`]}`}>{STATUS_LABELS[req.status]}</span>
        </div>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>
          Автор: {req.initiator.fullName}{req.initiator.position ? `, ${req.initiator.position}` : ""} · создана {fmtDateTime(req.createdAt)}
          {req.acceptedCompany && <> · исполнитель: <b>{req.acceptedCompany.name}</b></>}
        </div>

        {error && <div className={`${styles.error} no-print`} role="alert">{error}</div>}
        {req.status === "returned" && (
          <div className={`${styles.error} no-print`}>Заявку не приняли (причины — в журнале ниже). Можно исправить её и отправить заново (согласование начнётся с главного инженера) или отменить.</div>
        )}

        <div className={`${styles.actionsBar} no-print`}>
          {p.accept && (
            <button className={css.btnPrimary} disabled={busy}
              onClick={() => act(() => acceptRequest(id), {
                title: req.status === "engineer" ? "Согласовать заявку и передать исполнителям?" : "Принять заявку в работу?",
                confirmLabel: req.status === "engineer" ? "Согласовать" : "Принять",
              })}>
              {req.status === "engineer" ? "Согласовать" : "Принять в работу"}
            </button>
          )}
          {p.reject && <button className={styles.btnDanger} disabled={busy} onClick={() => setRejecting(true)}>Отклонить</button>}
          {p.edit && <button className={css.btnPrimary} disabled={busy} onClick={() => navigate(`/drilling-request/${id}/edit`)}>Исправить и отправить заново</button>}
          {p.restart && (
            <button className={css.btnGhost} style={{ marginRight: 0 }} disabled={busy}
              onClick={() => act(() => restartRequest(id), { title: "Отправить заявку заново без изменений?", confirmLabel: "Отправить" })}>
              Отправить заново как есть
            </button>
          )}
          {p.cancel && (
            <button className={styles.btnDanger} disabled={busy}
              onClick={() => act(() => cancelRequest(id), { title: "Отменить заявку?", text: "Отменённую заявку вернуть нельзя.", confirmLabel: "Отменить заявку", danger: true })}>
              Отменить заявку
            </button>
          )}
          {req.attachments?.length > 0 && (
            <button className={css.btnGhost} style={{ marginRight: 0 }} onClick={() => downloadAttachments(id, req.attachments).catch((e) => setError(e.message))}>
              Скачать чертежи ({req.attachments.length})
            </button>
          )}
          <button className={css.btnGhost} style={{ marginRight: 0 }} onClick={() => window.print()} title="Откроется печать: там же можно выбрать «Сохранить как PDF»">
            Печать / PDF
          </button>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>№</th><th>Объект, позиция</th><th>Вид работ</th><th>Размер</th><th>Материал</th><th>Кол-во</th><th>Причина</th>{showFact && <th>Выполнение</th>}</tr>
            </thead>
            <tbody>
              {req.items.map((i) => {
                const f = facts[i.id];
                const diff = f && f.fact !== "" && Number(f.fact.replace(",", ".")) !== i.quantity;
                return (
                  <tr key={i.id}>
                    <td>{i.lineNo}</td>
                    <td>{i.object}<br />{positionLabel(i.position)}</td>
                    <td>{WORK_LABELS[i.workType]}</td>
                    <td>{sizeOf(i)}</td>
                    <td>{i.material}</td>
                    <td>{fmtNum(i.quantity)} {UNITS[i.workType]}</td>
                    <td>{i.reason || "—"}</td>
                    {showFact && (
                      <td>
                        {i.doneAt ? (
                          <>
                            <span className={styles.done}>Выполнено: {fmtNum(i.factQuantity)} {UNITS[i.workType]}</span>
                            {i.factComment && <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>{i.factComment}</div>}
                          </>
                        ) : p.markDone && f ? (
                          <div className="no-print">
                            <input className={styles.factInput} inputMode={i.workType === "drill" ? "numeric" : "decimal"} value={f.fact}
                              aria-label={`Фактически, строка ${i.lineNo}`}
                              onChange={(e) => setFact(i.id, { fact: sanitizeNumber(e.target.value, i.workType === "drill") })} />{" "}
                            <button className={styles.smallBtn} disabled={busy} onClick={() => complete([i])}>Выполнено</button>
                            {diff && (
                              <input className={styles.factComment} value={f.comment} maxLength={300} placeholder="Комментарий: почему не заявленное количество"
                                aria-label={`Комментарий к строке ${i.lineNo}`} onChange={(e) => setFact(i.id, { comment: e.target.value })} />
                            )}
                            {rowErrors[i.id] && <div className={css.fieldError}>{rowErrors[i.id]}</div>}
                          </div>
                        ) : "—"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {p.markDone && undone.length > 0 && (
          <div className="no-print">
            <p className={styles.hint}>Отметьте выполнение по строке или сразу по всем. Если сделано меньше заявленного — измените количество (больше заявленного нельзя) и при желании поясните комментарием.</p>
            {undone.length > 1 && (
              <button className={styles.btnOk} disabled={busy} onClick={() => complete(undone)}>Выполнить все строки ({undone.length})</button>
            )}
          </div>
        )}

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Чертежи и фото{req.attachments.length ? ` (${req.attachments.length})` : ""}</h2>
          {uploadErrors.length > 0 && (
            <div className={`${styles.error} no-print`} role="alert">
              Заявка подана, но не загрузились файлы: {uploadErrors.map((f) => `${f.name} — ${f.error}`).join("; ")}. Добавьте их ниже.
            </div>
          )}
          {req.attachments.length === 0 && <div className={styles.empty}>Файлы не приложены.</div>}
          <AttachmentGallery requestId={id} attachments={req.attachments} canEdit={p.attach} onChanged={setReq} onError={setError} />
          {p.attach && (
            <div className="no-print" style={{ marginTop: 12 }}>
              <AttachmentAdder requestId={id} remaining={req.attachmentLimits.maxFiles - req.attachments.length} onDone={load} onError={setError} />
            </div>
          )}
        </div>

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
      {confirmDialog}
      {rejecting && <RejectDialog busy={busy} onCancel={() => setRejecting(false)} onSubmit={(reason) => act(() => rejectRequest(id, reason))} />}
    </div>
  );
};

export default DrillingRequestDetailPage;
