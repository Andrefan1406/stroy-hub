"""Собирает план по объекту: для каждой позиции и каждого раздела сводит
сумму (из привязанной к позиции сметы, config.py) с ПЛАНОВЫМИ сроками (из
ГПР, колонки "Начало"/"Окончание" — gpr_timeline.py:fetch_gpr_plan_dates) —
по совпадению названия раздела, и добавляет факт (% готовности) и прогноз
(forecast.py).

Раздел без сроков в ГПР — это ожидаемо для строк-надбавок сметы
("Непредвиденные расходы 2%", "Накладные расходы 9%") и для "Техника"
(это группировка расходов на технику в смете, не отдельный этап работ в
графике) — они не ошибка, помечены отдельно. Любой ДРУГОЙ раздел без
сроков — уже повод присмотреться, вдруг где-то разошлось название.

Запуск:
    python build_financing_plan.py <object_key>   # например nz4
"""
import sys

from config import OBJECTS, SMETAS
from forecast import compute_forecast
from gpr_timeline import compute_section_timeline, fetch_gpr_plan_dates, fetch_gpr_values, plan_dates_by_key
from smeta_reader import aggregate_by_section, read_smeta_rows

# Разделы сметы, у которых по своей природе нет соответствия в графике работ.
NON_SCHEDULE_SECTIONS = {"техника"}


def load_smeta_totals(smeta_key: str) -> dict[str, float]:
    smeta = SMETAS[smeta_key]
    rows = read_smeta_rows(smeta["spreadsheet_id"], smeta["gid"])
    totals, _, _ = aggregate_by_section(rows)
    return totals


def gpr_position_key(position: str) -> str:
    """'1.1' (как в config.py) -> 'поз.1.1' (как в БД ГПР)."""
    return position if position.startswith("поз.") else f"поз.{position}"


def is_markup_section(name: str) -> bool:
    return name.lower().startswith("непредвиденные") or name.lower().startswith("накладные")


def chronological_sort(sections: list[dict]) -> list[dict]:
    """По дате начала (потом конца) — разделы без дат (расхождение "(!)")
    считаются самыми поздними и идут в конце, а не путаются по алфавиту."""
    return sorted(
        sections,
        key=lambda s: (s["start"] is None, s["start"] or "", s["end"] or "", s["name"]),
    )


def redistribute_overhead(sections: list[dict]) -> list[dict]:
    """Сумма разделов без графика, но ОЖИДАЕМО без него (Непредвиденные,
    Накладные, Техника) — распределяется пропорционально их стоимости на
    разделы, у которых график есть, а сами эти строки из списка убираются
    (их деньги теперь размазаны по остальным работам, не потеряны — сумма
    по позиции не меняется). Раздел без графика, который НЕ входит в
    ожидаемые — настоящее расхождение "(!)", не трогаем, оставляем как
    отдельную строку без распределения.
    """
    overhead = [s for s in sections if s["expected_no_schedule"]]
    overhead_cost = sum(s["cost"] or 0 for s in overhead)

    scheduled = [s for s in sections if not s["expected_no_schedule"] and s["in_schedule"]]
    scheduled_total = sum(s["cost"] or 0 for s in scheduled)

    mismatched = [s for s in sections if not s["expected_no_schedule"] and not s["in_schedule"]]

    if overhead_cost == 0 or scheduled_total == 0:
        return chronological_sort(sections)  # нечего или некуда распределять — оставляем как было

    result = []
    for s in scheduled:
        share = (s["cost"] or 0) / scheduled_total * overhead_cost
        result.append({**s, "cost": (s["cost"] or 0) + share, "overhead_share": share})
    result.extend({**s, "overhead_share": 0.0} for s in mismatched)
    return chronological_sort(result)


def build_object_plan(object_key: str) -> dict:
    obj = OBJECTS[object_key]
    smeta_cache: dict[str, dict[str, float]] = {}

    # Все позиции этого объекта — из одного источника ГПР ('nz4'); если
    # появятся объекты с несколькими источниками ГПР, это место придётся
    # обобщить так же, как SOURCES в server/syncGprReport.js.
    plan_rows = fetch_gpr_plan_dates("nz4")
    plan_all = plan_dates_by_key(plan_rows)
    fact_rows = fetch_gpr_values("nz4")
    fact_all = compute_section_timeline(fact_rows)

    positions = {}
    object_total = 0.0
    for position, smeta_key in obj["positions"].items():
        if smeta_key not in smeta_cache:
            smeta_cache[smeta_key] = load_smeta_totals(smeta_key)
        section_costs = smeta_cache[smeta_key]

        gpr_key = gpr_position_key(position)
        position_plan = {work_name: dates for (pos, work_name), dates in plan_all.items() if pos == gpr_key}
        position_fact = {work_name: fact for (pos, work_name), fact in fact_all.items() if pos == gpr_key}

        section_names = set(section_costs) | set(position_plan)
        sections = []
        for name in sorted(section_names):
            cost = section_costs.get(name)
            dates = position_plan.get(name)  # None -> раздела нет в ГПР вообще
            fact = position_fact.get(name)
            expected_no_schedule = name.lower() in NON_SCHEDULE_SECTIONS or is_markup_section(name)
            sections.append(
                {
                    "name": name,
                    "cost": cost,
                    "in_schedule": dates is not None,
                    "start": dates["start"] if dates else None,
                    "end": dates["end"] if dates else None,
                    "expected_no_schedule": expected_no_schedule,
                    "fact_percent": fact["percent"] if fact else None,
                    "fact_started": fact["started"] if fact else False,
                    "fact_completed": fact["completed"] if fact else False,
                    "fact_start": fact["start"] if fact else None,
                    "fact_end": fact["end"] if fact else None,
                    "fact_as_of": fact["as_of"] if fact else None,
                }
            )

        sections = redistribute_overhead(sections)
        sections = compute_forecast(sections)
        position_total = sum(s["cost"] for s in sections if s["cost"] is not None)
        smeta_info = SMETAS[smeta_key]
        positions[position] = {
            "smeta": smeta_key,
            "sections": sections,
            "total": position_total,
            "description": smeta_info.get("description"),
            "apartments_area_m2": smeta_info.get("apartments_area_m2"),
            "commercial_floor1_area_m2": smeta_info.get("commercial_floor1_area_m2"),
            "commercial_basement_area_m2": smeta_info.get("commercial_basement_area_m2"),
        }
        object_total += position_total

    return {"object": object_key, "name": obj["name"], "positions": positions, "total": object_total}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Использование: python build_financing_plan.py <object_key>")
    object_key = sys.argv[1]

    plan = build_object_plan(object_key)
    print(f"Объект: {plan['name']} ({plan['object']})\n")

    for position, data in plan["positions"].items():
        print(f"Поз.{position}  [{data['smeta']}]  {data['total']:>18,.2f}".replace(",", " "))
        for s in data["sections"]:
            cost = f"{s['cost']:>15,.2f}".replace(",", " ") if s["cost"] is not None else " " * 15 + "—"
            if not s["in_schedule"]:
                dates = "нет в ГПР (!)"  # ожидаемые сюда уже не попадают — распределены
            elif s["start"] and s["end"]:
                dates = f"{s['start']} -> {s['end']}"
            else:
                dates = "дата в ячейке пустая/не распознана (!)"
            print(f"    {s['name']:35} {cost}   {dates}")
        print()

    print(f"Итого по объекту: {plan['total']:>18,.2f}".replace(",", " "))
    print(
        "\nПримечание: непредвиденные расходы, накладные расходы и расходы на технику "
        "распределены пропорционально между всеми разделами проекта."
    )


if __name__ == "__main__":
    main()
