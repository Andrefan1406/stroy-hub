// Админка системы поездок — общая страница для двух разных людей, у
// каждого своя вкладка "Пользователи" (первая):
// - главный админ сайта назначает РОЛЬ и "Доступ ко всему сайту"
//   (RoleAssignmentTab) — имя/телефон не его забота вообще;
// - диспетчер заполняет ИМЯ/ТЕЛЕФОН уже назначенным людям (UserCardsTab)
//   и полноценно ведёт справочники водителей/машин; главный админ эти
//   справочники только читает (readOnly).
// Кто есть кто — определяем по email (SITE_ADMIN_EMAIL) и по собственной
// роли из GET /api/v1/users/me; бэкенд разграничивает то же самое
// по-настоящему (requireSiteAdmin/requireRoleOrSiteAdmin, см. server/rides/*.js).
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAuth } from "firebase/auth";
import * as XLSX from "xlsx";
import { ridesApiDelete, ridesApiFetch, ridesApiPatch, ridesApiPost, ridesApiPut } from "../../rides/api";
import LogoutButton from "../../rides/LogoutButton";
import { SITE_ADMIN_EMAIL } from "../../rides/constants";

const ROLE_OPTIONS = [
  { value: "", label: "— нет доступа —" },
  { value: "employee", label: "Сотрудник (пассажир)" },
  { value: "dispatcher", label: "Диспетчер" },
  { value: "driver", label: "Водитель" },
];

function roleLabel(role) {
  return ROLE_OPTIONS.find((o) => o.value === role)?.label || "—";
}

// Главный админ: только email → роль → "Доступ ко всему сайту". Имя и
// телефон здесь нет вообще — не его забота (см. usersRouter.js, PUT /:email).
function RoleAssignmentTab() {
  const [users, setUsers] = useState([]);
  const [drafts, setDrafts] = useState({}); // email -> {role, fullSiteAccess}
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingEmail, setSavingEmail] = useState(null);

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const { users: rows } = await ridesApiFetch("/api/v1/users");
      setUsers(rows);
      const nextDrafts = {};
      for (const u of rows) {
        nextDrafts[u.email] = { role: u.role || "", fullSiteAccess: u.fullSiteAccess };
      }
      setDrafts(nextDrafts);
    } catch (err) {
      setError(err.message || "Не удалось загрузить список пользователей");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setDraft = (email, patch) => setDrafts((prev) => ({ ...prev, [email]: { ...prev[email], ...patch } }));

  const save = async (email) => {
    const draft = drafts[email];
    setSavingEmail(email);
    setError("");
    try {
      if (!draft.role) {
        await ridesApiDelete(`/api/v1/users/${encodeURIComponent(email)}`);
      } else {
        await ridesApiPut(`/api/v1/users/${encodeURIComponent(email)}`, draft);
      }
      // silent — чтобы список не пропадал во время перезагрузки и страница
      // не прыгала к началу (не показываем "Загрузка..." вместо таблицы)
      await load(true);
    } catch (err) {
      setError(err.message || "Не удалось сохранить пользователя");
    } finally {
      setSavingEmail(null);
    }
  };

  if (loading) return <p style={s.muted}>Загрузка...</p>;

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      <p style={s.muted}>Имя и телефон сюда не входят — их вписывает диспетчер на вкладке «Пользователи» после того, как роль назначена здесь.</p>
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Email</th>
              <th style={s.th}>Роль в системе поездок</th>
              <th style={s.th}>Доступ ко всему сайту</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const draft = drafts[u.email] || { role: "", fullSiteAccess: false };
              return (
                <tr key={u.email}>
                  <td style={s.td}>{u.email}</td>
                  <td style={s.td}>
                    <select style={s.inputSmall} value={draft.role} onChange={(e) => setDraft(u.email, { role: e.target.value })}>
                      {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td style={{ ...s.td, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={draft.fullSiteAccess}
                      disabled={!draft.role}
                      onChange={(e) => setDraft(u.email, { fullSiteAccess: e.target.checked })}
                    />
                  </td>
                  <td style={s.td}>
                    <button style={s.secondaryButton} disabled={savingEmail === u.email} onClick={() => save(u.email)}>Сохранить</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Диспетчер: только email → имя → телефон, для тех, кому роль уже
// назначил главный админ. Роль показана как справка (не редактируется),
// "Доступ ко всему сайту" ему вообще не видно (не его рычаг).
function UserCardsTab() {
  const [users, setUsers] = useState([]);
  const [drafts, setDrafts] = useState({}); // email -> {name, phone}
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingEmail, setSavingEmail] = useState(null);

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const { users: rows } = await ridesApiFetch("/api/v1/users");
      setUsers(rows);
      const nextDrafts = {};
      for (const u of rows) {
        nextDrafts[u.email] = { name: u.name, phone: u.phone };
      }
      setDrafts(nextDrafts);
    } catch (err) {
      setError(err.message || "Не удалось загрузить список пользователей");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setDraft = (email, patch) => setDrafts((prev) => ({ ...prev, [email]: { ...prev[email], ...patch } }));

  const save = async (email) => {
    const draft = drafts[email];
    if (!draft.name.trim() || !draft.phone.trim()) {
      setError("Укажите имя и телефон");
      return;
    }
    setSavingEmail(email);
    setError("");
    try {
      await ridesApiPatch(`/api/v1/users/${encodeURIComponent(email)}`, draft);
      // silent — чтобы список не пропадал во время перезагрузки и страница
      // не прыгала к началу (не показываем "Загрузка..." вместо таблицы)
      await load(true);
    } catch (err) {
      setError(err.message || "Не удалось сохранить карточку");
    } finally {
      setSavingEmail(null);
    }
  };

  if (loading) return <p style={s.muted}>Загрузка...</p>;

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      {users.length === 0 && <p style={s.muted}>Пока никому не назначена роль — это делает главный администратор сайта.</p>}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Email</th>
              <th style={s.th}>Имя</th>
              <th style={s.th}>Телефон</th>
              <th style={s.th}>Роль</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const draft = drafts[u.email] || { name: "", phone: "" };
              return (
                <tr key={u.email}>
                  <td style={s.td}>{u.email}</td>
                  <td style={s.td}>
                    <input style={s.inputSmall} value={draft.name} onChange={(e) => setDraft(u.email, { name: e.target.value })} />
                  </td>
                  <td style={s.td}>
                    <input style={s.inputSmall} value={draft.phone} onChange={(e) => setDraft(u.email, { phone: e.target.value })} />
                  </td>
                  <td style={s.td}>{roleLabel(u.role)}</td>
                  <td style={s.td}>
                    <button style={s.secondaryButton} disabled={savingEmail === u.email} onClick={() => save(u.email)}>Сохранить</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// readOnly = главный админ сайта (может только смотреть); диспетчер видит
// то же самое с формой добавления и кнопками изменения/удаления.
function VehiclesTab({ readOnly }) {
  const [vehicles, setVehicles] = useState([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ plateNumber: "", model: "" });

  const load = useCallback(async () => {
    setError("");
    try {
      const { vehicles: rows } = await ridesApiFetch("/api/v1/vehicles");
      setVehicles(rows);
    } catch (err) {
      setError(err.message || "Не удалось загрузить машины");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    if (!form.plateNumber.trim()) return;
    try {
      await ridesApiPost("/api/v1/vehicles", form);
      setForm({ plateNumber: "", model: "" });
      load();
    } catch (err) {
      setError(err.message || "Не удалось добавить машину");
    }
  };

  const updateStatus = async (id, status) => {
    try {
      await ridesApiPatch(`/api/v1/vehicles/${id}`, { status });
      load();
    } catch (err) {
      setError(err.message || "Не удалось обновить статус");
    }
  };

  const remove = async (id) => {
    try {
      await ridesApiDelete(`/api/v1/vehicles/${id}`);
      load();
    } catch (err) {
      setError(err.message || "Не удалось удалить машину");
    }
  };

  const STATUS_LABEL = { available: "Свободна", busy: "Занята", maintenance: "На ремонте" };

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      {!readOnly && (
        <form onSubmit={add} style={s.inlineForm}>
          <input style={s.inputSmall} placeholder="Гос. номер" value={form.plateNumber} onChange={(e) => setForm({ ...form, plateNumber: e.target.value })} />
          <input style={s.inputSmall} placeholder="Модель" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          <button type="submit" style={s.primaryButton}>Добавить машину</button>
        </form>
      )}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Гос. номер</th>
              <th style={s.th}>Модель</th>
              <th style={s.th}>Статус</th>
              {!readOnly && <th style={s.th}></th>}
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id}>
                <td style={s.td}>{v.plateNumber}</td>
                <td style={s.td}>{v.model}</td>
                <td style={s.td}>
                  {readOnly ? STATUS_LABEL[v.status] || v.status : (
                    <select style={s.inputSmall} value={v.status} onChange={(e) => updateStatus(v.id, e.target.value)}>
                      <option value="available">Свободна</option>
                      <option value="busy">Занята</option>
                      <option value="maintenance">На ремонте</option>
                    </select>
                  )}
                </td>
                {!readOnly && (
                  <td style={s.td}><button style={s.dangerButton} onClick={() => remove(v.id)}>Удалить</button></td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DriversTab({ readOnly }) {
  const [drivers, setDrivers] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [driverUsers, setDriverUsers] = useState([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ userId: "", vehicleId: "" });
  // Уволенных водителей (active=false) не удаляем — сервер не даст, если у
  // них есть история заказов (см. driversRouter.js) — а прячем из списка по
  // умолчанию, чтобы не мешались среди работающих; полный список — по галочке.
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [driversRes, vehiclesRes] = await Promise.all([
        ridesApiFetch("/api/v1/drivers"),
        ridesApiFetch("/api/v1/vehicles"),
      ]);
      setDrivers(driversRes.drivers);
      setVehicles(vehiclesRes.vehicles);
      // Список пользователей с ролью "Водитель" нужен только для формы
      // создания карточки — она есть только у диспетчера (readOnly её не
      // видит), и только диспетчеру доступен GET /api/v1/users вообще,
      // так что главному админу этот запрос смысла не имеет.
      if (!readOnly) {
        const usersRes = await ridesApiFetch("/api/v1/users");
        setDriverUsers(usersRes.users.filter((u) => u.role === "driver" && u.id));
      }
    } catch (err) {
      setError(err.message || "Не удалось загрузить данные");
    }
  }, [readOnly]);

  useEffect(() => { load(); }, [load]);

  const unassigned = driverUsers.filter((u) => !drivers.some((d) => d.userId === u.id));

  const add = async (e) => {
    e.preventDefault();
    if (!form.userId) return;
    try {
      await ridesApiPost("/api/v1/drivers", { userId: Number(form.userId), vehicleId: form.vehicleId ? Number(form.vehicleId) : null });
      setForm({ userId: "", vehicleId: "" });
      load();
    } catch (err) {
      setError(err.message || "Не удалось создать карточку водителя");
    }
  };

  const remove = async (id) => {
    try {
      await ridesApiDelete(`/api/v1/drivers/${id}`);
      load();
    } catch (err) {
      setError(err.message || "Не удалось удалить карточку водителя");
    }
  };

  const updateVehicle = async (id, vehicleId) => {
    try {
      await ridesApiPatch(`/api/v1/drivers/${id}`, { vehicleId: vehicleId || null });
      load();
    } catch (err) {
      setError(err.message || "Не удалось закрепить машину");
    }
  };

  const setArchived = async (id, active) => {
    try {
      await ridesApiPatch(`/api/v1/drivers/${id}`, { active });
      load();
    } catch (err) {
      setError(err.message || "Не удалось изменить статус водителя");
    }
  };

  const visibleDrivers = drivers.filter((d) => showArchived || d.active);
  const archivedCount = drivers.filter((d) => !d.active).length;

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      {!readOnly && (
        <form onSubmit={add} style={s.inlineForm}>
          <select style={s.inputSmall} value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
            <option value="">Выберите пользователя с ролью «Водитель»</option>
            {unassigned.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
          <select style={s.inputSmall} value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}>
            <option value="">— без машины —</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plateNumber}</option>)}
          </select>
          <button type="submit" style={s.primaryButton} disabled={!form.userId}>Создать карточку водителя</button>
        </form>
      )}
      {!readOnly && unassigned.length === 0 && driverUsers.length === 0 && (
        <p style={s.muted}>Сначала назначьте кому-нибудь роль «Водитель» на вкладке «Пользователи и роли».</p>
      )}
      {archivedCount > 0 && (
        <label style={{ ...s.muted, display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Показать уволенных ({archivedCount})
        </label>
      )}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Имя</th>
              <th style={s.th}>Телефон</th>
              <th style={s.th}>Машина</th>
              <th style={s.th}>Статус</th>
              {!readOnly && <th style={s.th}></th>}
            </tr>
          </thead>
          <tbody>
            {visibleDrivers.map((d) => (
              <tr key={d.id} style={d.active ? undefined : { opacity: 0.55 }}>
                <td style={s.td}>{d.name}</td>
                <td style={s.td}>{d.phone}</td>
                <td style={s.td}>
                  {readOnly || !d.active ? (d.vehiclePlate || "— не закреплена —") : (
                    <select style={s.inputSmall} value={d.vehicleId || ""} onChange={(e) => updateVehicle(d.id, e.target.value ? Number(e.target.value) : "")}>
                      <option value="">— не закреплена —</option>
                      {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plateNumber}</option>)}
                    </select>
                  )}
                </td>
                <td style={s.td}>{d.active ? d.status : "уволен"}</td>
                {!readOnly && (
                  <td style={{ ...s.td, display: "flex", gap: "8px" }}>
                    {d.active ? (
                      <button style={s.secondaryButton} onClick={() => setArchived(d.id, false)}>Уволить</button>
                    ) : (
                      <button style={s.secondaryButton} onClick={() => setArchived(d.id, true)}>Восстановить</button>
                    )}
                    <button style={s.dangerButton} onClick={() => remove(d.id)}>Удалить</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Журнал событий по заявкам — читает /api/v1/events (см.
// server/rides/eventsRouter.js). Виден и диспетчеру, и главному админу.
// Выгрузка в Excel собирается прямо здесь (XLSX уже в проекте).
function fmtDateTime(s) {
  if (!s) return "";
  // события пишутся в UTC (datetime('now')) — дорисовываем 'Z' и показываем в локали
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("ru-RU");
}

function fmtEventDetails(ev) {
  const p = ev.payload;
  if (!p || typeof p !== "object") return "";
  const parts = [];
  if (p.reason) parts.push(`причина: ${p.reason}`);
  if (p.from && p.to) parts.push(`${p.from} → ${p.to}`);
  if (p.previousStatus) parts.push(`было: ${p.previousStatus}`);
  if (p.driverId) parts.push(`водитель #${p.driverId}`);
  if (p.distanceKm != null) parts.push(`${p.distanceKm} км`);
  if (p.durationMin != null) parts.push(`~${p.durationMin} мин`);
  if (p.expectedCompletionAt) parts.push(`освободится ~${fmtDateTime(p.expectedCompletionAt)}`);
  if (p.source) parts.push(`расчёт: ${p.source}`);
  if (p.address) parts.push(p.address);
  if (Array.isArray(p.extraStops) && p.extraStops.length) parts.push(`+${p.extraStops.length} пункт(а)`);
  if (p.ok === false && p.reason == null) parts.push("маршрут не рассчитан");
  return parts.join("; ");
}

function JournalTab() {
  const [events, setEvents] = useState([]);
  const [eventTypes, setEventTypes] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ requestId: "", type: "", from: "", to: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      if (filters.requestId) qs.set("requestId", filters.requestId);
      if (filters.type) qs.set("type", filters.type);
      if (filters.from) qs.set("from", filters.from);
      if (filters.to) qs.set("to", filters.to + " 23:59:59");
      const { events: rows, eventTypes: types } = await ridesApiFetch(`/api/v1/events?${qs.toString()}`);
      setEvents(rows);
      setEventTypes(types || {});
    } catch (err) {
      setError(err.message || "Не удалось загрузить журнал");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const setFilter = (patch) => setFilters((prev) => ({ ...prev, ...patch }));

  const exportExcel = () => {
    const aoa = [
      ["Дата и время", "Заявка №", "Событие", "Кто", "Роль", "Маршрут", "Статус заявки", "Детали"],
      ...events.map((ev) => [
        fmtDateTime(ev.createdAt),
        ev.requestId,
        ev.typeLabel,
        ev.actorName || ev.actorEmail || "",
        ev.actorRole || "",
        [ev.fromAddress, ev.toAddress].filter(Boolean).join(" → "),
        ev.requestStatus || "",
        fmtEventDetails(ev),
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 19 }, { wch: 9 }, { wch: 26 }, { wch: 20 }, { wch: 12 }, { wch: 40 }, { wch: 16 }, { wch: 44 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Журнал");
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Журнал_поездок_${today}.xlsx`);
  };

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      <div style={s.inlineForm}>
        <input style={{ ...s.inputSmall, width: "110px" }} placeholder="Заявка №" value={filters.requestId}
          onChange={(e) => setFilter({ requestId: e.target.value.replace(/\D/g, "") })} />
        <select style={{ ...s.inputSmall, width: "auto" }} value={filters.type} onChange={(e) => setFilter({ type: e.target.value })}>
          <option value="">— все события —</option>
          {Object.entries(eventTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input style={{ ...s.inputSmall, width: "auto" }} type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} />
        <input style={{ ...s.inputSmall, width: "auto" }} type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} />
        <button style={s.secondaryButton} onClick={() => setFilters({ requestId: "", type: "", from: "", to: "" })}>Сбросить</button>
        <button style={s.primaryButton} onClick={exportExcel} disabled={!events.length}>Выгрузить в Excel</button>
      </div>

      {loading ? <p style={s.muted}>Загрузка...</p> : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Дата и время</th>
                <th style={s.th}>Заявка №</th>
                <th style={s.th}>Событие</th>
                <th style={s.th}>Кто</th>
                <th style={s.th}>Маршрут</th>
                <th style={s.th}>Детали</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td style={s.td} colSpan={6}><span style={s.muted}>Событий нет</span></td></tr>
              )}
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td style={{ ...s.td, whiteSpace: "nowrap" }}>{fmtDateTime(ev.createdAt)}</td>
                  <td style={s.td}>{ev.requestId}</td>
                  <td style={s.td}>{ev.typeLabel}</td>
                  <td style={s.td}>{ev.actorName || ev.actorEmail || "—"}</td>
                  <td style={s.td}>{[ev.fromAddress, ev.toAddress].filter(Boolean).join(" → ")}</td>
                  <td style={s.td}>{fmtEventDetails(ev)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function RidesAdminPage() {
  const isSiteAdmin = getAuth().currentUser?.email?.toLowerCase() === SITE_ADMIN_EMAIL;
  const [role, setRole] = useState(undefined); // undefined = проверяется; своя роль по rides.users (у site admin — null)
  const [tab, setTab] = useState(null);

  useEffect(() => {
    ridesApiFetch("/api/v1/users/me")
      .then(({ user }) => {
        setRole(user?.role || null);
        setTab("users");
      })
      .catch(() => { setRole(null); setTab("users"); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (tab === null) return <div style={{ padding: 30 }}>Загрузка...</div>;

  const isDispatcher = role === "dispatcher";
  // Справочники доступны и диспетчеру (полноценно), и главному админу
  // (только для чтения) — readOnly включается именно для него.
  const readOnly = isSiteAdmin && !isDispatcher;

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Администрирование системы поездок</h1>
        <div style={s.headerRight}>
          {isDispatcher && <Link to="/dispatcher" style={s.link}>← Панель диспетчера</Link>}
          <LogoutButton />
        </div>
      </div>
      <div style={s.tabs}>
        <button style={tab === "users" ? s.tabActive : s.tab} onClick={() => setTab("users")}>
          {isSiteAdmin ? "Роли" : "Пользователи"}
        </button>
        <button style={tab === "drivers" ? s.tabActive : s.tab} onClick={() => setTab("drivers")}>Водители</button>
        <button style={tab === "vehicles" ? s.tabActive : s.tab} onClick={() => setTab("vehicles")}>Машины</button>
        <button style={tab === "journal" ? s.tabActive : s.tab} onClick={() => setTab("journal")}>Журнал</button>
      </div>
      {tab === "users" && (isSiteAdmin ? <RoleAssignmentTab /> : <UserCardsTab />)}
      {tab === "drivers" && <DriversTab readOnly={readOnly} />}
      {tab === "vehicles" && <VehiclesTab readOnly={readOnly} />}
      {tab === "journal" && <JournalTab />}
    </div>
  );
}

const s = {
  page: { padding: "16px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "1100px", margin: "0 auto", boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "16px" },
  headerRight: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "12px" },
  link: { color: "#1976d2", fontSize: "13px", textDecoration: "none" },
  title: { fontSize: "clamp(18px, 5vw, 22px)", margin: 0 },
  tabs: { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "20px" },
  tab: { background: "#fff", border: "1px solid #ccc", borderRadius: "6px", padding: "8px 16px", cursor: "pointer", fontSize: "13px" },
  tabActive: { background: "#1976d2", color: "#fff", border: "1px solid #1976d2", borderRadius: "6px", padding: "8px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 600 },

  error: { background: "#fff0f0", color: "#c00", borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px" },
  muted: { color: "#888", fontSize: "13px", marginBottom: "10px" },

  inlineForm: { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px", alignItems: "center" },

  tableWrap: { overflowX: "auto", WebkitOverflowScrolling: "touch" },
  table: { width: "100%", minWidth: "480px", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "8px", borderBottom: "2px solid #ddd", background: "#fafafa", fontSize: "13px", whiteSpace: "nowrap" },
  td: { padding: "8px", borderBottom: "1px solid #eee", fontSize: "13px" },

  inputSmall: { padding: "6px 8px", borderRadius: "6px", border: "1px solid #ccc", fontSize: "13px", width: "100%", boxSizing: "border-box" },
  primaryButton: { background: "#1976d2", color: "#fff", border: "none", borderRadius: "6px", padding: "8px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
  secondaryButton: { background: "#fff", border: "1px solid #ccc", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px" },
  dangerButton: { background: "#fff0f0", color: "#c00", border: "1px solid #f5b5b5", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px" },
};
