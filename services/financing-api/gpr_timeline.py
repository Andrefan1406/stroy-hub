"""Сроки по разделам — из уже засинканных в Node данных ГПР
(server/internalApi.js), а не парсингом сырых Google-таблиц заново (см.
пояснение в server/syncGprReport.js — там сложная разноформатная логика на
несколько источников, дублировать её в Python смысла нет).

Два источника, для разного:
- fetch_gpr_plan_dates / plan_dates_by_key — колонки "Начало"/"Окончание" из
  исходника, ПЛАН, выставленный до начала стройки. Это то, что нужно для
  финплана сейчас.
- fetch_gpr_values / compute_section_timeline — еженедельный % готовности,
  ФАКТ (в процессе стройки от плана отстают).

Запуск:
    python gpr_timeline.py <position>   # например поз.1.1
"""
import os
import sys
from collections import defaultdict

import requests
from dotenv import load_dotenv

load_dotenv()

NODE_API_URL = os.environ.get("NODE_API_URL", "http://localhost:4000")


def resync_source(source_key: str) -> dict:
    """Точечный пересинк ОДНОГО источника (server/syncGprReport.js:resyncSource)
    прямо перед чтением его данных — таблицы ГПР правятся вживую людьми на
    площадке, а плановый кроновый синк раз в несколько часов может отставать.
    Один источник — секунды, а не полный обход всех источников синка."""
    api_key = os.environ.get("INTERNAL_API_KEY")
    if not api_key:
        raise SystemExit("Не задана INTERNAL_API_KEY в .env (см. .env.example)")

    resp = requests.post(
        f"{NODE_API_URL}/api/internal/gpr-resync",
        json={"source_key": source_key},
        headers={"X-Internal-Api-Key": api_key},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_gpr_values(source_key: str) -> list[dict]:
    api_key = os.environ.get("INTERNAL_API_KEY")
    if not api_key:
        raise SystemExit("Не задана INTERNAL_API_KEY в .env (см. .env.example)")

    resp = requests.get(
        f"{NODE_API_URL}/api/internal/gpr-values",
        params={"source_key": source_key},
        headers={"X-Internal-Api-Key": api_key},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["rows"]


def fetch_gpr_plan_dates(source_key: str) -> list[dict]:
    api_key = os.environ.get("INTERNAL_API_KEY")
    if not api_key:
        raise SystemExit("Не задана INTERNAL_API_KEY в .env (см. .env.example)")

    resp = requests.get(
        f"{NODE_API_URL}/api/internal/gpr-plan-dates",
        params={"source_key": source_key},
        headers={"X-Internal-Api-Key": api_key},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["rows"]


def plan_dates_by_key(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """(позиция, раздел работы) -> {"start": ..., "end": ...} (могут быть None,
    если ячейка в исходнике пустая/не дата)."""
    return {
        (row["position"], row["work_name"]): {"start": row["plan_start"], "end": row["plan_end"]}
        for row in rows
    }


def compute_section_timeline(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """(позиция, раздел работы) -> {"started", "start", "end", "completed", "percent", "as_of"}.

    percent — самый свежий известный % готовности (по последней дате отчёта
    с непустым значением), не обязательно максимум за всё время: если вдруг
    отчёт исправили в меньшую сторону, доверяем последнему, а не пиковому.
    as_of — дата этого самого свежего отчёта (нужна для прогноза: скорость
    работ считается от даты старта до as_of, см. forecast.py).
    """
    grouped: dict[tuple[str, str], list[tuple[str, float | None]]] = defaultdict(list)
    for row in rows:
        grouped[(row["position"], row["work_name"])].append((row["report_date"], row["percent"]))

    timeline = {}
    for key, points in grouped.items():
        points.sort()
        known = [(report_date, percent) for report_date, percent in points if percent is not None]
        started = [report_date for report_date, percent in known if percent > 0]
        finished = [report_date for report_date, percent in known if percent >= 100]
        timeline[key] = {
            "started": bool(started),
            "start": started[0] if started else None,
            "end": finished[0] if finished else None,
            "completed": bool(finished),
            "percent": known[-1][1] if known else None,
            "as_of": known[-1][0] if known else None,
        }
    return timeline


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Использование: python gpr_timeline.py <position>")
    position = sys.argv[1]

    rows = fetch_gpr_plan_dates("nz4")
    plan = plan_dates_by_key(rows)

    matches = {k: v for k, v in plan.items() if k[0] == position}
    if not matches:
        raise SystemExit(f"Нет данных ГПР по позиции {position!r}")

    print(f"Плановые сроки по разделам, {position}:\n")
    for (pos, work_name), dates in sorted(matches.items()):
        print(f"  {work_name:35} {dates['start']} -> {dates['end']}")


if __name__ == "__main__":
    main()
