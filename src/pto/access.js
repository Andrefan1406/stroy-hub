// Кто видит модуль ПТО. Только UX (скрыть карточку в личном кабинете и
// закрыть страницу): настоящая проверка — на сервере, server/pto/access.js
// (Firebase ID-токен, 403 для остальных). Список держать равным серверному.
export const PTO_ALLOWED_EMAILS = ["admin@vkdev.kz"];

export const canUsePto = (email) => !!email && PTO_ALLOWED_EMAILS.includes(email.toLowerCase());
