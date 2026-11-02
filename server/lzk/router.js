// POST /api/lzk/generate — Excel с ВДЦ в теле запроса (application/octet-stream),
// в ответ JSON { fileName, fileBase64, summary }. Ничего не сохраняется:
// файл разбирается в памяти и сразу отдаётся обратно.
//
// Доступ — любой вошедший пользователь (Firebase ID-токен): данных из базы
// эндпоинт не отдаёт, только пересчитывает присланный файл.
const express = require('express');
const { getAuth } = require('firebase-admin/auth');
require('../adminAuth'); // инициализирует общее firebase-admin приложение
const { generate } = require('./build');

const router = express.Router();

async function requireUser(req, res, next) {
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: 'Не передан токен авторизации' });
  try {
    req.userEmail = (await getAuth().verifyIdToken(match[1])).email;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Недействительный или просроченный токен авторизации' });
  }
}

router.post(
  '/generate',
  requireUser,
  express.raw({ type: () => true, limit: '10mb' }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Файл не передан' });
    }
    try {
      const month = typeof req.query.month === 'string' ? req.query.month : undefined;
      const { file, summary } = await generate(req.body, { month });
      console.log(`[lzk] ${req.userEmail}: ${summary.rows} строк ВДЦ → ${summary.materials.length} материалов`);
      res.json({ fileName: 'ЛЗК_и_М-29_черновик.xlsx', fileBase64: file.toString('base64'), summary });
    } catch (err) {
      // ошибки разбора — понятные тексты из build.js; XLSX на мусорном файле кидает свои
      res.status(422).json({ error: err.message || 'Не удалось разобрать файл' });
    }
  },
);

module.exports = router;
