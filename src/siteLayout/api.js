// Клиент к /api/layouts и сокету '/layouts' (server/layouts/) — Firebase
// ID-токен в заголовке, как у остальных админ-страниц.
import { getAuth } from "firebase/auth";
import { io } from "socket.io-client";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

async function token() {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  return user.getIdToken();
}

export async function layoutsApi(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_URL}/api/layouts${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

// Свежий токен на каждое (пере)подключение — как в src/rides/socket.js.
export function createLayoutSocket() {
  return io(`${API_URL}/layouts`, {
    auth: async (cb) => {
      try {
        cb({ token: await token() });
      } catch {
        cb({});
      }
    },
  });
}

export const emitWithAck = (socket, event, data) =>
  new Promise((resolve) => socket.timeout(10000).emit(event, data, (err, res) => resolve(err ? { error: "Сервер не ответил" } : res)));
