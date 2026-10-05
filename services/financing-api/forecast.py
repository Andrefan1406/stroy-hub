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

Окончание вместе с внутренней отделкой (FINISH_WITH_INTERIOR): сантехники
и электрики сначала монтируют трубы и кабели (сети — ВК, электромонтаж,
обычный прогноз), а в конце отделки те же бригады ставят сантехприборы и
розетки/выключатели — поэтому прогноз чистового монтажа заканчивается
одновременно с прогнозом внутренней отделки, а не по собственному
темпу/накопленному сдвигу. Не начатый чистовой монтаж идёт в конце отделки
параллельно со своей сетью: старт — за плановую длительность до окончания
отделки, но не раньше старта прогноза своей сети и не раньше даты
последнего отчёта. У Нурлы Жол 3 к отделке выравниваются и сами сети
(networks_finish_with_interior в config.py, NETWORKS_FINISH_WITH_INTERIOR):
старт сети — обычный прогноз, она растягивается до конца отделки. Отделка по плану идёт позже сетей, т.е. к моменту
их обработки её прогноз ещё не посчитан — поэтому два прохода: первый
находит окончание отделки, второй выравнивает по нему. Сдвиг выровненного
раздела от его плана — следствие выравнивания, а не отставание, поэтому
на последующие разделы он не переходит. Не применяется к уже
завершённым разделам (их даты — факт) и если сама отделка уже завершена
(закончить "одновременно" с прошлой датой нельзя — обычная логика).
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

INTERIOR_FINISH = "внутренняя отделка"
# раздел -> сеть, параллельно с которой он идёт (None — это сама сеть).
FINISH_WITH_INTERIOR = {
    "монтаж сантех.оборудования": "водоснабжение и канализация",
    "чистовой монтаж эл.оборудования": "электромонтажные работы",
}
# Сети тоже заканчиваются с отделкой — только у объектов с
# networks_finish_with_interior (config.py); None — сама сеть.
NETWORKS_FINISH_WITH_INTERIOR = {
    "водоснабжение и канализация": None,
    "электромонтажные работы": None,
}


def _parse(d: str) -> date:
    return date.fromisoformat(d)


def minus_months(d: date, months: int) -> date:
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


def compute_forecast(sections: list[dict], networks_finish_with_interior: bool = False) -> list[dict]:
    """Добавляет forecast_start/forecast_end/delay_days к каждому разделу с
    известными плановыми сроками (start/end уже в секции); для остальных —
    forecast_start=forecast_end=delay_days=None. Ожидает sections в плановой
    хронологии (как их уже возвращает redistribute_overhead)."""
    finish_with = dict(FINISH_WITH_INTERIOR)
    if networks_finish_with_interior:
        finish_with.update(NETWORKS_FINISH_WITH_INTERIOR)
    first_pass = _forecast_pass(sections, None, finish_with)
    interior = next(
        (s for s in first_pass if s["name"].lower() == INTERIOR_FINISH and s["forecast_end"]),
        None,
    )
    if interior is None or (interior.get("fact_completed") and interior.get("fact_end")):
        return first_pass
    return _forecast_pass(sections, interior, finish_with)


def _forecast_pass(sections: list[dict], interior: dict | None, finish_with: dict[str, str | None]) -> list[dict]:
    """Один проход прогноза. interior — раздел "Внутренняя отделка" из
    первого прохода (его прогноз во втором проходе берётся как есть) или
    None — без выравнивания по finish_with (раздел -> его сеть, см.
    FINISH_WITH_INTERIOR)."""
    interior_end = _parse(interior["forecast_end"]) if interior else None
    carry_forward_days = 0
    has_signal = False  # True после первого раздела, давшего сдвиг (факт или вынужденная задержка)
    today = date.today()
    forecast_start_by_name: dict[str, date] = {}
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
                    forecast_start = max(forecast_start, minus_months(pred_end, months_before))
            forecast_end = forecast_start + timedelta(days=plan_days)
            forecast_end, pause_start, pause_end = _apply_winter_pause(sec["name"], forecast_start, forecast_end)

        name = sec["name"].lower()
        aligned = False
        if interior and not (fact_completed and fact_end_str):
            if name == INTERIOR_FINISH:
                # Прогноз отделки — тот, по которому выравнивались сети
                # выше; пересчёт во втором проходе мог бы его сдвинуть
                # (если отделка не начата — через изменившийся сдвиг).
                forecast_start = _parse(interior["forecast_start"])
                forecast_end = interior_end
            elif name in finish_with:
                aligned = True
                network = finish_with[name]
                if network and not has_own_fact:
                    # Не начатый чистовой монтаж — в конце отделки, за
                    # плановую длительность до её окончания, но не раньше
                    # старта своей сети (параллельно с ней). Сеть же
                    # стартует по обычному прогнозу и тянется до конца
                    # отделки (только окончание общее).
                    forecast_start = max(interior_end - timedelta(days=plan_days), last_report)
                    network_start = forecast_start_by_name.get(network)
                    if network_start:
                        forecast_start = max(forecast_start, network_start)
                forecast_end = max(interior_end, forecast_start)

        forecast_start_by_name[name] = forecast_start
        forecast_end_by_name[name] = forecast_end
        delay_days = (forecast_end - plan_end).days
        if end_uncertain and delay_days <= 0:
            # Мог закончить по плану — сигнала ни об отставании, ни об
            # опережении нет. (Если даже самое раннее возможное окончание
            # позже плана — отставание точно было, и дальше передаётся
            # именно это, минимальное, ниже как обычно.)
            pass
        elif aligned:
            # Окончание задано отделкой, а не отставанием этого раздела —
            # сдвиг от плана (сеть растянута до конца отделки) не bottleneck
            # и на последующие разделы не переходит.
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
