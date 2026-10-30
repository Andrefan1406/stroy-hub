// Логин и кнопка выхода в правом верхнем углу — на каждой странице сайта
// (подключён один раз в App.js, а не в каждой странице). У админа логин —
// ссылка в личный кабинет (/admin). position: fixed — страницы свёрстаны
// по-разному (светлые формы, тёмный финплан), а в общем потоке блок пришлось
// бы встраивать в каждую; подложка делает его читаемым на любом фоне.
import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { TbLogout } from "react-icons/tb";
import { auth } from "../firebase";

const ADMIN_EMAIL = "admin@vkdev.kz";

export default function AccountBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(auth.currentUser?.email?.toLowerCase() || "");

  useEffect(() => onAuthStateChanged(auth, (user) => setEmail(user?.email?.toLowerCase() || "")), []);

  // В Telegram Mini App (/tg/*) вход — через Telegram, не через этот логин.
  if (!email || location.pathname === "/login" || location.pathname.startsWith("/tg")) return null;

  const login = email.split("@")[0];

  const handleLogout = async () => {
    if (!window.confirm("Вы уверены, что хотите выйти?")) return;
    await signOut(auth);
    navigate("/login");
  };

  return (
    <div style={styles.bar}>
      {email === ADMIN_EMAIL ? (
        <button type="button" onClick={() => navigate("/admin")} style={styles.adminLink} title="Личный кабинет">
          {login}
        </button>
      ) : (
        <span style={styles.accountEmail}>{login}</span>
      )}
      <button type="button" onClick={handleLogout} style={styles.logoutIconBtn} title="Выход" aria-label="Выход">
        <TbLogout aria-hidden="true" />
      </button>
    </div>
  );
}

// Цвета и шрифт — как у главной (HomePage.module.css): акцент цвета логотипа,
// контур, видимый на солнце. top учитывает вырез iPhone (safe-area), иначе
// кнопки уходят под строку статуса и не нажимаются.
const BRAND = "#485875";
const styles = {
  bar: {
    position: "fixed",
    top: "calc(env(safe-area-inset-top, 0px) + 4px)",
    right: "12px",
    zIndex: 50, // ниже модальных окон (100-200), чтобы не перекрывать их
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "0 2px 0 6px",
    borderRadius: "10px",
    border: "1px solid #939ba7",
    background: "rgba(255, 255, 255, 0.95)",
    fontFamily: "inherit",
  },
  accountEmail: {
    color: "#4b5563",
    fontSize: "14px",
    fontWeight: "500",
  },
  adminLink: {
    minHeight: "32px",
    background: "none",
    border: "none",
    color: BRAND,
    cursor: "pointer",
    font: "inherit",
    fontSize: "14px",
    fontWeight: "600",
    padding: "0 6px",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  },
  logoutIconBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "36px",
    minHeight: "32px",
    background: "none",
    border: "none",
    color: BRAND,
    cursor: "pointer",
    fontSize: "20px",
    lineHeight: "1",
    padding: "0 4px",
  },
};
