// REST-клиент заявок на бурение и резку (server/drilling/). Firebase ID-токен
// в заголовке — сервер сам решает, что пользователю можно (автор / ответственный / админ).
import { getAuth } from "firebase/auth";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

async function authHeaders() {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Не авторизован");
  return { Authorization: `Bearer ${await user.getIdToken()}` };
}

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(await authHeaders()), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Ошибка сервера (HTTP ${res.status})`);
  }
  return res;
}
const json = async (path, opts) => (await call(path, opts)).json();

const BASE = "/api/drilling";
export const fetchMe = () => json(`${BASE}/me`);
export const fetchCounter = () => json(`${BASE}/counter`);
export const fetchRequests = (scope) => json(`${BASE}/requests?scope=${scope}`).then((d) => d.requests);
export const fetchRequest = (id) => json(`${BASE}/requests/${id}`);
export const createRequest = (items) => json(`${BASE}/requests`, { method: "POST", body: { items } });
export const updateRequest = (id, items) => json(`${BASE}/requests/${id}`, { method: "PUT", body: { items } });
export const restartRequest = (id) => json(`${BASE}/requests/${id}/restart`, { method: "POST" });
export const cancelRequest = (id) => json(`${BASE}/requests/${id}/cancel`, { method: "POST" });
export const acceptRequest = (id) => json(`${BASE}/requests/${id}/accept`, { method: "POST" });
export const rejectRequest = (id, reason) => json(`${BASE}/requests/${id}/reject`, { method: "POST", body: { reason } });
export const markItemDone = (id, itemId, factQuantity, comment = "") =>
  json(`${BASE}/requests/${id}/items/${itemId}/done`, { method: "POST", body: { factQuantity, comment } });
// Сразу несколько строк (все или ни одной): items = [{ itemId, factQuantity, comment }].
export const markItemsDone = (id, items) => json(`${BASE}/requests/${id}/items-done`, { method: "POST", body: { items } });

// Word отдаётся с токеном, поэтому скачиваем через blob, а не ссылкой.
export async function downloadDocx(id) {
  const res = await call(`${BASE}/requests/${id}/docx`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `Наряд-задание-${id}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- исполнители (админка; людей назначают ролями на /rides-admin) ----------
const ADMIN = "/api/admin/drilling";
export const fetchDrillingAdmin = () => json(ADMIN);
export const saveCompany = (company) =>
  json(company.id ? `${ADMIN}/companies/${company.id}` : `${ADMIN}/companies`, { method: company.id ? "PUT" : "POST", body: company });

// ---------- подписи и числа ----------
export const STATUS_LABELS = {
  engineer: "Ждёт согласования главного инженера",
  line1: "Ждёт ответа исполнителя",
  line2: "Передана субподрядчику",
  returned: "Отклонена — нужно ваше решение",
  accepted: "Принята в работу",
  completed: "Выполнена",
  cancelled: "Отменена",
};
export const UNITS = { drill: "шт", cut: "м.п." };
export const WORK_LABELS = { drill: "Сверление", cut: "Резка" };
export const fmtNum = (n) => String(n).replace(".", ",");

// Позиция в справочнике иногда уже «поз.56» — второе «поз.» не добавляем (как на сервере).
export const positionLabel = (position) => (/^\s*поз/i.test(String(position)) ? String(position).trim() : `поз. ${position}`);

// Только цифры и один разделитель (запятая/точка равнозначны), не больше
// одного знака после него; для целых — только цифры.
export function sanitizeNumber(value, integer) {
  let v = String(value).replace(integer ? /[^\d]/g : /[^\d.,]/g, "");
  if (integer) return v;
  const m = v.match(/^\d*[.,]?/);
  const head = m ? m[0] : "";
  const rest = v.slice(head.length).replace(/[.,]/g, "");
  const sep = /[.,]$/.test(head) || /[.,]/.test(head);
  return sep ? head + rest.slice(0, 1) : head;
}

export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

// ---------- реестр ----------
function registryQuery(f) {
  const p = new URLSearchParams();
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.status) p.set("status", f.status);
  if (f.object) p.set("object", f.object);
  if (f.workType) p.set("workType", f.workType);
  if (f.company) p.set("company", f.company);
  if (f.author) p.set("author", f.author);
  if (f.onlyMine) p.set("onlyMine", "1");
  const q = p.toString();
  return q ? `?${q}` : "";
}
export const fetchRegistry = (filters) => json(`${BASE}/registry${registryQuery(filters)}`);

// Excel с теми же фильтрами, что на странице.
export async function downloadRegistryXlsx(filters) {
  const res = await call(`${BASE}/registry.xlsx${registryQuery(filters)}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = "Реестр-заявок-бурение-резка.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- чертежи и фото ----------
export const MAX_FILE_MB = 15;
const IMAGE_SIDE = 2400; // длинная сторона фото после сжатия, пикселей
const COMPRESS_FROM = 1.5 * 1024 * 1024; // картинки легче не трогаем

// Подходит ли выбранный файл (PDF или картинка); пустая строка — подходит.
export function localFileProblem(file) {
  const type = String(file.type || "").toLowerCase();
  const isPdf = type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImage = type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
  if (!isPdf && !isImage) return "Допустимы PDF и картинки";
  if (isPdf && file.size > MAX_FILE_MB * 1024 * 1024) return `PDF больше ${MAX_FILE_MB} МБ — уменьшите файл`;
  if (isImage && file.size > 60 * 1024 * 1024) return "Картинка слишком большая";
  return "";
}

// Фото с телефона — 5–12 МБ: перед отправкой уменьшаем до JPEG (до 2400 px), текст чертежа остаётся читаемым.
// PDF и лёгкие картинки уходят как есть; если картинку не удалось прочитать — тоже как есть.
// rotate — поворот по часовой стрелке в градусах (кратно 90), выбранный пользователем.
export async function prepareForUpload(file, rotate = 0) {
  const turn = ((rotate % 360) + 360) % 360;
  if (!String(file.type).startsWith("image/") || (file.size < COMPRESS_FROM && turn === 0)) return file;
  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); // поворот по EXIF
    } catch {
      bitmap = await createImageBitmap(file);
    }
    const scale = Math.min(1, IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = turn % 180 === 0 ? w : h;
    canvas.height = turn % 180 === 0 ? h : w;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // у PNG с прозрачностью фон иначе станет чёрным
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((turn * Math.PI) / 180);
    ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    // повернутый файл отдаём всегда; без поворота — только если стал легче
    if (blob && (turn !== 0 || blob.size < file.size)) return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
  } catch {
    /* отправим исходный файл */
  }
  return file;
}

export async function uploadAttachment(id, file, rotate = 0) {
  const prepared = await prepareForUpload(file, rotate);
  if (prepared.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`Файл больше ${MAX_FILE_MB} МБ`);
  const res = await fetch(`${API_URL}${BASE}/requests/${id}/attachments?name=${encodeURIComponent(prepared.name)}`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/octet-stream" },
    body: prepared,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || (res.status === 413 ? "Файл слишком большой" : `Ошибка сервера (HTTP ${res.status})`));
  }
  return res.json();
}

// Файл отдаётся только с токеном, поэтому картинки и PDF получаем как blob.
export async function fetchAttachmentBlob(id, attachmentId) {
  return (await call(`${BASE}/requests/${id}/attachments/${attachmentId}`)).blob();
}
export const deleteAttachment = (id, attachmentId) => json(`${BASE}/requests/${id}/attachments/${attachmentId}`, { method: "DELETE" });
