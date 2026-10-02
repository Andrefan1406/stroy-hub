"""Суммы сметы по строкам ГПР — для смет, у которых "Раздел" крупнее строк
графика (сметы Нурлы Жол 3: один раздел "Кровельные работы" в смете, но две
строки "Кровля (стяжка)"/"Кровля (покрытие)" в ГПР; "ВК и ОВ" — это и
"Отопление", и "Водоснабжение и канализация", и "Монтаж сантех.оборудования").

Каждая строка сметы получает ключ — название строки ГПР, к которой она
относится (дальше этот ключ переводится в общий для всех объектов раздел
через section_map объекта, см. config.py). Способ — из конфига сметы:

- konstruktiv_column: в смете есть колонка "Конструктивы (как в ГПР)"
  (поз.59, 65) — берём её как есть, построчно.
- split_sections: только перечисленные разделы делятся, остальные идут
  ключом = своим названием раздела. Для каждого делимого раздела:
  - {"template": <smeta_key>, "template_sections": [...]} — у почти такой
    же сметы-образца (63 ~ 59, 69 ~ 65, 64 ~ 72) уже известен ключ каждой
    строки; строку ищем там по наименованию (среди строк разделов
    template_sections образца, по умолчанию — раздела с тем же названием).
    Если наименование в образце не найдено или встречается под разными
    ключами (например "Кран шаровый 20 мм" есть и в отоплении, и в
    водопроводе) — ключ предыдущей строки этого же раздела: в смете строки
    идут блоками по конструктивам, соседняя строка почти всегда из того же
    блока.
  - {"keywords": [(подстрока, ключ), ...], "default": ключ} — по словам в
    наименовании (первое совпадение), иначе default.
"""
from collections import Counter

from smeta_reader import parse_amount, read_smeta_rows


def _norm(text: str) -> str:
    return " ".join(text.split()).lower()


def _is_total_name(name: str) -> bool:
    return name.lower().startswith("итого")


def classified_rows(smeta_key: str, smetas: dict, cache: dict) -> list[dict]:
    """Строки сметы с суммой: {"section", "name", "amount", "key"}. cache —
    общий на один расчёт объекта (смета-образец читается из Sheets один раз,
    даже если на неё ссылаются несколько смет)."""
    if smeta_key in cache:
        return cache[smeta_key]

    smeta = smetas[smeta_key]
    raw = read_smeta_rows(smeta["spreadsheet_id"], smeta["gid"], stop_at_total=True)
    rows = []
    for row in raw:
        amount = parse_amount(row["sum_vat"])
        if not amount:
            continue
        name = row["name"].strip()
        if _is_total_name(name):
            continue
        section = row["section"].strip() or name  # у "Непредвиденные"/"Накладные" Раздел = их же название
        rows.append({"section": section, "name": name, "amount": amount, "konstruktiv": row["konstruktiv"].strip()})

    if smeta.get("konstruktiv_column"):
        for row in rows:
            row["key"] = row["konstruktiv"] or row["section"]
    else:
        split = smeta.get("split_sections", {})
        previous_key: dict[str, str] = {}  # раздел -> ключ последней классифицированной строки
        for row in rows:
            rule = split.get(row["section"])
            if rule is None:
                row["key"] = row["section"]
            elif "keywords" in rule:
                lowered = row["name"].lower()
                row["key"] = next((key for word, key in rule["keywords"] if word in lowered), rule["default"])
            else:
                row["key"] = _key_from_template(row, rule, smetas, cache, previous_key.get(row["section"]))
            previous_key[row["section"]] = row["key"]

    cache[smeta_key] = rows
    return rows


def _key_from_template(row: dict, rule: dict, smetas: dict, cache: dict, previous: str | None) -> str:
    template_sections = set(rule.get("template_sections", [row["section"]]))
    candidates = [r for r in classified_rows(rule["template"], smetas, cache) if r["section"] in template_sections]

    keys = {r["key"] for r in candidates if _norm(r["name"]) == _norm(row["name"])}
    if len(keys) == 1:
        return keys.pop()
    if previous:
        return previous
    # Первая же строка раздела не нашлась в образце — самый "тяжёлый" ключ
    # этих разделов в образце.
    weights = Counter()
    for r in candidates:
        weights[r["key"]] += r["amount"]
    return weights.most_common(1)[0][0] if weights else row["section"]


def totals_by_key(smeta_key: str, smetas: dict, cache: dict) -> dict[str, float]:
    totals: dict[str, float] = {}
    for row in classified_rows(smeta_key, smetas, cache):
        totals[row["key"]] = totals.get(row["key"], 0.0) + row["amount"]
    return totals
