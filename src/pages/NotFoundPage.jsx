// Неверный адрес: понятное сообщение и возврат — вместо пустого экрана. Бурильщик заперт
// на своей странице заявок, поэтому для него возврат ведёт туда, а не на главную.
import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ridesApiFetch } from "../rides/api";

const NotFoundPage = () => {
  const { pathname } = useLocation();
  const [role, setRole] = useState(null);
  useEffect(() => {
    ridesApiFetch("/api/v1/users/me").then(({ user }) => setRole(user?.role || null)).catch(() => {});
  }, []);
  const home = role === "driller" ? "/drilling-requests" : "/";
  return (
    <div style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div style={{ fontSize: 48, fontWeight: 700, color: "#485875" }}>404</div>
      <h1 style={{ margin: 0, fontSize: 22 }}>Страница не найдена</h1>
      <p style={{ margin: 0, color: "#4b5563", maxWidth: 420 }}>
        Адреса <b style={{ overflowWrap: "anywhere" }}>{pathname}</b> на сайте нет. Проверьте ссылку или вернитесь назад.
      </p>
      <Link to={home} style={{ marginTop: 8, display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 20px", borderRadius: 10, background: "#485875", color: "#fff", textDecoration: "none", fontWeight: 600 }}>
        {role === "driller" ? "К заявкам" : "На главную"}
      </Link>
    </div>
  );
};

export default NotFoundPage;
