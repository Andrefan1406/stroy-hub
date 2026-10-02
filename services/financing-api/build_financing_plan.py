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
from gpr_timeline import (
    compute_section_timeline,
    fetch_gpr_plan_dates,
    fetch_gpr_values,
    plan_dates_by_key,
    resync_source,
)
from plateau_split import split_rows
from smeta_reader import aggregate_by_section, read_smeta_rows
from smeta_sections import totals_by_key

# Разделы сметы, у которых по своей природе нет соответствия в графике работ.
NON_SCHEDULE_SECTIONS = {"техника"}


def load_smeta_totals(smeta_key: str, rows_cache: dict) -> dict[str, float]:
    smeta = SMETAS[smeta_key]
    if smeta.get("konstruktiv_column") or smeta.get("split_sections"):
        return totals_by_key(smeta_key, SMETAS, rows_cache)  # сметы НЖ3, см. smeta_sections.py
    rows = read_smeta_rows(smeta["spreadsheet_id"], smeta["gid"])
    totals, _, _ = aggregate_by_section(rows)
    return totals


def map_section_costs(costs: dict[str, float], section_map: dict) -> dict[str, float]:
    """Суммы сметы -> общие разделы объекта (config.py: section_map); долевой
    раздел (словарь) делится между несколькими."""
    result: dict[str, float] = {}
    for name, amount in costs.items():
        target = section_map.get(name, name)
        shares = target if isinstance(target, dict) else {target: 1.0}
        for mapped, share in shares.items():
            result[mapped] = result.get(mapped, 0.0) + amount * share
    return result


def map_gpr_sections(by_work: dict[str, dict], section_map: dict, exclude: set) -> dict[str, dict]:
    """Строки ГПР одной позиции -> общие разделы объекта. У долевого раздела
    все части получают одни и те же сроки и % готовности."""
    result: dict[str, dict] = {}
    for work_name, value in by_work.items():
        if work_name in exclude:
            continue
        target = section_map.get(work_name, work_name)
        for mapped in target if isinstance(target, dict) else [target]:
            if mapped in result:
                # Две строки ГПР в один раздел — сроки/% не сложить
                # осмысленно; сейчас такого нет, предупреждаем, если появится.
                print(f"[financing-plan] раздел '{mapped}' уже есть в ГПР позиции, строка '{work_name}' пропущена")
                continue
            result[mapped] = value
    return result


def gpr_position_key(position: str) -> str:
    """'1.1' (как в config.py) -> 'поз.1.1' (как в БД ГПР)."""
    return position if position.startswith("поз.") else f"поз.{position}"


def is_markup_section(name: str) -> bool:
    # "Накл.расх." — так накладные подписаны в сметах НЖ3.
    return name.lower().startswith("непредвиденные") or name.lower().startswith("накл")


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


def build_object_plan(object_key: str, resync: bool = True) -> dict:
    """resync — сначала пересинкать ГПР объекта (таблицы правят вживую).
    Расчёт дорогой (сметы из Google Sheets), поэтому страница финплана
    получает его готовым из plan_cache.py, а не считает на каждое открытие."""
    obj = OBJECTS[object_key]
    section_map = obj.get("section_map", {})
    gpr_exclude = obj.get("gpr_exclude", set())
    plateau = obj.get("plateau_split")
    smeta_cache: dict[str, dict[str, float]] = {}
    smeta_rows_cache: dict = {}

    # Fail-open — если Sheets недоступен, считаем на последних засинканных
    # данных, а не роняем расчёт.
    if resync:
        try:
            resync_source(obj["gpr_source"])
        except Exception as exc:
            print(f"[financing-plan] пересинк ГПР '{obj['gpr_source']}' не удался, используем последние данные: {exc}")

    # Все позиции этого объекта — из одного источника ГПР (obj["gpr_source"],
    # см. config.py); сам источник может объединять несколько листов
    # (server/syncGprReport.js:SOURCES), это уже разрулено на стороне синка.
    plan_rows = fetch_gpr_plan_dates(obj["gpr_source"])
    plan_all = plan_dates_by_key(plan_rows)
    fact_rows = fetch_gpr_values(obj["gpr_source"])
    plateau_shares: dict[str, float] = {}  # позиция ГПР -> % на плато (см. plateau_split.py)
    if plateau:
        fact_rows, plateau_shares = split_rows(fact_rows, plateau["work"], plateau["before"], plateau["after"])
    fact_all = compute_section_timeline(fact_rows)

    positions = {}
    object_total = 0.0
    for position, smeta_key in obj["positions"].items():
        if smeta_key not in smeta_cache:
            smeta_cache[smeta_key] = map_section_costs(load_smeta_totals(smeta_key, smeta_rows_cache), section_map)
        section_costs = smeta_cache[smeta_key]

        gpr_key = gpr_position_key(position)
        raw_plan = {work_name: dates for (pos, work_name), dates in plan_all.items() if pos == gpr_key}
        share = plateau_shares.get(gpr_key)
        if share is not None:
            # Строка поделена по плато — у частей своих плановых дат в ГПР
            # нет (у исходной строки их тоже нет или они не про эти работы),
            # сроки возьмутся из факта, см. plan_from_fact ниже. Стоимость
            # делится в той же пропорции, что и %.
            raw_plan.pop(plateau["work"], None)
            raw_plan[plateau["before"]] = {"start": None, "end": None}
            raw_plan[plateau["after"]] = {"start": None, "end": None}
            section_costs = dict(section_costs)
            earthworks = section_costs.pop(plateau["before"], 0.0)
            section_costs[plateau["before"]] = earthworks * share / 100
            section_costs[plateau["after"]] = earthworks * (100 - share) / 100
        position_plan = map_gpr_sections(raw_plan, section_map, gpr_exclude)
        position_fact = map_gpr_sections(
            {work_name: fact for (pos, work_name), fact in fact_all.items() if pos == gpr_key},
            section_map,
            gpr_exclude,
        )

        section_names = set(section_costs) | set(position_plan)
        sections = []
        for name in sorted(section_names):
            cost = section_costs.get(name)
            dates = position_plan.get(name)  # None -> раздела нет в ГПР вообще
            fact = position_fact.get(name)
            expected_no_schedule = name.lower() in NON_SCHEDULE_SECTIONS or is_markup_section(name)
            start = dates["start"] if dates else None
            end = dates["end"] if dates else None
            # Раздел уже завершён, а плановые даты в ГПР не заполнены (так у
            # части давно сделанных работ НЖ3) — без дат он выпал бы и из
            # графика, и из финплана, поэтому вместо плана — фактические
            # сроки выполнения.
            plan_from_fact = bool(dates and not (start and end) and fact and fact["completed"] and fact["start"])
            if plan_from_fact:
                start, end = fact["start"], fact["end"]
            sections.append(
                {
                    "name": name,
                    "cost": cost,
                    "in_schedule": dates is not None,
                    "start": start,
                    "end": end,
                    "plan_from_fact": plan_from_fact,
                    "expected_no_schedule": expected_no_schedule,
                    "fact_percent": fact["percent"] if fact else None,
                    "fact_started": fact["started"] if fact else False,
                    "fact_completed": fact["completed"] if fact else False,
                    "fact_start": fact["start"] if fact else None,
                    "fact_end": fact["end"] if fact else None,
                    "fact_end_earliest": fact["end_earliest"] if fact else None,
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
