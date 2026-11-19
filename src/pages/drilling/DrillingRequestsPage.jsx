// Список заявок на бурение и резку: «Мои» (инициатор), «Входящие» (ответственные
// исполнителя) и «Все» (админ). Красные счётчики — что ждёт реакции.
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import { fetchMe, fetchRequests, STATUS_LABELS, fmtDateTime } from "./drillingApi";

const DrillingRequestsPage = () => {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState(null); // выбирается после загрузки профиля: админ — «Все», остальные — «Мои»
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async (scope) => {
    try {
      const [m, list] = await Promise.all([fetchMe(), fetchRequests(scope)]);
      setMe(m);
      setRequests(list);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchMe().then((m) => setTab((cur) => cur || (m.isAdmin ? "all" : "mine"))).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!tab) return undefined;
    setRequests(null);
    load(tab);
    const timer = setInterval(() => load(tab), 30000); // новые заявки и ответы подтягиваются сами
    return () => clearInterval(timer);
  }, [tab, load]);

  const tabs = [{ key: "mine", label: "Мои заявки", count: me?.counters.mine }];
  if (me?.companies.length) tabs.push({ key: "inbox", label: "Входящие", count: me.counters.inbox });
  if (me?.isAdmin) tabs.unshift({ key: "all", label: "Все заявки" });

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to="/" className={css.back}>← На главную</Link>
        <div className={styles.head}>
          <h1 className={css.title}>Заявки на бурение и резку</h1>
        </div>
        <Link to="/drilling-request" className={css.btnPrimary} style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
          + Новая заявка
        </Link>{" "}
        <Link to="/drilling-registry" className={css.btnGhost} style={{ display: "inline-flex", alignItems: "center", textDecoration: "none", marginRight: 0 }}>
          Реестр / Excel
        </Link>

        <div className={styles.tabs} role="tablist">
          {tabs.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`${styles.tab} ${tab === t.key ? styles.tabActive : ""}`}>
              {t.label}
              {t.count > 0 && <span className={styles.count}>{t.count}</span>}
            </button>
          ))}
        </div>

        {error && <div className={styles.error}>{error}</div>}
        {requests === null && !error && <div className={styles.empty}>Загрузка…</div>}
        {requests?.length === 0 && <div className={styles.empty}>Заявок нет.</div>}

        <div className={styles.list}>
          {requests?.map((r) => (
            <Link key={r.id} to={`/drilling-requests/${r.id}`} className={styles.row}>
              <span className={styles.rowNum}>№ {r.id}</span>
              <span className={styles.rowMain}>
                <div className={styles.rowPlaces}>{r.places.join("; ")}{r.itemsCount > r.places.length ? "…" : ""}</div>
                <div className={styles.rowMeta}>
                  {fmtDateTime(r.createdAt)} · {r.initiator} · строк: {r.itemsCount}{r.round > 1 ? ` · круг ${r.round}` : ""}
                </div>
              </span>
              <span className={`${styles.badge} ${styles[`st_${r.status}`]}`}>{STATUS_LABELS[r.status]}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DrillingRequestsPage;
