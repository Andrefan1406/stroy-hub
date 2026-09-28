// REST-клиент для Python-сервиса финплана (services/financing-api/) — тот
// же паттерн (Firebase ID-токен + fetch), что и в остальных админ-страницах
// (см. BlockedUsersAdminPage.jsx, src/rides/api.js).
import { getAuth } from "firebase/auth";

export const FINANCING_API_URL = process.env.REACT_APP_FINANCING_API_URL || "http://localhost:8000";

async function getIdToken() {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  return user.getIdToken();
}

export async function fetchFinancingPlan(objectKey) {
  const token = await getIdToken();
  const res = await fetch(`${FINANCING_API_URL}/financing-plan/${objectKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Не удалось загрузить финплан (HTTP ${res.status})`);
  }
  return res.json();
}

// Лёгкий эндпоинт (только config.py, без Google Sheets/ГПР) — категории и
// объекты с агрегатами, для верхних уровней навигации, открывается мгновенно.
export async function fetchCategories() {
  const token = await getIdToken();
  const res = await fetch(`${FINANCING_API_URL}/categories`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Не удалось загрузить категории (HTTP ${res.status})`);
  }
  return res.json();
}
