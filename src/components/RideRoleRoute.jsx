// Гейт по роли для страниц системы поездок (/employee, /dispatcher,
// /driver, /rides-admin) — как AdminRoute.jsx, только сверяет не один
// захардкоженный email, а роль из rides.users. UX-уровень: настоящая
// проверка — requireRideRole/requireRoleOrSiteAdmin на бэкенде на каждом
// /api/v1/* эндпоинте.
//
// Главный админ сайта (SITE_ADMIN_EMAIL) роли в системе поездок не имеет,
// но пускается на любую её страницу по email (сервер так же пропускает его
// через любую проверку роли — см. server/rides/auth.js).
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import { ridesApiFetch } from "../rides/api";
import { SITE_ADMIN_EMAIL } from "../rides/constants";

export default function RideRoleRoute({ roles, children }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState("checking"); // checking | ok | denied

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) { setStatus("denied"); return; }
      const isSiteAdmin = user.email?.toLowerCase() === SITE_ADMIN_EMAIL;
      if (isSiteAdmin) { setStatus("ok"); return; }
      ridesApiFetch("/api/v1/users/me")
        .then(({ user: rideUser }) => setStatus(rideUser && roles.includes(rideUser.role) ? "ok" : "denied"))
        .catch((err) => {
          // Сеть/бэкенд недоступны — fail-open, тот же принцип, что и в
          // RideAccessGate.jsx: не запираем страницу роли из-за временной
          // недоступности API (например, сервер ещё не поднялся после
          // рестарта) — настоящая проверка всё равно на бэкенде, на
          // каждый запрос к /api/v1/*.
          console.error("Не удалось проверить роль в системе поездок:", err);
          setStatus("ok");
        });
    });
    return () => unsubscribe();
  }, [roles]);

  if (status === "checking") return <div style={{ padding: 30 }}>Проверка доступа...</div>;

  if (status === "denied") {
    return (
      <div style={{ padding: 30, textAlign: "center" }}>
        <p>У вас нет доступа к этому разделу системы поездок.</p>
        <button onClick={() => navigate("/")} style={{ padding: "8px 16px", cursor: "pointer" }}>На главную</button>
      </div>
    );
  }

  return children;
}
