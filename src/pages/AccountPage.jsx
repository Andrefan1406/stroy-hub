// Личный кабинет сотрудника (клик по логину в правом верхнем углу). Здесь то,
// что относится к самому пользователю, а не к главной странице: статусы его
// заявок на бурение и резку (и входящие, если он назначен ответственным).
// У админа логин ведёт в /admin — там та же карточка (см. AdminDashboardPage).
import React from "react";
import { useNavigate } from "react-router-dom";
import useDrillingCounter from "./drilling/useDrillingCounter";

const AccountPage = () => {
  const navigate = useNavigate();
  const drillingCount = useDrillingCounter();

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => navigate("/")} style={s.back}>← Назад</button>
        <h1 style={s.title}>Личный кабинет</h1>
      </div>
      <div style={s.grid}>
        <button onClick={() => navigate("/drilling-requests")} style={s.card}>
          <div style={s.cardTitle}>
            Статусы заявок на бурение и резку
            {drillingCount > 0 && <span style={s.badge} aria-label={`Ждёт внимания: ${drillingCount}`}>{drillingCount}</span>}
          </div>
          <div style={s.cardDescription}>Ход согласования ваших заявок; входящие — если вы назначены ответственным</div>
        </button>
        <button onClick={() => navigate("/drilling-registry")} style={s.card}>
          <div style={s.cardTitle}>Реестр заявок на бурение и резку</div>
          <div style={s.cardDescription}>Таблица заявок с содержимым и количествами, фильтры, выгрузка в Excel</div>
        </button>
      </div>
    </div>
  );
};

const s = {
  page: { padding: "24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "900px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "16px", marginBottom: "24px" },
  back: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" },
  title: { margin: 0, fontSize: "22px" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "16px" },
  card: { textAlign: "left", background: "#fff", border: "none", borderTop: "4px solid #485875", borderRadius: "12px", padding: "18px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", cursor: "pointer", display: "flex", flexDirection: "column", gap: "6px" },
  cardTitle: { fontSize: "15px", fontWeight: 700, color: "#222", display: "flex", alignItems: "center", gap: "8px" },
  cardDescription: { fontSize: "13px", color: "#666", lineHeight: 1.4 },
  badge: { minWidth: "22px", height: "22px", padding: "0 6px", borderRadius: "11px", background: "#d92d20", color: "#fff", fontSize: "13px", fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" },
};

export default AccountPage;
