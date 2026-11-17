// Пользователи с доступом только к одной странице: после входа (и при попытке открыть любой другой
// адрес) их сразу перенаправляет на «домашнюю» страницу, см. components/RestrictedUserGate.jsx.
// Клиентское ограничение — только UX, как и AdminRoute: админ-эндпоинты сервера по-прежнему проверяют
// Firebase ID-токен и список разрешённых адресов (server/planradarExport.js).
export const PLANRADAR_REPORT_PATH = "/admin/planradar-export";

// email (строчными) → единственная доступная страница
export const RESTRICTED_USERS = {
  "rabdrakhmanov@kazmintech.com": PLANRADAR_REPORT_PATH,
};

export const restrictedHome = (email) => RESTRICTED_USERS[(email || "").toLowerCase()] || null;
export const PLANRADAR_REPORT_EMAILS = Object.keys(RESTRICTED_USERS);
