// Ведомость в Excel: листы «Ведомость», «Замеры», «Материалы», «Проёмы».
import * as XLSX from "xlsx";
import { OPENING_TYPES, effectiveHeight, effectiveThickness } from "./masonry";

const r3 = (v) => (v == null ? "" : Math.round(v * 1000) / 1000);
const r4 = (v) => (v == null ? "" : Math.round(v * 10000) / 10000);
const r2 = (v) => (v == null ? "" : Math.round(v * 100) / 100);

export function exportTakeoffExcel({ fileName, masonry, statement, measurements, floors, openings }) {
  const book = XLSX.utils.book_new();
  const title = fileName ? `Чертёж: ${fileName}` : "";
  const floorName = (id) => floors.find((f) => f.id === id)?.name || "";
  const describe = (m) => {
    const w = measurements.find((x) => x.id === m);
    return w ? `лист ${w.page}: ${w.snapshot?.name || w.work || "без названия"}${w.room ? ` (${w.room})` : ""}` : "";
  };

  // Ведомость
  const total = [["Ведомость объёмов работ"], [title], []];
  if (masonry.rows.length) {
    total.push(["Работы по справочнику"]);
    total.push(["№", "Группа", "Работа", "Ед. изм.", "Объём", "Материал", "Ед. мат.", "Расход", "Сумма работ, тг", "Сумма материалов, тг"]);
    masonry.rows.forEach((r, i) => total.push([
      i + 1, r.groupName, r.work, r.unit, r4(r.quantity), r.materialName || "", r.materialUnit || "", r.material ?? "", r.workSum ?? "", r.materialSum ?? "",
    ]));
    const workSum = masonry.rows.reduce((s, r) => s + (r.workSum || 0), 0);
    const matSum = masonry.rows.reduce((s, r) => s + (r.materialSum || 0), 0);
    if (workSum || matSum) total.push(["", "", "Итого", "", "", "", "", "", r2(workSum) || "", r2(matSum) || ""]);
    total.push([]);
  }
  if (statement.rows.length) {
    total.push(["Прочие работы"]);
    total.push(["№", "Вид работ", "Ед. изм.", "Количество"]);
    statement.rows.forEach((r, i) => total.push([i + 1, r.work, r.unit, r.quantity]));
  }
  const totalSheet = XLSX.utils.aoa_to_sheet(total);
  totalSheet["!cols"] = [{ wch: 5 }, { wch: 22 }, { wch: 44 }, { wch: 9 }, { wch: 12 }, { wch: 20 }, { wch: 9 }, { wch: 12 }, { wch: 16 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(book, totalSheet, "Ведомость");

  // Замеры
  const det = [["Работа", "Помещение / место", "Лист PDF", "Этаж", "Высота, м", "Толщина, м", "Брутто, м²", "Проёмы / каналы, м²", "Количество", "Ед. изм.", "Материал", "Расход", "× одинаковых", "Вычет", "Норма"]];
  for (const d of masonry.details) {
    const m = d.m;
    det.push([
      m.snapshot.name, m.room || "", m.page, floorName(m.floorId),
      m.heightOverride ? `${r3(effectiveHeight(m, floors))} (вручную)` : r3(effectiveHeight(m, floors)),
      m.snapshot.unit === "м³" && m.snapshot.method !== "rect_channels" ? r3(effectiveThickness(m)) : "",
      r4(d.gross ?? d.outerArea), r4(d.openingsArea ?? d.channelsArea), r4(d.quantity), m.snapshot.unit,
      m.snapshot.materialName || "", d.material == null ? "" : r3(d.material), m.count > 1 ? m.count : 1, "", `версия ${m.snapshot.version}`,
    ]);
  }
  for (const d of statement.details) {
    det.push([d.work, d.room, d.page, "", "", "", "", "", d.quantity, d.unit, "", "", d.count, d.deduct ? "да" : "", ""]);
  }
  const detSheet = XLSX.utils.aoa_to_sheet(det);
  detSheet["!cols"] = [{ wch: 40 }, { wch: 20 }, { wch: 8 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 11 }, { wch: 8 }, { wch: 18 }, { wch: 10 }, { wch: 11 }, { wch: 7 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(book, detSheet, "Замеры");

  // Материалы
  const mats = [["Свод расхода материалов"], [title], [], ["№", "Материал", "Ед. изм.", "Количество", "Сумма, тг"]];
  masonry.materials.forEach((t, i) => mats.push([i + 1, t.materialName, t.materialUnit, t.quantity, t.sum ?? ""]));
  const matSheet = XLSX.utils.aoa_to_sheet(mats);
  matSheet["!cols"] = [{ wch: 5 }, { wch: 30 }, { wch: 9 }, { wch: 12 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(book, matSheet, "Материалы");

  // Проёмы
  const ops = [["Ведомость проёмов"], [title], [], ["Марка", "Тип", "Ширина, м", "Высота, м", "Кол-во по ведомости", "Назначено в замерах", "Источник", "Где использованы"]];
  for (const o of masonry.openingsUsage) {
    ops.push([
      o.mark, OPENING_TYPES[o.type] || o.type, o.width, o.height, o.qty, o.used, o.source === "spec" ? "спецификация" : "вручную",
      o.uses.map((u) => `${describe(u.measurementId)} × ${u.qty}`).join("; "),
    ]);
  }
  if (!openings.length) ops.push(["Проёмов нет"]);
  const opSheet = XLSX.utils.aoa_to_sheet(ops);
  opSheet["!cols"] = [{ wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(book, opSheet, "Проёмы");

  XLSX.writeFile(book, `Ведомость объёмов — ${fileName ? fileName.replace(/\.pdf$/i, "") : "чертёж"}.xlsx`);
}
