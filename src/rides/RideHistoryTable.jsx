// Таблица истории поездок — одна на всех: у пассажира, у водителя и в
// журнале диспетчера. Время подачи, маршрут (с комментарием пассажира),
// расстояние по маршруту (оценка по карте — фактический пробег не
// измеряется), фактические начало, окончание и длительность поездки (по смене статусов
// «в пути» -> «завершена», см. server/rides/requestView.js: getTiming),
// заказчик, водитель, статус.
import React from "react";
import { formatRoute } from "./format";

const STATUS = {
  completed: { label: "Завершена", color: "#1a7f37" },
  cancelled: { label: "Отменена", color: "#c00" },
};

// Время подачи — местное "YYYY-MM-DDTHH:MM" (без зоны).
function formatPickup(value) {
  if (!value) return "—";
  const [date, time = ""] = value.replace(" ", "T").split("T");
  const [, m, d] = date.split("-");
  return `${d}.${m}, ${time.slice(0, 5)}`;
}

// Начало/окончание — UTC "YYYY-MM-DD HH:MM:SS" из истории статусов; день
// показываем, только если он не совпадает с днём подачи.
function formatMoment(utc, pickup) {
  if (!utc) return "—";
  const d = new Date(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "—";
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const day = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return pickup && formatPickup(pickup).startsWith(day) ? time : `${day}, ${time}`;
}

// 25.2 -> "25,2"; маршрут не построился — «—».
const formatKm = (km) => (km == null ? "—" : String(km).replace(".", ","));

function formatDuration(min) {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  return h ? `${h} ч ${String(min % 60).padStart(2, "0")} мин` : `${min} мин`;
}

export default function RideHistoryTable({ rows, showId = false, loading = false, emptyText = "Поездок нет" }) {
  const cols = showId ? 10 : 9;
  return (
    <div style={s.wrap}>
      <table style={s.table}>
        <thead>
          <tr>
            {showId && <th style={s.th}>№</th>}
            <th style={s.th}>Время</th>
            <th style={s.th}>Маршрут</th>
            <th style={s.th} title="Расстояние по маршруту — оценка по карте">≈ км</th>
            <th style={s.th}>Начало</th>
            <th style={s.th}>Окончание</th>
            <th style={s.th}>Длительность</th>
            <th style={s.th}>Заказчик</th>
            <th style={s.th}>Водитель</th>
            <th style={s.th}>Статус</th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td style={s.td} colSpan={cols}>Загрузка...</td></tr>}
          {!loading && rows.length === 0 && <tr><td style={s.td} colSpan={cols}>{emptyText}</td></tr>}
          {!loading && rows.map((r) => {
            const status = STATUS[r.status] || { label: r.status, color: "#555" };
            return (
              <tr key={r.id}>
                {showId && <td style={s.td}>{r.id}</td>}
                <td style={s.tdNowrap}>{formatPickup(r.requestedAt)}</td>
                <td style={s.td}>
                  {formatRoute(r)}
                  {r.withReturn && <span style={s.muted}> (туда-обратно)</span>}
                  {r.mergedInto && <span style={s.merge}> 🔗 в составе поездки #{r.mergedInto}</span>}
                  {r.comment && <div style={s.comment}>💬 {r.comment}</div>}
                </td>
                <td style={s.tdNowrap}>{formatKm(r.distanceKm)}</td>
                <td style={s.tdNowrap}>{formatMoment(r.startedAt, r.requestedAt)}</td>
                <td style={s.tdNowrap}>{formatMoment(r.finishedAt, r.requestedAt)}</td>
                <td style={s.tdNowrap}>{formatDuration(r.actualMinutes)}</td>
                <td style={s.td}>{r.employeeName || "—"}</td>
                <td style={s.td}>{r.driverName ? `${r.driverName}${r.vehiclePlate ? ` (${r.vehiclePlate})` : ""}` : "—"}</td>
                <td style={s.td}>
                  <span style={{ color: status.color }}>{status.label}</span>
                  {r.cancelReason && <div style={s.reason}>{r.cancelReason}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const s = {
  wrap: { overflowX: "auto", WebkitOverflowScrolling: "touch" },
  table: { width: "100%", minWidth: "920px", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #ddd", background: "#fafafa", fontSize: "13px", whiteSpace: "nowrap" },
  td: { padding: "8px 10px", borderBottom: "1px solid #eee", fontSize: "13px", verticalAlign: "top" },
  tdNowrap: { padding: "8px 10px", borderBottom: "1px solid #eee", fontSize: "13px", verticalAlign: "top", whiteSpace: "nowrap" },
  muted: { color: "#888", fontSize: "12px" },
  merge: { color: "#0b5cad", fontSize: "12px", fontWeight: 600 },
  comment: { marginTop: "4px", fontSize: "12px", color: "#7a4b00", background: "#fff6e0", borderRadius: "4px", padding: "2px 6px", display: "inline-block" },
  reason: { fontSize: "11px", color: "#b45309", marginTop: "3px" },
};
