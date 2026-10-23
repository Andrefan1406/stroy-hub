// Доступ к модулю ПТО — один список email. Пока только главный админ;
// чтобы расширить доступ (другие email или роль), правится только этот файл
// (и зеркальный src/pto/access.js для фронтенда — там это лишь UX: скрыть
// кнопку и страницу). Настоящая граница — requirePto: каждый /api/pto/*
// проверяет Firebase ID-токен и отвечает 403 всем, кого нет в списке.
const { requireEmails, ADMIN_EMAIL } = require('../adminAuth');

const PTO_ALLOWED_EMAILS = [ADMIN_EMAIL];

const requirePto = requireEmails(PTO_ALLOWED_EMAILS);

module.exports = { PTO_ALLOWED_EMAILS, requirePto };
