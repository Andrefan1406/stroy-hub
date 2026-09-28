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
"""
from datetime import date, timedelta


def _parse(d: str) -> date:
    return date.fromisoformat(d)


def _weeks_between(a: date, b: date) -> float:
    return max((b - a).days, 0) / 7


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
        else:
            # Ещё не начат — своей скорости нет, сдвигаем плановые даты на
            # то, что перенёс предыдущий (по хронологии) раздел — может быть
            # и в плюс (отставание), и в минус (опережение).
            forecast_start = plan_start + timedelta(days=carry_forward_days)
            forecast_end = plan_end + timedelta(days=carry_forward_days)

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
            }
        )

    return result
