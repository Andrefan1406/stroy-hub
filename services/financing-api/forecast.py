"""Прогноз сроков по текущему темпу факта — фича «Прогноз» на странице
Графика производства работ.

Метод намеренно простой, без графа зависимостей между разделами (его нет в
исходных данных — ГПР хранит только позицию+раздел+% по неделям, без связей
"после какой работы идёт эта"): разделы обрабатываются в плановой
хронологии (chronological_sort уже применён к sections на входе). Худшее
(максимальное) отставание среди уже завершённых/начатых разделов — это и
есть сдвиг для всех ещё НЕ начатых разделов дальше по графику: реальный
бottleneck не должен "забываться" из-за того, что более поздний (по плану)
раздел закончился с меньшей задержкой — при линейной стройке одного объекта
это разумное упрощение вместо честного propagation по зависимостям.

delay_days МОЖЕТ быть отрицательным (раздел идёт с опережением) — это
намеренно: если ПЕРВЫЙ по хронологии раздел с фактом закончился раньше
плана, а настоящего отставания ещё нигде не возникало, последующие ещё не
начатые разделы допустимо показать сдвинутыми раньше исходного плана.

Для раздела в процессе:
    P_week = Текущий% / Недель_с_начала_работы
    Если P_week слишком мал (< 5% от планового темпа) — берём плановый темп
    вместо него, чтобы не получить бесконечный/абсурдный прогноз.
    Остаток% = 100 - Текущий%
    Остаток_недель = Остаток% / P_week
    Дата_прогноз_окончания = Дата_последнего_отчёта + Остаток_недель
forecast_start для раздела в процессе — дата последнего отчёта (as_of), а
не дата фактического старта: на дашборде полоса "Прогноз" стыкуется с
концом полосы "Факт" и не заходит в прошлое.

Для завершённого раздела — прогноз не нужен, берём фактические даты как есть
(фронтенд вообще не рисует по ним полосу прогноза — предсказывать нечего).
Для ещё не начатого — Дата_прогноз = ПланДата + накопленный сдвиг.

Зимний простой монолитных работ (WINTER_PAUSE_*): бетон зимой не льют —
раздел "Монолитный каркас" физически не может идти с 15 ноября по конец
февраля. По плану эти работы должны укладываться в тёплый сезон (значит
план этого простоя не учитывает), но ПРОГНОЗ, посчитанный от реального
отставания, может показать окончание внутри зимнего окна — это невозможно,
поэтому если прогнозируемое (до поправки) окончание раздела попадает на/после
начала простоя, весь остаток работ замораживается целиком до конца февраля
(а не размазывается по зиме) и доделывается уже после. Добавленные дни
становятся частью delay_days этого раздела и дальше расходятся на все
последующие ещё не начатые разделы через обычный carry_forward_days — так
что отдельной пропагации не требуется.
"""
import calendar
from datetime import date, timedelta

WINTER_PAUSE_START_MONTH_DAY = (11, 15)  # 15 ноября


def _parse(d: str) -> date:
    return date.fromisoformat(d)


def _weeks_between(a: date, b: date) -> float:
    return max((b - a).days, 0) / 7


def _feb_end(year: int) -> date:
    return date(year, 2, 29 if calendar.isleap(year) else 28)


def _relevant_winter_window(anchor: date) -> tuple[date, date]:
    """Ближайшее (текущее идущее или ещё предстоящее относительно anchor)
    окно зимнего простоя — с 15 ноября по конец февраля следующего года."""
    month, day = WINTER_PAUSE_START_MONTH_DAY
    candidates = []
    for start_year in (anchor.year - 1, anchor.year, anchor.year + 1):
        gap_start = date(start_year, month, day)
        gap_end = _feb_end(start_year + 1)
        candidates.append((gap_start, gap_end))
    for gap_start, gap_end in sorted(candidates):
        if gap_end >= anchor:
            return gap_start, gap_end
    return candidates[-1]


def _apply_winter_pause(
    work_name: str, forecast_start: date, forecast_end: date
) -> tuple[date, date | None, date | None]:
    """Если work_name — "Монолитный каркас" и forecast_end (до поправки)
    приходится на/после начала зимнего простоя, сдвигает его на полную
    длительность простоя (работы не идут НИ ДНЯ из окна, а не частично).
    Возвращает (новый forecast_end, начало паузы, конец паузы) — начало/конец
    паузы — None, если простой не применялся (фронтенду нечего вырезать из
    полосы прогноза).

    gap_start_effective — не просто начало окна, а более позднее из (начало
    окна, forecast_start): если сам старт раздела уже перенёсся внутрь зимы
    (унаследованным сдвигом от более раннего раздела той же позиции), то
    считать "оставшиеся дни" от начала окна, а не от даты старта, значило бы
    сдвинуть на кусок времени ДО начала работ, которого в реальности и так
    не было бы отработано — двойной сдвиг."""
    if "монолитный каркас" not in work_name.lower():
        return forecast_end, None, None
    gap_start, gap_end = _relevant_winter_window(forecast_start)
    gap_start_effective = max(forecast_start, gap_start)
    if forecast_end <= gap_start_effective:
        return forecast_end, None, None
    remaining_days = (forecast_end - gap_start_effective).days
    new_end = gap_end + timedelta(days=remaining_days)
    return new_end, gap_start_effective, gap_end


def compute_forecast(sections: list[dict]) -> list[dict]:
    """Добавляет forecast_start/forecast_end/delay_days к каждому разделу с
    известными плановыми сроками (start/end уже в секции); для остальных —
    forecast_start=forecast_end=delay_days=None. Ожидает sections в плановой
    хронологии (как их уже возвращает redistribute_overhead)."""
    carry_forward_days = 0
    has_signal = False  # True после первого раздела с фактом (завершённого/в процессе)
    result = []

    for sec in sections:
        if not sec.get("start") or not sec.get("end"):
            result.append({**sec, "forecast_start": None, "forecast_end": None, "delay_days": None})
            continue

        plan_start = _parse(sec["start"])
        plan_end = _parse(sec["end"])
        plan_weeks = max(_weeks_between(plan_start, plan_end), 1)
        baseline_p_week = 100 / plan_weeks

        fact_percent = sec.get("fact_percent")
        fact_started = sec.get("fact_started")
        fact_completed = sec.get("fact_completed")
        fact_start_str = sec.get("fact_start")
        fact_as_of_str = sec.get("fact_as_of")
        fact_end_str = sec.get("fact_end")

        has_own_fact = (fact_completed and fact_end_str) or (
            fact_started and fact_percent is not None and fact_start_str and fact_as_of_str
        )

        pause_start = None
        pause_end = None

        if fact_completed and fact_end_str:
            # Уже завершён — прогнозировать нечего, берём реальные даты.
            forecast_start = _parse(fact_start_str) if fact_start_str else plan_start
            forecast_end = _parse(fact_end_str)
        elif has_own_fact:
            fact_start = _parse(fact_start_str)
            as_of = _parse(fact_as_of_str)
            weeks_elapsed = max(_weeks_between(fact_start, as_of), 1)
            p_week = fact_percent / weeks_elapsed
            # Скорость почти нулевая (или отрицательная — не должно быть, но
            # на всякий случай) -> базовый плановый темп, чтобы не улететь
            # в бесконечность/абсурдные сроки.
            effective_p_week = p_week if p_week > baseline_p_week * 0.05 else baseline_p_week
            remaining_percent = max(100 - fact_percent, 0)
            remaining_weeks = remaining_percent / effective_p_week
            forecast_start = as_of
            forecast_end = as_of + timedelta(days=round(remaining_weeks * 7))
            forecast_end, pause_start, pause_end = _apply_winter_pause(sec["name"], forecast_start, forecast_end)
        else:
            # Ещё не начат — своей скорости нет, сдвигаем плановые даты на
            # то, что перенёс предыдущий (по хронологии) раздел — может быть
            # и в плюс (отставание), и в минус (опережение).
            forecast_start = plan_start + timedelta(days=carry_forward_days)
            forecast_end = plan_end + timedelta(days=carry_forward_days)
            forecast_end, pause_start, pause_end = _apply_winter_pause(sec["name"], forecast_start, forecast_end)

        delay_days = (forecast_end - plan_end).days
        if has_own_fact:
            carry_forward_days = delay_days if not has_signal else max(carry_forward_days, delay_days)
            has_signal = True
        # у "ещё не начат" delay_days = унаследованный сдвиг — не переопределяет
        # carry_forward_days, это не новый сигнал, а просто его трансляция дальше.

        result.append(
            {
                **sec,
                "forecast_start": forecast_start.isoformat(),
                "forecast_end": forecast_end.isoformat(),
                "delay_days": delay_days,
                # Границы зимнего простоя, применённого к ЭТОМУ разделу (не
                # None только для "Монолитный каркас", когда простой реально
                # сработал) — фронтенд вырезает эти даты из полосы "Прогноз".
                "forecast_pause_start": pause_start.isoformat() if pause_start else None,
                "forecast_pause_end": pause_end.isoformat() if pause_end else None,
            }
        )

    return result
