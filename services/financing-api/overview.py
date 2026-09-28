"""Агрегаты для верхних уровней навигации (категория -> объект) — количество
домов/квартир/площадей. Считается ТОЛЬКО из config.py (без обращения к
Google Sheets или Node/ГПР) — эти карточки должны открываться мгновенно, в
отличие от карточки конкретного объекта (там уже реальная смета/график,
поэтому дороже и по клику).
"""
from config import CATEGORIES, OBJECTS, SMETAS


def _object_totals(object_key: str) -> dict:
    obj = OBJECTS[object_key]
    buildings_count = len(obj["positions"])
    apartments_count = 0
    apartments_area_m2 = 0.0
    commercial_area_m2 = 0.0

    for smeta_key in obj["positions"].values():
        smeta = SMETAS[smeta_key]
        apartments_count += smeta.get("apartments_count") or 0
        apartments_area_m2 += smeta.get("apartments_area_m2") or 0
        commercial_area_m2 += (smeta.get("commercial_floor1_area_m2") or 0) + (
            smeta.get("commercial_basement_area_m2") or 0
        )

    return {
        "key": object_key,
        "name": obj["name"],
        "buildings_count": buildings_count,
        "apartments_count": apartments_count,
        "apartments_area_m2": round(apartments_area_m2, 2),
        "commercial_area_m2": round(commercial_area_m2, 2),
    }


def build_categories_overview() -> dict:
    categories = []
    for category_key, category in CATEGORIES.items():
        objects = [_object_totals(object_key) for object_key in category["objects"]]
        categories.append(
            {
                "key": category_key,
                "name": category["name"],
                "buildings_count": sum(o["buildings_count"] for o in objects),
                "apartments_count": sum(o["apartments_count"] for o in objects),
                "apartments_area_m2": round(sum(o["apartments_area_m2"] for o in objects), 2),
                "commercial_area_m2": round(sum(o["commercial_area_m2"] for o in objects), 2),
                "objects": objects,
            }
        )
    return {"categories": categories}
