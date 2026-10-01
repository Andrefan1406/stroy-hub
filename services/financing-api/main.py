"""FastAPI-обёртка над build_financing_plan.py — отдаёт готовый план по
объекту фронтенду (src/pages/FinancingPlanDashboardPage.jsx).

Локальный запуск (venv активен):
    uvicorn main:app --reload --port 8000

/financing-plan/*, /categories закрыты Firebase-токеном администратора
(см. auth.py) — финансовые данные, не для анонимного доступа. /health
открыт — по нему Render проверяет, что сервис жив, туда токен не приходит.
"""
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from auth import require_admin
from build_financing_plan import build_object_plan
from config import OBJECTS
from overview import build_categories_overview

app = FastAPI(title="StroyHub Financing Plan API")

# Тот же принцип, что и CORS в server/index.js: фронтенд ходит сюда с
# другого origin (localhost:3000 -> localhost:8000, а на проде Netlify ->
# Render). Открыто для всех origin — сама граница безопасности не в CORS, а
# в Authorization-токене (require_admin), CORS его не подменяет.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/categories")
def categories(admin_email: str = Depends(require_admin)):
    return build_categories_overview()


@app.get("/financing-plan/{object_key}")
def financing_plan(object_key: str, admin_email: str = Depends(require_admin)):
    if object_key not in OBJECTS:
        raise HTTPException(status_code=404, detail=f"Неизвестный объект: {object_key!r}")
    return build_object_plan(object_key)
