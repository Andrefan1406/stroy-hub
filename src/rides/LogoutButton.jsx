// Кнопка выхода для страниц системы поездок — пользователи без
// full_site_access заперты RideAccessGate.jsx на своей странице роли и не
// видят HomePage.js, где обычно живёт кнопка "Выход" (см. handleLogout там же).
// Подтверждение — своим окном, не window.confirm: тот в Android-приложении
// молча возвращает false, и выйти было нельзя.
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { isTelegramMiniApp } from "./telegramSession";
import ConfirmDialog from "./ConfirmDialog";

export default function LogoutButton({ style }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  // В Telegram Mini App выходить не из чего — окно закрывается самим Telegram.
  if (isTelegramMiniApp()) return null;

  const logout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  return (
    <>
      <button type="button" onClick={() => setConfirming(true)} style={{ ...defaultStyle, ...style }}>
        Выйти
      </button>
      {confirming && (
        <ConfirmDialog
          title="Выйти из аккаунта?"
          confirmLabel="Выйти"
          cancelLabel="Остаться"
          onConfirm={logout}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
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
