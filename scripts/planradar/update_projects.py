"""Обновляет справочник объектов projects.json (название -> id) по списку проектов в PlanRadar.

Запуск: python scripts/planradar/update_projects.py
Новые объекты добавляются, названия и id берутся из PlanRadar; объекты,
которых там больше нет, из справочника удаляются. Закреплённые за объектом
адреса (emails) сохраняются по названию объекта.
"""
import json

import requests

from common import API, CUSTOMER_ID, HEADERS, PROJECTS_FILE, attr, check, format_projects

old = json.loads(PROJECTS_FILE.read_text(encoding="utf-8")) if PROJECTS_FILE.exists() else {}

r = requests.get(f"{API}/v2/{CUSTOMER_ID}/projects/my_projects", headers=HEADERS, timeout=60)
check(r)

projects = {}
for pr in r.json().get("data", []):
    name = (attr(pr, "name") or str(pr["id"])).strip()
    if name in projects:  # одинаковые названия — различаем по id
        name = f"{name} ({pr['id']})"
    projects[name] = {"id": str(pr["id"]), "emails": old.get(name, {}).get("emails", [])}

projects = dict(sorted(projects.items(), key=lambda kv: kv[0].lower()))
PROJECTS_FILE.write_text(json.dumps(projects, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Объектов: {len(projects)}. Справочник: {PROJECTS_FILE}\n")
print(format_projects(projects))
