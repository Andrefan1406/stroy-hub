// Логин и кнопка выхода в правом верхнем углу — на каждой странице сайта
// (подключён один раз в App.js, а не в каждой странице). У админа логин —
// ссылка в личный кабинет (/admin). position: fixed — страницы свёрстаны
// по-разному (светлые формы, тёмный финплан), а в общем потоке блок пришлось
// бы встраивать в каждую; подложка делает его читаемым на любом фоне.
import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "../firebase";

const ADMIN_EMAIL = "admin@vkdev.kz";

export default function AccountBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(auth.currentUser?.email?.toLowerCase() || "");

  useEffect(() => onAuthStateChanged(auth, (user) => setEmail(user?.email?.toLowerCase() || "")), []);

  if (!email || location.pathname === "/login") return null;

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
        ➤
      </button>
    </div>
  );
}

const styles = {
  bar: {
    position: "fixed",
    top: "8px",
    right: "12px",
    zIndex: 50, // ниже модальных окон (100-200), чтобы не перекрывать их
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "3px 8px",
    borderRadius: "12px",
    background: "rgba(255, 255, 255, 0.85)",
  },
  accountEmail: {
    color: "#666",
    fontSize: "12px",
    fontWeight: "500",
  },
  adminLink: {
    background: "none",
    border: "none",
    color: "#6610f2",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: "600",
    padding: "0",
    textDecoration: "underline",
  },
  logoutIconBtn: {
    background: "none",
    border: "none",
    color: "#007bff",
    cursor: "pointer",
    fontSize: "14px",
    lineHeight: "1",
    padding: "2px",
  },
};
