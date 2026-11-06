import { aggregateFlat, buildGrid, buildVdcWorkbook, objectLine, parseIsoDate, priceAfterGarbage, splitPeriod } from "./exportXlsx";

const line = (roomNo, work, qty, priceVat) => ({ roomNo, roomName: "x", work, rateNo: "2.1", unit: "м2", qty, priceVat, sum: null });
const flat = (section, floor, flatIndex, lines) => ({ section, floor, flatIndex, label: `Тип 1 в/о ${flatIndex}`, code: "1", works: { lines } });

const rows = [
  flat("1", 2, 1, [line(1, "Оклейка стен обоями", 10, 1000), line(2, "Оклейка стен обоями", 5.5, 1000), line(3, "Устройство линолеума", 8, 2001), line(4, "Без объёма", null, 500)]),
  flat("1", 3, 1, [line(1, "Оклейка стен обоями", 10, 1000)]),
  flat("2", 2, 1, [line(1, "Оклейка стен обоями", 4, 1000)]),
];

describe("выгрузка ВДЦ в Excel", () => {
  it("цена — расценка минус 10 %, округлённая до целого", () => {
    expect(priceAfterGarbage(1000)).toBe(900);
    expect(priceAfterGarbage(2001)).toBe(1801); // 1800,9
  });

  it("в квартире работы складываются по всем помещениям, строки без объёма пропускаются", () => {
    const { items, skipped } = aggregateFlat(rows[0]);
    expect(items.map((i) => [i.work, i.qty])).toEqual([["Оклейка стен обоями", 15.5], ["Устройство линолеума", 8]]);
    expect(skipped).toBe(1);
  });

  it("сетка: до месяца — по 3 дня, дольше — по неделе, первый столбец — дата начала", () => {
    const a = buildGrid(parseIsoDate("2026-03-02"), parseIsoDate("2026-03-20"));
    expect(a.step).toBe(3);
    expect(a.starts).toHaveLength(7);
    const b = buildGrid(parseIsoDate("2026-03-04"), parseIsoDate("2026-05-01"));
    expect(b.step).toBe(7);
    expect(b.starts[0].toISOString().slice(0, 10)).toBe("2026-03-04"); // не раньше начала графика
    expect(b.starts.at(-1).getTime()).toBeLessThanOrEqual(parseIsoDate("2026-05-01").getTime());
  });

  it("период делится на доли без пропусков и выхода за границы", () => {
    const parts = splitPeriod(parseIsoDate("2026-03-01"), parseIsoDate("2026-03-10"), 3);
    expect(parts.map((p) => [p.start.toISOString().slice(8, 10), p.end.toISOString().slice(8, 10)])).toEqual([["01", "03"], ["04", "06"], ["07", "10"]]);
    const tight = splitPeriod(parseIsoDate("2026-03-01"), parseIsoDate("2026-03-02"), 5);
    expect(tight.every((p) => p.start >= parseIsoDate("2026-03-01") && p.end <= parseIsoDate("2026-03-02") && p.end >= p.start)).toBe(true);
  });

  it("книга: на каждый блок вкладки ВДЦ и ГПР; суммы, уборка мусора и итого — формулы, ГПР по блоку без этажей", async () => {
    const { workbook, skipped, grid } = await buildVdcWorkbook({
      rows, sections: ["1", "2"], schedule: { start: parseIsoDate("2026-03-02"), end: parseIsoDate("2026-06-30") },
      objectName: objectLine("Строительство жилых домов"), position: "Многоэтажный жилой дом поз.1.6",
    });
    expect(workbook.worksheets.map((w) => w.name)).toEqual(["ВДЦ БЛОК 1", "ГПР БЛОК 1", "ВДЦ БЛОК 2", "ГПР БЛОК 2"]);
    expect(skipped).toBe(1);
    expect(grid.step).toBe(7);

    const v = workbook.getWorksheet("ВДЦ БЛОК 1");
    expect(v.getCell("A6").value).toBe("Наименование объекта: «Строительство жилых домов»");
    expect(v.getCell("A7").value).toBe("Позиция: Многоэтажный жилой дом поз.1.6");
    expect(workbook.getWorksheet("ГПР БЛОК 1").getCell("A7").value).toBe("Позиция: Многоэтажный жилой дом поз.1.6");
    expect(v.getCell("J8").value).toBeNull(); // колонки «расценка до вычета» нет
    expect(v.getCell("E9").value).toBe("Оклейка стен обоями");
    expect(v.getCell("G9").value).toBe(15.5);
    expect(v.getCell("H9").value).toBe(900); // 1000 − 10 %
    expect(v.getCell("H10").value).toBe(1801); // 2001 − 10 % = 1800,9 → 1801
    expect(v.getCell("I9").value.formula).toBe("G9*H9");
    expect(v.getCell("E12").value).toBe("Уборка мусора 10%");
    expect(v.getCell("I12").value.formula).toBe("ROUND(SUM(I9:I11)*10/90,0)");
    expect(v.getCell("E13").value).toBe("Итого:");
    expect(v.getCell("I13").value.formula).toBe("SUM(I9:I11)+I12");
    // сумма по строкам 15,5×900 + 8×1801 + 10×900 = 37 358; 10 % от исходных = 37 358 / 9 = 4 150,9 → 4151
    expect(v.getCell("I12").value.result).toBe(4151);

    const g = workbook.getWorksheet("ГПР БЛОК 1");
    // три вида работ блока (этажей в графике нет): оклейка, линолеум
    expect(g.getCell("B10").value).toBe("Оклейка стен обоями");
    expect(g.getCell("B11").value).toBe("Устройство линолеума");
    expect(g.getCell("B12").value).toBeNull();
    expect(g.getCell("C10").value.toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(g.getCell("D11").value.toISOString().slice(0, 10)).toBe("2026-06-30");
    expect(g.conditionalFormattings.length).toBeGreaterThan(0);

    const buf = await workbook.xlsx.writeBuffer();
    expect(buf.byteLength).toBeGreaterThan(5000);
  });
});
