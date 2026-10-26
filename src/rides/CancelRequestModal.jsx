// Модалка отмены заявки сотрудником — причина обязательна: либо выбор из
// готового списка, либо "Другая причина" со своим текстом. Бэкенд
// (server/rides/requestsRouter.js, POST /:id/cancel-mine) проверяет
// только "строка не пустая" — сам список вариантов существует только
// здесь, на фронте. onConfirm может бросить ошибку — она показывается
// здесь же, в окне (а не за ним, на странице).
import React, { useState } from "react";
import { useDialog } from "./dialog";

const PRESET_REASONS = [
  "Планы изменились — поездка больше не нужна",
  "Ошибка в заявке (адрес, время или число пассажиров)",
  "Долго нет водителя",
  "Добрался другим способом",
];
const OTHER = "__other__";

export default function CancelRequestModal({ onConfirm, onClose }) {
  const [selected, setSelected] = useState(PRESET_REASONS[0]);
  const [customReason, setCustomReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(onClose);

  const reason = selected === OTHER ? customReason.trim() : selected;
  const canConfirm = reason.length > 0;

  const confirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(reason);
    } catch (err) {
      setError(err?.message || "Не удалось отменить заявку — попробуйте ещё раз");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={s.overlay} onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-request-title"
        tabIndex={-1}
        style={s.modal}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="cancel-request-title" style={s.title}>Отменить заявку</h3>
        <fieldset style={s.fieldset}>
          <legend style={s.hint}>Укажите причину отмены:</legend>
          {PRESET_REASONS.map((r) => (
            <label key={r} style={s.radioRow}>
              <input type="radio" name="cancel-reason" style={s.radio} checked={selected === r} onChange={() => setSelected(r)} />
              {r}
            </label>
          ))}
          <label style={s.radioRow}>
            <input type="radio" name="cancel-reason" style={s.radio} checked={selected === OTHER} onChange={() => setSelected(OTHER)} />
            Другая причина
          </label>
        </fieldset>
        {selected === OTHER && (
          <input
            style={s.input}
            aria-label="Причина отмены"
            placeholder="Опишите причину"
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            autoFocus
          />
        )}
        {error && <p role="alert" style={s.error}>{error}</p>}
        <div style={s.actions}>
          <button type="button" style={s.secondaryButton} onClick={onClose}>Не отменять</button>
          <button type="button" style={s.dangerButton} disabled={!canConfirm || submitting} onClick={confirm}>
            {submitting ? "Отменяем…" : "Отменить заявку"}
          </button>
        </div>
      </div>
    </div>
  );
}

const button = { minHeight: "44px", borderRadius: "8px", padding: "0 16px", cursor: "pointer", fontSize: "15px" };
const s = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: "16px", boxSizing: "border-box" },
  modal: { background: "#fff", borderRadius: "12px", padding: "20px", width: "440px", maxWidth: "100%", maxHeight: "100%", overflowY: "auto", boxSizing: "border-box", outline: "none" },
  title: { margin: "0 0 8px", fontSize: "17px" },
  fieldset: { border: "none", margin: 0, padding: 0 },
  hint: { fontSize: "14px", color: "#444", padding: 0, marginBottom: "4px" },
  radioRow: { display: "flex", alignItems: "center", gap: "10px", fontSize: "15px", color: "#222", minHeight: "44px", cursor: "pointer" },
  radio: { width: "18px", height: "18px", flex: "none", margin: 0 },
  input: { width: "100%", minHeight: "44px", padding: "8px 12px", borderRadius: "8px", border: "1px solid #8c8c8c", fontSize: "16px", boxSizing: "border-box", marginTop: "6px" },
  error: { margin: "10px 0 0", fontSize: "14px", color: "#b00020" },
  actions: { display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "8px", marginTop: "16px" },
  secondaryButton: { ...button, background: "#fff", border: "1px solid #8c8c8c", color: "#222" },
  dangerButton: { ...button, background: "#b3261e", color: "#fff", border: "none", fontWeight: 600 },
};
