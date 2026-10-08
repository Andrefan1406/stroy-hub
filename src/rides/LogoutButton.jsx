// Кнопка выхода для страниц системы поездок — пользователи без
// full_site_access заперты RideAccessGate.jsx на своей странице роли и не
// видят HomePage.js, где обычно живёт кнопка "Выход" (см. handleLogout там же).
import React from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { isTelegramMiniApp } from "./telegramSession";

export default function LogoutButton({ style }) {
  const navigate = useNavigate();
  // В Telegram Mini App выходить не из чего — окно закрывается самим Telegram.
  if (isTelegramMiniApp()) return null;

  const handleLogout = async () => {
    if (!window.confirm("Вы уверены, что хотите выйти?")) return;
    await signOut(auth);
    navigate("/login");
  };

  return (
    <button type="button" onClick={handleLogout} style={{ ...defaultStyle, ...style }}>
      Выйти
    </button>
  );
}

const defaultStyle = {
  background: "#fff",
  border: "1px solid #ccc",
  borderRadius: "6px",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: "13px",
};
