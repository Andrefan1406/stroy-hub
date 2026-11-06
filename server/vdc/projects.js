// Сохранение «человеческих решений» страницы «Черновик ВДЦ на внутреннюю отделку по чертежам АР»:
// обмеры, калибровки листов, оси квартир, коэффициенты лоджий, высота от пола до потолка, выбранные листы.
// Чтобы при перезагрузке сервера, страницы или смене компьютера обмеры не приходилось делать заново.
//
// Хранилище — Firestore (firebase-admin, то же приложение, что и вход): файловая система Render эфемерная,
// SQLite-файл там стирается при каждом деплое. Состояние лежит строкой JSON в одном документе
// vdc_projects/<ключ проекта> — так не мешают ограничения Firestore на вложенные массивы и имена полей.
//
//   GET /api/vdc/projects/:key  → { found: false } | { found: true, state, updatedAt, updatedBy }
//   PUT /api/vdc/projects/:key  { state } → { ok: true, updatedAt }
//
// Ключ проекта — шифр из штампа чертежа («АВ/24-11/187-1.6-АР»), приходит URL-кодированным.
// Доступ — любой вошедший пользователь (Firebase ID-токен): данные общие для всех сотрудников.
// PDF на сервер не передаётся — сохраняются только введённые пользователем значения.
const express = require('express');
const { getAuth } = require('firebase-admin/auth');
require('../adminAuth'); // инициализирует общее firebase-admin приложение

const COLLECTION = 'vdc_projects';
const MAX_STATE_BYTES = 800 * 1024; // документ Firestore — до 1 МиБ
const MAX_KEY_LENGTH = 200;

// Что разрешено сохранять: остальное из присланного состояния отбрасывается.
const ALLOWED_FIELDS = [
  'version', 'numPages', 'tepPage', 'sections', 'explPages', 'finPages', 'axisLabels', 'loggias', 'loggiasConfirmed',
  'wallHeight', 'calibrations', 'measureLines', 'manualValues',
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// «АВ/24-11/187-1.6-АР» → идентификатор документа (без «/»)
function docIdOf(rawKey) {
  const key = String(rawKey ?? '').trim();
  if (!key) throw new HttpError(400, 'Не указан проект');
  if (key.length > MAX_KEY_LENGTH) throw new HttpError(400, 'Слишком длинный ключ проекта');
  return { key, id: encodeURIComponent(key).replace(/\./g, '%2E') };
}

// → строка JSON с разрешёнными полями; бросает HttpError, если состояние неверное или слишком большое
function serializeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new HttpError(400, 'Состояние проекта должно быть объектом');
  const clean = {};
  for (const field of ALLOWED_FIELDS) if (state[field] !== undefined) clean[field] = state[field];
  const json = JSON.stringify(clean);
  if (Buffer.byteLength(json, 'utf8') > MAX_STATE_BYTES) {
    throw new HttpError(413, 'Сохраняемых данных слишком много (больше 800 КБ): уменьшите число линий обмера');
  }
  return json;
}

function firestoreStore() {
  // firebase-admin/firestore подключаем лениво: тестам и серверу без Firestore он не нужен
  const col = () => require('firebase-admin/firestore').getFirestore().collection(COLLECTION);
  return {
    async get(id) {
      const snap = await col().doc(id).get();
      return snap.exists ? snap.data() : null;
    },
    async set(id, data) {
      await col().doc(id).set(data);
    },
  };
}

async function defaultVerify(token) {
  return getAuth().verifyIdToken(token);
}

function createHandlers({ store = firestoreStore(), verify = defaultVerify } = {}) {
  const storeUnavailable = (err) => {
    console.error('[vdc] хранилище недоступно:', err.message);
    return new HttpError(503, 'Хранилище недоступно: на сервере не настроен доступ к Firestore (FIREBASE_SERVICE_ACCOUNT_JSON)');
  };
  const fail = (res, err) => res.status(err.status || 500).json({ error: err.message || 'Ошибка сервера' });

  async function requireUser(req, res, next) {
    const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: 'Не передан токен авторизации' });
    try {
      req.userEmail = (await verify(match[1])).email;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Недействительный или просроченный токен авторизации' });
    }
  }

  async function getProject(req, res) {
    try {
      const { id } = docIdOf(req.params.key);
      let data;
      try {
        data = await store.get(id);
      } catch (err) {
        throw storeUnavailable(err);
      }
      if (!data) return res.json({ found: false });
      let state = null;
      try {
        state = JSON.parse(data.stateJson);
      } catch (err) {
        return res.json({ found: false });
      }
      return res.json({ found: true, state, updatedAt: data.updatedAt, updatedBy: data.updatedBy });
    } catch (err) {
      return fail(res, err);
    }
  }

  async function putProject(req, res) {
    try {
      const { key, id } = docIdOf(req.params.key);
      const stateJson = serializeState(req.body?.state);
      const updatedAt = new Date().toISOString();
      try {
        await store.set(id, { key, stateJson, updatedAt, updatedBy: req.userEmail || '' });
      } catch (err) {
        throw storeUnavailable(err);
      }
      console.log(`[vdc] ${req.userEmail}: проект «${key}» сохранён (${Math.round(stateJson.length / 1024)} КБ)`);
      return res.json({ ok: true, updatedAt });
    } catch (err) {
      return fail(res, err);
    }
  }

  return { requireUser, getProject, putProject };
}

function createRouter(options) {
  const { requireUser, getProject, putProject } = createHandlers(options);
  const router = express.Router();
  router.get('/projects/:key', requireUser, getProject);
  router.put('/projects/:key', requireUser, putProject);
  return router;
}

module.exports = { createRouter, createHandlers, docIdOf, serializeState, MAX_STATE_BYTES, COLLECTION };
