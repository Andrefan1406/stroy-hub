"""Прогноз сроков — фича «Прогноз» на странице Графика производства работ.

Прогноз строится по ПЛАНОВОЙ скорости, а не по текущей: исходим из того,
что с даты последнего отчёта работы идут с тем темпом, с каким их
планировали (прогноз по текущему темпу получался слишком пессимистичным —
отстающие разделы уезжали на годы вперёд).

Метод намеренно простой, без графа зависимостей между разделами (его нет в
исходных данных — ГПР хранит только позицию+раздел+% по неделям, без связей
"после какой работы идёт эта"): разделы обрабатываются в плановой
хронологии (chronological_sort уже применён к sections на входе). Худшее
(максимальное) отставание среди уже обработанных разделов — это сдвиг для
всех ещё НЕ начатых разделов дальше по графику: реальный bottleneck не
должен "забываться" из-за того, что более поздний (по плану) раздел
закончился с меньшей задержкой — при линейной стройке одного объекта это
разумное упрощение вместо честного propagation по зависимостям.

delay_days МОЖЕТ быть отрицательным (раздел идёт с опережением) — это
намеренно: если ПЕРВЫЙ по хронологии раздел с фактом закончился раньше
плана, а настоящего отставания ещё нигде не возникало, последующие ещё не
начатые разделы допустимо показать сдвинутыми раньше исходного плана (но не
раньше даты последнего отчёта — см. ниже).

Для раздела в процессе (0 < Текущий% < 100):
    Остаток_дней = Плановая_длительность * (100 - Текущий%) / 100
    Дата_прогноз_окончания = Дата_последнего_отчёта + Остаток_дней
forecast_start — дата последнего отчёта (as_of): на дашборде полоса
"Прогноз" стыкуется с концом полосы "Факт" и не заходит в прошлое.

Для завершённого раздела — прогноз не нужен, берём фактические даты как есть
(фронтенд вообще не рисует по ним полосу прогноза — предсказывать нечего).
Если первой отметке 100% предшествует пропуск в отчётах, точная дата
окончания неизвестна (см. fact_end_earliest, gpr_timeline.py) — тогда
отставание считается только то, что было наверняка.

Для ещё не начатого — плановая длительность целиком, со стартом в
ПланДата_начала + накопленный сдвиг, но не раньше даты последнего отчёта:
раздел, который по плану уже должен был начаться, но не начат, не может
начаться в прошлом. Этот вынужденный сдвиг — тоже отставание и переходит
на последующие разделы позиции.

Зимний простой монолитных работ (WINTER_PAUSE_*): бетон зимой не льют —
раздел "Монолитный каркас" физически не может идти с 15 ноября по конец
февраля. По плану эти работы должны укладываться в тёплый сезон (значит
план этого простоя не учитывает), но ПРОГНОЗ, посчитанный от реального
отставания, может показать окончание внутри зимнего окна — это невозможно,
поэтому если прогнозируемое (до поправки) окончание раздела попадает на/после
начала простоя, весь остаток работ замораживается целиком до конца февраля
(а не размазывается по зиме) и доделывается уже после. Добавленные дни
становятся частью delay_days этого раздела и дальше расходятся на все
последующие ещё не начатые разделы через обычный carry_forward_days.

Технологические ограничения на старт (START_CONSTRAINTS) — поверх общего
сдвига, только для ещё не начатых разделов (уже начатую работу переносить
некуда): кладка может идти параллельно с каркасом, но не раньше чем за
месяц до его прогнозного окончания; покрытие кровли — только после
окончания наружной отделки. Вынужденный этим сдвиг — тоже отставание и
переходит на последующие разделы.
"""
import calendar
from datetime import date, timedelta

WINTER_PAUSE_START_MONTH_DAY = (11, 15)  # 15 ноября

# раздел -> (раздел-предшественник, за сколько месяцев до ЕГО прогнозного
# окончания раздел может начаться; 0 — только после окончания). Названия —
# как в ГПР/смете (в т.ч. "Наружняя"), сравниваются без учёта регистра.
START_CONSTRAINTS = {
    "каменная кладка": ("монолитный каркас", 1),
    "кровля (покрытие)": ("наружняя отделка", 0),
}


def _parse(d: str) -> date:
    return date.fromisoformat(d)


def _minus_months(d: date, months: int) -> date:
    year_shift, month0 = divmod(d.month - 1 - months, 12)
    year = d.year + year_shift
    month = month0 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


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
    has_signal = False  # True после первого раздела, давшего сдвиг (факт или вынужденная задержка)
    today = date.today()
    forecast_end_by_name: dict[str, date] = {}
    result = []

    for sec in sections:
        if not sec.get("start") or not sec.get("end"):
            result.append({**sec, "forecast_start": None, "forecast_end": None, "delay_days": None})
            continue

        plan_start = _parse(sec["start"])
        plan_end = _parse(sec["end"])
        plan_days = max((plan_end - plan_start).days, 0)

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

        end_uncertain = False
        if fact_completed and fact_end_str:
            # Уже завершён — прогнозировать нечего, берём реальные даты.
            forecast_start = _parse(fact_start_str) if fact_start_str else plan_start
            forecast_end = _parse(fact_end_str)
            # Перед первой отметкой 100% был пропуск в отчётах — точная дата
            # окончания неизвестна, известно только окно [end_earliest, end].
            # Считаем, что закончили по плану, если плановая дата в это окно
            # попадает (иначе — ближайшая граница окна), и такой раздел не
            # передаёт отставание дальше: иначе один пропуск в отчётах
            # сдвигал весь прогноз позиции на длину пропуска.
            earliest_str = sec.get("fact_end_earliest")
            if earliest_str != fact_end_str:
                end_uncertain = True
                lower = _parse(earliest_str) if earliest_str else date.min
                forecast_end = min(max(plan_end, lower), forecast_end)
        elif has_own_fact:
            # В процессе — остаток доделываем с плановой скоростью, начиная
            # с даты последнего отчёта.
            as_of = _parse(fact_as_of_str)
            remaining_percent = max(100 - fact_percent, 0)
            remaining_days = round(plan_days * remaining_percent / 100)
            forecast_start = as_of
            forecast_end = as_of + timedelta(days=remaining_days)
            forecast_end, pause_start, pause_end = _apply_winter_pause(sec["name"], forecast_start, forecast_end)
        else:
            # Ещё не начат — плановая длительность целиком, старт сдвинут на
            # накопленное отставание предыдущих разделов (может быть и в
            # минус — опережение), но не раньше даты последнего отчёта.
            last_report = min(_parse(fact_as_of_str), today) if fact_as_of_str else today
            forecast_start = max(plan_start + timedelta(days=carry_forward_days), last_report)
            # Предшественник идёт раньше по плановой хронологии, значит уже
            # посчитан; если его нет в позиции — ограничение не действует.
            constraint = START_CONSTRAINTS.get(sec["name"].lower())
            if constraint:
                pred_name, months_before = constraint
                pred_end = forecast_end_by_name.get(pred_name)
                if pred_end:
                    forecast_start = max(forecast_start, _minus_months(pred_end, months_before))
            forecast_end = forecast_start + timedelta(days=plan_days)
            forecast_end, pause_start, pause_end = _apply_winter_pause(sec["name"], forecast_start, forecast_end)

        forecast_end_by_name[sec["name"].lower()] = forecast_end
        delay_days = (forecast_end - plan_end).days
        if end_uncertain and delay_days <= 0:
            # Мог закончить по плану — сигнала ни об отставании, ни об
            # опережении нет. (Если даже самое раннее возможное окончание
            # позже плана — отставание точно было, и дальше передаётся
            # именно это, минимальное, ниже как обычно.)
            pass
        elif has_own_fact:
            carry_forward_days = delay_days if not has_signal else max(carry_forward_days, delay_days)
            has_signal = True
        elif delay_days > carry_forward_days:
            # Не начатый раздел сам добавил отставание (не мог стартовать в
            # прошлом или попал на зимний простой) — это новый сигнал для
            # последующих разделов, а не просто трансляция унаследованного.
            carry_forward_days = delay_days
            has_signal = True

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
