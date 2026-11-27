// Окно «Причина отказа» (внутри страницы): одна причина для одной или сразу нескольких заявок.
import React, { useState } from "react";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";

const RejectDialog = ({ onCancel, onSubmit, busy, count = 1, title = "Причина отказа", hint = "", submitLabel = "Отклонить" }) => {
  const [reason, setReason] = useState("");
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Отказ по заявке">
      <div className={styles.modal}>
        <h2 className={css.cardTitle}>{count > 1 ? `${title} (заявок: ${count})` : title}</h2>
        {hint && <p className={styles.hintLine}>{hint}</p>}
        <textarea className={css.textarea} rows={4} maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Например: вышло из строя оборудование" />
        <div className={styles.actionsBar}>
          <button className={styles.btnDanger} disabled={busy || !reason.trim()} onClick={() => onSubmit(reason.trim())}>
            {busy ? "Отправляю…" : submitLabel}
          </button>
          <button className={css.btnGhost} style={{ marginRight: 0 }} onClick={onCancel} disabled={busy}>Назад</button>
        </div>
      </div>
    </div>
  );
};

export default RejectDialog;
