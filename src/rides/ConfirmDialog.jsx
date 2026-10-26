// Подтверждение действия внутри страницы — вместо window.confirm. Тот в
// Android-приложении (WebView без своего обработчика диалогов) молча
// возвращает false, а в Telegram Mini App ведёт себя по-разному в разных
// клиентах: кнопка просто «не работала».
import React, { useState } from "react";
import { useDialog } from "./dialog";

export default function ConfirmDialog({ title, text, confirmLabel, cancelLabel = "Нет", danger = false, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(onClose);

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (err) {
      setError(err?.message || "Не получилось — попробуйте ещё раз");
      setBusy(false);
    }
  };

  return (
    <div style={s.overlay} onClick={onClose}>
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={text ? "confirm-dialog-text" : undefined}
        tabIndex={-1}
        style={s.modal}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-dialog-title" style={s.title}>{title}</h3>
        {text && <p id="confirm-dialog-text" style={s.text}>{text}</p>}
        {error && <p role="alert" style={s.error}>{error}</p>}
        <div style={s.actions}>
          <button type="button" style={s.secondary} onClick={onClose} data-autofocus>{cancelLabel}</button>
          <button type="button" style={danger ? s.danger : s.primary} onClick={confirm} disabled={busy}>
            {busy ? "Секунду…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const button = { minHeight: "44px", borderRadius: "8px", padding: "0 16px", cursor: "pointer", fontSize: "15px" };
const s = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 210, padding: "16px", boxSizing: "border-box" },
  modal: { background: "#fff", borderRadius: "12px", padding: "20px", width: "380px", maxWidth: "100%", boxSizing: "border-box", outline: "none" },
  title: { margin: "0 0 8px", fontSize: "17px" },
  text: { margin: 0, fontSize: "15px", color: "#444", lineHeight: 1.45 },
  error: { margin: "10px 0 0", fontSize: "14px", color: "#b00020" },
  actions: { display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "8px", marginTop: "18px" },
  secondary: { ...button, background: "#fff", border: "1px solid #8c8c8c", color: "#222" },
  primary: { ...button, background: "#1565c0", border: "none", color: "#fff", fontWeight: 600 },
  danger: { ...button, background: "#b3261e", border: "none", color: "#fff", fontWeight: 600 },
};
