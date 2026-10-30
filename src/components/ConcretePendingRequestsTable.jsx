// Таблицы неисполненных заявок на бетон и на раствор — заменяют встроенный
// iframe Google Таблицы на странице заявки. Две отдельные таблицы (бетон
// выше раствора), одни и те же данные с одного запроса, просто отфильтрованы
// по полю material. Сортировку (приоритет объекта -> плановая дата поставки
// -> дата подачи заявки) считает сервер (server/concreteRequestsBoard.js),
// здесь только отображение и локальное admin-скрытие строки.
//
// На телефоне бетон и раствор — две вкладки с переключением смахиванием
// влево/вправо (иначе до раствора пришлось бы долго прокручивать карточки
// бетона); на широком экране обе таблицы подряд, вкладки скрыты.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { getAuth } from "firebase/auth";
import styles from "./ConcretePendingRequestsTable.module.css";
import RequestDialog from "./RequestDialog";

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
const NewBadge = () => <span className={styles.badgeNew}>Новая</span>;

const MaterialRequestsTable = ({ id, title, rows, showGeoColumn, canDeleteRows, onDeleteClick, newKeys, active }) => (
  <div
    id={`panel-${id}`}
    role="tabpanel"
    aria-labelledby={`tab-${id}`}
    className={active ? styles.panel : `${styles.panel} ${styles.panelOff}`}
  >
    <h3 className={styles.sub}>{title}</h3>
    {rows.length === 0 ? (
      <p className={styles.state}>Неисполненных заявок нет.</p>
    ) : (
      <>
        {/* Широкий экран — таблица (блок прокручивается с клавиатуры). */}
        <div className={styles.scroll} role="region" aria-label={`Таблица заявок: ${title}`}>
          <table className={showGeoColumn ? styles.table : `${styles.table} ${styles.tableMortar}`}>
            <thead>
              <tr>
                <th scope="col">№ п/п</th>
                <th scope="col">Объект</th>
                <th scope="col">Позиция</th>
                <th scope="col">Марка</th>
                <th scope="col">Объём</th>
                <th scope="col">Плановая дата</th>
                <th scope="col">Подача заявки</th>
                {showGeoColumn && <th scope="col">Геодезисты</th>}
                {showGeoColumn && <th scope="col">Энергетики</th>}
                <th scope="col">Примечание</th>
                <th scope="col">Ответственный</th>
                {canDeleteRows && <th scope="col">Действия</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.request_key}>
                  <td>{index + 1}</td>
                  <td>{newKeys.has(row.request_key) && <NewBadge />}{row.object_name || "—"}</td>
                  <td>{row.block_position || "—"}</td>
                  <td>{row.grade_class || "—"}</td>
                  <td>{formatVolume(row.volume_planned_m3)}</td>
                  <td>{row.planned_delivery_date || "—"}</td>
                  <td>{formatSubmittedAt(row.submitted_at)}</td>
                  {showGeoColumn && (
                    <td className={row.geo_approved ? styles.approved : styles.dash}>{row.geo_approved ? "Согласовано" : "—"}</td>
                  )}
                  {showGeoColumn && (
                    <td className={row.energy_approved ? styles.approved : styles.dash}>{row.energy_approved ? "Согласовано" : "—"}</td>
                  )}
                  <td>{row.note || "—"}</td>
                  <td>{formatResponsible(row.responsible_name, row.responsible_phone)}</td>
                  {canDeleteRows && (
                    <td>
                      <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={() => onDeleteClick(row)}>
                        Удалить
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Телефон — те же данные карточками: объект сверху, статусы на виду. */}
        <ul className={styles.cards}>
          {rows.map((row, index) => (
            <li key={row.request_key} className={styles.cardItem}>
              <p className={styles.cardHead}>
                <span className={styles.cardNum}>{index + 1}.</span>
                {newKeys.has(row.request_key) && <NewBadge />}
                {row.object_name || "—"}
              </p>
              <p className={styles.cardPos}>{row.block_position || "—"}</p>
              <dl className={styles.dl}>
                <dt>Марка · объём</dt>
                <dd>{[row.grade_class, formatVolume(row.volume_planned_m3)].filter((v) => v && v !== "—").join(" · ") || "—"}</dd>
                <dt>Плановая дата</dt>
                <dd>{row.planned_delivery_date || "—"}</dd>
                <dt>Подача заявки</dt>
                <dd>{formatSubmittedAt(row.submitted_at)}</dd>
                {showGeoColumn && (
                  <>
                    <dt>Геодезисты</dt>
                    <dd className={row.geo_approved ? styles.approved : styles.dash}>{row.geo_approved ? "Согласовано" : "—"}</dd>
                    <dt>Энергетики</dt>
                    <dd className={row.energy_approved ? styles.approved : styles.dash}>{row.energy_approved ? "Согласовано" : "—"}</dd>
                  </>
                )}
                {row.note && (
                  <>
                    <dt>Примечание</dt>
                    <dd>{row.note}</dd>
                  </>
                )}
                <dt>Ответственный</dt>
                <dd>{formatResponsible(row.responsible_name, row.responsible_phone)}</dd>
              </dl>
              {canDeleteRows && (
                <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={() => onDeleteClick(row)}>
                  Удалить
                </button>
              )}
            </li>
          ))}
        </ul>
      </>
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
  const [deleteError, setDeleteError] = useState("");
  // Заявки, появившиеся в списке после отправки новой, — помечаются «Новая».
  const [newKeys, setNewKeys] = useState(() => new Set());
  const knownKeysRef = useRef(null);
  // Вкладка на телефоне: concrete | mortar.
  const [tab, setTab] = useState("concrete");
  const touchRef = useRef(null);

  const currentEmail = getAuth().currentUser?.email?.toLowerCase() || "";
  const canDeleteRows = ROW_DELETE_ALLOWED_EMAILS.includes(currentEmail);

  const load = useCallback(async (markNew = false) => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/api/concrete-board/pending");
      const loaded = data.rows || [];
      if (markNew && knownKeysRef.current) {
        setNewKeys(new Set(loaded.filter((r) => !knownKeysRef.current.has(r.request_key)).map((r) => r.request_key)));
      }
      knownKeysRef.current = new Set(loaded.map((r) => r.request_key));
      setRows(loaded);
    } catch (err) {
      setError(err.message || "Не удалось загрузить заявки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(refreshSignal > 0);
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
    setDeleteError("");
    try {
      await apiFetchWithAuth("/api/concrete-board/hide", {
        method: "POST",
        body: JSON.stringify({ request_key: confirmingRow.request_key }),
      });
      setRows((prev) => prev.filter((r) => r.request_key !== confirmingRow.request_key));
      setConfirmingRow(null);
    } catch (err) {
      setDeleteError(err.message || "Не удалось удалить строку");
    } finally {
      setDeleting(false);
    }
  };

  const concreteRows = rows.filter((r) => r.material === "Бетон");
  const mortarRows = rows.filter((r) => r.material === "Раствор");

  const TABS = [
    { id: "concrete", label: "Бетон", count: concreteRows.length },
    { id: "mortar", label: "Раствор", count: mortarRows.length },
  ];

  // Смахивание: палец влево — следующая вкладка, вправо — предыдущая.
  // Засчитываем только явно горизонтальный жест, вертикальная прокрутка не мешает.
  const onTouchStart = (e) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    setTab(dx < 0 ? "mortar" : "concrete");
  };
  const onTabKeyDown = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = e.key === "ArrowRight" ? "mortar" : "concrete";
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <div className={styles.wrap}>
      <h2 className={styles.heading}>Текущие заявки</h2>

      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" className={styles.btn} onClick={() => load()}>
            Повторить
          </button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <p className={styles.state} role="status">Загрузка...</p>
      ) : (
        !(error && rows.length === 0) && (
          <>
            {loading && <p className={styles.updating} role="status">Обновляется...</p>}
            <div className={styles.tabs} role="tablist" aria-label="Материал" onKeyDown={onTabKeyDown}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  id={`tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={tab === t.id ? 0 : -1}
                  className={tab === t.id ? `${styles.tab} ${styles.tabOn}` : styles.tab}
                  onClick={() => setTab(t.id)}
                >
                  {t.label} <span className={styles.tabCount}>{t.count}</span>
                </button>
              ))}
            </div>
            <p className={styles.swipeHint}>Листайте влево и вправо, чтобы переключить бетон и раствор</p>
            <div className={styles.panels} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <MaterialRequestsTable
              id="concrete"
              active={tab === "concrete"}
              title="Бетон"
              rows={concreteRows}
              newKeys={newKeys}
              showGeoColumn
              canDeleteRows={canDeleteRows}
              onDeleteClick={setConfirmingRow}
            />
            <MaterialRequestsTable
              id="mortar"
              active={tab === "mortar"}
              title="Раствор"
              rows={mortarRows}
              newKeys={newKeys}
              showGeoColumn={false}
              canDeleteRows={canDeleteRows}
              onDeleteClick={setConfirmingRow}
            />
            </div>
          </>
        )
      )}

      {confirmingRow && (
        <RequestDialog title="Удаление строки" onClose={() => { setConfirmingRow(null); setDeleteError(""); }}>
          <p className={styles.dialogText}>Вы действительно хотите удалить эту строку?</p>
          {deleteError && <p className={styles.error} role="alert">{deleteError}</p>}
          <div className={styles.dialogButtons}>
            <button type="button" className={styles.btn} onClick={() => { setConfirmingRow(null); setDeleteError(""); }} disabled={deleting}>
              Отмена
            </button>
            <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDeleteConfirmed} disabled={deleting}>
              {deleting ? "Удаление..." : "Удалить"}
            </button>
          </div>
        </RequestDialog>
      )}
    </div>
  );
};

export default ConcretePendingRequestsTable;
