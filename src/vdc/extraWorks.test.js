import { elementsInContour, EXTRA_WORKS, extraWorkLines } from "./extraWorks";
import { pointInPolygon } from "./doors";

describe("дополнительные работы по квартире", () => {
  it("расценки с НДС заданы заказчиком", () => {
    expect(Object.fromEntries(EXTRA_WORKS.map((w) => [w.key, w.priceVat]))).toEqual({ vent: 696, hatch: 2320, holes: 1160, windows: 2000, blocks: 3000 });
  });

  it("строки работ: количество × цена с НДС, нулевые не добавляются", () => {
    const lines = extraWorkLines({ vent: "3", hatch: 1, holes: "0", windows: 4, blocks: "2" });
    expect(lines.map((l) => [l.work, l.qty, l.priceVat, l.sum])).toEqual([
      ["Установка вентиляционных решёток", 3, 696, 2088],
      ["Установка ревизионного люка", 1, 2320, 2320],
      ["Устройство оконных откосов, балконных дверей: черновой + чистовой слой", 4, 2000, 8000],
      ["Устройство откосов балконных блоков (дверь + окно): черновой + чистовой слой", 2, 3000, 6000],
    ]);
    expect(lines[0].priceNoVat).toBe(600); // 696 / 1,16
    // балконный блок без окна считается по расценке окна: окна 4 + блоков без окна 2 → 6 шт по 2 000
    const withNo = extraWorkLines({ windows: 4, blocksNo: "2", blocks: 1 });
    expect(withNo.map((l) => [l.qty, l.priceVat])).toEqual([[6, 2000], [1, 3000]]);
    expect(extraWorkLines({ blocksNo: 3 }).map((l) => [l.work.slice(0, 22), l.qty])).toEqual([["Устройство оконных отк", 3]]);
    expect(extraWorkLines({})).toEqual([]);
  });

  it("окна и балконные блоки — по меткам внутри контура", () => {
    const sq = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
    const items = [
      { str: "ОК-4", x: 2, y: 4, w: 4, h: 4 },
      { str: "ОК-4н", x: 8, y: 4, w: 4, h: 4 },
      { str: "ББ-1", x: 12, y: 10, w: 4, h: 4 },
      { str: "ОК-5", x: 50, y: 4, w: 4, h: 4 }, // вне контура
      { str: "Д-1", x: 4, y: 4, w: 4, h: 4 }, // не окно
    ];
    const r = elementsInContour(items, sq, pointInPolygon);
    expect([r.windows, r.blocks]).toEqual([2, 1]);
    expect(r.found.map((f) => f.label)).toEqual(["ОК-4", "ОК-4н", "ББ-1"]);
    expect(elementsInContour(items, sq.slice(0, 2), pointInPolygon).windows).toBe(0);
  });
});
