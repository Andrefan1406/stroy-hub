// Личный кабинет водителя — ключевая страница системы поездок: пул
// свободных заказов (кто первый нажал "Взять заказ", тот и получил —
// гонка решается на бэкенде транзакцией, см. server/rides/requestsRouter.js
// POST /:id/claim), свои текущие заказы и история завершённых поездок.
// Обновление пула в реальном времени — через Socket.io, без релоада.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ridesApiFetch, ridesApiPatch, ridesApiPost } from "../../rides/api";
import { createRidesSocket } from "../../rides/socket";
import LogoutButton from "../../rides/LogoutButton";
import AdminPanelLinks, { isSiteAdmin } from "../../rides/AdminPanelLinks";
import MapPicker from "../../rides/MapPicker";
import { formatRoute, formatEstimate, formatClock } from "../../rides/format";

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABEL = {
  assigned: "Назначен, ожидает выезда",
  in_progress: "В пути",
  completed: "Завершён",
};

export default function DriverDashboardPage() {
  const [driver, setDriver] = useState(null);
  const [pool, setPool] = useState([]);
  const [current, setCurrent] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [proposeFor, setProposeFor] = useState(null); // requestId, для которого открыт выбор точки на карте
  const [mergeBFor, setMergeBFor] = useState(null); // id заявки из пула, которую объединяем (когда текущих заказов несколько)
  const [busyIds, setBusyIds] = useState(new Set());

  const setRowBusy = (id, val) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (val) next.add(id); else next.delete(id);
      return next;
    });
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [driverRes, poolRes, currentRes] = await Promise.all([
        ridesApiFetch("/api/v1/drivers/me"),
        ridesApiFetch("/api/v1/requests/pool"),
        ridesApiFetch("/api/v1/requests/my-current"),
      ]);
      setDriver(driverRes.driver);
      setPool(poolRes.requests);
      setCurrent(currentRes.requests);
    } catch (err) {
      setError(err.message || "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Socket.io: новый заказ в пуле появляется у всех сразу, забранный —
  // сразу пропадает, а принудительное назначение диспетчером добавляет
  // заказ в "Мои текущие" даже без действия самого водителя.
  useEffect(() => {
    const socket = createRidesSocket();
    socket.on("request:new", (req) => {
      setPool((prev) => (prev.some((r) => r.id === req.id) ? prev : [...prev, req].sort((a, b) => a.id - b.id)));
    });
    socket.on("request:removed", ({ id }) => {
      setPool((prev) => prev.filter((r) => r.id !== id));
    });
    socket.on("request:assigned", (req) => {
      setCurrent((prev) => (prev.some((r) => r.id === req.id) ? prev : [...prev, req]));
      setPool((prev) => prev.filter((r) => r.id !== req.id));
    });
    // Маршрут текущего заказа изменился (диспетчер одобрил/добавил точку) —
    // подменяем карточку, чтобы водитель сразу видел новую точку.
    socket.on("request:updated", (req) => {
      setCurrent((prev) => prev.map((r) => (r.id === req.id ? req : r)));
    });
    // Диспетчер экстренно снял заказ с водителя (переброска машины).
    socket.on("request:pulled", ({ id, reason }) => {
      setCurrent((prev) => prev.filter((r) => r.id !== id));
      setNotice(`Диспетчер снял с вас заказ #${id}${reason ? `. Причина: ${reason}` : ""}.`);
      ridesApiFetch("/api/v1/drivers/me").then(({ driver: d }) => setDriver(d)).catch(() => {});
    });
    // Ход согласования объединения заявок (П.6).
    socket.on("merge:new", () => loadAll());
    socket.on("merge:updated", (m) => {
      if (m.status === "approved") setNotice(`Заявка #${m.requestBId} объединена с вашим заказом #${m.requestAId}.`);
      else if (m.status === "rejected" || m.status === "auto_rejected") {
        setNotice(`Объединение заявок #${m.requestAId} и #${m.requestBId} не согласовано${m.decisionReason ? `: ${m.decisionReason}` : ""}.`);
      }
      loadAll();
    });
    // Решение по предложенной этим водителем точке.
    socket.on("proposal:updated", (p) => {
      if (p.status === "approved") setNotice(`Диспетчер добавил точку «${p.address}» в маршрут заявки #${p.requestId}.`);
      else if (p.status === "rejected") setNotice(`Диспетчер отклонил точку «${p.address}»${p.decisionReason ? `: ${p.decisionReason}` : ""}.`);
      else if (p.status === "auto_rejected") setNotice(`Предложение точки «${p.address}» отклонено автоматически — диспетчер не успел рассмотреть.`);
      setCurrent((prev) => prev.map((r) => (
        r.id === p.requestId ? { ...r, stopProposals: (r.stopProposals || []).filter((sp) => sp.id !== p.id) } : r
      )));
    });
    socket.on("connect_error", () => {});
    return () => socket.disconnect();
  }, [loadAll]);

  const proposeMerge = async (bId, intoRequestId) => {
    setMergeBFor(null);
    setError("");
    try {
      await ridesApiPost(`/api/v1/requests/${bId}/merge`, { intoRequestId });
      setNotice(`Предложение объединить заявку #${bId} с вашим заказом отправлено на согласование.`);
      loadAll();
    } catch (err) {
      setError(err.message || "Не удалось предложить объединение");
    }
  };

  const claim = async (id) => {
    setRowBusy(id, true);
    setError("");
    try {
      const { request } = await ridesApiPost(`/api/v1/requests/${id}/claim`);
      setPool((prev) => prev.filter((r) => r.id !== id));
      setCurrent((prev) => [...prev, request]);
      setDriver((prev) => (prev ? { ...prev, status: "busy" } : prev));
    } catch (err) {
      setError(err.message || "Заказ уже взят другим водителем");
      setPool((prev) => prev.filter((r) => r.id !== id));
    } finally {
      setRowBusy(id, false);
    }
  };

  const setStatus = async (id, status) => {
    setRowBusy(id, true);
    setError("");
    try {
      const { request } = await ridesApiPost(`/api/v1/requests/${id}/status`, { status });
      if (status === "completed") {
        setCurrent((prev) => prev.filter((r) => r.id !== id));
        setDriver((prev) => (prev ? { ...prev, status: "available" } : prev));
      } else {
        setCurrent((prev) => prev.map((r) => (r.id === id ? request : r)));
      }
    } catch (err) {
      setError(err.message || "Не удалось сменить статус заказа");
    } finally {
      setRowBusy(id, false);
    }
  };

  const decline = async (id) => {
    const reason = window.prompt("Причина отказа:");
    if (reason === null) return;
    if (!reason.trim()) { setError("Укажите причину отказа"); return; }
    setRowBusy(id, true);
    setError("");
    try {
      await ridesApiPost(`/api/v1/requests/${id}/decline`, { reason });
      setCurrent((prev) => prev.filter((r) => r.id !== id));
      setDriver((prev) => (prev ? { ...prev, status: "available" } : prev));
    } catch (err) {
      setError(err.message || "Не удалось отказаться от заказа");
    } finally {
      setRowBusy(id, false);
    }
  };

  const proposeStop = async (requestId, address) => {
    setProposeFor(null);
    setError("");
    try {
      const { proposal } = await ridesApiPost(`/api/v1/requests/${requestId}/stop-changes`, { action: "add", address });
      setNotice(
        proposal.status === "approved"
          ? `Точка «${address}» добавлена в маршрут.`
          : `Точка «${address}» отправлена диспетчеру на согласование.`
      );
      loadAll();
    } catch (err) {
      setError(err.message || "Не удалось предложить точку");
    }
  };

  const toggleOnline = async () => {
    if (!driver) return;
    const nextStatus = driver.status === "offline" ? "available" : "offline";
    try {
      const { driver: updated } = await ridesApiPatch("/api/v1/drivers/me/status", { status: nextStatus });
      setDriver(updated);
    } catch (err) {
      setError(err.message || "Не удалось сменить статус");
    }
  };

  const loadHistory = async () => {
    setError("");
    try {
      const params = new URLSearchParams();
      if (historyFrom) params.set("from", historyFrom);
      if (historyTo) params.set("to", historyTo);
      const { requests } = await ridesApiFetch(`/api/v1/requests/my-history?${params.toString()}`);
      setHistory(requests);
    } catch (err) {
      setError(err.message || "Не удалось загрузить историю");
    }
  };

  const statusBadge = useMemo(() => {
    if (!driver) return null;
    const map = { available: ["На линии", "#1a7f37"], busy: ["На заказе", "#b8860b"], offline: ["Не на линии", "#888"] };
    const [label, color] = map[driver.status] || ["—", "#888"];
    return <span style={{ ...s.badge, color, borderColor: color }}>{label}</span>;
  }, [driver]);

  if (loading) return <div style={{ padding: 30 }}>Загрузка...</div>;

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Кабинет водителя</h1>
        <div style={s.headerRight}>
          {statusBadge}
          {driver && driver.status !== "busy" && (
            <button style={s.secondaryButton} onClick={toggleOnline}>
              {driver.status === "offline" ? "Выйти на линию" : "Уйти с линии"}
            </button>
          )}
          <AdminPanelLinks style={s.adminLink} />
          <LogoutButton />
        </div>
      </div>

      {!driver && isSiteAdmin() && (
        <div style={s.notice}>
          Вы смотрите панель водителя как администратор: пул заявок виден, но брать заказы может только водитель.
        </div>
      )}

      {error && <div style={s.error}>{error}</div>}
      {notice && <div style={s.notice} onClick={() => setNotice("")}>{notice}</div>}

      <section style={s.section}>
        <h2 style={s.sectionTitle}>Мои текущие заказы ({current.length})</h2>
        {current.length === 0 ? (
          <p style={s.muted}>Сейчас нет активных заказов.</p>
        ) : (
          <div style={s.cards}>
            {current.map((r) => (
              <div key={r.id} style={s.card}>
                <div style={s.cardRoute}>{formatRoute(r)}{r.withReturn && <span style={s.returnBadge}> (туда-обратно, ждать на месте)</span>}</div>
                <div style={s.cardMeta}>Подача: {formatDateTime(r.requestedAt)} · Пассажиров: {r.passengersCount}</div>
                {formatEstimate(r) && <div style={s.cardMeta}>{formatEstimate(r)}</div>}
                {r.purpose && <div style={s.cardMeta}>Цель: {r.purpose}</div>}
                {r.comment && <div style={s.cardMeta}>Комментарий: {r.comment}</div>}
                <div style={s.cardMeta}>
                  Заказчик: {r.employeeName} — <a href={`tel:${r.employeePhone}`} style={s.phoneLink}>{r.employeePhone}</a>
                </div>
                <div style={s.cardStatus}>{STATUS_LABEL[r.status] || r.status}</div>
                {r.mergedRequests?.length > 0 && (
                  <div style={s.mergeBox}>
                    {r.mergedRequests.map((mr) => (
                      <div key={mr.id}>
                        🔗 попутно заявка #{mr.id}: {mr.fromAddress} → {mr.toAddress}
                        {mr.pickupEtaAt && <> · посадка {formatClock(mr.pickupEtaAt)}</>}
                        {mr.employeePhone && <> · <a href={`tel:${mr.employeePhone}`} style={s.phoneLink}>{mr.employeePhone}</a></>}
                      </div>
                    ))}
                  </div>
                )}
                {r.pendingMerges?.length > 0 && (
                  <div style={s.pendingBox}>
                    {r.pendingMerges.map((pm) => (
                      <div key={pm.id}>
                        🕓 объединение с заявкой #{pm.requestBId === r.id ? pm.requestAId : pm.requestBId}: заказчик {pm.approvedByA ? "✓" : "…"}, диспетчер {pm.approvedByDispatcher ? "✓" : "…"}
                      </div>
                    ))}
                  </div>
                )}
                {r.stopProposals?.length > 0 && (
                  <div style={s.pendingBox}>
                    {r.stopProposals.map((sp) => (
                      <div key={sp.id}>🕓 точка «{sp.address}» ожидает решения диспетчера</div>
                    ))}
                  </div>
                )}
                <div style={s.cardActions}>
                  {r.status === "assigned" && (
                    <button style={s.primaryButton} disabled={busyIds.has(r.id)} onClick={() => setStatus(r.id, "in_progress")}>В пути</button>
                  )}
                  {r.status === "in_progress" && (
                    <button style={s.primaryButton} disabled={busyIds.has(r.id)} onClick={() => setStatus(r.id, "completed")}>Завершено</button>
                  )}
                  <button style={s.secondaryButton} disabled={busyIds.has(r.id)} onClick={() => setProposeFor(r.id)}>Предложить точку</button>
                  <button style={s.dangerButton} disabled={busyIds.has(r.id)} onClick={() => decline(r.id)}>Отказаться</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={s.section}>
        <h2 style={s.sectionTitle}>Пул свободных заказов ({pool.length})</h2>
        {pool.length === 0 ? (
          <p style={s.muted}>Сейчас в пуле нет заказов.</p>
        ) : (
          <div style={s.cards}>
            {pool.map((r) => (
              <div key={r.id} style={s.card}>
                <div style={s.cardRoute}>{formatRoute(r)}{r.withReturn && <span style={s.returnBadge}> (туда-обратно, ждать на месте)</span>}</div>
                <div style={s.cardMeta}>Подача: {formatDateTime(r.requestedAt)} · Пассажиров: {r.passengersCount}</div>
                {formatEstimate(r) && <div style={s.cardMeta}>{formatEstimate(r)}</div>}
                {r.purpose && <div style={s.cardMeta}>Цель: {r.purpose}</div>}
                {r.comment && <div style={s.cardMeta}>Комментарий: {r.comment}</div>}
                <div style={s.cardMeta}>
                  Заказчик: {r.employeeName} — <a href={`tel:${r.employeePhone}`} style={s.phoneLink}>{r.employeePhone}</a>
                </div>
                <div style={s.cardActions}>
                  <button style={s.primaryButton} disabled={busyIds.has(r.id) || driver?.status !== "available"} onClick={() => claim(r.id)}>
                    Взять заказ
                  </button>
                  {current.length > 0 && (
                    current.length === 1 ? (
                      <button style={s.secondaryButton} onClick={() => proposeMerge(r.id, current[0].id)}>Подвезти попутно</button>
                    ) : mergeBFor === r.id ? (
                      <select
                        style={s.mergeSelect}
                        defaultValue=""
                        onChange={(e) => e.target.value && proposeMerge(r.id, Number(e.target.value))}
                      >
                        <option value="">К какому заказу?</option>
                        {current.map((c) => <option key={c.id} value={c.id}>#{c.id} {formatRoute(c)}</option>)}
                      </select>
                    ) : (
                      <button style={s.secondaryButton} onClick={() => setMergeBFor(r.id)}>Подвезти попутно</button>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={s.section}>
        <h2 style={s.sectionTitle}>История поездок</h2>
        <div style={s.historyFilters}>
          <input type="date" value={historyFrom} onChange={(e) => setHistoryFrom(e.target.value)} style={s.dateInput} />
          <span>—</span>
          <input type="date" value={historyTo} onChange={(e) => setHistoryTo(e.target.value)} style={s.dateInput} />
          <button style={s.secondaryButton} onClick={loadHistory}>Показать</button>
        </div>
        {history.length > 0 && (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Дата</th>
                  <th style={s.th}>Маршрут</th>
                  <th style={s.th}>Заказчик</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td style={s.td}>{formatDateTime(r.createdAt)}</td>
                    <td style={s.td}>{formatRoute(r)}</td>
                    <td style={s.td}>{r.employeeName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {proposeFor && (
        <MapPicker
          onClose={() => setProposeFor(null)}
          onSelect={(address) => proposeStop(proposeFor, address)}
        />
      )}
    </div>
  );
}

const s = {
  page: { padding: "16px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "900px", margin: "0 auto", boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "10px" },
  headerRight: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px" },
  adminLink: { color: "#1976d2", fontSize: "13px", textDecoration: "none" },
  title: { margin: 0, fontSize: "clamp(18px, 5vw, 22px)" },
  badge: { padding: "4px 10px", borderRadius: "999px", border: "1px solid", fontSize: "13px", fontWeight: 600 },

  error: { background: "#fff0f0", color: "#c00", borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px" },
  notice: { background: "#eef6ff", color: "#0b5cad", border: "1px solid #b8d9f7", borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px", cursor: "pointer" },
  pendingBox: { marginTop: "8px", background: "#fffdf6", border: "1px solid #f0d9a8", borderRadius: "8px", padding: "8px 10px", fontSize: "12px", color: "#8a6d2f" },
  mergeBox: { marginTop: "8px", background: "#eef6ff", border: "1px solid #b8d9f7", borderRadius: "8px", padding: "8px 10px", fontSize: "12px", color: "#0b5cad" },
  mergeSelect: { padding: "8px 10px", borderRadius: "6px", border: "1px solid #ccc", fontSize: "13px" },
  muted: { color: "#888", fontSize: "14px" },

  section: { marginBottom: "28px" },
  sectionTitle: { fontSize: "16px", marginBottom: "12px" },

  cards: { display: "flex", flexDirection: "column", gap: "12px" },
  card: { background: "#fff", border: "1px solid #eee", borderRadius: "10px", padding: "14px 16px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", boxSizing: "border-box" },
  cardRoute: { fontWeight: 700, fontSize: "14px", marginBottom: "4px", wordBreak: "break-word" },
  cardMeta: { fontSize: "13px", color: "#555", marginBottom: "2px", wordBreak: "break-word" },
  cardStatus: { fontSize: "13px", fontWeight: 600, color: "#1976d2", marginTop: "6px" },
  cardActions: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" },
  returnBadge: { fontWeight: 400, fontSize: "13px", color: "#888" },
  phoneLink: { color: "#1976d2", fontWeight: 600, textDecoration: "none" },

  primaryButton: { background: "#1976d2", color: "#fff", border: "none", borderRadius: "6px", padding: "8px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
  secondaryButton: { background: "#fff", border: "1px solid #ccc", borderRadius: "6px", padding: "8px 14px", cursor: "pointer", fontSize: "13px" },
  dangerButton: { background: "#fff0f0", color: "#c00", border: "1px solid #f5b5b5", borderRadius: "6px", padding: "8px 14px", cursor: "pointer", fontSize: "13px" },

  historyFilters: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "12px" },
  dateInput: { padding: "6px 8px", borderRadius: "6px", border: "1px solid #ccc", minWidth: 0, flex: "1 1 130px" },

  tableWrap: { overflowX: "auto", WebkitOverflowScrolling: "touch" },
  table: { width: "100%", minWidth: "420px", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "8px", borderBottom: "2px solid #ddd", background: "#fafafa", fontSize: "13px", whiteSpace: "nowrap" },
  td: { padding: "8px", borderBottom: "1px solid #eee", fontSize: "13px" },
};
