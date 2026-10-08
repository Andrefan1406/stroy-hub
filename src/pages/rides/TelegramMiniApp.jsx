// Telegram Mini App системы поездок: вход без пароля и маршруты /tg/*.
//
// /tg?go=new|my|panel — сюда ведут кнопки бота. Страница берёт у Telegram
// подписанные данные пользователя (initData), меняет их на сервере на токен
// сессии (server/rides/telegramRouter.js: /webapp-session) и открывает
// обычную страницу пассажира или диспетчера под /tg — те же компоненты, что
// на сайте, только API-запросы идут с токеном Telegram (src/rides/api.js).
import React, { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { RIDES_API_URL } from "../../rides/api";
import { getTelegramSession, loadTelegramWebApp, setTelegramSession } from "../../rides/telegramSession";

const DISPATCHER_ROLES = ["dispatcher", "admin"];

function targetPath(role, go) {
  if (DISPATCHER_ROLES.includes(role) && go === "panel") return "/tg/dispatcher";
  return "/tg/employee";
}

export default function TelegramMiniApp() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const go = params.get("go");
    (async () => {
      const tg = await loadTelegramWebApp();
      if (!tg?.initData) {
        throw new Error("Эта страница открывается из Telegram-бота «VK Dev · Транспорт» — кнопкой под сообщением или кнопкой меню.");
      }
      tg.ready();
      tg.expand();
      const res = await fetch(`${RIDES_API_URL}/api/v1/telegram/webapp-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: tg.initData }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
      if (data.user.role === "driver") {
        throw new Error("Водителям заявки и заказы — прямо в чате бота: кнопки «Пул заявок» и «Мои заказы».");
      }
      setTelegramSession({ token: data.token, expiresAt: data.expiresAt, user: data.user });
      if (!cancelled) navigate(targetPath(data.user.role, go), { replace: true });
    })().catch((err) => {
      if (!cancelled) setError(err.message || "Не удалось войти");
    });
    return () => {
      cancelled = true;
    };
  }, [navigate, params]);

  return (
    <div style={s.page}>
      {error ? <div style={s.error}>{error}</div> : <div style={s.muted}>Входим через Telegram…</div>}
    </div>
  );
}

// Страницы под /tg — только с живой сессией Telegram; иначе на вход (/tg).
export function TelegramMiniAppRoute({ children }) {
  const location = useLocation();
  if (!getTelegramSession()) {
    const go = location.pathname.startsWith("/tg/dispatcher") ? "panel" : "new";
    return <Navigate to={`/tg?go=${go}`} replace />;
  }
  return children;
}

const s = {
  page: { padding: "24px 16px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "700px", margin: "0 auto", boxSizing: "border-box" },
  muted: { color: "#888", fontSize: "14px" },
  error: { background: "#fff0f0", color: "#c00", borderRadius: "8px", padding: "12px 14px", fontSize: "14px", lineHeight: 1.4 },
};
