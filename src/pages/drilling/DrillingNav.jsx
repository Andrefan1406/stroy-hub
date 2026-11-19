// Единая навигация страниц заявок на бурение и резку для всех ролей: «На главную» (кроме
// бурильщика — у него главной нет, его страница заявок и есть его кабинет), «Заявки»,
// «Реестр», «Новая заявка» (только тем, кому она доступна).
import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import { fetchMe } from "./drillingApi";

// Профиль запрашиваем один раз на страницу — навигация стоит на каждой странице раздела.
let meCache = null;
export function useDrillingMe() {
  const [me, setMe] = useState(meCache?.value || null);
  useEffect(() => {
    if (meCache && Date.now() - meCache.at < 30000) { setMe(meCache.value); return undefined; }
    let alive = true;
    fetchMe().then((m) => { meCache = { value: m, at: Date.now() }; if (alive) setMe(m); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return me;
}

export default function DrillingNav() {
  const me = useDrillingMe();
  const { pathname } = useLocation();
  const is = (p) => pathname === p || pathname.startsWith(`${p}/`);
  const link = (to, label, active) => (
    <Link key={to} to={to} className={`${styles.navLink} ${active ? styles.navActive : ""}`} aria-current={active ? "page" : undefined}>{label}</Link>
  );
  return (
    <nav className={`${styles.nav} no-print`} aria-label="Заявки на бурение и резку">
      {me?.role !== "driller" && <Link to="/" className={css.back} style={{ marginRight: 8 }}>← На главную</Link>}
      {link("/drilling-requests", "Заявки", is("/drilling-requests"))}
      {link("/drilling-registry", "Реестр", is("/drilling-registry"))}
      {me?.canSubmit && link("/drilling-request", "+ Новая заявка", pathname === "/drilling-request")}
    </nav>
  );
}
