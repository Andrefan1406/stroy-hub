// Подтверждение действия окном внутри страницы вместо системного window.confirm: системное
// окно блокирует вкладку (страница перестаёт отвечать), а это окно — обычный элемент страницы.
// Использование:
//   const [confirm, confirmDialog] = useConfirm();
//   if (!(await confirm({ title: "Выйти?", text: "…", confirmLabel: "Выйти" }))) return;
//   …в разметке: {confirmDialog}
import React, { useCallback, useEffect, useRef, useState } from "react";

const styles = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", zIndex: 300 },
  box: { background: "#fff", color: "#1f2937", borderRadius: "14px", padding: "20px", width: "100%", maxWidth: "420px", boxShadow: "0 12px 40px rgba(0,0,0,0.3)", fontFamily: "inherit" },
  title: { margin: "0 0 8px", fontSize: "18px", fontWeight: 600 },
  text: { margin: "0 0 18px", fontSize: "15px", lineHeight: 1.45, color: "#4b5563", whiteSpace: "pre-wrap" },
  actions: { display: "flex", gap: "10px", justifyContent: "flex-end", flexWrap: "wrap" },
  cancel: { minHeight: "44px", padding: "0 18px", borderRadius: "10px", border: "1px solid #939ba7", background: "#fff", color: "#1f2937", font: "inherit", fontWeight: 600, cursor: "pointer" },
  ok: { minHeight: "44px", padding: "0 18px", borderRadius: "10px", border: "1px solid #485875", background: "#485875", color: "#fff", font: "inherit", fontWeight: 600, cursor: "pointer" },
  danger: { background: "#a61b1b", borderColor: "#a61b1b" },
};

export function ConfirmDialog({ title, text, confirmLabel = "Подтвердить", cancelLabel = "Отмена", danger = false, onConfirm, onCancel }) {
  const okRef = useRef(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div style={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={styles.box} role="alertdialog" aria-modal="true" aria-label={title}>
        <h2 style={styles.title}>{title}</h2>
        {text && <p style={styles.text}>{text}</p>}
        <div style={styles.actions}>
          <button type="button" style={styles.cancel} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" ref={okRef} style={{ ...styles.ok, ...(danger ? styles.danger : null) }} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// Хук: confirm(opts) возвращает Promise<boolean>; confirmDialog — элемент, который нужно вывести в разметке.
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = (value) => {
    state?.resolve(value);
    setState(null);
  };
  const confirmDialog = state ? (
    <ConfirmDialog
      title={state.title || "Подтвердите действие"}
      text={state.text}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      danger={state.danger}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;
  return [confirm, confirmDialog];
}

export default ConfirmDialog;
