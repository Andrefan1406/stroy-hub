// REST-клиент модуля ПТО (/api/pto/*): Firebase ID-токен в заголовке — сервер
// пускает только admin@vkdev.kz (server/pto/access.js), остальные получают 403.
import { getAuth } from "firebase/auth";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

async function authHeaders() {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  return { Authorization: `Bearer ${await user.getIdToken()}` };
}

async function parse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка сервера (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function request(method, path, body) {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}/api/pto${path}`, {
    method,
    headers: body !== undefined ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return parse(res);
}

export const ptoGet = (path) => request("GET", path);
export const ptoPost = (path, body) => request("POST", path, body ?? {});
export const ptoPatch = (path, body) => request("PATCH", path, body ?? {});
export const ptoPut = (path, body) => request("PUT", path, body ?? {});
export const ptoDelete = (path) => request("DELETE", path);

// Загрузка PDF: тело запроса — сам файл, остальное — в адресе. Ответ 202: разбор идёт в фоне.
export async function ptoUpload(file, { section, category, object, position }) {
  const params = new URLSearchParams({ section, object, fileName: file.name });
  if (category) params.set("category", category);
  if (position) params.set("position", position);
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}/api/pto/documents?${params}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/pdf" },
    body: file,
  });
  return parse(res);
}

// Скачать Excel: файл отдаётся под тем же токеном, поэтому через fetch → blob.
export async function ptoDownloadExcel(id, fileName) {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}/api/pto/documents/${id}/export.xlsx`, { headers });
  if (!res.ok) await parse(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- Открыть лист PDF ----
// Файл — под токеном, поэтому берём его через fetch и открываем как blob-адрес с #page=N.
// Один и тот же blob переиспользуется для всех листов документа (файл большой, качаем один раз за сессию).
const pdfUrls = new Map();

function pdfBlobUrl(id) {
  if (!pdfUrls.has(id)) {
    pdfUrls.set(id, (async () => {
      const headers = await authHeaders();
      const res = await fetch(`${API_URL}/api/pto/documents/${id}/pdf`, { headers });
      if (!res.ok) await parse(res);
      return URL.createObjectURL(await res.blob());
    })().catch((err) => {
      pdfUrls.delete(id);
      throw err;
    }));
  }
  return pdfUrls.get(id);
}

export async function ptoOpenPdfPage(id, page) {
  // Вкладку открываем сразу, по клику: после ожидания загрузки браузер заблокировал бы всплывающее окно.
  const win = window.open("", "_blank");
  if (win) win.document.write('<p style="font-family:sans-serif;padding:20px">Загружаем чертёж…</p>');
  try {
    const target = `${await pdfBlobUrl(id)}#page=${page}`;
    if (win) win.location.href = target;
    else window.open(target, "_blank");
  } catch (err) {
    if (win) win.close();
    throw err;
  }
}
