// Тот же email, что server/adminAuth.js признаёт главным админом сайта.
// Роль в системе поездок ему не назначают: он пускается во все её панели
// (диспетчер/пассажир/водитель/справочники) по email; служебная запись в
// rides.users с ролью 'admin' создаётся сервером сама (server/rides/auth.js).
export const SITE_ADMIN_EMAIL = "admin@vkdev.kz";

// Куда ведёт роль в системе поездок — единый источник для RideAccessGate.jsx
// (запирает сюда тех, у кого нет full_site_access) и для мест вроде
// HomePage.js (даёт обычным пользователям с полным доступом ссылку назад
// на их страницу поездок).
export const ROLE_HOME_PATH = {
  employee: "/employee",
  dispatcher: "/dispatcher",
  driver: "/driver",
  admin: "/dispatcher", // главный админ — оттуда ссылки на остальные панели
  driller: "/drilling-requests", // бурильщик заперт на заявках на бурение
};

// Роли, у которых нет ни одной страницы в системе поездок (заявки на бурение и резку):
// ссылку «назад в поездки» им на главной не показываем.
export const NON_RIDE_ROLES = ["staff", "chief_engineer", "prom_alyans", "driller"];

// Роли, которым нельзя подавать заявки на бурение и резку (исполнители) — для интерфейса;
// настоящий запрет — на сервере (server/drilling/service.js).
export const DRILLING_NO_SUBMIT_ROLES = ["prom_alyans", "driller"];
