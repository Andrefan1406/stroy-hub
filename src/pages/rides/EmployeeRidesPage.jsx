// Личный кабинет сотрудника (заказчика): форма подачи заявки на служебный
// транспорт + список своих заявок с статусом, который обновляется в
// реальном времени через Socket.io (комната employee:{id}) — без
// перезагрузки страницы видно, кто именно принял заказ.
//
// Когда есть активная поездка, страница открывается как «трекер»: карточки
// поездок сверху, форма новой заявки свёрнута. Страницу чаще всего открывают
// с телефона (в том числе в Telegram Mini App и Android-приложении), поэтому
// поля — 16px (иначе iOS увеличивает масштаб при фокусе), кнопки — от 44px.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ridesApiFetch, ridesApiPatch, ridesApiPost } from "../../rides/api";
import { createRidesSocket } from "../../rides/socket";
import LogoutButton from "../../rides/LogoutButton";
import AdminPanelLinks from "../../rides/AdminPanelLinks";
import { formatRoute, formatEstimate, formatClock } from "../../rides/format";
import MapPicker from "../../rides/MapPicker";
import AddressField, { addressNeedsMap, addressPayload, addressReady, cityProblem, emptyAddress } from "../../rides/AddressField";
import CancelRequestModal from "../../rides/CancelRequestModal";
import ConfirmDialog from "../../rides/ConfirmDialog";
import TelegramConnect from "../../rides/TelegramConnect";
import RideHistoryTable from "../../rides/RideHistoryTable";
import { isTelegramMiniApp, ridesPath } from "../../rides/telegramSession";

const CAN_EDIT_ROUTE = ["pending_assignment", "assigned", "in_progress"];
const MAX_PASSENGERS = 50; // как в server/rides/requestsRouter.js
// Время подачи по умолчанию — не раньше чем через столько минут: «ближайшие
// 15 минут» истекали, пока человек заполнял форму, и кнопка блокировалась
// ошибкой, которую он не совершал.
const DEFAULT_LEAD_MINUTES = 20;
const DRAFT_KEY = "rides:employee:draft";

// datetime-local со step="900" не годится: нативный пикер (см. скриншот
// пользователя) в своей выпадашке всё равно листает КАЖДУЮ минуту — step
// там влияет только на стрелки при вводе с клавиатуры, а не на список
// выбора. Поэтому время подачи — отдельный <select> с шагом 15 мин:
// выбрать что-то, кроме кратного 15 мин, в принципе нельзя. Время подачи —
// весь день, 00:00 ... 23:45 (на сегодня прошедшее в списке не показываем,
// см. isPastSlot). Ограничено другое — КОГДА можно подать заявку: см.
// SUBMIT_FROM/SUBMIT_TO в server/rides/slots.js.
const QUARTER_HOUR_OPTIONS = Array.from({ length: 24 * 4 }, (_, i) => {
  const h = String(Math.floor(i / 4)).padStart(2, "0");
  const m = String((i % 4) * 15).padStart(2, "0");
  return `${h}:${m}`;
});

const pad = (n) => String(n).padStart(2, "0");

function nowLocalTimeStr() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// По умолчанию — сегодня, первый слот не раньше чем через
// DEFAULT_LEAD_MINUTES. Поздно вечером, когда на сегодня слотов не
// осталось, — завтра на 09:00.
function defaultRequestedAt() {
  const soon = new Date(Date.now() + DEFAULT_LEAD_MINUTES * 60000);
  const soonTime = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
  const sameDay = soon.getDate() === new Date().getDate();
  const next = sameDay && QUARTER_HOUR_OPTIONS.find((t) => t >= soonTime);
  return next ? `${localDateStr()}T${next}` : `${localDateStr(1)}T09:00`;
}

// timeAuto — время подставлено само, человек его не трогал: тогда оно
// сдвигается вперёд по ходу времени, а не превращается в «уже прошло».
const makeEmptyForm = () => ({
  from: emptyAddress, to: emptyAddress, extraStops: [], requestedAt: defaultRequestedAt(), timeAuto: true,
  purpose: "", passengersCount: 1, withReturn: false, comment: "",
});

// Черновик формы — в sessionStorage: Telegram и Android-приложение
// перезагружают страницу из фона, и заполненная форма терялась. Хранилище
// может быть недоступно (приватный режим) — тогда просто без черновика.
// Незавершённые проверки адреса сбрасываем в «проверить заново».
function loadDraft() {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return makeEmptyForm();
    const draft = { ...makeEmptyForm(), ...JSON.parse(raw) };
    const settle = (v) => (v && v.status === "checking" ? { ...v, status: "idle" } : v);
    draft.from = settle(draft.from);
    draft.to = settle(draft.to);
    draft.extraStops = (draft.extraStops || []).map(settle);
    if (draft.timeAuto) draft.requestedAt = defaultRequestedAt();
    return draft;
  } catch {
    return makeEmptyForm();
  }
}

function saveDraft(form) {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(form));
  } catch {
    // нет хранилища — без черновика
  }
}

function clearDraft() {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // нет хранилища — нечего чистить
  }
}

// Узкий экран — история карточками, а не таблицей.
function useNarrowScreen(maxWidth = 640) {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [query]);
  return narrow;
}

const prefersReducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// «Сегодня, 14:15» / «Завтра, 09:00» / «25.10, 09:00» — так люди и думают о
// поездке, номер заявки им ничего не говорит.
function formatWhen(value) {
  if (!value) return "—";
  const [date, time = ""] = value.replace(" ", "T").split("T");
  const hhmm = time.slice(0, 5);
  if (date === localDateStr()) return `Сегодня, ${hhmm}`;
  if (date === localDateStr(1)) return `Завтра, ${hhmm}`;
  const [, m, d] = date.split("-");
  return `${d}.${m}, ${hhmm}`;
}

// «на сегодня, 14:15» — для уведомлений: «Поездку на сегодня, 14:15 отменил диспетчер».
const rideWhen = (r) => (r?.requestedAt ? ` на ${formatWhen(r.requestedAt).toLowerCase()}` : "");

function statusLabel(r) {
  // Совместная поездка: вас уже высадили, водитель развозит попутчиков.
  if (r.droppedOffAt && r.status === "in_progress") return "Вы на месте — поездка для вас завершена";
  switch (r.status) {
    case "pending_assignment": return "Ищем водителя…";
    case "assigned": return `Заказ принял ${r.driverName || "водитель"}${r.vehiclePlate ? ` (${r.vehiclePlate})` : ""}`;
    case "in_progress": return `В пути — ${r.driverName || "водитель"}${r.vehiclePlate ? ` (${r.vehiclePlate})` : ""}`;
    case "completed": return "Завершено";
    case "cancelled": return `Отменено${r.cancelReason ? `: ${r.cancelReason}` : ""}`;
    default: return r.status;
  }
}

// Все цвета статусов — не ниже 4,5:1 на белом.
function statusColor(status) {
  switch (status) {
    case "pending_assignment": return "#8a6100";
    case "assigned":
    case "in_progress": return "#1565c0";
    case "completed": return "#1a7f37";
    case "cancelled": return "#b3261e";
    default: return "#555";
  }
}

export default function EmployeeRidesPage() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState(""); // ошибки действий на странице (не формы)
  const [formError, setFormError] = useState(""); // ошибки подачи — показываем у кнопки «Подать заявку»
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState(loadDraft);
  const [formOpen, setFormOpen] = useState(false); // при активных поездках форма свёрнута
  const [role, setRole] = useState(null); // диспетчер, зашедший сюда сам себе заказать машину, видит ссылку назад на /dispatcher
  // Главный админ: свои ФИО и телефон для водителя заполняет сам (у остальных — диспетчер).
  const [contact, setContact] = useState({ name: "", phone: "" });
  const [savedPhone, setSavedPhone] = useState("");
  const [contactSaving, setContactSaving] = useState(false);
  const [cancelTargetId, setCancelTargetId] = useState(null); // id заявки, для которой открыта модалка отмены
  const [holdCancelId, setHoldCancelId] = useState(null); // отмена после переброски машины — подтверждение
  const [proposeFor, setProposeFor] = useState(null); // id заявки, для которой добавляем точку через карту
  const [notice, setNotice] = useState("");
  const [cardEvents, setCardEvents] = useState({}); // { [id]: "Водитель больше не назначен — ищем другого" }
  const [highlightId, setHighlightId] = useState(null); // карточка, по которой только что пришла важная новость
  const [holdBusyId, setHoldBusyId] = useState(null); // «Вернуть в очередь» отправляется — от двойного тапа
  const [offline, setOffline] = useState(false);
  const [fleet, setFleet] = useState(null); // { hasFree, freeCount, nextFreeAt } — занятость парка
  const [slots, setSlots] = useState(null); // { date, capacity, counts: { "HH:MM": n } } — занятость времени подачи

  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const selfCancelledRef = useRef(new Set()); // отменённые самим пассажиром — не называть «отменил диспетчер»
  const activeSectionRef = useRef(null);
  const narrow = useNarrowScreen();

  useEffect(() => { saveDraft(form); }, [form]);

  // Фокус на «Мои поездки» — когда карточка, с которой работали, исчезла
  // (отменили): иначе фокус улетает в начало страницы.
  const focusRides = () => requestAnimationFrame(() => activeSectionRef.current?.focus({ preventScroll: true }));

  // requestedAt хранится одной строкой "YYYY-MM-DDTHH:MM" (как раньше у
  // datetime-local), но вводится двумя раздельными полями — датой и
  // временем с шагом 15 мин (см. QUARTER_HOUR_OPTIONS).
  const [requestedDate, requestedTime] = form.requestedAt ? form.requestedAt.split("T") : ["", ""];

  // Прошедшее время выбрать нельзя: прошлые даты — через min у поля даты,
  // сегодняшние уже наступившие слоты (включая текущий) — скрыты из
  // списка. Таймер перерисовывает форму, чтобы слоты гасли по ходу дня.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  // Время, подставленное само, двигаем вперёд, пока человек его не выбрал.
  useEffect(() => {
    setForm((f) => {
      if (!f.timeAuto) return f;
      const next = defaultRequestedAt();
      return f.requestedAt < next ? { ...f, requestedAt: next } : f;
    });
  }, [tick]);
  const today = localDateStr();
  const tomorrow = localDateStr(1);
  const nowTime = nowLocalTimeStr();
  const isPastSlot = (date, time) => date < today || (date === today && time <= nowTime);

  const setRequestedDate = (value) => setForm((f) => {
    if (!value) return { ...f, requestedAt: "" };
    const [, curTime] = f.requestedAt ? f.requestedAt.split("T") : ["", ""];
    const time = curTime && !isPastSlot(value, curTime)
      ? curTime
      : QUARTER_HOUR_OPTIONS.find((t) => !isPastSlot(value, t)) || QUARTER_HOUR_OPTIONS[0];
    return { ...f, requestedAt: `${value}T${time}`, timeAuto: false };
  });
  const setRequestedTime = (value) => setForm((f) => {
    const [curDate] = f.requestedAt ? f.requestedAt.split("T") : [""];
    return { ...f, requestedAt: `${curDate || localDateStr()}T${value}`, timeAuto: false };
  });

  // На одно время принимается не больше заявок, чем машин на линии
  // (server/rides/slots.js) — занятое время в списке выбрать нельзя.
  // Сервер проверяет то же самое при подаче, это только подсказка заранее.
  const slotsDate = requestedDate || localDateStr();
  const loadSlots = useCallback(() => {
    ridesApiFetch(`/api/v1/requests/slots?date=${slotsDate}`).then(setSlots).catch(() => setSlots(null));
  }, [slotsDate]);

  useEffect(() => {
    loadSlots();
    const t = setInterval(loadSlots, 60000);
    return () => clearInterval(t);
  }, [loadSlots]);

  // Заявки принимаются только в рабочее время. Решает сервер (время
  // Казахстана, приходит вместе со слотами); пока ответа нет — по часам
  // браузера, с теми же границами.
  const submission = slots?.submission || {
    open: nowTime >= "08:30" && nowTime < "17:30",
    message: "Заявки на легковой транспорт принимаются с 08:30 до 17:30. Сейчас подать заявку нельзя.",
  };

  const isSlotFull = (time) => !!slots && slots.date === slotsDate && (slots.counts[time] || 0) >= slots.capacity;
  const isSlotUnavailable = (time) => isPastSlot(slotsDate, time) || isSlotFull(time);
  const selectedSlotPast = !!requestedTime && isPastSlot(slotsDate, requestedTime);
  const selectedSlotFull = !!requestedTime && !selectedSlotPast && isSlotFull(requestedTime);
  const selectedSlotUnavailable = selectedSlotPast || selectedSlotFull;
  const nextFreeTime = selectedSlotUnavailable
    ? QUARTER_HOUR_OPTIONS.find((t) => t > requestedTime && !isSlotUnavailable(t)) || null
    : null;
  // На сегодня прошедшее время из списка убираем (иначе к вечеру — десятки
  // серых строк), но выбранное оставляем, чтобы было видно, что оно прошло.
  const timeOptions = QUARTER_HOUR_OPTIONS.filter((t) => !isPastSlot(slotsDate, t) || t === requestedTime);

  useEffect(() => {
    ridesApiFetch("/api/v1/users/me").then(({ user }) => {
      setRole(user?.role || null);
      setContact({ name: user?.name || "", phone: user?.phone || "" });
      setSavedPhone(user?.phone || "");
    }).catch(() => {});
  }, []);

  const loadFleet = useCallback(() => {
    ridesApiFetch("/api/v1/fleet-status").then(setFleet).catch(() => {});
  }, []);

  useEffect(() => {
    loadFleet();
    const t = setInterval(loadFleet, 60000);
    return () => clearInterval(t);
  }, [loadFleet]);

  // silent — фоновое обновление (после обрыва связи, при возврате на
  // вкладку): без «Загрузка…» поверх уже показанных карточек.
  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { requests: rows } = await ridesApiFetch("/api/v1/requests/mine");
      setRequests(rows);
      setLoadError("");
    } catch (err) {
      if (!silent) setLoadError(err.message || "Не удалось загрузить заявки");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Telegram и Android-приложение «усыпляют» страницу в фоне — вернувшись,
  // человек видел бы устаревший статус. Перечитываем при возврате.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      load({ silent: true });
      loadFleet();
      loadSlots();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load, loadFleet, loadSlots]);

  useEffect(() => {
    const socket = createRidesSocket();
    let lostConnection = false;

    // Важная новость по поездке — уведомлением (его зачитывает скринридер) и
    // короткой подсветкой карточки.
    let highlightTimer = null;
    const announce = (id, text) => {
      setNotice(text);
      setHighlightId(id);
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => setHighlightId(null), 2500);
    };

    // Что произошло с поездкой — строкой в её карточке. Снятие водителя
    // иначе видно только по тому, что статус «откатился». Причина бывает
    // разной (отказался сам, снял диспетчер), поэтому формулировка общая.
    // quiet — событие уже объяснено своим уведомлением (расстроилась
    // попутная поездка), строку в карточке не добавляем.
    const onUpdate = (req, { quiet = false } = {}) => {
      const prev = requestsRef.current.find((r) => r.id === req.id);
      if (!quiet && prev && ["assigned", "in_progress"].includes(prev.status) && req.status === "pending_assignment" && !req.onHold) {
        setCardEvents((ev) => ({ ...ev, [req.id]: "Водитель больше не назначен — ищем другого" }));
      } else if (req.status !== "pending_assignment") {
        setCardEvents((ev) => {
          if (!ev[req.id]) return ev;
          const next = { ...ev };
          delete next[req.id];
          return next;
        });
      }
      if (prev && prev.status !== "cancelled" && req.status === "cancelled" && !selfCancelledRef.current.has(req.id)) {
        setNotice(`Поездку${rideWhen(req)} отменил диспетчер${req.cancelReason ? `: ${req.cancelReason}` : ""}.`);
      }
      const car = `${req.driverName || "водитель"}${req.vehiclePlate ? `, машина ${req.vehiclePlate}` : ""}`;
      if (prev && prev.status !== req.status && !req.mergedInto) {
        if (req.status === "assigned") announce(req.id, `Заказ на ${formatWhen(req.requestedAt).toLowerCase()} принял ${car}.`);
        else if (req.status === "in_progress") announce(req.id, `Машина в пути — ${car}.`);
        else if (req.status === "completed") setNotice(`Поездка${rideWhen(req)} завершена.`);
      }
      setRequests((list) => list.map((r) => (r.id === req.id ? req : r)));
    };
    const onUpdateAndFleet = (req) => { onUpdate(req); loadFleet(); };
    const findRide = (id) => requestsRef.current.find((r) => r.id === id);

    socket.on("request:assigned", onUpdateAndFleet);
    socket.on("request:status", onUpdateAndFleet);
    socket.on("request:reassigned", (req) => {
      onUpdate(req);
      loadFleet();
      setNotice(`Машину с поездки${rideWhen(req)} направили на срочный вызов${req.pullReason ? `: ${req.pullReason}` : ""}. Выберите в карточке поездки, что делать дальше.`);
    });
    // К поездке пассажира добавили попутчика (водитель или диспетчер).
    socket.on("merge:applied", (m) => {
      load({ silent: true });
      const ride = findRide(m.requestId);
      setNotice(`К поездке${rideWhen(ride)} добавлен попутный пассажир.`);
    });
    socket.on("request:merged", (req) => {
      onUpdate(req);
      setNotice(`Вас подвезут попутно${req.driverName ? `, водитель ${req.driverName}` : ""}${req.pickupEtaAt ? `, посадка ${formatClock(req.pickupEtaAt)}` : ""}.`);
    });
    socket.on("request:unmerged", (req) => {
      onUpdate(req, { quiet: true });
      setNotice(`Попутная поездка расстроилась — заявка${rideWhen(req)} снова в общей очереди.`);
    });
    socket.on("proposal:updated", (p) => {
      if (p.status === "approved") setNotice(`Точка «${p.address}» добавлена в маршрут.`);
      else if (p.status === "rejected") setNotice(`Диспетчер отклонил точку «${p.address}»${p.decisionReason ? `: ${p.decisionReason}` : ""}.`);
      else if (p.status === "auto_rejected") setNotice(`Точка «${p.address}» отклонена автоматически — диспетчер не успел рассмотреть.`);
      setRequests((prev) => prev.map((r) => (
        r.id === p.requestId ? { ...r, stopProposals: (r.stopProposals || []).filter((sp) => sp.id !== p.id) } : r
      )));
    });

    // Пока связи нет, события по сокету теряются — после переподключения
    // перечитываем заявки целиком.
    socket.on("connect", () => {
      setOffline(false);
      if (lostConnection) {
        lostConnection = false;
        load({ silent: true });
        loadFleet();
      }
    });
    const onLost = () => { lostConnection = true; setOffline(true); };
    socket.on("disconnect", onLost);
    socket.on("connect_error", onLost);
    return () => {
      clearTimeout(highlightTimer);
      socket.disconnect();
    };
  }, [loadFleet, load]);

  // Сервер шлёт событие по сокету раньше, чем отвечает на запрос, —
  // поэтому «отменил сам» помечаем ДО запроса, иначе на миг всплывало бы
  // «Поездку отменил диспетчер».
  const holdDecision = async (requestId, decision) => {
    setError("");
    if (decision === "cancel") selfCancelledRef.current.add(requestId);
    else setHoldBusyId(requestId);
    try {
      const { request } = await ridesApiPost(`/api/v1/requests/${requestId}/hold-decision`, { decision });
      setRequests((prev) => prev.map((r) => (r.id === request.id ? request : r)));
      setNotice(decision === "requeue" ? "Заявка снова в очереди — её возьмёт первый свободный водитель." : "Заявка отменена.");
    } catch (err) {
      if (decision === "cancel") {
        selfCancelledRef.current.delete(requestId);
        throw err; // покажет окно подтверждения
      }
      setError(err.message || "Не удалось обработать решение");
    } finally {
      setHoldBusyId(null);
    }
  };

  const proposeStop = async (requestId, address, point) => {
    setProposeFor(null);
    setError("");
    try {
      // Новая точка от пассажира — всегда на согласование диспетчеру.
      await ridesApiPost(`/api/v1/requests/${requestId}/stop-changes`, { action: "add", address, lat: point?.lat, lng: point?.lng });
      setNotice(`Точка «${address}» отправлена диспетчеру на согласование.`);
      load({ silent: true });
    } catch (err) {
      setError(err.message || "Не удалось добавить точку");
    }
  };

  const isSiteAdminUser = role === "admin";
  const needsContact = isSiteAdminUser && !savedPhone.trim();

  const saveContact = async (e) => {
    e.preventDefault();
    setContactSaving(true);
    setError("");
    try {
      const { user } = await ridesApiPatch("/api/v1/users/me", contact);
      setContact({ name: user.name, phone: user.phone });
      setSavedPhone(user.phone);
      setNotice("Ваши ФИО и телефон сохранены — их увидит водитель.");
    } catch (err) {
      setError(err.message || "Не удалось сохранить данные");
    } finally {
      setContactSaving(false);
    }
  };

  // Адреса без точки на карте: заявку нельзя отправить, пока их не отметят.
  const addressFields = [
    { label: "откуда", v: form.from },
    { label: "куда", v: form.to },
    ...form.extraStops.map((v, i) => ({ label: `пункт ${i + 1}`, v })),
  ].filter((f) => f.v.address.trim());
  const needMap = addressFields.filter((f) => addressNeedsMap(f.v));
  // Вписанный вручную населённый пункт не найден (или ещё не вписан).
  const badCity = addressFields.filter((f) => cityProblem(f.v));
  const checking = addressFields.some((f) => !addressReady(f.v) && !addressNeedsMap(f.v) && !cityProblem(f.v));
  const addressesReady = !needMap.length && !badCity.length && !checking;

  const blockedReason = needsContact
    ? "Сначала сохраните ваши ФИО и телефон в блоке «Ваши данные для водителя» выше."
    : !submission.open
      ? submission.message
      : selectedSlotUnavailable
        ? "Выберите другое время подачи."
        : "";
  const submitBlocked = submitting || selectedSlotUnavailable || !submission.open || needsContact || !addressesReady;

  const submit = async (e) => {
    e.preventDefault();
    // Кнопка помечена aria-disabled, а не disabled (чтобы до неё доходил Tab
    // и озвучивалась причина) — поэтому проверяем блокировку здесь.
    if (submitting) return;
    if (selectedSlotUnavailable || !submission.open || needsContact) {
      setFormError(blockedReason);
      return;
    }
    const missing = [
      !form.from.address.trim() && "откуда",
      !form.to.address.trim() && "куда",
      !form.requestedAt && "время подачи",
      !form.purpose.trim() && "цель поездки",
    ].filter(Boolean);
    if (missing.length) {
      setFormError(`Заполните: ${missing.join(", ")}.`);
      return;
    }
    if (!addressesReady) {
      setFormError(checking ? "Подождите секунду — проверяем адреса." : "Проверьте адреса выше: нужен населённый пункт или точка на карте.");
      return;
    }
    setSubmitting(true);
    setFormError("");
    const filledStops = form.extraStops.map((v, i) => i).filter((i) => form.extraStops[i].address.trim());
    try {
      const from = addressPayload(form.from);
      const to = addressPayload(form.to);
      const passengers = Math.min(MAX_PASSENGERS, Math.max(1, Number(form.passengersCount) || 1));
      const payload = {
        fromAddress: from.address, fromLat: from.lat, fromLng: from.lng,
        toAddress: to.address, toLat: to.lat, toLng: to.lng,
        extraStops: filledStops.map((i) => addressPayload(form.extraStops[i])),
        requestedAt: form.requestedAt, purpose: form.purpose, passengersCount: passengers,
        withReturn: form.withReturn, comment: form.comment,
      };
      const { request } = await ridesApiPost("/api/v1/requests", payload);
      setRequests((prev) => [request, ...prev]);
      clearDraft();
      setForm(makeEmptyForm());
      setFormOpen(false);
      setNotice(`Заявка на ${formatWhen(request.requestedAt).toLowerCase()} подана — ищем водителя. Когда его назначат, статус обновится здесь.`);
      // Показать новую поездку: карточки теперь наверху страницы.
      requestAnimationFrame(() => {
        activeSectionRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
        activeSectionRef.current?.focus({ preventScroll: true });
      });
    } catch (err) {
      setFormError(err.message || "Не удалось отправить заявку");
      // Сервер не нашёл адрес точно — подсветить эти поля (нужна точка на карте).
      if (err.data?.unresolved) {
        setForm((f) => {
          const next = { ...f, extraStops: [...f.extraStops] };
          for (const u of err.data.unresolved) {
            const mark = (v) => ({ ...v, point: null, status: ["street", "unavailable"].includes(u.status) ? u.status : "not_found" });
            if (u.index === 0) next.from = mark(next.from);
            else if (u.index === 1) next.to = mark(next.to);
            else if (filledStops[u.index - 2] != null) next.extraStops[filledStops[u.index - 2]] = mark(next.extraStops[filledStops[u.index - 2]]);
          }
          return next;
        });
      }
    } finally {
      loadSlots(); // и после успеха (слот занят на одну заявку больше), и после отказа "время занято"
      setSubmitting(false);
    }
  };

  // Ошибку покажет само окно отмены (CancelRequestModal), а не страница за ним.
  const cancelRequest = async (reason) => {
    const id = cancelTargetId;
    selfCancelledRef.current.add(id); // до запроса — см. holdDecision
    try {
      const { request } = await ridesApiPost(`/api/v1/requests/${id}/cancel-mine`, { reason });
      setRequests((prev) => prev.map((r) => (r.id === request.id ? request : r)));
    } catch (err) {
      selfCancelledRef.current.delete(id);
      throw err;
    }
    setCancelTargetId(null);
    setNotice("Заявка отменена.");
    focusRides();
  };

  const setPassengers = (n) => setForm((f) => ({ ...f, passengersCount: Math.min(MAX_PASSENGERS, Math.max(1, n)) }));

  const active = requests.filter((r) => !["completed", "cancelled"].includes(r.status));
  const history = requests.filter((r) => ["completed", "cancelled"].includes(r.status));
  const hasActive = !loading && active.length > 0;
  // Пока заявки грузятся, форму не показываем: иначе она мелькнёт и
  // свернётся, если поездка уже есть.
  const showForm = !loading && (!hasActive || formOpen);

  const activeSection = (
    <section style={s.section} aria-labelledby="active-rides-title" ref={activeSectionRef} tabIndex={-1}>
      <h2 id="active-rides-title" style={s.sectionTitle}>Мои поездки</h2>
      {loading ? <p style={s.muted}>Загрузка…</p> : loadError && !requests.length ? (
        <p style={s.muted}>Не удалось загрузить поездки — см. сообщение вверху.</p>
      ) : active.length === 0 ? (
        <p style={s.muted}>Активных заявок нет.</p>
      ) : (
        <div style={s.cards}>
          {active.map((r) => {
            const statusTone = statusColor(r.droppedOffAt ? "completed" : r.status);
            return (
              <article
                key={r.id}
                style={{ ...s.card, ...(r.onHold || r.mergedInto ? s.cardHold : null), ...(highlightId === r.id ? s.cardHighlight : null) }}
                aria-label={`Поездка: ${formatWhen(r.requestedAt)}`}
              >
                <div style={s.cardWhen}>{formatWhen(r.requestedAt)}</div>

                {r.mergedInto ? (
                  <div style={s.holdBox}>
                    <div style={s.holdTitle}>Вас подвезут попутно</div>
                    <div style={s.cardMeta}>
                      {r.driverName ? `Водитель ${r.driverName}` : "Водитель назначен"}
                      {r.vehiclePlate ? ` (${r.vehiclePlate})` : ""}
                      {r.pickupEtaAt ? ` · посадка ${formatClock(r.pickupEtaAt)}` : ""}
                    </div>
                  </div>
                ) : r.onHold ? (
                  <div style={s.holdBox}>
                    <div style={s.holdTitle}>Машину направили на срочный вызов</div>
                    {r.pullReason && <div style={s.cardMeta}>Причина: {r.pullReason}</div>}
                    <div style={s.cardMeta}>Вернуть заявку в очередь или отменить её?</div>
                    <div style={s.holdActions}>
                      <button type="button" style={s.primaryButton} disabled={holdBusyId === r.id} onClick={() => holdDecision(r.id, "requeue")}>
                        {holdBusyId === r.id ? "Секунду…" : "Вернуть в очередь"}
                      </button>
                      <button type="button" style={s.cancelButton} disabled={holdBusyId === r.id} onClick={() => setHoldCancelId(r.id)}>Отменить заявку</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ ...s.cardStatus, color: statusTone }}>{statusLabel(r)}</div>
                )}
                {/* Номер машины — то, что ищут глазами у подъезда. */}
                {["assigned", "in_progress"].includes(r.status) && r.vehiclePlate && !r.mergedInto && (
                  <div style={s.plateRow}>Машина <span style={s.plate}>{r.vehiclePlate}</span></div>
                )}
                {cardEvents[r.id] && <div style={s.cardEvent}>{cardEvents[r.id]}</div>}

                <div style={s.cardRoute}>{formatRoute(r)}{r.withReturn && <span style={s.returnBadge}> · туда-обратно</span>}</div>
                <div style={s.cardMeta}>Пассажиров: {r.passengersCount}</div>
                {formatEstimate(r) && <div style={s.cardMeta}>{formatEstimate(r)}</div>}
                {r.comment && <div style={s.cardMeta}>Комментарий: {r.comment}</div>}

                {r.mergedRequests?.length > 0 && (
                  <div style={s.pendingBox}>
                    {r.mergedRequests.map((m) => (
                      <div key={m.id}>С вами попутно едет пассажир: {m.fromAddress} → {m.toAddress}</div>
                    ))}
                  </div>
                )}
                {r.stopProposals?.length > 0 && (
                  <div style={s.pendingBox}>
                    {r.stopProposals.map((sp) => (
                      <div key={sp.id}>Точка «{sp.address}» ждёт решения диспетчера</div>
                    ))}
                  </div>
                )}
                {!r.onHold && (
                  <div style={s.cardActions}>
                    {/* Попутную заявку можно отменить (её точки уберут из
                        маршрута поездки), а менять маршрут — нет: он общий. */}
                    {CAN_EDIT_ROUTE.includes(r.status) && !r.mergedInto && (
                      <button type="button" style={s.secondaryButton} onClick={() => setProposeFor(r.id)}>+ Добавить точку</button>
                    )}
                    {["pending_assignment", "assigned"].includes(r.status) && (
                      <button type="button" style={s.cancelButton} onClick={() => setCancelTargetId(r.id)}>Отменить заявку</button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  return (
    <div style={s.page}>
      <header style={s.header}>
        <h1 style={s.title}>Заказ служебного транспорта</h1>
        <div style={s.headerRight}>
          {/* Админу на сайте ссылки даёт AdminPanelLinks, в Mini App её нет. */}
          {(role === "dispatcher" || (role === "admin" && isTelegramMiniApp())) && (
            <Link to={ridesPath("/dispatcher")} style={s.link}>← Панель диспетчера</Link>
          )}
          <AdminPanelLinks style={s.link} />
          <LogoutButton style={s.headerButton} />
        </div>
      </header>

      <main>
        {/* Регион всегда на странице — тогда скринридер зачитывает и
            уведомление, и пропажу связи, когда они появляются. */}
        <div aria-live="polite" role="status">
          {offline && (
            <div style={s.offline}>Нет связи с сервером — статусы могут быть устаревшими. Обновим, когда связь вернётся.</div>
          )}
          {notice && (
            <div style={s.notice}>
              <span style={{ flex: 1 }}>{notice}</span>
              <button type="button" style={s.noticeClose} onClick={() => setNotice("")} aria-label="Закрыть уведомление">×</button>
            </div>
          )}
        </div>
        {loadError && !loading && !requests.length && (
          <div style={s.error} role="alert">
            <span style={{ flex: 1 }}>{loadError}</span>
            <button type="button" style={s.errorAction} onClick={() => load()}>Повторить</button>
          </div>
        )}
        {error && (
          <div style={s.error} role="alert">
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" style={s.noticeClose} onClick={() => setError("")} aria-label="Закрыть сообщение об ошибке">×</button>
          </div>
        )}

        {isSiteAdminUser && (
          <form onSubmit={saveContact} style={needsContact ? { ...s.contactBox, ...s.contactBoxAlert } : s.contactBox}>
            <div style={s.contactTitle}>Ваши данные для водителя</div>
            {needsContact && <div style={s.contactHint}>Укажите ФИО и телефон — без них заявку подать нельзя: водитель должен знать, кого везёт и куда звонить.</div>}
            <div style={s.contactRow}>
              <input style={s.contactInput} aria-label="ФИО" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} placeholder="ФИО" autoComplete="name" />
              <input style={s.contactInput} aria-label="Телефон" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} placeholder="+7 701 123 45 67" inputMode="tel" autoComplete="tel" />
              <button type="submit" style={s.primaryButton} disabled={contactSaving}>{contactSaving ? "Сохраняем…" : "Сохранить"}</button>
            </div>
          </form>
        )}

        {/* Есть поездка — сначала она: кто едет и когда. Форма новой заявки ниже, свёрнута. */}
        {hasActive && activeSection}

        {hasActive && (
          <button
            type="button"
            style={formOpen ? s.disclosureOpen : s.disclosure}
            aria-expanded={formOpen}
            aria-controls="new-ride-form"
            onClick={() => setFormOpen((v) => !v)}
          >
            {formOpen ? "Скрыть форму новой заявки" : "+ Новая заявка"}
          </button>
        )}

        {showForm && (
          <section id="new-ride-form" aria-labelledby="new-ride-title" style={s.formSection}>
            <h2 id="new-ride-title" style={s.sectionTitle}>Новая заявка</h2>

            {!submission.open ? (
              <div style={s.submissionClosed}>
                <b>{submission.message}</b>
                <div style={{ ...s.bannerHint, color: "#8a1c1c" }}>Форму можно заполнить заранее и отправить, когда откроется приём — она сохранится, даже если закрыть вкладку ненадолго.</div>
              </div>
            ) : fleet && (
              fleet.hasFree ? (
                <div style={s.fleetOk}>
                  Свободные машины есть{fleet.freeCount > 1 ? ` — ${fleet.freeCount}` : ""}. Заявку возьмёт первый освободившийся водитель.
                </div>
              ) : (
                <div style={s.fleetBusy}>
                  <b>Все машины сейчас заняты.</b>{" "}
                  {fleet.nextFreeAt
                    ? `Ближайшая освободится ${formatClock(fleet.nextFreeAt)}.`
                    : "Время освобождения пока не определено."}
                  <div style={s.bannerHint}>Заявку можно подать — она встанет в очередь и её возьмёт первый освободившийся водитель.</div>
                </div>
              )
            )}

            <form onSubmit={submit} style={s.form} noValidate>
              <div role="group" aria-labelledby="from-label" style={s.field}>
                <span id="from-label" style={s.labelText}>Откуда <span aria-hidden="true">*</span></span>
                <AddressField label="Откуда" value={form.from} onChange={(v) => setForm((f) => ({ ...f, from: v }))} inputStyle={s.input} buttonStyle={s.mapButton} mapTitle="Отметьте место подачи" />
              </div>
              <div role="group" aria-labelledby="to-label" style={s.field}>
                <span id="to-label" style={s.labelText}>Куда <span aria-hidden="true">*</span></span>
                <AddressField label="Куда" value={form.to} onChange={(v) => setForm((f) => ({ ...f, to: v }))} inputStyle={s.input} buttonStyle={s.mapButton} mapTitle="Отметьте место назначения" />
              </div>

              {form.extraStops.map((stop, i) => (
                <div key={i} role="group" aria-labelledby={`stop-label-${i}`} style={s.field}>
                  <span id={`stop-label-${i}`} style={s.labelText}>Затем — пункт {i + 1}</span>
                  <div style={s.stopRow}>
                    <AddressField
                      label={`Пункт ${i + 1}`}
                      value={stop}
                      inputStyle={s.input}
                      buttonStyle={s.mapButton}
                      mapTitle={`Отметьте пункт назначения ${i + 1}`}
                      onChange={(v) => setForm((f) => {
                        const next = [...f.extraStops];
                        next[i] = v;
                        return { ...f, extraStops: next };
                      })}
                    />
                    <button
                      type="button"
                      style={s.removeStopButton}
                      aria-label={`Удалить пункт ${i + 1}`}
                      onClick={() => setForm((f) => ({ ...f, extraStops: f.extraStops.filter((_, j) => j !== i) }))}
                    >
                      Удалить
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                style={s.addStopButton}
                onClick={() => setForm((f) => ({ ...f, extraStops: [...f.extraStops, emptyAddress] }))}
              >
                + Ещё пункт после «Куда»
              </button>

              <div role="group" aria-labelledby="when-label" style={s.field}>
                <span id="when-label" style={s.labelText}>Когда подать машину <span aria-hidden="true">*</span></span>
                <div style={s.chips} role="radiogroup" aria-label="День подачи">
                  {[["Сегодня", today], ["Завтра", tomorrow]].map(([label, date]) => (
                    <button
                      key={date}
                      type="button"
                      role="radio"
                      aria-checked={requestedDate === date}
                      style={requestedDate === date ? s.chipActive : s.chip}
                      onClick={() => setRequestedDate(date)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div style={s.whenRow}>
                  <input
                    type="date"
                    aria-label="Дата подачи"
                    style={{ ...s.input, flex: "1 1 160px" }}
                    min={today}
                    value={requestedDate}
                    onChange={(e) => setRequestedDate(e.target.value)}
                  />
                  <select
                    aria-label="Время подачи"
                    style={{ ...s.input, flex: "0 0 150px" }}
                    value={requestedTime || ""}
                    onChange={(e) => setRequestedTime(e.target.value)}
                  >
                    <option value="" disabled>Время</option>
                    {timeOptions.map((t) => {
                      const past = isPastSlot(slotsDate, t);
                      const full = !past && isSlotFull(t);
                      return (
                        <option key={t} value={t} disabled={(past || full) && t !== requestedTime}>
                          {full ? `${t} — занято` : t}
                        </option>
                      );
                    })}
                  </select>
                </div>
                {selectedSlotUnavailable && (
                  <div style={s.slotWarning} role="status">
                    {selectedSlotPast ? `Время ${requestedTime} уже прошло.` : `На ${requestedTime} машин уже не хватает.`}{" "}
                    {nextFreeTime ? (
                      <button type="button" style={s.inlineAction} onClick={() => setRequestedTime(nextFreeTime)}>
                        Выбрать ближайшее свободное — {nextFreeTime}
                      </button>
                    ) : (
                      "До конца дня свободного времени нет — выберите другую дату."
                    )}
                  </div>
                )}
              </div>

              <div role="group" aria-labelledby="passengers-label" style={s.field}>
                <span id="passengers-label" style={s.labelText}>Пассажиров</span>
                <div style={s.stepper}>
                  <button type="button" style={s.stepButton} aria-label="Меньше пассажиров" disabled={Number(form.passengersCount) <= 1} onClick={() => setPassengers((Number(form.passengersCount) || 1) - 1)}>−</button>
                  <input
                    type="number"
                    inputMode="numeric"
                    aria-label="Количество пассажиров"
                    min={1}
                    max={MAX_PASSENGERS}
                    style={s.stepInput}
                    value={form.passengersCount}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setForm((f) => ({ ...f, passengersCount: Number.isNaN(n) ? "" : Math.min(MAX_PASSENGERS, Math.max(1, n)) }));
                    }}
                    onBlur={() => setPassengers(Number(form.passengersCount) || 1)}
                  />
                  <button type="button" style={s.stepButton} aria-label="Больше пассажиров" disabled={Number(form.passengersCount) >= MAX_PASSENGERS} onClick={() => setPassengers((Number(form.passengersCount) || 1) + 1)}>+</button>
                </div>
              </div>

              <label style={s.field}>
                <span style={s.labelText}>Цель поездки <span aria-hidden="true">*</span></span>
                <input style={s.input} required aria-required="true" value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} />
              </label>
              <label style={s.checkboxLabel}>
                <input type="checkbox" style={s.checkbox} checked={form.withReturn} onChange={(e) => setForm((f) => ({ ...f, withReturn: e.target.checked }))} />
                С ожиданием и возвратом (водитель ждёт на месте и везёт обратно)
              </label>
              <label style={s.field}>
                <span style={s.labelText}>Комментарий для водителя</span>
                <textarea style={{ ...s.input, minHeight: "72px", paddingTop: "10px" }} value={form.comment} onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))} />
              </label>
              {badCity.length > 0 && (
                <div style={s.slotWarning}>
                  Укажите населённый пункт ({badCity.map((f) => f.label).join(", ")}): выберите из списка или впишите название, найденное на карте.
                </div>
              )}
              {needMap.length > 0 && (
                <div style={s.slotWarning}>
                  Укажите на карте: {needMap.map((f) => `«${f.v.address.trim()}» (${f.label})`).join(", ")} — для точного расчёта времени в пути и километража.
                </div>
              )}
              {/* Ошибка подачи — у кнопки, а не вверху страницы, где её не видно. */}
              {formError && <div style={s.formError} role="alert">{formError}</div>}
              <button
                type="submit"
                style={submitBlocked ? { ...s.submitButton, ...s.buttonDisabled } : s.submitButton}
                aria-disabled={submitBlocked || undefined}
                aria-describedby={blockedReason ? "submit-blocked-reason" : undefined}
              >
                {checking ? "Проверяем адреса…" : submitting ? "Отправляем…" : "Подать заявку"}
              </button>
              {/* Почему кнопка неактивна — иначе кажется, что «ничего не происходит». */}
              {blockedReason && <div id="submit-blocked-reason" style={s.blockedReason}>{blockedReason}</div>}
            </form>
          </section>
        )}

        {!hasActive && activeSection}

        <TelegramConnect hint="Узнавайте в Telegram, кто вас везёт: водитель назначен, машина в пути, поездка завершена." />

        <section style={s.section} aria-labelledby="history-title">
          <h2 id="history-title" style={s.sectionTitle}>История поездок</h2>
          {loading ? <p style={s.muted}>Загрузка…</p> : history.length === 0 ? (
            <p style={s.muted}>{loadError ? "Не удалось загрузить историю." : "Пока ничего нет."}</p>
          ) : (
            <RideHistoryTable rows={history} hideEmployee compact={narrow} />
          )}
        </section>
      </main>

      {cancelTargetId && (
        <CancelRequestModal onClose={() => setCancelTargetId(null)} onConfirm={cancelRequest} />
      )}
      {holdCancelId && (
        <ConfirmDialog
          title="Отменить заявку?"
          text="Машина для неё больше не будет назначена."
          confirmLabel="Отменить заявку"
          cancelLabel="Не отменять"
          danger
          onConfirm={async () => { await holdDecision(holdCancelId, "cancel"); setHoldCancelId(null); }}
          onClose={() => setHoldCancelId(null)}
        />
      )}
      {proposeFor && (
        <MapPicker title="Отметьте новую точку маршрута" onClose={() => setProposeFor(null)} onSelect={(address, point) => proposeStop(proposeFor, address, point)} />
      )}
    </div>
  );
}

// Размеры под телефон: шрифт полей 16px (меньше — iOS и Telegram на iOS
// увеличивают масштаб при фокусе), высота кнопок и полей от 44px.
// Цвета текста — не ниже 4,5:1 к своему фону.
const control = { minHeight: "44px", borderRadius: "8px", fontSize: "16px", boxSizing: "border-box" };
const button = { minHeight: "44px", borderRadius: "8px", padding: "0 16px", cursor: "pointer", fontSize: "15px", boxSizing: "border-box" };
const banner = { borderRadius: "8px", padding: "10px 14px", marginBottom: "12px", fontSize: "14px", lineHeight: 1.45 };

const s = {
  page: { padding: "16px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "700px", margin: "0 auto", boxSizing: "border-box", color: "#1f1f1f" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "16px" },
  headerRight: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "12px" },
  headerButton: { minHeight: "40px", fontSize: "14px" },
  link: { color: "#1565c0", fontSize: "14px", textDecoration: "none", padding: "10px 0" },
  title: { fontSize: "clamp(20px, 5vw, 24px)", margin: 0 },

  error: { ...banner, display: "flex", alignItems: "center", gap: "8px", background: "#fff0f0", color: "#a40000" },
  errorAction: { flex: "none", minHeight: "36px", background: "#fff", border: "1px solid #a40000", color: "#a40000", borderRadius: "8px", padding: "0 12px", cursor: "pointer", fontSize: "14px" },
  offline: { ...banner, background: "#f3f3f3", color: "#3d3d3d", border: "1px solid #d6d6d6" },
  notice: { ...banner, display: "flex", alignItems: "flex-start", gap: "8px", background: "#eef6ff", color: "#0b5cad", border: "1px solid #b8d9f7" },
  noticeClose: { flex: "none", width: "36px", height: "36px", margin: "-6px -8px -6px 0", background: "none", border: "none", color: "#0b5cad", fontSize: "22px", lineHeight: 1, cursor: "pointer", borderRadius: "6px" },
  fleetOk: { ...banner, background: "#eaf7ec", color: "#1a6b30", border: "1px solid #b6e0bf" },
  fleetBusy: { ...banner, background: "#fff7e6", color: "#7a4f00", border: "1px solid #f0d19a" },
  submissionClosed: { ...banner, background: "#fff0f0", color: "#a40000", border: "1px solid #f5b5b5" },
  bannerHint: { marginTop: "4px", fontSize: "13px", color: "#6b4a10" },
  slotWarning: { marginTop: "4px", fontSize: "14px", color: "#9a3412", lineHeight: 1.45 },
  inlineAction: { background: "none", border: "none", padding: "10px 0", color: "#1565c0", textDecoration: "underline", cursor: "pointer", fontSize: "14px", textAlign: "left" },
  muted: { color: "#5f5f5f", fontSize: "15px" },
  cardActions: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" },
  pendingBox: { marginTop: "8px", background: "#fffdf6", border: "1px solid #f0d9a8", borderRadius: "8px", padding: "8px 10px", fontSize: "14px", color: "#6b4a10" },
  contactBox: { background: "#f4f9ff", border: "1px solid #cfe3f7", borderRadius: "8px", padding: "12px 14px", marginBottom: "16px" },
  contactBoxAlert: { background: "#fff7e6", border: "1px solid #f0c48a" },
  contactTitle: { fontWeight: 700, fontSize: "15px", marginBottom: "6px" },
  contactHint: { fontSize: "14px", color: "#7a4f00", marginBottom: "8px" },
  contactRow: { display: "flex", gap: "8px", flexWrap: "wrap" },
  contactInput: { ...control, flex: "1 1 200px", minWidth: 0, padding: "8px 12px", border: "1px solid #8c8c8c" },
  cardHold: { border: "1px solid #f0c48a", background: "#fffaf3" },
  // Подсветка карточки при важной новости (плавный переход — в card,
  // отключается при «уменьшить движение»).
  cardHighlight: { boxShadow: "0 0 0 3px #1565c0" },
  plateRow: { fontSize: "14px", color: "#4a4a4a", marginBottom: "8px" },
  plate: { display: "inline-block", marginLeft: "6px", padding: "2px 8px", border: "2px solid #1f1f1f", borderRadius: "4px", fontSize: "17px", fontWeight: 700, letterSpacing: "0.04em", color: "#1f1f1f", fontVariantNumeric: "tabular-nums" },
  holdBox: { marginTop: "6px", background: "#fff3e0", border: "1px solid #f0c48a", borderRadius: "8px", padding: "10px 12px" },
  holdTitle: { fontWeight: 700, fontSize: "15px", color: "#8a3c00", marginBottom: "4px" },
  holdActions: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" },

  disclosure: { ...button, width: "100%", marginBottom: "24px", background: "#fff", border: "1px dashed #1565c0", color: "#1565c0", fontWeight: 600 },
  disclosureOpen: { ...button, width: "100%", marginBottom: "12px", background: "#f4f8fd", border: "1px solid #c5d9f0", color: "#1565c0" },
  formSection: { marginBottom: "28px" },
  form: { background: "#fff", border: "1px solid #e3e3e3", borderRadius: "12px", padding: "16px", display: "flex", flexDirection: "column", gap: "16px", boxSizing: "border-box" },
  field: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
  labelText: { fontSize: "14px", fontWeight: 600, color: "#333" },
  checkboxLabel: { display: "flex", alignItems: "center", gap: "10px", fontSize: "15px", color: "#333", minHeight: "44px", cursor: "pointer" },
  checkbox: { width: "20px", height: "20px", flex: "none", margin: 0 },
  // Рамки полей и кнопок #8c8c8c — 3,4:1 к белому (нетекстовый контраст ≥ 3:1).
  input: { ...control, padding: "8px 12px", border: "1px solid #8c8c8c", width: "100%", minWidth: 0, background: "#fff" },
  chips: { display: "flex", gap: "8px" },
  chip: { ...button, background: "#fff", border: "1px solid #8c8c8c", color: "#333" },
  chipActive: { ...button, background: "#e3effc", border: "1px solid #1565c0", color: "#0d47a1", fontWeight: 600 },
  whenRow: { display: "flex", gap: "8px", flexWrap: "wrap" },
  stepper: { display: "flex", alignItems: "center", gap: "8px" },
  stepButton: { ...button, width: "44px", padding: 0, background: "#fff", border: "1px solid #8c8c8c", color: "#222", fontSize: "20px" },
  stepInput: { ...control, width: "72px", textAlign: "center", padding: "8px", border: "1px solid #8c8c8c" },
  primaryButton: { ...button, background: "#1565c0", color: "#fff", border: "none", fontWeight: 600 },
  secondaryButton: { ...button, background: "#fff", border: "1px solid #1565c0", color: "#1565c0" },
  submitButton: { ...button, minHeight: "48px", background: "#1565c0", color: "#fff", border: "none", fontWeight: 600, fontSize: "16px" },
  // Неактивная кнопка остаётся читаемой (5,8:1) — причина рядом, в blockedReason.
  buttonDisabled: { background: "#e0e6ea", color: "#455a64", cursor: "not-allowed" },
  formError: { background: "#fff0f0", color: "#a40000", border: "1px solid #f5b5b5", borderRadius: "8px", padding: "10px 14px", fontSize: "14px" },
  blockedReason: { fontSize: "14px", color: "#9a3412", marginTop: "-6px" },
  stopRow: { display: "flex", gap: "8px", alignItems: "flex-start", flexWrap: "wrap" },
  addStopButton: { ...button, alignSelf: "flex-start", background: "none", border: "1px dashed #1565c0", color: "#1565c0" },
  removeStopButton: { ...button, background: "#fff0f0", color: "#a40000", border: "1px solid #f5b5b5" },
  mapButton: { ...button, background: "#fff", border: "1px solid #8c8c8c", whiteSpace: "nowrap" },

  section: { marginBottom: "28px", outline: "none" },
  sectionTitle: { fontSize: "18px", margin: "0 0 12px" },

  cards: { display: "flex", flexDirection: "column", gap: "12px" },
  card: { background: "#fff", border: "1px solid #e3e3e3", borderRadius: "12px", padding: "14px 16px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", boxSizing: "border-box",
    transition: prefersReducedMotion() ? "none" : "box-shadow 0.6s cubic-bezier(0.16, 1, 0.3, 1)" },
  cardWhen: { fontSize: "20px", fontWeight: 700, marginBottom: "2px" },
  cardStatus: { fontSize: "16px", fontWeight: 600, marginBottom: "8px" },
  cardEvent: { fontSize: "14px", color: "#7a4f00", background: "#fff6e0", borderRadius: "6px", padding: "6px 10px", marginBottom: "8px" },
  cardRoute: { fontWeight: 600, fontSize: "15px", marginBottom: "4px", wordBreak: "break-word" },
  cardMeta: { fontSize: "14px", color: "#4a4a4a", marginBottom: "2px", wordBreak: "break-word" },
  cancelButton: { ...button, background: "#fff0f0", color: "#a40000", border: "1px solid #f5b5b5" },
  returnBadge: { fontWeight: 400, fontSize: "14px", color: "#5f5f5f" },
};
