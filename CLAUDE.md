# CLAUDE.md

Этот файл даёт Claude Code (claude.ai/code) контекст для работы с кодом в этом репозитории.

## Обзор проекта

stroy-hub — внутренний портал строительной компании: формы заявок (бетон, электрика, геодезия, лабораторные испытания и т.д.), дашборды отчётности и админ-инструменты. Это два независимо запускаемых процесса без общего шага сборки:

- **Фронтенд** — Create React App (`src/`), React Router, Firebase Auth для логина.
- **Бэкенд** — один Express-процесс (`server/index.js`), который проксирует LLM (Ollama Cloud), выполняет text-to-SQL чат аналитики, делает RAG/семантический поиск (Qdrant + Voyage embeddings) и периодически синхронизирует read-only зеркала Google Таблиц в локальный SQLite-файл.

Третья часть — `services/financing-api/`: отдельный Python-сервис (FastAPI) для страницы `/financing-plan` (`src/pages/FinancingPlanDashboardPage.jsx`). Считает смету/график/финплан по объекту: читает сметы напрямую из Google Sheets (свой сервис-аккаунт, `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` в `services/financing-api/.env`, отдельный от корневого), а плановые сроки и факт % готовности — через read-only `server/internalApi.js` (`/api/internal/gpr-plan-dates`, `/api/internal/gpr-values`), защищённый общим секретом `INTERNAL_API_KEY` (сервер-сервер, не Firebase-логин). Сам финплан-эндпоинт (`/financing-plan/{object}`, `/categories`) закрыт Firebase ID-токеном администратора, как и остальные `/api/admin/*`. Финпланы не считаются на каждое открытие (чтение смет из Sheets — десятки секунд): `plan_cache.py` держит их готовыми в памяти и пересчитывает при старте сервиса, каждую ночь в 03:00 (UTC+5) и по кнопке `/admin/financing-resync` (`POST /admin/resync`). Запуск: `npm run financing-api` из корня (то же, что `uvicorn main:app --port 8000` из `services/financing-api/`, venv там же).

## Команды

```bash
npm start           # фронтенд dev-сервер (CRA), http://localhost:3000
npm run server      # бэкенд (server/index.js), env PORT/SMART_REQUEST_PROXY_PORT, по умолчанию 4000
npm run financing-api  # Python-сервис финплана (services/financing-api/), порт 8000; путь к venv — Windows (.venv\Scripts)
npm run build       # продакшен-сборка фронтенда -> build/
npm test            # Jest через react-scripts (интерактивный watch-режим)
npm test -- --watchAll=false --testPathPattern=App   # один тестовый файл, без watch
npm run rascenki:seed  # разовая загрузка таблицы расценок из XLSX
```

Отдельного скрипта линтинга нет — ESLint запускается через конфиг CRA (`react-app`/`react-app/jest`) во время `start`/`build`/`test`.

Обоим процессам нужен `.env` в корне репозитория (загружается через `dotenv` в `server/index.js`). Используемые ключи: `OLLAMA_API_KEY`, `QDRANT_API_KEY`, `QDRANT_URL`, `VOYAGE_API_KEY`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_API_KEY`, `RASCENKI_SYNC_CSV_URL`, `INTERNAL_API_KEY`. Фронтенд обращается к бэкенду через `REACT_APP_CONCRETE_CHAT_API_URL` (по умолчанию `http://localhost:4000`).

## Архитектура

### Поток данных: Google Таблицы → SQLite (только в одну сторону)

`server/db.js` открывает единый файл `better-sqlite3` (`server/data/concrete.db`, переопределяется через `CONCRETE_DATA_DIR` — это нужно, потому что у хостингов вроде Render эфемерная файловая система). Каждый модуль `server/sync*.js` (`syncConcrete`, `syncObjects`, `syncPeople`, `syncDefectActs`, `syncGprReport`, `syncRascenki`) тянет данные из Google Таблиц и пишет в свою таблицу(ы). Обратной записи в Таблицы нет никогда.

В схеме сосуществуют две стратегии для таблиц, и комментарии в `server/db.js` объясняют выбор для каждой:
- **Чистые зеркала** (`objects`, `defect_acts`, `people_reports`, `gpr_report_values` и др.) пересоздаются через `DROP TABLE` + `CREATE TABLE` при каждом синке/старте — у строк источника нет стабильного ID, поэтому полная перезапись проще, чем диффинг.
- **Постоянные таблицы человеческих решений** (`concrete_hidden_requests`, `people_gap_decisions`, `people_gap_check_rules`, `gpr_report_check_rules`) используют `CREATE TABLE IF NOT EXISTS` и никогда не удаляются — в них решения/конфигурация администратора, которые должны пережить ресинк или рестарт.

`concrete_orders` — гибрид: `CREATE TABLE IF NOT EXISTS` плюс явные миграции `ALTER TABLE` в `migrateSchema()`, потому что на уже существующей прод-базе новые колонки нужно добавлять, а не пересоздавать таблицу.

### Два SQLite-соединения с одной целью: обезопасить SQL, сгенерированный LLM

`db.js` предоставляет `getWriteDb()` (режим WAL, используется только модулями синка) и `getReadDb()` (открыт с `readonly: true`, используется только `chatHandler.js`). Это осознанный второй рубеж защиты: даже если сгенерированный LLM SQL прошёл бы мимо валидации, соединение, на котором он выполняется, физически не способно ничего записать.

### Text-to-SQL чат (`server/chatHandler.js`)

Двухшаговый процесс на каждый вопрос пользователя, с привязкой к домену через `body.domain` (каждый домен соответствует одной разрешённой таблице, например `concrete_orders`):
1. LLM (Ollama Cloud, `gpt-oss:120b-cloud` — выбрана после того, как другие бесплатные модели показали недостаточную точность в text-to-SQL) генерирует SQL-запрос по вопросу, описанию схемы и живым примерам различных значений.
2. `server/sqlGuard.js` валидирует SQL (только `SELECT`/`WITH`, без комментариев, без нескольких выражений, блок-лист запрещённых ключевых слов, allowlist таблиц, автоматический `LIMIT`) перед выполнением на readonly-соединении.
3. Второй вызов LLM превращает (уже безопасные, уже выполненные) строки результата в финальный ответ `{type, text, table?, chart?}` — этот вызов никогда не видит непровалидированный SQL.

Диапазоны дат («в этом месяце», «за последние 7 дней») считаются на сервере во времени Asia/Almaty и передаются LLM готовыми строками, а не отдаются на откуп собственной арифметике дат модели.

### RAG / семантический поиск (Qdrant + Voyage)

Используется там, где свободнотекстовые поля делают text-to-SQL непрактичным: дефектные акты (коллекция `defect_acts`) и свод строительных расценок (коллекция `rascenki_2026`, наполняется из CSV/XLSX через `syncRascenki.js`/`rascenkiSeedXlsx.js`, переиндексируется только вручную из `/admin/rascenki`, никогда по расписанию).

- `server/embeddings.js` вызывает Voyage AI (`voyage-3.5-lite`, размерность 1024) — выбрана после того, как локальные ONNX-эмбеддинги валили процесс по OOM на тарифе Render с 512МБ, а бесплатная квота Gemini оказалась слишком мала. Текст запроса и текст документа используют разные значения `input_type` (`query` vs `document`) — та же идея, что префиксы `query:`/`passage:` у E5.
- `server/qdrantClient.js` оборачивает Qdrant Cloud, по одной коллекции на домен, косинусная метрика.
- Поиск по расценкам (`server/rascenkiSearch.js`) намеренно пропускает шаг «LLM формулирует ответ», используемый в остальных доменах: цены/обоснования нельзя перефразировать, поэтому результат собирается напрямую из payload'ов Qdrant в фиксированную раскладку из 4 блоков.

### Авторизация: клиентские гварды — только UX, сервер проверяет Firebase ID-токены

`src/firebase.js` инициализирует Firebase Auth на клиенте. `src/components/PrivateRoute.jsx` / `AdminRoute.jsx` просто перенаправляют неавторизованных/не-админов ради UX. Настоящая граница авторизации — `server/adminAuth.js` (middleware `requireAdmin` / `requireEmails(allowedEmails)`), который проверяет `Authorization: Bearer <Firebase ID token>` на каждый вызов `/api/admin/*` — это необходимо, потому что CORS бэкенда полностью открыт (`Access-Control-Allow-Origin: *`), а значит API доступен любому, кто узнал URL, а не только фронтенду.

### Паттерн «gate» для блокировки подачи заявок

`src/peopleGapsGate.js` и `src/gprReportGate.js` устроены одинаково: перед тем как дать пользователю подать заявку, проверяется, есть ли именно он в настроенном администратором списке (`people_gap_check_rules` / `gpr_report_check_rules`, управляются через `/admin/users`), привязанном к участку/источнику отчёта с неразрешённым пропуском. Оба fail-open — ошибка сети/бэкенда страницу не блокирует, и оба возвращают `blocked: false` для любого email без совпавшего правила, так что для всех остальных пользователей проверка незаметна.

### Роутинг

Все маршруты объявлены в одном месте, `src/App.js`, оборачивая страницы в `Protected` (авторизация), `AdminRoute` (только админ) и/или гварды-«gate» (`GprReportGuard`, `PeopleGapsGuard`) по необходимости — сначала стоит смотреть туда, чтобы понять, какая защита стоит на конкретной странице, а не предполагать, что она открыта.
