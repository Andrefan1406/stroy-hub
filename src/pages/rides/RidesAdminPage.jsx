// Админка системы поездок и ролей сайта — общая страница для двух разных людей, у
// каждого своя первая вкладка:
// - главный админ сайта назначает РОЛЬ и сразу заполняет карточку человека — ФИО,
//   телефон, должность (RoleAssignmentTab), и ведёт исполнителей по заявкам на
//   бурение (DrillingCompaniesTab);
// - диспетчер видит имена и телефоны людей поездок только для чтения (UserCardsTab)
//   и полноценно ведёт справочники водителей/машин; главный админ эти
//   справочники только читает (readOnly).
// Кто есть кто — определяем по email (SITE_ADMIN_EMAIL) и по собственной
// роли из GET /api/v1/users/me; бэкенд разграничивает то же самое
// по-настоящему (requireSiteAdmin/requireRoleOrSiteAdmin, см. server/rides/*.js).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getAuth } from "firebase/auth";
import * as XLSX from "xlsx";
import { ridesApiDelete, ridesApiFetch, ridesApiPatch, ridesApiPost, ridesApiPut } from "../../rides/api";
import LogoutButton from "../../rides/LogoutButton";
import AdminPanelLinks from "../../rides/AdminPanelLinks";
import { SITE_ADMIN_EMAIL } from "../../rides/constants";
import { fetchDrillingAdmin, saveCompany } from "../drilling/drillingApi";

const ROLE_OPTIONS = [
  { value: "", label: "— нет доступа —" },
  { value: "employee", label: "Сотрудник (пассажир)" },
  { value: "dispatcher", label: "Диспетчер" },
  { value: "driver", label: "Водитель" },
  { value: "staff", label: "Сотрудник (без транспорта)" },
  { value: "chief_engineer", label: "Главный инженер" },
  { value: "prom_alyans", label: "Пром Альянс" },
  { value: "driller", label: "Бурильщик" },
];

// Совпадает с серверными правилами (server/rides/usersRouter.js): доступ ко всему сайту у
// ролей по бурению зашит, телефон обязателен ролям поездок.
const FIXED_SITE_ACCESS = { staff: true, chief_engineer: true, prom_alyans: true, driller: false };
const PHONE_REQUIRED_ROLES = ["employee", "dispatcher", "driver"];

// Таблица ролей всегда во всю ширину экрана, без горизонтальной прокрутки (кнопка «Сохранить» и
// «Доступ» не уезжают за край). «Доступ» и «Сохранить» занимают фиксированную долю, остальное
// делится по весам. Раскрытый столбец (клик по шапке или фокус в поле) получает вес в
// EXPAND_FACTOR раз больше — длинный текст виден целиком, соседи сжимаются.
const FIXED_SHARE = { access: 9, save: 9 }; // проценты ширины таблицы
const EXPAND_FACTOR = 3;
// Отличается ли черновик строки от того, что сохранено на сервере.
function isRoleDraftDirty(user, draft) {
  if (!draft) return false;
  return draft.role !== (user.role || "")
    || draft.name !== (user.name || "")
    || draft.phone !== (user.phone || "")
    || draft.position !== (user.position || "")
    || String(draft.companyId || "") !== String(user.companyId || "")
    || (!(draft.role in FIXED_SITE_ACCESS) && !!draft.fullSiteAccess !== !!user.fullSiteAccess);
}

const ROLE_COLUMNS = [
  { key: "email", title: "Email", weight: 1.3 },
  { key: "role", title: "Роль", weight: 1.2 },
  { key: "name", title: "ФИО", weight: 1 },
  { key: "phone", title: "Телефон", weight: 0.8 },
  { key: "position", title: "Должность", weight: 1 },
  { key: "company", title: "Компания", weight: 0.9 },
  { key: "access", title: "Доступ ко всему сайту", fixed: true },
  { key: "save", title: "", fixed: true },
];

function roleLabel(role) {
  return ROLE_OPTIONS.find((o) => o.value === role)?.label || "—";
}

// Расстояние Левенштейна — для поиска опечаток в доменах почты (gmail.ru, gmai.lcom, vkdtvgroup.kz).
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// Предупреждения по справочнику: возможные опечатки в домене email (домен редкий, но похож на
// частый) и одно и то же ФИО у нескольких адресов. Только подсказки — сохранять не мешают.
function directoryWarnings(users, drafts) {
  const out = {};
  const add = (email, text) => { (out[email] = out[email] || []).push(text); };

  const domainOf = (email) => (email.split("@")[1] || "").toLowerCase();
  const counts = {};
  for (const u of users) counts[domainOf(u.email)] = (counts[domainOf(u.email)] || 0) + 1;
  const common = Object.keys(counts).filter((d) => counts[d] >= 3);
  for (const u of users) {
    const d = domainOf(u.email);
    if (!d || common.includes(d)) continue;
    const close = common.find((c) => editDistance(d, c) <= 2);
    if (close) add(u.email, `Возможная опечатка в домене: «${d}», обычно «${close}»`);
  }

  const byName = {};
  for (const u of users) {
    const name = (drafts[u.email]?.name ?? u.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (name.length > 3) (byName[name] = byName[name] || []).push(u.email);
  }
  for (const emails of Object.values(byName)) {
    if (emails.length < 2) continue;
    for (const e of emails) add(e, `То же ФИО у: ${emails.filter((x) => x !== e).join(", ")}`);
  }
  return out;
}

// Главный админ: роль и карточка человека одной строкой — ФИО, телефон, должность.
// Телефон нужен ролям поездок, должность — главному инженеру (подпись в Word),
// бурильщику — компания-субподрядчик. «Доступ ко всему сайту» у ролей по заявкам на
// бурение зашит (см. server/rides/usersRouter.js): бурильщик заперт на своей странице,
// остальные пользуются всем сайтом. Если роль не выбрана, но карточка заполнена —
// сохраняется карточка с ролью «Сотрудник (без транспорта)»; пустая строка без роли удаляет запись.
function RoleAssignmentTab() {
  const [users, setUsers] = useState([]);
  const [drafts, setDrafts] = useState({}); // email -> {role, fullSiteAccess, name, phone, position, companyId}
  const [companies, setCompanies] = useState([]); // субподрядчики (линия 2) для бурильщика
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rowErrors, setRowErrors] = useState({}); // email -> текст ошибки в строке
  const [rowNotes, setRowNotes] = useState({}); // email -> пояснение после сохранения
  const [saving, setSaving] = useState({}); // email -> true, пока идёт сохранение этой строки
  const [savedEmails, setSavedEmails] = useState({}); // email -> true, пока показываем «Сохранено»
  const [selected, setSelected] = useState({}); // email -> true, строки для массового назначения роли
  const [bulk, setBulk] = useState({ role: "staff", companyId: "" });
  const [bulkMsg, setBulkMsg] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [wideCol, setWideCol] = useState(null); // ключ раскрытого столбца (ROLE_COLUMNS)
  // актуальные значения для асинхронных обработчиков (иначе после перезагрузки списка теряются правки)
  const usersRef = useRef([]);
  const draftsRef = useRef({});
  usersRef.current = users;
  draftsRef.current = drafts;
  const resetRef = useRef(new Set()); // email только что сохранённых строк: их черновик после перезагрузки берём с сервера

  const widthOf = (col) => {
    if (col.fixed) return `${FIXED_SHARE[col.key]}%`;
    const flex = ROLE_COLUMNS.filter((c) => !c.fixed);
    const weightOf = (c) => c.weight * (wideCol === c.key ? EXPAND_FACTOR : 1);
    const total = flex.reduce((sum, c) => sum + weightOf(c), 0);
    const room = 100 - Object.values(FIXED_SHARE).reduce((sum, v) => sum + v, 0);
    return `${((weightOf(col) / total) * room).toFixed(2)}%`;
  };
  const focusCol = (key) => setWideCol(key); // ввод в поле раскрывает его столбец

  const draftFromUser = (u) => ({
    role: u.role || "", fullSiteAccess: u.fullSiteAccess, name: u.name || "", phone: u.phone || "",
    position: u.position || "", companyId: u.companyId || "",
  });

  // Загрузка списка. При тихой перезагрузке (после сохранения) несохранённые правки в ДРУГИХ
  // строках не затираются — раньше быстрые правки подряд пропадали.
  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const [{ users: rows }, drillingAdmin] = await Promise.all([
        ridesApiFetch("/api/v1/users"),
        fetchDrillingAdmin().catch(() => ({ companies: [] })),
      ]);
      const prevUsers = usersRef.current;
      const prevDrafts = draftsRef.current;
      setUsers(rows);
      setCompanies(drillingAdmin.companies.filter((c) => c.line === 2 && c.active));
      const nextDrafts = {};
      for (const u of rows) {
        const old = prevUsers.find((x) => x.email === u.email);
        const keep = silent && prevDrafts[u.email] && old && !resetRef.current.has(u.email) && isRoleDraftDirty(old, prevDrafts[u.email]);
        nextDrafts[u.email] = keep ? prevDrafts[u.email] : draftFromUser(u);
      }
      resetRef.current.clear();
      setDrafts(nextDrafts);
    } catch (err) {
      setError(err.message || "Не удалось загрузить список пользователей");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setDraft = (email, patch) => {
    setDrafts((prev) => ({ ...prev, [email]: { ...prev[email], ...patch } }));
    setSavedEmails((prev) => (prev[email] ? { ...prev, [email]: false } : prev));
    setRowErrors((prev) => (prev[email] ? { ...prev, [email]: "" } : prev));
    setRowNotes((prev) => (prev[email] ? { ...prev, [email]: "" } : prev));
  };

  // Роль, с которой сохранится строка: выбранная, а при заполненной карточке без роли — «Сотрудник (без транспорта)».
  const effectiveRole = (d) => d.role || ((d.name || d.phone || d.position).trim() ? "staff" : "");

  // Сохраняет одну строку. reload=false — для массового сохранения (список перечитывается один раз в конце).
  const saveOne = async (email, { reload = true } = {}) => {
    const draft = draftsRef.current[email];
    const user = usersRef.current.find((x) => x.email === email);
    const fail = (msg) => { setRowErrors((prev) => ({ ...prev, [email]: msg })); return false; };
    setRowErrors((prev) => ({ ...prev, [email]: "" }));
    setRowNotes((prev) => ({ ...prev, [email]: "" }));
    setSavedEmails((prev) => ({ ...prev, [email]: false }));
    const role = effectiveRole(draft);
    if (role) {
      if (!draft.name.trim()) return fail("Укажите ФИО");
      if (PHONE_REQUIRED_ROLES.includes(role) && !draft.phone.trim()) return fail("Укажите телефон");
      if (role === "chief_engineer" && !draft.position.trim()) return fail("Укажите должность — она печатается в подписи");
      if (role === "driller" && !draft.companyId) return fail("Выберите компанию-субподрядчика");
    } else if (!user?.role) {
      return fail("Нечего сохранять: заполните карточку или выберите роль");
    }
    setSaving((prev) => ({ ...prev, [email]: true }));
    try {
      if (!role) {
        await ridesApiDelete(`/api/v1/users/${encodeURIComponent(email)}`);
        setRowNotes((prev) => ({ ...prev, [email]: "Запись удалена: роли и карточки у этого пользователя больше нет." }));
      } else {
        await ridesApiPut(`/api/v1/users/${encodeURIComponent(email)}`, {
          role,
          fullSiteAccess: !!draft.fullSiteAccess,
          name: draft.name,
          phone: draft.phone,
          position: draft.position,
          companyId: role === "driller" ? Number(draft.companyId) : null,
        });
        if (!draft.role) setRowNotes((prev) => ({ ...prev, [email]: "Роль не выбрана — сохранена карточка с ролью «Сотрудник (без транспорта)»." }));
      }
      resetRef.current.add(email);
      if (reload) await load(true);
      setSavedEmails((prev) => ({ ...prev, [email]: true }));
      setTimeout(() => setSavedEmails((prev) => ({ ...prev, [email]: false })), 4000);
      return true;
    } catch (err) {
      return fail(err.message || "Не удалось сохранить пользователя");
    } finally {
      setSaving((prev) => ({ ...prev, [email]: false }));
    }
  };

  const dirtyEmails = users.filter((u) => isRoleDraftDirty(u, drafts[u.email])).map((u) => u.email);
  const selectedEmails = users.filter((u) => selected[u.email]).map((u) => u.email);

  // Сохранить все изменённые строки подряд; в конце — один итог.
  const saveAll = async () => {
    setBulkSaving(true);
    setBulkMsg("");
    let ok = 0;
    const failed = [];
    for (const email of dirtyEmails) {
      if (await saveOne(email, { reload: false })) ok += 1; else failed.push(email);
    }
    await load(true);
    setBulkSaving(false);
    setBulkMsg(failed.length ? `Сохранено: ${ok}. С ошибкой: ${failed.length} (см. красные строки).` : `Сохранено: ${ok}.`);
  };

  // Массовое назначение роли: меняет черновики выбранных строк, сохраняются они кнопкой «Сохранить все».
  const applyBulkRole = () => {
    for (const email of selectedEmails) {
      setDraft(email, { role: bulk.role, companyId: bulk.role === "driller" ? bulk.companyId : "" });
    }
    setBulkMsg(`Роль подставлена в строках: ${selectedEmails.length}. Заполните недостающие поля и нажмите «Сохранить все изменения».`);
  };

  const warnings = useMemo(() => directoryWarnings(users, drafts), [users, drafts]);

  if (loading) return <p style={s.muted}>Загрузка...</p>;

  const allSelected = users.length > 0 && selectedEmails.length === users.length;

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      <p style={s.muted}>
        Роль и карточка заполняются здесь же: ФИО нужно всем, телефон — ролям поездок, должность — главному инженеру
        (печатается в подписи заявки на бурение). Главным инженером может быть только один человек. Если роль не
        выбрана, а карточка заполнена, сохранится карточка с ролью «Сотрудник (без транспорта)». Авторам заявок на
        бурение нужна карточка с ФИО и должностью.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", marginBottom: "12px", padding: "10px 12px", background: "#f4f6fa", border: "1px solid #dde2ea", borderRadius: "8px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
          <input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? Object.fromEntries(users.map((u) => [u.email, true])) : {})} />
          Выбрать всех
        </label>
        {selectedEmails.length > 0 && (
          <>
            <b style={{ fontSize: "13px" }}>Выбрано: {selectedEmails.length}</b>
            <select style={{ ...s.inputSmall, width: "auto" }} value={bulk.role} onChange={(e) => setBulk({ ...bulk, role: e.target.value })} aria-label="Роль для выбранных">
              {ROLE_OPTIONS.filter((o) => o.value && o.value !== "chief_engineer").map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {bulk.role === "driller" && (
              <select style={{ ...s.inputSmall, width: "auto" }} value={bulk.companyId} onChange={(e) => setBulk({ ...bulk, companyId: e.target.value })} aria-label="Компания для выбранных">
                <option value="">— компания —</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button style={s.secondaryButton} onClick={applyBulkRole}>Назначить роль выбранным</button>
            <button style={s.secondaryButton} onClick={() => setSelected({})}>Снять выбор</button>
          </>
        )}
        <button style={{ ...s.primaryButton, marginLeft: "auto", opacity: dirtyEmails.length && !bulkSaving ? 1 : 0.5 }} disabled={!dirtyEmails.length || bulkSaving} onClick={saveAll}>
          {bulkSaving ? "Сохраняю…" : `Сохранить все изменения (${dirtyEmails.length})`}
        </button>
        {bulkMsg && <span style={{ fontSize: "13px", color: "#1d6b3a", flexBasis: "100%" }} role="status">{bulkMsg}</span>}
      </div>
      <div style={s.tableWrap}>
        <table style={{ ...s.table, minWidth: 0, tableLayout: "fixed", width: "100%" }}>
          <colgroup>
            {ROLE_COLUMNS.map((c) => <col key={c.key} style={{ width: widthOf(c), transition: "width 0.15s" }} />)}
          </colgroup>
          <thead>
            <tr>
              {ROLE_COLUMNS.map((c) => (
                <th
                  key={c.key}
                  style={{ ...s.th, whiteSpace: c.fixed ? "normal" : "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: c.fixed ? "default" : "pointer", userSelect: "none" }}
                  title={c.fixed ? undefined : "Нажмите, чтобы расширить или сузить столбец"}
                  aria-expanded={c.fixed ? undefined : wideCol === c.key}
                  onClick={c.fixed ? undefined : () => setWideCol((cur) => (cur === c.key ? null : c.key))}
                >
                  {c.title}{!c.fixed && <span style={{ color: "#888", marginLeft: "4px" }}>{wideCol === c.key ? "◂" : "▸"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const draft = drafts[u.email] || { role: "", fullSiteAccess: false, name: "", phone: "", position: "", companyId: "" };
              const role = effectiveRole(draft);
              const fixed = role in FIXED_SITE_ACCESS;
              const warn = warnings[u.email];
              return (
                <React.Fragment key={u.email}>
                  <tr>
                    <td style={{ ...s.td, overflowWrap: "anywhere", wordBreak: "break-word" }} title={u.email} onClick={() => focusCol("email")}>
                      <label style={{ display: "flex", gap: "6px", alignItems: "flex-start" }}>
                        <input type="checkbox" checked={!!selected[u.email]} onChange={(e) => setSelected((prev) => ({ ...prev, [u.email]: e.target.checked }))} aria-label={`Выбрать ${u.email}`} style={{ marginTop: "2px" }} />
                        <span>{u.email}</span>
                      </label>
                      {warn && <div style={{ color: "#8a5a00", fontSize: "11px", marginTop: "2px" }} title={warn.join("\n")}>⚠ {warn[0]}</div>}
                    </td>
                    <td style={s.td}>
                      <select style={s.inputSmall} value={draft.role} onFocus={() => focusCol("role")} onChange={(e) => setDraft(u.email, { role: e.target.value })}>
                        {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                    <td style={s.td}>
                      <input style={s.inputSmall} value={draft.name} title={draft.name} onFocus={() => focusCol("name")} onChange={(e) => setDraft(u.email, { name: e.target.value })} />
                    </td>
                    <td style={s.td}>
                      <input style={s.inputSmall} value={draft.phone} title={draft.phone} onFocus={() => focusCol("phone")} onChange={(e) => setDraft(u.email, { phone: e.target.value })} />
                    </td>
                    <td style={s.td}>
                      <input style={s.inputSmall} value={draft.position} title={draft.position} onFocus={() => focusCol("position")} onChange={(e) => setDraft(u.email, { position: e.target.value })} />
                    </td>
                    <td style={s.td}>
                      {draft.role === "driller" ? (
                        <select style={s.inputSmall} value={draft.companyId} onFocus={() => focusCol("company")} onChange={(e) => setDraft(u.email, { companyId: e.target.value })}>
                          <option value="">— выберите —</option>
                          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      ) : "—"}
                    </td>
                    <td style={{ ...s.td, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={fixed ? FIXED_SITE_ACCESS[role] : !!draft.fullSiteAccess}
                        disabled={!role || fixed}
                        title={fixed ? "Для этой роли доступ задан автоматически" : undefined}
                        onChange={(e) => setDraft(u.email, { fullSiteAccess: e.target.checked })}
                      />
                    </td>
                    <td style={s.td}>
                      {(() => {
                        const dirty = isRoleDraftDirty(u, draft);
                        const busy = !!saving[u.email];
                        const failed = !!rowErrors[u.email];
                        let label = "Сохранить";
                        let look = s.secondaryButton; // нечего сохранять
                        if (busy) { label = "Сохраняю…"; look = { ...s.primaryButton, opacity: 0.7 }; }
                        else if (failed) { label = "Не сохранено"; look = s.dangerButton; }
                        else if (savedEmails[u.email] && !dirty) { label = "✓ Сохранено"; look = { ...s.secondaryButton, background: "#e8f5e9", color: "#1d6b3a", borderColor: "#a5d6a7", fontWeight: 600 }; }
                        else if (dirty) { label = "Сохранить"; look = s.primaryButton; }
                        return (
                          <button
                            style={{ ...look, width: "100%", padding: "6px 2px", fontSize: "12px", whiteSpace: "nowrap" }}
                            disabled={busy || bulkSaving || (!dirty && !failed)}
                            title={dirty ? "Есть несохранённые изменения" : failed ? rowErrors[u.email] : savedEmails[u.email] ? "Изменения сохранены" : "Нет изменений"}
                            onClick={() => saveOne(u.email)}
                          >
                            {label}
                          </button>
                        );
                      })()}
                    </td>
                  </tr>
                  {rowErrors[u.email] && (
                    <tr><td style={{ ...s.td, color: "#c00", background: "#fff6f6" }} colSpan={8}>{u.email}: {rowErrors[u.email]}</td></tr>
                  )}
                  {rowNotes[u.email] && !rowErrors[u.email] && (
                    <tr><td style={{ ...s.td, color: "#1d6b3a", background: "#f3faf5" }} colSpan={8}>{u.email}: {rowNotes[u.email]}</td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Диспетчер: список людей системы поездок только для чтения (имя и телефон) —
// карточки заполняет и правит главный админ на вкладке «Роли».
function UserCardsTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    ridesApiFetch("/api/v1/users")
      .then(({ users: rows }) => setUsers(rows))
      .catch((err) => setError(err.message || "Не удалось загрузить список пользователей"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={s.muted}>Загрузка...</p>;

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      <p style={s.muted}>Имя и телефон вписывает главный администратор сайта при назначении роли — здесь они только для просмотра.</p>
      {users.length === 0 && <p style={s.muted}>Пока никому не назначена роль — это делает главный администратор сайта.</p>}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Email</th>
              <th style={s.th}>Имя</th>
              <th style={s.th}>Телефон</th>
              <th style={s.th}>Роль</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.email}>
                <td style={s.td}>{u.email}</td>
                <td style={s.td}>{u.name || "—"}</td>
                <td style={s.td}>{u.phone || "—"}</td>
                <td style={s.td}>{roleLabel(u.role)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Главный админ: исполнители по заявкам на бурение — название (для колонтитула Word),
// адресат («Директору …») и линия. Субподрядчики добавляются в линию 2; людей к ним
// привязывают на вкладке «Роли» (роль «Бурильщик» + компания), здесь они только показаны.
function DrillingCompaniesTab() {
  const [companies, setCompanies] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fresh, setFresh] = useState({ name: "", addressee: "" });

  const apply = (list) => {
    setCompanies(list);
    setDrafts(Object.fromEntries(list.map((c) => [c.id, { name: c.name, addressee: c.addressee, active: c.active }])));
  };

  useEffect(() => {
    fetchDrillingAdmin().then((d) => apply(d.companies)).catch((err) => setError(err.message));
  }, []);

  const run = async (fn, okText) => {
    setError("");
    setNotice("");
    try {
      apply((await fn()).companies);
      setNotice(okText);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  if (!companies) return error ? <div style={s.error}>{error}</div> : <p style={s.muted}>Загрузка...</p>;

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      {notice && <p style={{ ...s.muted, color: "#1d6b3a" }}>{notice}</p>}
      <p style={s.muted}>
        Заявка идёт: главный инженер → линия 1 (Пром Альянс) → линия 2 (субподрядчики; принимает первый, автору возвращают,
        когда отказали все). Людей назначайте на вкладке «Роли». «Согласовано» в Word берётся из карточки главного инженера.
      </p>
      <div style={s.tableWrap}>
        <table style={{ ...s.table, minWidth: "820px" }}>
          <thead>
            <tr>
              <th style={s.th}>Линия</th>
              <th style={s.th}>Название (в колонтитуле)</th>
              <th style={s.th}>Адресат в шапке Word</th>
              <th style={s.th}>Активна</th>
              <th style={s.th}>Ответственные (по ролям)</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => {
              const d = drafts[c.id] || {};
              return (
                <tr key={c.id}>
                  <td style={s.td}>{c.line === 1 ? "1 — своя компания" : "2 — субподрядчик"}</td>
                  <td style={s.td}><input style={s.inputSmall} value={d.name || ""} onChange={(e) => setDrafts((p) => ({ ...p, [c.id]: { ...d, name: e.target.value } }))} /></td>
                  <td style={s.td}><input style={s.inputSmall} value={d.addressee || ""} onChange={(e) => setDrafts((p) => ({ ...p, [c.id]: { ...d, addressee: e.target.value } }))} /></td>
                  <td style={{ ...s.td, textAlign: "center" }}>
                    <input type="checkbox" checked={!!d.active} onChange={(e) => setDrafts((p) => ({ ...p, [c.id]: { ...d, active: e.target.checked } }))} />
                  </td>
                  <td style={s.td}>{c.users.length ? c.users.join(", ") : <span style={s.muted}>никто не назначен</span>}</td>
                  <td style={s.td}>
                    <button style={s.secondaryButton} onClick={() => run(() => saveCompany({ id: c.id, line: c.line, ...d }), "Сохранено")}>Сохранить</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3 style={{ fontSize: "15px", margin: "20px 0 8px" }}>Новый субподрядчик</h3>
      <div style={s.inlineForm}>
        <input style={{ ...s.inputSmall, width: "200px" }} placeholder="Название" value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} />
        <input style={{ ...s.inputSmall, width: "280px" }} placeholder='Адресат, например: Директору ТОО "…"' value={fresh.addressee} onChange={(e) => setFresh({ ...fresh, addressee: e.target.value })} />
        <button style={s.primaryButton} onClick={async () => { if (await run(() => saveCompany({ ...fresh, line: 2, active: true }), "Субподрядчик добавлен")) setFresh({ name: "", addressee: "" }); }}>
          Добавить
        </button>
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
              <th style={s.th}>Telegram</th>
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
                <td style={s.td}>{d.telegramLinked ? "подключён" : "—"}</td>
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
          <AdminPanelLinks style={s.link} />
          <LogoutButton />
        </div>
      </div>
      <div style={s.tabs}>
        <button style={tab === "users" ? s.tabActive : s.tab} onClick={() => setTab("users")}>
          {isSiteAdmin ? "Роли" : "Пользователи"}
        </button>
        {isSiteAdmin && <button style={tab === "companies" ? s.tabActive : s.tab} onClick={() => setTab("companies")}>Исполнители по бурению</button>}
        <button style={tab === "drivers" ? s.tabActive : s.tab} onClick={() => setTab("drivers")}>Водители</button>
        <button style={tab === "vehicles" ? s.tabActive : s.tab} onClick={() => setTab("vehicles")}>Машины</button>
        <button style={tab === "journal" ? s.tabActive : s.tab} onClick={() => setTab("journal")}>Журнал</button>
      </div>
      {tab === "users" && (isSiteAdmin ? <RoleAssignmentTab /> : <UserCardsTab />)}
      {tab === "companies" && isSiteAdmin && <DrillingCompaniesTab />}
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
