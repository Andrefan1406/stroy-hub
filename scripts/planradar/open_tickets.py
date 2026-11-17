"""Выгрузка просроченных незакрытых замечаний объекта PlanRadar в Excel и JSON.

Запуск: python scripts/planradar/open_tickets.py "<объект>"
Объект — название (можно частью) или id из projects.json. Без аргумента
печатает список объектов. Справочник обновляется: update_projects.py.
"""
import json
import sys
import time
from datetime import date
from pathlib import Path

import requests
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from common import (API as api, CUSTOMER_ID, HEADERS, attr, check, format_projects,
                    get_all, load_projects, resolve_project, to_date)

OPEN_STATUSES = ["1", "2", "3", "4"]  # Open, In-Progress, Resolved, Feedback (без Closed=5 и Rejected=6)

# Коды статусов и приоритетов из документации PlanRadar (закодированные и числовые)
STATUS_NAMES = {"lm": "Открыто", "ol": "В работе", "ma": "Устранено", "ex": "На проверке",
                "gk": "Закрыто", "ky": "Отклонено",
                "1": "Открыто", "2": "В работе", "3": "Устранено", "4": "На проверке",
                "5": "Закрыто", "6": "Отклонено"}
PRIORITY_NAMES = {"lm": "Низкий", "ol": "Обычный", "ma": "Высокий",
                  "1": "Низкий", "2": "Обычный", "3": "Высокий"}

if len(sys.argv) < 2:
    raise SystemExit("Укажите объект: python scripts/planradar/open_tickets.py \"<название или id>\"\n\nОбъекты:\n"
                     + format_projects(load_projects()))
PROJECT_NAME, PROJECT_ID = resolve_project(" ".join(sys.argv[1:]))
print(f"Объект: {PROJECT_NAME} ({PROJECT_ID})")

# 1. Не закрытые замечания
tickets, included = get_all(
    f"{api}/v2/{CUSTOMER_ID}/projects/{PROJECT_ID}/tickets",
    {"filter[status_id][][predicate]": "in", "filter[status_id][][value][]": OPEN_STATUSES},
)
open_count = len(tickets)


def deadline(t):
    """Действующий срок: дата продления, если она есть, иначе плановый срок."""
    dates = [to_date(attr(t, "due-date", "due_date")),
             to_date(attr(t, "extension-date", "extension_date"))]
    dates = [d for d in dates if isinstance(d, date)]
    return max(dates) if dates else None


# Оставляем только просроченные: срок есть и он раньше сегодняшнего дня
today = date.today()
tickets = [t for t in tickets if deadline(t) and deadline(t) < today]

# 2. Справочники: пользователи, группы, слои
users = {}
for u in get_all(f"{api}/v1/{CUSTOMER_ID}/projects/{PROJECT_ID}/users")[0]:
    name = " ".join(filter(None, [attr(u, "firstname"), attr(u, "lastname")])) or attr(u, "mail")
    users[str(u["id"])] = name

groups = {}
for g in get_all(f"{api}/v1/{CUSTOMER_ID}/projects/{PROJECT_ID}/project_groups")[0]:
    groups[str(g["id"])] = attr(g, "name", "group-name") or str(g["id"])

r = requests.get(f"{api}/v2/{CUSTOMER_ID}/projects/{PROJECT_ID}/components/project_components",
                 headers=HEADERS, timeout=60)
check(r)
layers = {str(c["id"]): attr(c, "name") or str(c["id"]) for c in r.json().get("data", [])}

# Если сервер прислал пользователей в included — тоже используем
for inc in included:
    if inc.get("type") in ("users", "user"):
        users.setdefault(str(inc["id"]), " ".join(filter(None, [attr(inc, "firstname"), attr(inc, "lastname")])))


def assignee_name(t):
    aid = attr(t, "assigned-to-id", "assigned_to_id")
    if isinstance(aid, dict):  # иногда приходит объект {id, type}
        aid = aid.get("id")
    if aid is None:
        return ""
    aid = str(aid)
    return users.get(aid) or groups.get(aid) or aid


# 3. Excel
rows = []
for t in tickets:
    status = str(attr(t, "status-id", "status_id") or "")
    prio = str(attr(t, "priority-id", "priority_id") or "")
    layer = str(attr(t, "component-id", "component_id") or "")
    rows.append([
        attr(t, "sequential-id", "sequential_id"),
        attr(t, "subject") or "",
        STATUS_NAMES.get(status, status),
        PRIORITY_NAMES.get(prio, prio),
        assignee_name(t),
        layers.get(layer, layer),
        deadline(t),
        None,  # «Просрочка, дн.» — формула, заполняется ниже
        to_date(attr(t, "created-at", "created_at", "created-on")),
    ])
rows.sort(key=lambda x: x[6])  # сначала самые давно просроченные

wb = Workbook()
ws = wb.active
ws.title = "Просроченные"
columns = ["№", "Название", "Статус", "Приоритет", "Исполнитель", "Слой", "Срок", "Просрочка, дн.", "Создано"]
widths = [8, 60, 14, 12, 28, 28, 12, 14, 12]
ws.append(columns)
for i, row in enumerate(rows, start=2):
    row[7] = f"=TODAY()-G{i}"  # пересчитывается при каждом открытии файла
    ws.append(row)

base_font = Font(name="Arial", size=10)
head_font = Font(name="Arial", size=10, bold=True, color="FFFFFF")
head_fill = PatternFill("solid", start_color="305496")
for col, w in enumerate(widths, start=1):
    ws.column_dimensions[get_column_letter(col)].width = w
for cell in ws[1]:
    cell.font, cell.fill = head_font, head_fill
    cell.alignment = Alignment(horizontal="center", vertical="center")
for r_cells in ws.iter_rows(min_row=2):
    for cell in r_cells:
        cell.font = base_font
        cell.alignment = Alignment(vertical="top", wrap_text=(cell.column == 2))
    r_cells[6].number_format = r_cells[8].number_format = "DD.MM.YYYY"
    r_cells[7].number_format = "0"
    r_cells[7].font = Font(name="Arial", size=10, bold=True, color="C00000")
ws.freeze_panes = "A2"
ws.auto_filter.ref = ws.dimensions

# Выгрузки лежат рядом со скриптом, в output/ (папка в .gitignore)
out_dir = Path(__file__).resolve().parent / "output"
out_dir.mkdir(exist_ok=True)
out_xlsx = out_dir / f"overdue_tickets_{PROJECT_ID}.xlsx"
wb.save(out_xlsx)
with open(out_dir / f"overdue_tickets_{PROJECT_ID}.json", "w", encoding="utf-8") as f:
    json.dump(tickets, f, ensure_ascii=False, indent=2)

print(f"Не закрытых замечаний: {open_count}, из них просрочено: {len(tickets)}")
print(f"Таблица: {out_xlsx}")
