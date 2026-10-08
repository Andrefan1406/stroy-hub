// Сессия Telegram Mini App. Внутри Telegram нет Firebase-логина: страница
// /tg обменивает подписанные Telegram данные на токен сессии системы
// поездок (server/rides/telegram/webappAuth.js), и страницы под /tg ходят в
// API с ним вместо Firebase ID-токена (api.js, socket.js).
//
// Токен — только для страниц под /tg: если тот же браузер открыт и на
// обычном сайте, там по-прежнему работает Firebase-логин.
const STORAGE_KEY = "rides.telegramSession";
const SCRIPT_URL = "https://telegram.org/js/telegram-web-app.js";

let session = null;

export function setTelegramSession(value) {
  session = value;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // sessionStorage недоступен — сессия живёт до перезагрузки страницы
  }
}

export function getTelegramSession() {
  if (!session) {
    try {
      session = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      session = null;
    }
  }
  if (session && !(Date.parse(session.expiresAt) > Date.now())) session = null;
  return session;
}

export function isTelegramMiniApp() {
  return window.location.pathname.startsWith("/tg") && !!getTelegramSession();
}

// Путь внутри системы поездок: в Mini App — под /tg (там свои маршруты без
// Firebase-логина), на сайте — как есть.
export function ridesPath(path) {
  return isTelegramMiniApp() ? `/tg${path}` : path;
}

// Скрипт Telegram подключаем только на страницах Mini App, не на всём сайте.
// Возвращает Telegram.WebApp или null (открыто не из Telegram / скрипт не загрузился).
export function loadTelegramWebApp() {
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.Telegram?.WebApp || null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}
