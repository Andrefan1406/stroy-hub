// Справочник работ на сервере (server/takeoffCatalog.js): читать может любой
// вошедший, менять — только админ (проверяет сервер).
import { getAuth } from "firebase/auth";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

async function apiFetch(path, options = {}) {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  const token = await user.getIdToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

const send = (method) => (path, body) => apiFetch(path, { method, body: body ? JSON.stringify(body) : undefined });

export const fetchCatalog = () => apiFetch("/api/takeoff/catalog");
export const markWorkUsed = (id) => send("POST")(`/api/takeoff/works/${id}/used`);

export const createGroup = (body) => send("POST")("/api/admin/takeoff/groups", body);
export const updateGroup = (id, body) => send("PATCH")(`/api/admin/takeoff/groups/${id}`, body);
export const deleteGroup = (id) => send("DELETE")(`/api/admin/takeoff/groups/${id}`);
export const createWork = (body) => send("POST")("/api/admin/takeoff/works", body);
export const updateWork = (id, body) => send("PATCH")(`/api/admin/takeoff/works/${id}`, body);
export const deleteWork = (id) => send("DELETE")(`/api/admin/takeoff/works/${id}`);
