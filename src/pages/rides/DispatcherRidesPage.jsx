// Панель диспетчера — минимальное участие: диспетчер наблюдает за пулом
// (заявки водители разбирают сами), подсвечивает заявки без водителя, у
// которых подходит время подачи, может назначить
// водителя вручную или отменить заявку. Плюс (доработка П.1/П.5) —
// модерация предложений по маршруту: водитель/заказчик предлагают точку,
// диспетчер одобряет или отклоняет; сам диспетчер добавляет/убирает точки
// без согласования. Две вкладки: «Текущие» — только активные заявки,
// ближайшие по времени подачи сверху; «Журнал» — завершённые/отменённые
// за период (грузится с сервера по запросу, см. HistoryJournal).
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ridesApiFetch, ridesApiPost } from "../../rides/api";
import { createRidesSocket } from "../../rides/socket";
import LogoutButton from "../../rides/LogoutButton";
import AdminPanelLinks, { isSiteAdmin } from "../../rides/AdminPanelLinks";
import TelegramConnect from "../../rides/TelegramConnect";
import { isTelegramMiniApp, ridesPath } from "../../rides/telegramSession";
import MapPicker from "../../rides/MapPicker";
import { formatRoute, formatEstimate, formatDelta, formatClock, minutesSince } from "../../rides/format";

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABEL = {
  pending_assignment: "В пуле",
  assigned: "Назначен",
  in_progress: "В пути",
  completed: "Завершён",
  cancelled: "Отменён",
};

const ROLE_LABEL = { employee: "заказчик", driver: "водитель", dispatcher: "диспетчер" };

const ACTIVE_STATUSES = ["pending_assignment", "assigned", "in_progress"];

// requestedAt — местное время подачи "YYYY-MM-DDTHH:MM" без зоны.
function requestedAtMs(value) {
  return value ? new Date(value.replace(" ", "T")).getTime() : NaN;
}

function localDateStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Без водителя, а до подачи меньше порога (или время уже прошло). Считается
// на клиенте и пересчитывается по таймеру: время идёт, а событий по заявке
// может и не быть — серверный isStale устарел бы.
function staleInfo(r, thresholdMin, now) {
  if (r.status !== "pending_assignment" || r.onHold || r.mergedInto) return null;
  const minutesLeft = (requestedAtMs(r.requestedAt) - now) / 60000;
  if (!(minutesLeft <= thresholdMin)) return null;
  return minutesLeft < 0 ? "время подачи прошло" : `до подачи < ${thresholdMin} мин`;
}

export default function DispatcherRidesPage() {
  const [requests, setRequests] = useState([]);
  const [summary, setSummary] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [merges, setMerges] = useState([]);
  const [fleet, setFleet] = useState(null);
  const [availableDrivers, setAvailableDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [assignTarget, setAssignTarget] = useState(null);
  const [selectedDriverId, setSelectedDriverId] = useState("");
  const [stopsPanelFor, setStopsPanelFor] = useState(null); // requestId с раскрытым управлением точками
  const [mapForRequest, setMapForRequest] = useState(null); // requestId, для которого открыт выбор точки на карте
  const [pullTarget, setPullTarget] = useState(null); // requestId, с которого снимаем машину
  const [pullForm, setPullForm] = useState({ reason: "", targetRequestId: "" });
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("current"); // "current" | "journal"
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [{ requests: rows, summary: sum }, { proposals: props }, { merges: mrg }, fleetRes] = await Promise.all([
        ridesApiFetch("/api/v1/requests"),
        ridesApiFetch("/api/v1/requests/stop-changes/pending"),
        ridesApiFetch("/api/v1/requests/merges/pending"),
        ridesApiFetch("/api/v1/fleet-status"),
      ]);
      setRequests(rows);
      setSummary(sum);
      setProposals(props);
      setMerges(mrg);
      setFleet(fleetRes);
    } catch (err) {
      setError(err.message || "Не удалось загрузить заявки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const socket = createRidesSocket();
    const refreshFleet = () => ridesApiFetch("/api/v1/fleet-status").then(setFleet).catch(() => {});
    // Итоги дня (завершено/отменено) считает сервер — перезапрашиваем
    // сводку, когда заявка уходит из текущих.
    const refreshSummary = () => ridesApiFetch("/api/v1/requests").then(({ summary: sum }) => setSummary(sum)).catch(() => {});
    const upsert = (req) => {
      const active = ACTIVE_STATUSES.includes(req.status);
      setRequests((prev) => {
        const rest = prev.filter((r) => r.id !== req.id);
        return active ? [...rest, req] : rest;
      });
      if (!active) refreshSummary();
      refreshFleet();
    };
    socket.on("request:new", upsert);
    socket.on("request:updated", upsert);
    socket.on("proposal:new", (p) => setProposals((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p])));
    socket.on("proposal:updated", (p) => setProposals((prev) => prev.filter((x) => x.id !== p.id)));
    socket.on("merge:new", (m) => setMerges((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m])));
    socket.on("merge:updated", (m) => setMerges((prev) => (
      m.status === "pending" ? prev.map((x) => (x.id === m.id ? m : x)) : prev.filter((x) => x.id !== m.id)
    )));
    socket.on("connect_error", () => {});
    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    setSummary((prev) => ({
      ...prev,
      pending: requests.filter((r) => r.status === "pending_assignment").length,
      assigned: requests.filter((r) => r.status === "assigned").length,
      inProgress: requests.filter((r) => r.status === "in_progress").length,
    }));
  }, [requests]);

  const openAssign = async (requestId) => {
    setError("");
    setAssignTarget(requestId);
    setSelectedDriverId("");
    try {
      // Только водители без заказа, пересекающегося по времени с этой заявкой.
      const { drivers } = await ridesApiFetch(`/api/v1/drivers/available?requestId=${requestId}`);
      setAvailableDrivers(drivers);
    } catch (err) {
      setError(err.message || "Не удалось загрузить список свободных водителей");
    }
  };

  const confirmAssign = async () => {
    if (!selectedDriverId) return;
    try {
      const { request } = await ridesApiPost(`/api/v1/requests/${assignTarget}/assign`, { driverId: Number(selectedDriverId) });
      setRequests((prev) => prev.map((r) => (r.id === request.id ? request : r)));
      setAssignTarget(null);
    } catch (err) {
      setError(err.message || "Не удалось назначить водителя");
    }
  };

  // Отмена заявки целиком. «Отмена» в окне ввода причины — передумали,
  // заявку не трогаем (раньше null превращался в пустую причину и заявка
  // отменялась).
  const cancelRequest = async (id) => {
    const reason = window.prompt(`Отменить заявку #${id} целиком? Причина (необязательно):`);
    if (reason === null) return;
    try {
      await ridesApiPost(`/api/v1/requests/${id}/cancel`, { reason });
      setRequests((prev) => prev.filter((r) => r.id !== id)); // ушла в журнал
    } catch (err) {
      setError(err.message || "Не удалось отменить заявку");
    }
  };

  // Снять водителя, не отменяя заявку: она возвращается в пул («В пуле»).
  const unassignDriver = async (r) => {
    const reason = window.prompt(
      `Снять водителя ${r.driverName || ""} с заявки #${r.id}? Заявка вернётся в пул. Причина (необязательно, её увидит водитель):`
    );
    if (reason === null) return;
    try {
      const { request } = await ridesApiPost(`/api/v1/requests/${r.id}/unassign`, { reason });
      setRequests((prev) => prev.map((x) => (x.id === request.id ? request : x)));
    } catch (err) {
      setError(err.message || "Не удалось снять водителя");
    }
  };

  const decideProposal = async (id, decision) => {
    setBusy(true);
    setError("");
    try {
      if (decision === "approve") {
        await ridesApiPost(`/api/v1/requests/stop-changes/${id}/approve`);
      } else {
        const reason = window.prompt("Причина отклонения:");
        if (reason === null) { setBusy(false); return; }
        if (!reason.trim()) { setError("Укажите причину отклонения"); setBusy(false); return; }
        await ridesApiPost(`/api/v1/requests/stop-changes/${id}/reject`, { reason });
      }
      setProposals((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err.message || "Не удалось обработать предложение");
    } finally {
      setBusy(false);
    }
  };

  const addStop = async (requestId, address) => {
    setBusy(true);
    setError("");
    try {
      await ridesApiPost(`/api/v1/requests/${requestId}/stop-changes`, { action: "add", address });
      setMapForRequest(null);
    } catch (err) {
      setError(err.message || "Не удалось добавить точку");
    } finally {
      setBusy(false);
    }
  };

  const decideMerge = async (id, decision) => {
    setBusy(true);
    setError("");
    try {
      if (decision === "approve") {
        await ridesApiPost(`/api/v1/requests/merges/${id}/approve`);
      } else {
        const reason = window.prompt("Причина отказа в объединении:");
        if (reason === null) { setBusy(false); return; }
        if (!reason.trim()) { setError("Укажите причину"); setBusy(false); return; }
        await ridesApiPost(`/api/v1/requests/merges/${id}/reject`, { reason });
      }
      setMerges((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setError(err.message || "Не удалось обработать объединение");
    } finally {
      setBusy(false);
    }
  };

  const openPull = (requestId) => {
    setError("");
    setPullForm({ reason: "", targetRequestId: "" });
    setPullTarget(requestId);
  };

  const confirmPull = async () => {
    if (!pullForm.reason.trim()) { setError("Укажите причину переброски"); return; }
    setBusy(true);
    setError("");
    try {
      const body = { reason: pullForm.reason.trim() };
      if (pullForm.targetRequestId) body.targetRequestId = Number(pullForm.targetRequestId);
      await ridesApiPost(`/api/v1/requests/${pullTarget}/pull`, body);
      setPullTarget(null);
    } catch (err) {
      setError(err.message || "Не удалось перебросить машину");
    } finally {
      setBusy(false);
    }
  };

  const removeStop = async (requestId, stopId) => {
    if (!window.confirm("Убрать эту точку из маршрута?")) return;
    setBusy(true);
    setError("");
    try {
      await ridesApiPost(`/api/v1/requests/${requestId}/stop-changes`, { action: "remove", targetStopId: stopId });
    } catch (err) {
      setError(err.message || "Не удалось убрать точку");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ padding: 30 }}>Загрузка...</div>;

  const canEditRoute = (r) => ["pending_assignment", "assigned", "in_progress"].includes(r.status);
  const staleThresholdMin = summary?.staleThresholdMinutes ?? 15;
  // Ближайшие по времени подачи — сверху (сокет добавляет обновлённые
  // заявки в конец списка, поэтому порядок задаётся здесь).
  const sortedRequests = [...requests].sort(
    (a, b) => (a.requestedAt || "").localeCompare(b.requestedAt || "") || a.id - b.id
  );
  // В Telegram Mini App — только «Текущие»: журнал и справочники — на сайте.
  const inTelegram = isTelegramMiniApp();

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Мониторинг заявок</h1>
        <div style={s.headerRight}>
          {isSiteAdmin() ? (
            <AdminPanelLinks style={s.link} />
          ) : (
            <>
              {!inTelegram && <Link to="/rides-admin" style={s.link}>Водители и машины</Link>}
              <Link to={ridesPath("/employee")} style={s.link}>Заказать машину себе</Link>
            </>
          )}
          <LogoutButton />
        </div>
      </div>
      {error && <div style={s.error}>{error}</div>}
      <TelegramConnect hint="Получайте в Telegram новые заявки, отказы водителей и заявки, которые никто не взял." />

      {!inTelegram && <div style={s.tabs}>
        <button style={tab === "current" ? s.tabActive : s.tab} onClick={() => setTab("current")}>
          Текущие{requests.length ? ` (${requests.length})` : ""}
        </button>
        <button style={tab === "journal" ? s.tabActive : s.tab} onClick={() => setTab("journal")}>Журнал</button>
      </div>}

      {tab === "journal" && <HistoryJournal />}

      {tab === "current" && (<>
      <div style={s.cards}>
        <div style={s.card}><div style={s.cardLabel}>В пуле без водителя</div><div style={s.cardValue}>{summary?.pending ?? 0}</div></div>
        <div style={s.card}><div style={s.cardLabel}>Назначено</div><div style={s.cardValue}>{summary?.assigned ?? 0}</div></div>
        <div style={s.card}><div style={s.cardLabel}>В пути</div><div style={s.cardValue}>{summary?.inProgress ?? 0}</div></div>
        <div style={{ ...s.card, ...(proposals.length ? s.cardAlert : null) }}>
          <div style={s.cardLabel}>Предложений по маршруту</div><div style={s.cardValue}>{proposals.length}</div>
        </div>
        {summary?.onHold > 0 && (
          <div style={{ ...s.card, ...s.cardAlert }}>
            <div style={s.cardLabel}>Сняты с машины</div><div style={s.cardValue}>{summary.onHold}</div>
          </div>
        )}
        {merges.length > 0 && (
          <div style={{ ...s.card, ...s.cardAlert }}>
            <div style={s.cardLabel}>Объединения заявок</div><div style={s.cardValue}>{merges.length}</div>
          </div>
        )}
        <div style={s.card}>
          <div style={s.cardLabel}>Свободные машины</div>
          <div style={s.cardValue}>{fleet ? fleet.freeCount : "—"}</div>
          {fleet && !fleet.hasFree && (
            <div style={s.cardSub}>
              {fleet.nextFreeAt ? `ближайшая ${formatClock(fleet.nextFreeAt)}` : "время уточняется"}
            </div>
          )}
        </div>
      </div>

      <div style={s.todayLine}>
        Сегодня: завершено {summary?.completedToday ?? 0}, отменено {summary?.cancelledToday ?? 0}
        {!inTelegram && <>
          {" · "}
          <button style={s.linkButton} onClick={() => setTab("journal")}>открыть журнал</button>
        </>}
      </div>

      {proposals.length > 0 && (
        <section style={s.proposalsBox}>
          <h2 style={s.sectionTitle}>Предложения по маршруту — нужно решение</h2>
          {proposals.map((p) => {
            const age = minutesSince(p.createdAt);
            return (
              <div key={p.id} style={s.proposalRow}>
                <div style={s.proposalMain}>
                  <div style={s.proposalTitle}>
                    Заявка #{p.requestId} · {p.actionLabel}
                    {p.action === "remove" ? ` «${p.targetAddress || "?"}»` : ` «${p.address}»`}
                  </div>
                  <div style={s.proposalMeta}>Маршрут: {p.route}</div>
                  <div style={s.proposalMeta}>
                    Предложил: {p.proposedByName} ({ROLE_LABEL[p.proposedByRole] || p.proposedByRole})
                    {p.estDeltaMin != null && <> · <b>≈ {formatDelta(p.estDeltaMin)}</b></>}
                    {age != null && <> · {age === 0 ? "только что" : `${age} мин назад`}</>}
                  </div>
                </div>
                <div style={s.proposalActions}>
                  <button style={s.primaryButton} disabled={busy} onClick={() => decideProposal(p.id, "approve")}>Одобрить</button>
                  <button style={s.dangerButton} disabled={busy} onClick={() => decideProposal(p.id, "reject")}>Отклонить</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {merges.length > 0 && (
        <section style={s.proposalsBox}>
          <h2 style={s.sectionTitle}>Объединение заявок — нужно решение</h2>
          {merges.map((m) => {
            const age = minutesSince(m.createdAt);
            return (
              <div key={m.id} style={s.proposalRow}>
                <div style={s.proposalMain}>
                  <div style={s.proposalTitle}>
                    Заявка #{m.requestAId} + заявка #{m.requestBId} · водитель {m.driverName}
                  </div>
                  <div style={s.proposalMeta}>Основной маршрут: {m.aRoute}</div>
                  <div style={s.proposalMeta}>Попутная заявка: {m.bRoute}</div>
                  <div style={s.proposalMeta}>
                    Согласие: заказчик {m.approvedByA ? "✓" : "ждём"} · диспетчер {m.approvedByDispatcher ? "✓" : "ждём"}
                    {age != null && <> · {age === 0 ? "только что" : `${age} мин назад`}</>}
                  </div>
                </div>
                <div style={s.proposalActions}>
                  <button style={s.primaryButton} disabled={busy || m.approvedByDispatcher} onClick={() => decideMerge(m.id, "approve")}>
                    {m.approvedByDispatcher ? "Вы согласовали" : "Одобрить"}
                  </button>
                  <button style={s.dangerButton} disabled={busy} onClick={() => decideMerge(m.id, "reject")}>Отклонить</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Время</th>
              <th style={s.th}>Маршрут</th>
              <th style={s.th}>≈ км / мин</th>
              <th style={s.th}>Освободится</th>
              <th style={s.th}>Заказчик</th>
              <th style={s.th}>Статус</th>
              <th style={s.th}>Водитель</th>
              <th style={s.th}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {!loading && sortedRequests.length === 0 && (
              <tr><td style={s.td} colSpan={8}>Активных заявок нет</td></tr>
            )}
            {sortedRequests.map((r) => {
              const stale = staleInfo(r, staleThresholdMin, now);
              return (
              <React.Fragment key={r.id}>
                <tr style={stale ? s.staleRow : undefined}>
                  <td style={s.td}>{formatDateTime(r.requestedAt)}</td>
                  <td style={s.td}>
                    {formatRoute(r)}{r.withReturn && <span style={s.returnBadge}> (туда-обратно)</span>}
                    {r.stopProposals?.length > 0 && <span style={s.pendingBadge}>+{r.stopProposals.length} на модерации</span>}
                    {r.mergedRequests?.length > 0 && <span style={s.mergeBadge}>🔗 попутно #{r.mergedRequests.map((m) => m.id).join(", #")}</span>}
                    {r.mergedInto && <span style={s.mergeBadge}>🔗 в составе поездки #{r.mergedInto}</span>}
                    {r.pendingMerges?.length > 0 && <span style={s.pendingBadge}>объединение на согласовании</span>}
                  </td>
                  <td style={s.td}>{formatEstimate(r) || "—"}</td>
                  <td style={s.td}>
                    {["assigned", "in_progress"].includes(r.status) && r.expectedCompletionAt
                      ? formatClock(r.expectedCompletionAt)
                      : "—"}
                  </td>
                  <td style={s.td}>{r.employeeName}</td>
                  <td style={s.td}>
                    {r.onHold ? "Снята с машины" : (STATUS_LABEL[r.status] || r.status)}
                    {stale && <span style={s.staleBadge}>{stale}</span>}
                    {r.onHold && <div style={s.holdNote}>ждёт решения заказчика · причина: {r.pullReason}</div>}
                  </td>
                  <td style={s.td}>{r.driverName ? `${r.driverName}${r.vehiclePlate ? ` (${r.vehiclePlate})` : ""}` : "—"}</td>
                  <td style={s.td}>
                    {r.mergedInto && <span style={s.muted}>обслуживается заявкой #{r.mergedInto}</span>}
                    {!r.mergedInto && r.status === "pending_assignment" && (
                      <button style={s.secondaryButton} onClick={() => openAssign(r.id)}>
                        {r.onHold ? "Дать другую машину" : "Назначить"}
                      </button>
                    )}
                    {!r.mergedInto && r.status === "assigned" && (
                      <button style={s.secondaryButton} onClick={() => unassignDriver(r)}>Снять водителя</button>
                    )}
                    {!r.mergedInto && ["assigned", "in_progress"].includes(r.status) && (
                      <button style={s.warnButton} onClick={() => openPull(r.id)}>Перебросить машину</button>
                    )}
                    {!r.mergedInto && ["pending_assignment", "assigned"].includes(r.status) && (
                      <button style={s.dangerButton} onClick={() => cancelRequest(r.id)}>Отменить заявку</button>
                    )}
                    {!r.mergedInto && canEditRoute(r) && (
                      <button style={s.secondaryButton} onClick={() => setStopsPanelFor(stopsPanelFor === r.id ? null : r.id)}>
                        Маршрут
                      </button>
                    )}
                  </td>
                </tr>
                {stopsPanelFor === r.id && (
                  <tr>
                    <td style={s.td} colSpan={8}>
                      <div style={s.stopsPanel}>
                        <b>Точки маршрута заявки #{r.id}</b>
                        <div style={s.stopsList}>
                          <span style={s.stopChip}>{r.fromAddress}</span>
                          <span style={s.stopChip}>{r.toAddress}</span>
                          {(r.stopsDetailed || []).map((st) => (
                            <span key={st.id} style={s.stopChip}>
                              {st.address}
                              <button style={s.chipRemove} disabled={busy} onClick={() => removeStop(r.id, st.id)}>✕</button>
                            </span>
                          ))}
                        </div>
                        <button style={s.secondaryButton} disabled={busy} onClick={() => setMapForRequest(r.id)}>+ Добавить точку на карте</button>
                        {r.stopProposals?.length > 0 && (
                          <div style={s.panelHint}>На модерации: {r.stopProposals.map((sp) => sp.address || "удаление точки").join(", ")} — решается выше.</div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      </>)}

      {assignTarget && (
        <div style={s.modalOverlay} onClick={() => setAssignTarget(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Назначить водителя на заявку #{assignTarget}</h3>
            {availableDrivers.length === 0 ? (
              <p style={s.muted}>Нет водителей на линии, свободных на время этой заявки.</p>
            ) : (
              <select style={s.input} value={selectedDriverId} onChange={(e) => setSelectedDriverId(e.target.value)}>
                <option value="">Выберите водителя</option>
                {availableDrivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.vehiclePlate ? ` — ${d.vehiclePlate}` : ""}{d.status === "busy" ? " (сейчас на другом заказе)" : ""}
                  </option>
                ))}
              </select>
            )}
            <div style={s.modalActions}>
              <button style={s.secondaryButton} onClick={() => setAssignTarget(null)}>Отмена</button>
              <button style={s.primaryButton} disabled={!selectedDriverId} onClick={confirmAssign}>Назначить</button>
            </div>
          </div>
        </div>
      )}

      {mapForRequest && (
        <MapPicker
          onClose={() => setMapForRequest(null)}
          onSelect={(address) => addStop(mapForRequest, address)}
        />
      )}

      {pullTarget && (
        <div style={s.modalOverlay} onClick={() => setPullTarget(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Снять машину с заявки #{pullTarget}</h3>
            <p style={s.muted}>Заявка уйдёт в ожидание, заказчик получит уведомление с причиной и решит — вернуть в очередь или отменить.</p>
            <label style={s.fieldLabel}>Причина (увидит заказчик)
              <input
                style={s.input}
                value={pullForm.reason}
                onChange={(e) => setPullForm({ ...pullForm, reason: e.target.value })}
                placeholder="Напр.: срочный выезд на объект"
              />
            </label>
            <label style={s.fieldLabel}>Сразу отдать машину заявке (необязательно)
              <select
                style={s.input}
                value={pullForm.targetRequestId}
                onChange={(e) => setPullForm({ ...pullForm, targetRequestId: e.target.value })}
              >
                <option value="">— освободить машину в общий доступ —</option>
                {requests
                  .filter((x) => x.status === "pending_assignment" && !x.onHold && x.id !== pullTarget)
                  .map((x) => (
                    <option key={x.id} value={x.id}>#{x.id} · {formatRoute(x)}</option>
                  ))}
              </select>
            </label>
            <div style={s.modalActions}>
              <button style={s.secondaryButton} onClick={() => setPullTarget(null)}>Отмена</button>
              <button style={s.warnButton} disabled={busy} onClick={confirmPull}>Снять машину</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Журнал завершённых и отменённых заявок за период по дате подачи. Грузится
// с сервера по запросу (а не вместе с текущими), чтобы рабочий экран не
// тянул за собой всю историю.
function HistoryJournal() {
  const today = localDateStr();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!from || !to) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    ridesApiFetch(`/api/v1/requests/history?from=${from}&to=${to}&status=${status}`)
      .then((data) => {
        if (cancelled) return;
        setRows(data.requests);
        setTruncated(data.truncated);
      })
      .catch((err) => { if (!cancelled) setError(err.message || "Не удалось загрузить журнал"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, status]);

  const setLastDays = (days) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    setFrom(localDateStr(d));
    setTo(today);
  };

  const q = query.trim().toLowerCase();
  const visible = q
    ? rows.filter((r) => [formatRoute(r), r.employeeName, r.driverName, r.vehiclePlate, r.cancelReason, String(r.id)]
      .some((v) => v && v.toLowerCase().includes(q)))
    : rows;

  return (
    <section>
      <div style={s.journalFilters}>
        <label style={s.filterLabel}>с <input type="date" style={s.filterInput} value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={s.filterLabel}>по <input type="date" style={s.filterInput} value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <button style={s.secondaryButton} onClick={() => setLastDays(1)}>Сегодня</button>
        <button style={s.secondaryButton} onClick={() => setLastDays(7)}>7 дней</button>
        <button style={s.secondaryButton} onClick={() => setLastDays(30)}>30 дней</button>
        <select style={s.filterInput} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Все</option>
          <option value="completed">Завершённые</option>
          <option value="cancelled">Отменённые</option>
        </select>
        <input
          style={{ ...s.filterInput, flex: "1 1 180px" }}
          placeholder="Поиск: адрес, заказчик, водитель, №"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && <div style={s.error}>{error}</div>}
      {truncated && <div style={s.muted}>Показаны последние 1000 заявок периода — сузьте период.</div>}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>№</th>
              <th style={s.th}>Время</th>
              <th style={s.th}>Маршрут</th>
              <th style={s.th}>≈ км / мин</th>
              <th style={s.th}>Заказчик</th>
              <th style={s.th}>Водитель</th>
              <th style={s.th}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td style={s.td} colSpan={7}>Загрузка...</td></tr>}
            {!loading && visible.length === 0 && <tr><td style={s.td} colSpan={7}>За период заявок нет</td></tr>}
            {!loading && visible.map((r) => (
              <tr key={r.id}>
                <td style={s.td}>{r.id}</td>
                <td style={s.td}>{formatDateTime(r.requestedAt)}</td>
                <td style={s.td}>
                  {formatRoute(r)}{r.withReturn && <span style={s.returnBadge}> (туда-обратно)</span>}
                  {r.mergedInto && <span style={s.mergeBadge}>🔗 в составе поездки #{r.mergedInto}</span>}
                </td>
                <td style={s.td}>{formatEstimate(r) || "—"}</td>
                <td style={s.td}>{r.employeeName}</td>
                <td style={s.td}>{r.driverName ? `${r.driverName}${r.vehiclePlate ? ` (${r.vehiclePlate})` : ""}` : "—"}</td>
                <td style={s.td}>
                  <span style={{ color: r.status === "cancelled" ? "#c00" : "#1a7f37" }}>{STATUS_LABEL[r.status] || r.status}</span>
                  {r.cancelReason && <div style={s.holdNote}>{r.cancelReason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const s = {
  tabs: { display: "flex", gap: "6px", marginBottom: "16px", borderBottom: "1px solid #ddd" },
  tab: { background: "none", border: "none", borderBottom: "2px solid transparent", padding: "8px 14px", cursor: "pointer", fontSize: "14px", color: "#555", marginBottom: "-1px" },
  tabActive: { background: "none", border: "none", borderBottom: "2px solid #1976d2", padding: "8px 14px", cursor: "pointer", fontSize: "14px", color: "#1976d2", fontWeight: 600, marginBottom: "-1px" },
  todayLine: { fontSize: "13px", color: "#555", margin: "-8px 0 16px" },
  linkButton: { background: "none", border: "none", padding: 0, color: "#1976d2", textDecoration: "underline", cursor: "pointer", fontSize: "13px" },
  journalFilters: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "12px" },
  filterLabel: { fontSize: "13px", color: "#555", display: "flex", alignItems: "center", gap: "4px" },
  filterInput: { padding: "6px 8px", border: "1px solid #ccc", borderRadius: "6px", fontSize: "13px" },
  page: { padding: "16px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "1100px", margin: "0 auto", boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "16px" },
  headerRight: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "12px" },
  link: { color: "#1976d2", fontSize: "13px", textDecoration: "none" },
  title: { fontSize: "clamp(18px, 5vw, 22px)", margin: 0 },

  error: { background: "#fff0f0", color: "#c00", borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px" },
  muted: { color: "#888", fontSize: "14px" },
  sectionTitle: { fontSize: "15px", margin: "0 0 12px" },

  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px", marginBottom: "20px" },
  card: { background: "#fff", borderRadius: "10px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" },
  cardAlert: { boxShadow: "0 0 0 2px #e67e22" },
  cardLabel: { fontSize: "12px", color: "#888", marginBottom: "6px" },
  cardValue: { fontSize: "24px", fontWeight: 700 },
  cardSub: { fontSize: "11px", color: "#8a5a00", marginTop: "2px" },

  proposalsBox: { background: "#fffdf6", border: "1px solid #f0d9a8", borderRadius: "10px", padding: "14px 16px", marginBottom: "20px" },
  proposalRow: { display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "10px", padding: "10px 0", borderTop: "1px solid #f0e2c4" },
  proposalMain: { flex: "1 1 260px", minWidth: 0 },
  proposalTitle: { fontWeight: 700, fontSize: "13px", marginBottom: "3px" },
  proposalMeta: { fontSize: "12px", color: "#666", wordBreak: "break-word" },
  proposalActions: { display: "flex", gap: "8px", alignItems: "flex-start", flexWrap: "wrap" },

  tableWrap: { overflowX: "auto", WebkitOverflowScrolling: "touch", marginBottom: "12px" },
  table: { width: "100%", minWidth: "860px", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "10px", borderBottom: "2px solid #ddd", background: "#fafafa", fontSize: "13px", whiteSpace: "nowrap" },
  td: { padding: "10px", borderBottom: "1px solid #eee", fontSize: "13px", verticalAlign: "top" },
  staleRow: { background: "#fff8e1" },
  staleBadge: { marginLeft: "8px", fontSize: "11px", color: "#b8860b", fontWeight: 700 },
  pendingBadge: { marginLeft: "8px", fontSize: "11px", color: "#e67e22", fontWeight: 700, whiteSpace: "nowrap" },
  mergeBadge: { marginLeft: "8px", fontSize: "11px", color: "#0b5cad", fontWeight: 700, whiteSpace: "nowrap" },
  returnBadge: { fontSize: "12px", color: "#888" },

  stopsPanel: { background: "#f7f9fc", borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "10px" },
  stopsList: { display: "flex", flexWrap: "wrap", gap: "6px" },
  stopChip: { display: "inline-flex", alignItems: "center", gap: "4px", background: "#fff", border: "1px solid #d5dbe6", borderRadius: "999px", padding: "3px 10px", fontSize: "12px" },
  chipRemove: { background: "none", border: "none", color: "#c00", cursor: "pointer", fontSize: "12px", padding: 0, lineHeight: 1 },
  panelHint: { fontSize: "12px", color: "#e67e22" },

  primaryButton: { background: "#1976d2", color: "#fff", border: "none", borderRadius: "6px", padding: "8px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
  secondaryButton: { background: "#fff", border: "1px solid #ccc", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px", marginRight: "6px" },
  dangerButton: { background: "#fff0f0", color: "#c00", border: "1px solid #f5b5b5", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px", marginRight: "6px" },
  warnButton: { background: "#fff3e0", color: "#b45309", border: "1px solid #f0c48a", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px", marginRight: "6px" },
  holdNote: { fontSize: "11px", color: "#b45309", marginTop: "3px" },
  fieldLabel: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "#555", marginTop: "12px" },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modal: { background: "#fff", borderRadius: "10px", padding: "20px", width: "360px", maxWidth: "92vw", boxSizing: "border-box" },
  modalActions: { display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "8px", marginTop: "16px" },
  input: { width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #ccc", fontSize: "14px", boxSizing: "border-box" },
};
