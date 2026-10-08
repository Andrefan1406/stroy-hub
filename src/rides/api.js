// Общий REST-клиент для страниц системы поездок — тот же паттерн
// apiFetch(Firebase ID-токен + fetch), что и в остальных админ-страницах
// (см. src/pages/BlockedUsersAdminPage.jsx), вынесен в модуль, потому что
// им пользуются сразу 4 страницы (сотрудник/водитель/диспетчер/админ).
// В Telegram Mini App вместо Firebase ID-токена — токен сессии Telegram
// (см. telegramSession.js); сервер принимает оба.
import { getAuth } from "firebase/auth";
import { getTelegramSession, isTelegramMiniApp } from "./telegramSession";

export const RIDES_API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

async function getIdToken() {
  if (isTelegramMiniApp()) return getTelegramSession().token;
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  return user.getIdToken();
}

export async function ridesApiFetch(path, options = {}) {
  const token = await getIdToken();
  const res = await fetch(`${RIDES_API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

export const ridesApiPost = (path, body) => ridesApiFetch(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export const ridesApiPatch = (path, body) => ridesApiFetch(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
export const ridesApiPut = (path, body) => ridesApiFetch(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
export const ridesApiDelete = (path) => ridesApiFetch(path, { method: "DELETE" });

export { getIdToken };
