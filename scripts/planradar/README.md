# Скрипты PlanRadar

Работают с API PlanRadar (`https://www.planradar.com/api`). Ключи — из `.env` в корне
проекта: `PLANRADAR_API_KEY`, `PLANRADAR_CUSTOMER_ID`. Объект (проект) в `.env` не
задаётся: все объекты и их id лежат в справочнике `projects.json`, объект выбирается
при запуске. Лимит API — 30 запросов в минуту, скрипты делают паузы сами.
Нужны пакеты `requests` и `openpyxl` (`pip install requests openpyxl`).

| Файл | Что делает |
|---|---|
| `projects.json` | Справочник объектов: название → `id` в PlanRadar и `emails` закреплённых за объектом сотрудников (по `/admin/users`; неизвестные не заполняются) |
| `update_projects.py` | Обновляет `projects.json` по списку проектов в PlanRadar. Запускать, когда появился новый объект |
| `open_tickets.py` | Выгружает просроченные незакрытые замечания объекта в `output/overdue_tickets_<id>.xlsx` и `.json` |
| `common.py` | Общее: чтение `.env`, запросы к API, поиск объекта по справочнику |

```
python scripts/planradar/update_projects.py
python scripts/planradar/open_tickets.py "Хоккейный модуль"   # название, его часть или id
python scripts/planradar/open_tickets.py                      # без аргумента — список объектов
```

Папка `output/` в `.gitignore` — это данные компании.
