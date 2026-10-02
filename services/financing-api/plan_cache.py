"""Готовые финпланы объектов в памяти сервиса — чтобы страница финплана
открывалась сразу, а не ждала полминуты чтения смет из Google Sheets и
пересинка ГПР на каждое открытие.

Пересчитываются все объекты разом (с пересинком ГПР каждого):
- при старте сервиса (в фоне, сервис уже отвечает);
- каждую ночь в NIGHTLY_REBUILD_HOUR по времени Казахстана;
- вручную — кнопкой в админ-панели (/admin/financing-resync, см. main.py).

Если к моменту запроса объект ещё не посчитан (сервис только что
запустился), он считается прямо в запросе (без пересинка ГПР — Node и так
синкает его по своему крону) и кладётся в кэш.

Ограничение: кэш живёт в памяти процесса. Если хостинг усыпляет сервис без
запросов (бесплатный тариф Render), ночной пересчёт в спящем процессе не
сработает — тогда данные обновятся при следующем старте или кнопкой.
"""
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone

from build_financing_plan import build_object_plan
from config import OBJECTS

# Казахстан — единый UTC+5 (без перехода на летнее время); фиксированное
# смещение вместо zoneinfo — на Windows для него нужен отдельный пакет tzdata.
KZ_TZ = timezone(timedelta(hours=5))
NIGHTLY_REBUILD_HOUR = 3

_plans: dict[str, dict] = {}
_object_locks = {key: threading.Lock() for key in OBJECTS}
_rebuild_lock = threading.Lock()
_status = {"running": False, "started_at": None, "reason": None, "last_run": None}


def _now_iso() -> str:
    return datetime.now(KZ_TZ).isoformat(timespec="seconds")


def _build(object_key: str, resync: bool) -> dict:
    plan = build_object_plan(object_key, resync=resync)
    return {**plan, "built_at": _now_iso()}


def get_plan(object_key: str) -> dict:
    plan = _plans.get(object_key)
    if plan is not None:
        return plan
    with _object_locks[object_key]:
        plan = _plans.get(object_key)  # мог посчитаться, пока ждали блокировку
        if plan is None:
            plan = _build(object_key, resync=False)
            _plans[object_key] = plan
        return plan


def _try_begin(reason: str) -> bool:
    """Занимает пересчёт; False — он уже идёт (второй параллельный не нужен)."""
    if not _rebuild_lock.acquire(blocking=False):
        return False
    _status.update(running=True, started_at=_now_iso(), reason=reason)
    return True


def rebuild_all(reason: str) -> None:
    """Пересчёт всех объектов (синхронно). Пока идёт — страница отдаёт
    прежние данные."""
    if _try_begin(reason):
        _run_rebuild(reason)


def _run_rebuild(reason: str) -> None:
    errors = []
    try:
        for object_key, obj in OBJECTS.items():
            try:
                _plans[object_key] = _build(object_key, resync=True)
            except Exception as exc:
                traceback.print_exc()
                errors.append(f"{obj['name']}: {exc}")
    finally:
        _status.update(
            running=False,
            last_run={
                "ok": not errors,
                "error": "; ".join(errors) or None,
                "reason": reason,
                "started_at": _status["started_at"],
                "finished_at": _now_iso(),
            },
        )
        _rebuild_lock.release()


def start_rebuild(reason: str) -> bool:
    """Запускает пересчёт в фоне; False — он уже идёт. Статус "идёт"
    выставляется ещё до ответа — чтобы админ-страница сразу его увидела и
    начала опрашивать ход."""
    if not _try_begin(reason):
        return False
    threading.Thread(target=_run_rebuild, args=(reason,), daemon=True).start()
    return True


def status() -> dict:
    return {
        **_status,
        "objects": {
            key: {"name": obj["name"], "built_at": _plans[key]["built_at"] if key in _plans else None}
            for key, obj in OBJECTS.items()
        },
        "nightly_hour": NIGHTLY_REBUILD_HOUR,
    }


def _seconds_until_next_run() -> float:
    now = datetime.now(KZ_TZ)
    next_run = now.replace(hour=NIGHTLY_REBUILD_HOUR, minute=0, second=0, microsecond=0)
    if next_run <= now:
        next_run += timedelta(days=1)
    return (next_run - now).total_seconds()


def _nightly_loop() -> None:
    while True:
        time.sleep(_seconds_until_next_run())
        rebuild_all("ночной пересчёт")


def start_background_jobs() -> None:
    start_rebuild("старт сервиса")
    threading.Thread(target=_nightly_loop, daemon=True).start()
