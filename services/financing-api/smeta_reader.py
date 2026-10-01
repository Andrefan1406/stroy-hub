"""Читает одну Google-таблицу со сметой и считает сумму с ндс по разделам.

Строки без суммы (пустые/0) и строка "Итого" в агрегацию не идут — "Итого"
используется только для сверки, что сумма разделов совпадает с ней (если
нет — значит где-то задвоение, например от жирной строки-итога раздела,
у которой тоже своя ненулевая сумма).

Подписи колонок сравниваются в нормализованном виде (без учёта регистра,
переносов строк и лишних пробелов/двоеточий) — на практике разные сметы
называют одну и ту же колонку чуть по-разному ("Сумма с ндс" / "Сумма с
НДС", "№\nп/п" и т.п.).

Запуск:
    python smeta_reader.py <SPREADSHEET_ID> <GID>

SPREADSHEET_ID и GID берутся из ссылки на таблицу:
    https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit?gid=<GID>
"""
import json
import os
import sys

import gspread
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# Канонические поля, которые нам нужны -> варианты их подписи в таблице
# (уже в нормализованном виде, см. normalize_header_cell).
CANONICAL_FIELDS = {
    "rm": ["р/м"],
    "section": ["раздел"],
    "name": ["наименование"],
    "unit": ["ед.изм"],
    "qty": ["кол-во"],
    "sum_vat": ["сумма с ндс"],
}
HEADER_SEARCH_ROWS = 20


def get_client() -> gspread.Client:
    raw = os.environ.get("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise SystemExit(
            "Не задана переменная GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON в .env "
            "(см. .env.example) — содержимое JSON-ключа сервисного аккаунта целиком, одной строкой."
        )
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as err:
        raise SystemExit(f"GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON содержит невалидный JSON: {err}")
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    return gspread.authorize(creds)


def normalize_header_cell(cell: str) -> str:
    """'  Сумма с НДС ' / 'Кол-во:' / '№\\nп/п' -> 'сумма с ндс' / 'кол-во' / '№ п/п'."""
    return " ".join(cell.replace("\n", " ").split()).strip().lower().rstrip(":")


def find_header_row(rows: list[list[str]]) -> int:
    required = set(CANONICAL_FIELDS) - {"rm", "unit", "qty"}  # то, что точно есть в каждой смете
    required_labels = {CANONICAL_FIELDS[f][0] for f in required}
    for i, row in enumerate(rows[:HEADER_SEARCH_ROWS]):
        normalized = {normalize_header_cell(c) for c in row if c.strip()}
        if required_labels.issubset(normalized):
            return i
    raise ValueError(
        "Не нашёл строку заголовков в первых "
        f"{HEADER_SEARCH_ROWS} строках (ищу столбцы: {', '.join(sorted(required_labels))})"
    )


def build_field_map(header: list[str]) -> dict[str, int]:
    """Индекс столбца для каждого канонического поля."""
    normalized = [normalize_header_cell(h) for h in header]
    field_map = {}
    for field, variants in CANONICAL_FIELDS.items():
        for i, cell in enumerate(normalized):
            if cell in variants:
                field_map[field] = i
                break
    return field_map


def read_smeta_rows(spreadsheet_id: str, gid: int) -> list[dict]:
    client = get_client()
    spreadsheet = client.open_by_key(spreadsheet_id)
    worksheet = spreadsheet.get_worksheet_by_id(gid)
    raw_rows = worksheet.get_all_values()

    header_idx = find_header_row(raw_rows)
    field_map = build_field_map(raw_rows[header_idx])
    data_rows = raw_rows[header_idx + 1:]

    def cell(row: list[str], field: str) -> str:
        idx = field_map.get(field)
        if idx is None or idx >= len(row):
            return ""
        return row[idx]

    records = []
    for row in data_rows:
        if not any(c.strip() for c in row):
            continue  # пустая строка-разделитель
        records.append({field: cell(row, field) for field in CANONICAL_FIELDS})
    return records


def parse_amount(raw: str) -> float | None:
    """'10 124 717,80 ₸' -> 10124717.8; '' / '-' / 'по факту' -> None."""
    if not raw:
        return None
    cleaned = raw.replace("\xa0", "").replace(" ", "").replace("₸", "").strip()
    if not cleaned or cleaned == "-":
        return None
    try:
        return float(cleaned.replace(",", "."))
    except ValueError:
        return None  # текст вроде "по факту" — цена не зафиксирована в смете


def aggregate_by_section(rows: list[dict]) -> tuple[dict[str, float], float, float | None]:
    """Возвращает (суммы по разделам, сумма всех разделов, значение строки
    "Итого" из таблицы — для сверки, что сумма разделов совпадает с ним и
    нигде нет двойного счёта)."""
    totals: dict[str, float] = {}
    grand_total_row = None

    for row in rows:
        amount = parse_amount(row["sum_vat"])
        if amount is None or amount == 0:
            continue  # пустые/нулевые строки (в т.ч. строки-заголовки разделов без своей суммы) пропускаем

        name = row["name"].strip()
        section = row["section"].strip()

        if name.lower().startswith("итого"):
            grand_total_row = amount  # не раздел — строка контрольной суммы, для сверки
            continue

        key = section or name  # у "Непредвиденные"/"Накладные" Раздел = их же название
        totals[key] = totals.get(key, 0.0) + amount

    return totals, sum(totals.values()), grand_total_row


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Использование: python smeta_reader.py <SPREADSHEET_ID> <GID>")
    spreadsheet_id, gid = sys.argv[1], int(sys.argv[2])

    rows = read_smeta_rows(spreadsheet_id, gid)
    print(f"Прочитано строк: {len(rows)}\n")

    totals, sum_of_sections, grand_total_row = aggregate_by_section(rows)
    print("Сумма с ндс по разделам:")
    for section, amount in totals.items():
        print(f"  {section:30} {amount:>18,.2f}".replace(",", " "))

    print(f"\nСумма всех разделов:         {sum_of_sections:>18,.2f}".replace(",", " "))
    if grand_total_row is not None:
        print(f"Строка 'Итого' в таблице:    {grand_total_row:>18,.2f}".replace(",", " "))
        diff = sum_of_sections - grand_total_row
        if abs(diff) < 1:
            print("Совпадает — двойного счёта нет.")
        else:
            print(f"НЕ СОВПАДАЕТ (разница {diff:,.2f}) — где-то задвоение или пропуск, разбираемся.".replace(",", " "))


if __name__ == "__main__":
    main()
