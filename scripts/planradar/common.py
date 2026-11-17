"""Общее для скриптов PlanRadar: ключи из .env, запросы к API, справочник объектов."""
import json
import os
import time
from datetime import datetime
from pathlib import Path

import requests

BASE = "https://www.planradar.com"
API = f"{BASE}/api"
HERE = Path(__file__).resolve().parent
PROJECTS_FILE = HERE / "projects.json"  # справочник: название объекта -> {id в PlanRadar, emails закреплённых}

PAGESIZE = 500   # максимум по документации
PAUSE = 2.5      # лимит API: 30 запросов/мин на аккаунт


def load_env(path=".env"):
    """Читает .env рядом со скриптом, а если его нет — в корне проекта (без сторонних библиотек)."""
    env_path = next((d / path for d in (HERE, *HERE.parents) if (d / path).exists()), None)
    if env_path is None:
        raise SystemExit(f"Не найден файл {path} ни рядом со скриптом, ни в корне проекта. Создайте его с PLANRADAR_API_KEY=...")
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()
API_KEY = os.environ.get("PLANRADAR_API_KEY", "")
CUSTOMER_ID = os.environ.get("PLANRADAR_CUSTOMER_ID", "1518857")
if not API_KEY:
    raise SystemExit("В .env не задан PLANRADAR_API_KEY")

HEADERS = {"X-PlanRadar-API-Key": API_KEY, "Accept": "application/json"}


def check(r):
    """При ошибке показывает ответ сервера, а не только код."""
    if r.ok:
        return
    print(f"\nОшибка {r.status_code} для {r.url.split('?')[0]}")
    print("Ответ сервера:", r.text[:1000])
    raise SystemExit(1)


def get_all(url, params=None):
    """Проходит по всем страницам и возвращает (data, included)."""
    data, included, page = [], [], 1
    while True:
        p = dict(params or {}, page=page, pagesize=PAGESIZE)
        r = requests.get(url, headers=HEADERS, params=p, timeout=60)
        check(r)
        body = r.json()
        batch = body.get("data", [])
        data.extend(batch)
        included.extend(body.get("included", []))
        time.sleep(PAUSE)
        if len(batch) < PAGESIZE:
            return data, included
        page += 1


def attr(obj, *keys):
    """Берёт первое непустое поле из attributes (API пишет то через дефис, то через _)."""
    a = obj.get("attributes", {})
    for k in keys:
        if a.get(k) not in (None, ""):
            return a[k]
    return None


def to_date(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return str(value)


def load_projects():
    """Справочник {название: {"id": ..., "emails": [...]}} из projects.json."""
    if not PROJECTS_FILE.exists():
        raise SystemExit("Нет projects.json. Создайте справочник: python scripts/planradar/update_projects.py")
    return json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))


def resolve_project(query):
    """Объект по названию (целиком или частью, без учёта регистра) или по id -> (название, id)."""
    projects = load_projects()
    q = query.strip().lower()
    for name, info in projects.items():
        if q == info["id"].lower() or q == name.lower():
            return name, info["id"]
    found = {n: i for n, i in projects.items() if q in n.lower()}
    if len(found) == 1:
        name, info = next(iter(found.items()))
        return name, info["id"]
    if not found:
        raise SystemExit(f"Объект «{query}» не найден в projects.json. Объекты:\n" + format_projects(projects))
    raise SystemExit(f"«{query}» подходит к нескольким объектам, уточните:\n" + format_projects(found))


def format_projects(projects):
    return "\n".join(f"  {info['id']:<10} {name}" for name, info in projects.items())
