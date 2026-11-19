// Админка заявок на бурение и резку: исполнители по линиям и их ответственные,
// справочник сотрудников для подписей Word, подпись «Согласовано».
// Линия 1 — своя компания (любой отказ передаёт заявку в линию 2), линия 2 —
// субподрядчики (принимает первый; возврат автору — когда отказали все).
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import {
  addCompanyUser, deleteStaff, fetchDrillingAdmin, removeCompanyUser, saveApprover, saveCompany, saveStaff,
} from "./drillingApi";

const emptyCompany = { name: "", addressee: "", line: 2, active: true };
const emptyStaff = { email: "", fullName: "", position: "", organization: "" };

const TextField = ({ label, value, onChange, placeholder, id }) => (
  <div className={css.field} style={{ minWidth: 200, flex: "1 1 200px" }}>
    <label className={css.label} htmlFor={id}>{label}</label>
    <input id={id} className={css.input} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
  </div>
);

const CompanyCard = ({ company, onSave, onAddUser, onRemoveUser }) => {
  const [draft, setDraft] = useState(company);
  const [email, setEmail] = useState("");
  useEffect(() => setDraft(company), [company]);
  const dirty = JSON.stringify({ ...draft, users: 0 }) !== JSON.stringify({ ...company, users: 0 });
  return (
    <div className={styles.adminCard}>
      <div className={styles.inline}>
        <TextField id={`n${company.id}`} label="Название (для колонтитула)" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
        <TextField id={`a${company.id}`} label="Адресат в шапке Word" value={draft.addressee} onChange={(v) => setDraft({ ...draft, addressee: v })} />
        <div className={css.field}>
          <label className={css.label} htmlFor={`l${company.id}`}>Линия</label>
          <select id={`l${company.id}`} className={css.input} value={draft.line} onChange={(e) => setDraft({ ...draft, line: Number(e.target.value) })}>
            <option value={1}>1 — своя компания</option>
            <option value={2}>2 — субподрядчик</option>
          </select>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 48 }}>
          <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Активна
        </label>
        <button className={styles.smallBtn} disabled={!dirty} onClick={() => onSave(draft)}>Сохранить</button>
      </div>
      <div className={styles.chips}>
        {company.users.length === 0 && <span className={styles.hint}>Ответственные не назначены — компания не получает заявки.</span>}
        {company.users.map((u) => (
          <span key={u} className={styles.chip}>{u}
            <button className={styles.chipX} aria-label={`Убрать ${u}`} onClick={() => onRemoveUser(company.id, u)}>×</button>
          </span>
        ))}
      </div>
      <form className={styles.inline} onSubmit={(e) => { e.preventDefault(); if (email.trim()) { onAddUser(company.id, email.trim()); setEmail(""); } }}>
        <TextField id={`e${company.id}`} label="Добавить ответственного (email)" value={email} onChange={setEmail} placeholder="name@company.kz" />
        <button className={styles.smallBtn} type="submit">Добавить</button>
      </form>
    </div>
  );
};

const DrillingAdminPage = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newCompany, setNewCompany] = useState(emptyCompany);
  const [staff, setStaff] = useState(emptyStaff);
  const [approver, setApprover] = useState({ fullName: "", position: "" });

  const load = useCallback(async () => {
    try {
      const d = await fetchDrillingAdmin();
      setData(d);
      setApprover(d.approver);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, okText) => {
    setError("");
    setNotice("");
    try {
      const res = await fn();
      setData((cur) => ({ ...cur, ...res }));
      if (res.approver) setApprover(res.approver);
      if (okText) setNotice(okText);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to="/admin" className={css.back}>← Назад</Link>
        <h1 className={css.title}>Заявки на бурение и резку</h1>
        <p className={styles.hint}>
          Заявка сначала приходит всем ответственным линии 1 — кто первый ответил, тот и фиксируется. Отказ передаёт заявку
          в линию 2 (все субподрядчики равнозначны). Если отказали все субподрядчики — заявка возвращается автору.
        </p>
        {error && <div className={styles.error}>{error}</div>}
        {notice && <div className={styles.ok}>{notice}</div>}
        {!data && !error && <div className={styles.empty}>Загрузка…</div>}

        {data && (
          <>
            <h2 className={styles.sectionTitle}>Исполнители и ответственные</h2>
            {data.companies.map((c) => (
              <CompanyCard key={c.id} company={c}
                onSave={(draft) => run(() => saveCompany(draft), "Сохранено")}
                onAddUser={(id, email) => run(() => addCompanyUser(id, email))}
                onRemoveUser={(id, email) => run(() => removeCompanyUser(id, email))} />
            ))}

            <div className={styles.adminCard}>
              <h3 className={css.cardTitle}>Новый исполнитель (субподрядчик)</h3>
              <div className={styles.inline}>
                <TextField id="nc-name" label="Название" value={newCompany.name} onChange={(v) => setNewCompany({ ...newCompany, name: v })} placeholder="Жеңіс групп" />
                <TextField id="nc-addr" label="Адресат в шапке Word" value={newCompany.addressee} onChange={(v) => setNewCompany({ ...newCompany, addressee: v })} placeholder='Директору ТОО "…"' />
                <div className={css.field}>
                  <label className={css.label} htmlFor="nc-line">Линия</label>
                  <select id="nc-line" className={css.input} value={newCompany.line} onChange={(e) => setNewCompany({ ...newCompany, line: Number(e.target.value) })}>
                    <option value={1}>1</option><option value={2}>2</option>
                  </select>
                </div>
                <button className={styles.smallBtn} onClick={async () => { if (await run(() => saveCompany(newCompany), "Исполнитель добавлен")) setNewCompany(emptyCompany); }}>Добавить</button>
              </div>
            </div>

            <h2 className={styles.sectionTitle} style={{ marginTop: 28 }}>Подпись «Согласовано» в Word</h2>
            <div className={styles.adminCard}>
              <div className={styles.inline}>
                <TextField id="ap-pos" label="Должность" value={approver.position} onChange={(v) => setApprover({ ...approver, position: v })} />
                <TextField id="ap-name" label="ФИО" value={approver.fullName} onChange={(v) => setApprover({ ...approver, fullName: v })} />
                <button className={styles.smallBtn} onClick={() => run(() => saveApprover(approver), "Подпись сохранена")}>Сохранить</button>
              </div>
            </div>

            <h2 className={styles.sectionTitle} style={{ marginTop: 28 }}>Справочник сотрудников (подпись «Составил»)</h2>
            <p className={styles.hint}>Сотрудник, подающий заявку, подставляется в Word по email: ФИО, должность и организация.</p>
            <div className={styles.adminCard}>
              <div className={styles.inline}>
                <TextField id="st-email" label="Email" value={staff.email} onChange={(v) => setStaff({ ...staff, email: v })} />
                <TextField id="st-name" label="ФИО" value={staff.fullName} onChange={(v) => setStaff({ ...staff, fullName: v })} placeholder="Макажанов Е.С." />
                <TextField id="st-pos" label="Должность" value={staff.position} onChange={(v) => setStaff({ ...staff, position: v })} placeholder="Начальник строительного участка" />
                <TextField id="st-org" label="Организация" value={staff.organization} onChange={(v) => setStaff({ ...staff, organization: v })} placeholder='ТОО "VK INVEST COMPANY"' />
                <button className={styles.smallBtn} onClick={async () => { if (await run(() => saveStaff(staff), "Сотрудник сохранён")) setStaff(emptyStaff); }}>Сохранить</button>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Email</th><th>ФИО</th><th>Должность</th><th>Организация</th><th /></tr></thead>
                <tbody>
                  {data.staff.map((s) => (
                    <tr key={s.email}>
                      <td>{s.email}</td><td>{s.fullName}</td><td>{s.position}</td><td>{s.organization}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className={css.btnGhost} style={{ minHeight: 36, marginRight: 8 }} onClick={() => setStaff(s)}>Править</button>
                        <button className={styles.btnDanger} style={{ minHeight: 36 }} onClick={() => window.confirm(`Удалить ${s.email}?`) && run(() => deleteStaff(s.email))}>Удалить</button>
                      </td>
                    </tr>
                  ))}
                  {data.staff.length === 0 && <tr><td colSpan={5} className={styles.empty}>Справочник пуст.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DrillingAdminPage;
