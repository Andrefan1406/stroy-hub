"""Проверка Firebase ID-токена — тот же принцип, что и requireAdmin в
server/adminAuth.js (тот же Firebase-проект, тот же admin email).

В отличие от Node-SDK, python'овский firebase-admin всё равно требует
credential для инициализации Auth-клиента (google.auth.default() падает,
если его нет), даже несмотря на то что сама проверка подписи токена идёт
по публичным ключам Google и не требует авторизованных вызовов API. Чтобы
не заводить отдельный секрет только под это, переиспользуем уже имеющийся
сервисный аккаунт (GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON, см. smeta_reader.py)
— его собственный project_id тут не важен, project_id для проверки токена
задаётся explicitly через options ниже.
"""
import json
import logging
import os

import firebase_admin
from dotenv import load_dotenv
from fastapi import Header, HTTPException
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials as firebase_credentials

load_dotenv()

logger = logging.getLogger("uvicorn.error")

FIREBASE_PROJECT_ID = "my-first-site-16a0c"
ADMIN_EMAIL = "admin@vkdev.kz"
ALLOWED_EMAILS = {ADMIN_EMAIL, "v.titarenko@vkdevgroup.kz"}

if not firebase_admin._apps:
    raw = os.environ.get("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise SystemExit("Не задана переменная GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON в .env")
    cert = firebase_credentials.Certificate(json.loads(raw))
    firebase_admin.initialize_app(credential=cert, options={"projectId": FIREBASE_PROJECT_ID})


def require_admin(authorization: str = Header(default=None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Не передан токен авторизации")

    token = authorization.removeprefix("Bearer ")
    try:
        decoded = firebase_auth.verify_id_token(token)
    except Exception:
        logger.exception("Не удалось проверить Firebase ID-токен")
        raise HTTPException(status_code=401, detail="Недействительный или просроченный токен авторизации")

    email = decoded.get("email")
    if not email or email.lower() not in ALLOWED_EMAILS:
        raise HTTPException(status_code=403, detail="Доступ запрещён")
    return email
