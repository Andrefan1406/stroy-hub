#!/usr/bin/env python3
"""
Скрипт для массового добавления пользователей в Firebase Authentication
из Excel файла (колонки: Логин, Пароль).

Запуск:
    python3 add_firebase_users.py
"""

import firebase_admin
from firebase_admin import credentials, auth
import pandas as pd
import sys

# ========== НАСТРОЙКИ (поменяйте под себя) ==========
CREDENTIALS_FILE = "serviceAccountKey.json"   # файл ключа из Firebase Console
EXCEL_FILE = "passwords.xlsx"                 # файл с логинами/паролями
SHEET_NAME = 0                                 # 0 = первый лист, либо название листа
# ======================================================


def main():
    # 1. Подключаемся к Firebase
    try:
        cred = credentials.Certificate(CREDENTIALS_FILE)
        firebase_admin.initialize_app(cred)
        print("✓ Подключение к Firebase успешно\n")
    except Exception as e:
        print(f"✗ Не удалось подключиться к Firebase: {e}")
        print("  Проверьте, что файл serviceAccountKey.json лежит рядом со скриптом.")
        sys.exit(1)

    # 2. Читаем Excel
    try:
        df = pd.read_excel(EXCEL_FILE, sheet_name=SHEET_NAME)
    except Exception as e:
        print(f"✗ Не удалось прочитать {EXCEL_FILE}: {e}")
        sys.exit(1)

    if "Логин" not in df.columns or "Пароль" not in df.columns:
        print(f"✗ В файле должны быть колонки 'Логин' и 'Пароль'. Найдено: {list(df.columns)}")
        sys.exit(1)

    total = len(df)
    created, skipped, failed = 0, 0, 0

    print(f"Найдено пользователей: {total}\n{'-'*60}")

    # 3. Создаём пользователей по очереди
    for i, row in df.iterrows():
        email = str(row["Логин"]).strip()
        password = str(row["Пароль"]).strip()

        print(f"[{i+1}/{total}] {email} ... ", end="")

        try:
            user = auth.create_user(email=email, password=password)
            print(f"✓ создан (uid: {user.uid[:10]}...)")
            created += 1

        except auth.EmailAlreadyExistsError:
            print("↷ уже существует, пропущен")
            skipped += 1

        except Exception as e:
            print(f"✗ ошибка: {e}")
            failed += 1

    # 4. Итог
    print(f"{'-'*60}")
    print(f"Готово: создано {created}, пропущено {skipped}, ошибок {failed} из {total}")


if __name__ == "__main__":
    main()
