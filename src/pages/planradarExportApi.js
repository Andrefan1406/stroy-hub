// REST-клиент выгрузки замечаний PlanRadar (server/planradarExport.js).
// Тот же паттерн (Firebase ID-токен + fetch), что и в остальных админ-страницах.
import { getAuth } from "firebase/auth";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";
const BASE = `${API_URL}/api/admin/planradar`;

async function authHeaders() {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  return { Authorization: `Bearer ${await user.getIdToken()}` };
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...(await authHeaders()), ...(options.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Ошибка сервера (HTTP ${res.status})`);
  }
  return res;
}

export async function fetchPlanradarProjects() {
  const res = await request("/projects");
  return (await res.json()).projects;
}

// from/to — «ГГГГ-ММ-ДД»; projectIds — id объектов или null (все); withPhotos — встраивать фото.
export async function startPlanradarExport({ from, to, projectIds, withPhotos = true }) {
  const res = await request("/exports", { method: "POST", body: JSON.stringify({ from, to, projectIds, withPhotos }) });
  return res.json();
}

export async function fetchPlanradarExport(id) {
  const res = await request(`/exports/${encodeURIComponent(id)}`);
  return res.json();
}

// Готовый Excel → скачивание в браузере (файл отдаётся с токеном, поэтому не ссылкой).
export async function downloadPlanradarExport(id, filename) {
  const res = await request(`/exports/${encodeURIComponent(id)}/file`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "planradar.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
