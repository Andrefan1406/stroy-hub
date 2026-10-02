// Личный кабинет админа — хаб-страница со ссылками на все админ-разделы
// (управление пользователями, статистика, пропуски в отчётах). Сама
// страница видна только admin@vkdev.kz (см. AdminRoute в App.js) — вход в
// неё с главной через маленькую кнопку «Личный кабинет» (см. HomePage.js).
import React from "react";
import { useNavigate } from "react-router-dom";

const SECTIONS = [
  {
    title: "Управление пользователями",
    description: "Правила проверки пропусков в отчётах по людям (email → участок)",
    path: "/admin/users",
    color: "#007bff",
  },
  {
    title: "Пропуски в отчётах по людям",
    description: "Принять решение по пропущенным дням, массовые действия",
    path: "/admin/people-gaps",
    color: "#17a2b8",
  },
  {
    title: "Пропуски в отчётах ГПР",
    description: "Конструктивы, не заполненные за прошлую пятницу или раньше (ГПР 64,72 и НЖ3)",
    path: "/admin/gpr-report-gaps",
    color: "#e67e22",
  },
  {
    title: "Заблокированные пользователи",
    description: "Кто сейчас не может подать заявку и почему (люди/ГПР/вручную), ручная блокировка",
    path: "/admin/blocked-users",
    color: "#c0392b",
  },
  {
    title: "Админ-статистика",
    description: "Общая статистика по системе",
    path: "/admin/statistics",
    color: "#6610f2",
  },
  {
    title: "Система поездок — роли",
    description: "Назначить роль (сотрудник/диспетчер/водитель) и доступ ко всему сайту",
    path: "/rides-admin",
    color: "#1976d2",
  },
  {
    title: "Индексация расценок",
    description: "Принудительно переиндексировать свод расценок для поиска (после обновления таблицы)",
    path: "/admin/rascenki",
    color: "#10a37f",
  },
  {
    title: "Пересинк финплана",
    description: "Пересчитать финпланы объектов из смет и ГПР сейчас (обычно — автоматически ночью)",
    path: "/admin/financing-resync",
    color: "#7c5cff",
  },
];

const AdminDashboardPage = () => {
  const navigate = useNavigate();

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => navigate("/")} style={s.back}>← Назад</button>
        <h1 style={s.title}>Личный кабинет</h1>
      </div>

      <div style={s.grid}>
        {SECTIONS.map((section) => (
          <button
            key={section.path}
            onClick={() => navigate(section.path)}
            style={{ ...s.card, borderTop: `4px solid ${section.color}` }}
          >
            <div style={s.cardTitle}>{section.title}</div>
            <div style={s.cardDescription}>{section.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
};

const s = {
  page: { padding: "24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "900px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "16px", marginBottom: "24px" },
  back: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" },
  title: { margin: 0, fontSize: "22px" },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "16px" },
  card: {
    textAlign: "left",
    background: "#fff",
    border: "none",
    borderRadius: "12px",
    padding: "18px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  cardTitle: { fontSize: "15px", fontWeight: 700, color: "#222" },
  cardDescription: { fontSize: "13px", color: "#666", lineHeight: 1.4 },
};

export default AdminDashboardPage;
