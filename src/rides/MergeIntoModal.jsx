// Окно «Добавить попутно» в панели диспетчера: заявку без водителя
// (с комментарием пассажира) можно сразу добавить к поездке любого
// водителя. Список — только поездки, к которым заявка подходит по времени
// (подача не раньше чем за 15 мин до подачи основной заявки и до того, как
// водитель её выполнит), ближайшие — сверху. По выбранной поездке сервер считает
// прогноз: насколько удлинится маршрут и когда посадка. «Объединить» —
// сразу и окончательно, без согласований (server/rides/mergeApply.js).
import React, { useEffect, useState } from "react";
import { ridesApiFetch, ridesApiPost } from "./api";
import { formatRoute, formatDelta, formatClock } from "./format";

const STATUS_LABEL = { assigned: "назначена", in_progress: "в пути" };

function formatPickup(value) {
  if (!value) return "—";
  const [date, time = ""] = value.replace(" ", "T").split("T");
  const [, m, d] = date.split("-");
  return `${d}.${m} ${time.slice(0, 5)}`;
}

export default function MergeIntoModal({ requestId, onClose, onMerged }) {
  const [request, setRequest] = useState(null);
  const [trips, setTrips] = useState(null);
  const [leadMinutes, setLeadMinutes] = useState(15);
  const [selectedId, setSelectedId] = useState(null);
  const [preview, setPreview] = useState(null); // { deltaMin, pickupEtaAt, durationMin } | "loading"
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ridesApiFetch(`/api/v1/requests/${requestId}/merge-options`)
      .then(({ request: r, trips: t, leadMinutes: lead }) => {
        setRequest(r);
        setTrips(t);
        if (lead) setLeadMinutes(lead);
      })
      .catch((err) => setError(err.message || "Не удалось загрузить поездки"));
  }, [requestId]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setPreview("loading");
    ridesApiFetch(`/api/v1/requests/${requestId}/merge-preview?into=${selectedId}`)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err) => { if (!cancelled) { setPreview(null); setError(err.message || "Не удалось посчитать прогноз"); } });
    return () => { cancelled = true; };
  }, [requestId, selectedId]);

  const merge = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await ridesApiPost(`/api/v1/requests/${requestId}/merge`, { intoRequestId: selectedId });
      onMerged(result);
    } catch (err) {
      setError(err.message || "Не удалось объединить заявки");
      setBusy(false);
    }
  };

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={s.title}>Добавить попутно заявку #{requestId}</h3>

        {request && (
          <div style={s.requestBox}>
            <div style={s.route}>{formatRoute(request)}</div>
            <div style={s.meta}>
              Подача: {formatPickup(request.requestedAt)} · Пассажиров: {request.passengersCount} · {request.employeeName}
            </div>
            {request.purpose && <div style={s.meta}>Цель: {request.purpose}</div>}
            {request.comment ? (
              <div style={s.comment}>💬 Комментарий пассажира: {request.comment}</div>
            ) : (
              <div style={s.metaMuted}>Комментария пассажира нет</div>
            )}
          </div>
        )}

        {error && <div style={s.error}>{error}</div>}

        {trips === null && !error && <p style={s.metaMuted}>Загрузка поездок…</p>}
        {trips && trips.length === 0 && (
          <div style={s.empty}>
            <b>Не к чему добавить эту заявку попутно.</b>
            <div style={{ marginTop: 4 }}>
              Попутно можно добавить только к заявке, на которую уже назначен водитель, и только если время подачи
              примерно совпадает: не раньше чем за {leadMinutes} минут до подачи основной заявки и пока водитель её ещё
              не выполнил.
            </div>
            <div style={{ marginTop: 4 }}>Назначьте водителя на эту заявку отдельно.</div>
          </div>
        )}
        {trips && trips.length > 0 && (
          <div style={s.list}>
            {trips.map((t) => (
              <label key={t.id} style={{ ...s.trip, ...(selectedId === t.id ? s.tripSelected : null) }}>
                <input
                  type="radio"
                  name="mergeTrip"
                  checked={selectedId === t.id}
                  onChange={() => { setError(""); setSelectedId(t.id); }}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={s.tripTitle}>
                    #{t.id} · {formatPickup(t.requestedAt)} · {t.driverName || "водитель"}
                    {t.vehiclePlate ? ` (${t.vehiclePlate})` : ""} · {STATUS_LABEL[t.status] || t.status}
                  </span>
                  <span style={s.meta}>{formatRoute(t)}</span>
                  <span style={s.meta}>
                    Пассажиров: {t.passengersCount}
                    {t.mergedRequests?.length > 0 && ` · уже попутно #${t.mergedRequests.map((m) => m.id).join(", #")}`}
                  </span>
                  {t.comment && <span style={s.meta}>💬 {t.comment}</span>}
                </span>
              </label>
            ))}
          </div>
        )}

        {selectedId && (
          <div style={s.preview}>
            {preview === "loading" ? (
              "Считаем прогноз…"
            ) : preview && preview.deltaMin != null ? (
              <>
                Поездка удлинится: <b>{formatDelta(preview.deltaMin)}</b>
                {preview.pickupEtaAt && <> · посадка попутного пассажира <b>{formatClock(preview.pickupEtaAt)}</b></>}
              </>
            ) : (
              "Прогноз недоступен — адрес не найден на карте. Объединить всё равно можно."
            )}
          </div>
        )}

        <div style={s.actions}>
          <button style={s.secondaryButton} onClick={onClose}>Отмена</button>
          <button style={s.primaryButton} disabled={!selectedId || busy} onClick={merge}>
            {busy ? "Объединяем…" : "Объединить"}
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: "16px" },
  modal: { background: "#fff", borderRadius: "10px", padding: "20px", width: "560px", maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box" },
  title: { marginTop: 0, marginBottom: "12px", fontSize: "17px" },
  requestBox: { background: "#f4f9ff", border: "1px solid #cfe3f7", borderRadius: "8px", padding: "10px 12px", marginBottom: "12px" },
  route: { fontWeight: 600, fontSize: "14px", marginBottom: "4px" },
  meta: { display: "block", fontSize: "12px", color: "#555", marginTop: "2px" },
  metaMuted: { fontSize: "12px", color: "#888", marginTop: "4px" },
  comment: { fontSize: "13px", color: "#7a4b00", background: "#fff6e0", borderRadius: "6px", padding: "6px 8px", marginTop: "6px" },
  list: { display: "flex", flexDirection: "column", gap: "8px", marginBottom: "12px" },
  trip: { display: "flex", gap: "10px", alignItems: "flex-start", border: "1px solid #dde3ea", borderRadius: "8px", padding: "8px 10px", cursor: "pointer" },
  tripSelected: { borderColor: "#1976d2", background: "#f0f6fd" },
  tripTitle: { display: "block", fontSize: "13px", fontWeight: 600 },
  empty: { background: "#fff6e0", color: "#5f4100", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", marginBottom: "12px", lineHeight: 1.4 },
  preview: { background: "#e9f6ec", color: "#1e5c2a", borderRadius: "8px", padding: "8px 10px", fontSize: "13px", marginBottom: "12px" },
  error: { background: "#fff0f0", color: "#c00", borderRadius: "8px", padding: "8px 10px", fontSize: "13px", marginBottom: "12px" },
  actions: { display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" },
  primaryButton: { background: "#1976d2", color: "#fff", border: "none", borderRadius: "6px", padding: "8px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
  secondaryButton: { background: "#fff", border: "1px solid #ccc", borderRadius: "6px", padding: "8px 14px", cursor: "pointer", fontSize: "13px" },
};
