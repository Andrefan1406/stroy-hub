// Таблицы неисполненных заявок на бетон и на раствор — заменяют встроенный
// iframe Google Таблицы на странице заявки. Две отдельные таблицы (бетон
// выше раствора), одни и те же данные с одного запроса, просто отфильтрованы
// по полю material. Сортировку (приоритет объекта -> плановая дата поставки
// -> дата подачи заявки) считает сервер (server/concreteRequestsBoard.js),
// здесь только отображение и локальное admin-скрытие строки.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { getAuth } from "firebase/auth";
import styles from "../RequestPage.module.css";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

// Кому видна кнопка «Удалить» — только эти двое, остальным строка доступна
// только на чтение. Настоящая проверка — на бэкенде через Firebase ID-токен
// (см. requireEmails в server/adminAuth.js), этот список — только для UX.
const ROW_DELETE_ALLOWED_EMAILS = ["admin@vkdev.kz", "nach.bsu@vkdevgroup.kz"];

// Фоновая проверка статуса "исполнено" — раз в час, но только в интервале
// 06:00-24:00 (по требованию задачи; ночью 00:00-06:00 не дёргаем сервер).
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const POLL_WINDOW_START_HOUR = 6;
const POLL_WINDOW_END_HOUR = 24;

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Ошибка сервера (${res.status})`);
  }
  return data;
}

async function apiFetchWithAuth(path, options = {}) {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  const token = await user.getIdToken();
  return apiFetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
}

const formatVolume = (value) =>
  value === null || value === undefined ? "—" : `${Number(value).toLocaleString("ru-RU")} м³`;

const formatSubmittedAt = (value) => {
  if (!value) return "—";
  // "2024-06-06 15:26:16" -> "06.06.2024 15:26"
  const [datePart, timePart] = value.split(" ");
  const [y, m, d] = datePart.split("-");
  return `${d}.${m}.${y} ${(timePart || "").slice(0, 5)}`;
};

const formatResponsible = (name, phone) => {
  if (name && phone) return `${name} — ${phone}`;
  return name || phone || "—";
};

// showGeoColumn — только для бетона: согласование геодезистов имеет смысл
// для конструктива, у раствора (кладка/штукатурка) такого требования нет —
// ни колонки, ни сортировки по этому признаку в таблице раствора. Тот же
// флаг включает и колонку согласования энергетиков (прогрев бетона зимой).
const MaterialRequestsTable = ({ title, rows, showGeoColumn, canDeleteRows, onDeleteClick }) => (
  <div style={{ marginBottom: "32px" }}>
    <h4 style={{ textAlign: "center" }}>{title}</h4>
    {rows.length === 0 ? (
      <p style={{ color: "#888", textAlign: "center" }}>Неисполненных заявок нет.</p>
    ) : (
      <table className={styles.requestTable}>
        <thead>
          <tr>
            <th>№ п/п</th>
            <th>Объект</th>
            <th>Позиция</th>
            <th>Марка</th>
            <th>Объём</th>
            <th>Плановая дата</th>
            <th>Подача заявки</th>
            {showGeoColumn && <th>Геодезисты</th>}
            {showGeoColumn && <th>Энергетики</th>}
            <th>Примечание</th>
            <th>Ответственный</th>
            {canDeleteRows && <th>Действия</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.request_key}>
              <td>{index + 1}</td>
              <td>{row.object_name || "—"}</td>
              <td>{row.block_position || "—"}</td>
              <td>{row.grade_class || "—"}</td>
              <td>{formatVolume(row.volume_planned_m3)}</td>
              <td>{row.planned_delivery_date || "—"}</td>
              <td>{formatSubmittedAt(row.submitted_at)}</td>
              {showGeoColumn && <td>{row.geo_approved ? "Согласовано" : "—"}</td>}
              {showGeoColumn && <td>{row.energy_approved ? "Согласовано" : "—"}</td>}
              <td>{row.note || "—"}</td>
              <td>{formatResponsible(row.responsible_name, row.responsible_phone)}</td>
              {canDeleteRows && (
                <td>
                  <button type="button" onClick={() => onDeleteClick(row)}>
                    Удалить
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

// refreshSignal — любое меняющееся значение (например, счётчик), которое
// родитель увеличивает после успешной подачи новой заявки, чтобы таблицы
// сразу перезапросили список, не дожидаясь часового опроса.
const ConcretePendingRequestsTable = ({ refreshSignal }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmingRow, setConfirmingRow] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const currentEmail = getAuth().currentUser?.email?.toLowerCase() || "";
  const canDeleteRows = ROW_DELETE_ALLOWED_EMAILS.includes(currentEmail);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/api/concrete-board/pending");
      setRows(data.rows || []);
    } catch (err) {
      setError(err.message || "Не удалось загрузить заявки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  // Часовой опрос 06:00-24:00 — только перезапрашивает список, чтобы строки
  // с изменившимся статусом "исполнено" пропадали сами по себе.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const intervalId = setInterval(() => {
      const hour = new Date().getHours();
      if (hour >= POLL_WINDOW_START_HOUR && hour < POLL_WINDOW_END_HOUR) {
        loadRef.current();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, []);

  const handleDeleteConfirmed = async () => {
    if (!confirmingRow) return;
    setDeleting(true);
    try {
      await apiFetchWithAuth("/api/concrete-board/hide", {
        method: "POST",
        body: JSON.stringify({ request_key: confirmingRow.request_key }),
      });
      setRows((prev) => prev.filter((r) => r.request_key !== confirmingRow.request_key));
      setConfirmingRow(null);
    } catch (err) {
      alert(err.message || "Не удалось удалить строку");
    } finally {
      setDeleting(false);
    }
  };

  const concreteRows = rows.filter((r) => r.material === "Бетон");
  const mortarRows = rows.filter((r) => r.material === "Раствор");

  return (
    <div style={{ marginTop: "40px", maxWidth: "1200px", marginLeft: "auto", marginRight: "auto" }}>
      <h3 style={{ textAlign: "center" }}>Текущие заявки</h3>

      {error && <div style={{ color: "#c00", marginBottom: "10px" }}>{error}</div>}

      {loading ? (
        <p style={{ textAlign: "center" }}>Загрузка...</p>
      ) : (
        <>
          <MaterialRequestsTable
            title="Бетон"
            rows={concreteRows}
            showGeoColumn
            canDeleteRows={canDeleteRows}
            onDeleteClick={setConfirmingRow}
          />
          <MaterialRequestsTable
            title="Раствор"
            rows={mortarRows}
            showGeoColumn={false}
            canDeleteRows={canDeleteRows}
            onDeleteClick={setConfirmingRow}
          />
        </>
      )}

      {confirmingRow && (
        <div className={styles.modalOverlay}>
          <div className={styles.modal}>
            <p>Вы действительно хотите удалить эту строку?</p>
            <div className={styles.modalButtons}>
              <button type="button" onClick={() => setConfirmingRow(null)} disabled={deleting}>
                Отмена
              </button>
              <button type="button" onClick={handleDeleteConfirmed} disabled={deleting}>
                {deleting ? "Удаление..." : "Удалить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConcretePendingRequestsTable;
