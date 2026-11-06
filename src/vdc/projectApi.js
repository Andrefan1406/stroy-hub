// Сохранение проекта: на сервере (Firestore, общее для всех сотрудников и переживает перезапуск сервера)
// плюс копия в браузере — на случай, если сервер недоступен. Ничего, кроме введённых значений, не передаётся.
import { getAuth } from "firebase/auth";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";
const localKey = (key) => `vdc-project:${key}`;

function readLocal(key) {
  try {
    const raw = localStorage.getItem(localKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(localKey(key), JSON.stringify(value));
    return true;
  } catch {
    return false; // приватный режим или переполнение — копия в браузере необязательна
  }
}

async function request(method, key, body) {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  const token = await user.getIdToken();
  const res = await fetch(`${API_URL}/api/vdc/projects/${encodeURIComponent(key)}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

// → { found, state, updatedAt, updatedBy, source: 'server' | 'browser', serverError? }
export async function loadProject(key) {
  let serverError = null;
  try {
    const data = await request("GET", key);
    if (data.found) return { ...data, source: "server" };
  } catch (err) {
    serverError = err.message;
  }
  const local = readLocal(key);
  if (local?.state) return { found: true, state: local.state, updatedAt: local.updatedAt, updatedBy: "этот браузер", source: "browser", serverError };
  return { found: false, serverError };
}

// → { ok, source: 'server' | 'browser', updatedAt, error? }. Копия в браузере пишется всегда.
export async function saveProject(key, state) {
  const updatedAt = new Date().toISOString();
  writeLocal(key, { state, updatedAt });
  try {
    const data = await request("PUT", key, { state });
    return { ok: true, source: "server", updatedAt: data.updatedAt || updatedAt };
  } catch (err) {
    return { ok: false, source: "browser", updatedAt, error: err.message };
  }
}
