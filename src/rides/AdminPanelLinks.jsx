// Переходы между панелями системы поездок для главного админа сайта — у
// него нет своей роли, но доступ ко всем панелям (см. server/rides/auth.js),
// поэтому в шапке каждой панели ему видны ссылки на главную, на две другие
// панели и на справочники. Остальным пользователям компонент ничего не
// рисует.
import React from "react";
import { Link, useLocation } from "react-router-dom";
import { getAuth } from "firebase/auth";
import { SITE_ADMIN_EMAIL } from "./constants";
import { isTelegramMiniApp } from "./telegramSession";

const PANELS = [
  { path: "/dispatcher", label: "Диспетчер" },
  { path: "/employee", label: "Пассажир" },
  { path: "/driver", label: "Водитель" },
  { path: "/rides-admin", label: "Водители и машины" },
];

// В Telegram Mini App ссылки на панели сайта не нужны (там своя навигация).
export function isSiteAdmin() {
  if (isTelegramMiniApp()) return false;
  return getAuth().currentUser?.email?.toLowerCase() === SITE_ADMIN_EMAIL;
}

export default function AdminPanelLinks({ style }) {
  const { pathname } = useLocation();
  if (!isSiteAdmin()) return null;
  return (
    <>
      <Link to="/" style={style}>← На главную</Link>
      {PANELS.filter((p) => !pathname.startsWith(p.path)).map((p) => (
        <Link key={p.path} to={p.path} style={style}>{p.label}</Link>
      ))}
    </>
  );
}
