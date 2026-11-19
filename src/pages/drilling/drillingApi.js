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
