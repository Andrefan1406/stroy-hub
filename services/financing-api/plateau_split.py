"""Деление одной строки ГПР на два раздела по паузе в росте % готовности.

Нурлы Жол 3: в графике одна строка "Земляные работы", а в НЖ4/НЖ5 —
"Разработка котлована" и "Обратная засыпка". По факту это видно по самому
проценту: котлован выкопали — % встал и долго не растёт (идёт монолит), потом
снова начал расти — это уже обратная засыпка. Самая длинная такая пауза
(плато) и есть граница между двумя работами:

- до плато — первый раздел, его % = % строки / P * 100 (P — % на плато);
- после — второй, его % = (% строки - P) / (100 - P) * 100;
- стоимость сметы делится в той же пропорции: P% и (100 - P)%.

Плато короче MIN_PLATEAU_DAYS не считается паузой (обычная пара недель без
отметок). Если плато не нашлось (например, у листа "64,72" отметки
начинаются сразу со 100% — истории нет), строка не делится.
"""
from datetime import date

MIN_PLATEAU_DAYS = 90


def normalize_percent(percent: float | None) -> float | None:
    """В ячейку ГПР вписали целые проценты вместо доли (100 вместо 1, 55
    вместо 0,55 — встречается на листе "64,72"), синк умножил их ещё раз на
    100 -> 10000%/5500%."""
    if percent is not None and percent > 100:
        return percent / 100
    return percent


def find_plateau(points: list[tuple[str, float | None]]) -> float | None:
    """% на самом длинном плато (не короче MIN_PLATEAU_DAYS), после
    которого % снова вырос; None — такого нет. Длительность плато — от
    первой до последней заполненной отметки с этим значением: незаполненные
    недели (пропуск в отчётах) в плато не засчитываются, иначе любой пропуск
    выглядел бы паузой в работах."""
    known = [(d, p) for d, p in sorted(points) if p is not None]
    best_value, best_days = None, 0
    i = 0
    while i < len(known):
        value = known[i][1]
        j = i
        while j + 1 < len(known) and abs(known[j + 1][1] - value) < 1e-6:
            j += 1
        resumed = j + 1 < len(known) and known[j + 1][1] > value
        days = (date.fromisoformat(known[j][0]) - date.fromisoformat(known[i][0])).days
        if 0 < value < 100 and resumed and days >= MIN_PLATEAU_DAYS and days > best_days:
            best_value, best_days = value, days
        i = j + 1
    return best_value


def split_rows(rows: list[dict], work_name: str, before: str, after: str) -> tuple[list[dict], dict[str, float]]:
    """Строки ГПР (fetch_gpr_values) -> строки, где work_name заменён на
    before/after у тех позиций, где нашлось плато; плюс {позиция: P}."""
    points_by_position: dict[str, list[tuple[str, float | None]]] = {}
    for row in rows:
        if row["work_name"] == work_name:
            points_by_position.setdefault(row["position"], []).append(
                (row["report_date"], normalize_percent(row["percent"]))
            )

    shares = {}
    for position, points in points_by_position.items():
        plateau = find_plateau(points)
        if plateau is not None:
            shares[position] = plateau

    result = []
    for row in rows:
        plateau = shares.get(row["position"]) if row["work_name"] == work_name else None
        if plateau is None:
            result.append(row)
            continue
        percent = normalize_percent(row["percent"])
        result.append(
            {**row, "work_name": before, "percent": None if percent is None else min(percent / plateau, 1) * 100}
        )
        result.append(
            {
                **row,
                "work_name": after,
                "percent": None if percent is None else max(percent - plateau, 0) / (100 - plateau) * 100,
            }
        )
    return result, shares
