import { buildDoorDirectory, countPlanMarks, DEFAULT_DOOR_SPLIT, doorsInContour, doorWorkLines, interiorCheck, parseDoorSpec, perFloorByCategory, pointInPolygon, splitIsValid, suggestCategory, summarizeDoors } from "./doors";
import spec24 from "./__fixtures__/doors-spec-p24.json";
import p11 from "./__fixtures__/doors-plan-p11.json";
import p12 from "./__fixtures__/doors-plan-p12.json";
import p13 from "./__fixtures__/doors-plan-p13.json";

const plans = [
  { page: 11, floors: [1], items: p11.items },
  { page: 12, floors: [2, 3, 4, 5, 6], items: p12.items },
  { page: 13, floors: [7, 8, 9], items: p13.items },
];

describe("двери: справочник из спецификации лист 24", () => {
  const spec = parseDoorSpec(spec24.items);
  const by = Object.fromEntries(spec.map((s) => [s.mark, s]));

  it("находит все марки Д-1…Д-23 один раз, а не дубли из «Ведомости проёмов»", () => {
    expect(spec.map((s) => s.no)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it("стандарт и количество на секцию читаются из строки спецификации", () => {
    expect(by["Д-1"].standard).toMatch(/6629/);
    expect(by["Д-1"].qtyPerSection).toBe(54);
    expect(by["Д-1"].qtyTotal).toBe(108);
    expect(by["Д-9"].standard).toMatch(/31173/);
    expect(by["Д-9"].qtyPerSection).toBe(18);
    expect(by["Д-9"].width).toBe(970);
    expect(by["Д-11"].width).toBe(1310);
    expect(by["Д-20"].standard).toMatch(/2110/);
  });

  it("метки на плане считаются по этажам", () => {
    expect(countPlanMarks(p11.items)["Д-1"]).toBe(6);
    expect(countPlanMarks(p12.items)["Д-9"]).toBe(2);
  });

  it("количество по планам × этажи совпадает со спецификацией на секцию для квартирных дверей", () => {
    const dir = buildDoorDirectory(spec, plans);
    const d = Object.fromEntries(dir.map((x) => [x.mark, x]));
    for (const mark of ["Д-1", "Д-2", "Д-3", "Д-4", "Д-5", "Д-6", "Д-7", "Д-8", "Д-9", "Д-10"]) {
      expect(d[mark].planQty).toBe(d[mark].qtyPerSection);
      expect(d[mark].status).toBe("ok");
    }
    // двери подвала/чердака на типовых этажах не стоят
    expect(d["Д-20"].status).toBe("off-plan");
  });

  it("категории: ГОСТ 6629 — межкомнатные, Д-9/Д-10 — входные квартирные, Д-11…Д-14 — входной группы, ДПС — противопожарные", () => {
    const dir = buildDoorDirectory(spec, plans);
    const cat = Object.fromEntries(dir.map((x) => [x.mark, x.category]));
    expect(["Д-1", "Д-2", "Д-3", "Д-4", "Д-5", "Д-6", "Д-7", "Д-8"].map((m) => cat[m])).toEqual(Array(8).fill("interior"));
    expect(cat["Д-9"]).toBe("entrance");
    expect(cat["Д-10"]).toBe("entrance");
    expect(cat["Д-11"]).toBe("group");
    expect(cat["Д-13"]).toBe("group");
    expect(cat["Д-20"]).toBe("fire");
    expect(cat["Д-18"]).toBe("other"); // стальная, но на типовых этажах её нет
  });

  it("входных дверей на этаже столько же, сколько квартир (4)", () => {
    const dir = buildDoorDirectory(spec, plans);
    const entrance = perFloorByCategory(dir, 11).entrance;
    expect(Object.values(entrance).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("suggestCategory без данных — «прочая»", () => {
    expect(suggestCategory({})).toBe("other");
  });
});

describe("двери: створки и подсчёт по контуру квартиры", () => {
  const spec = parseDoorSpec(spec24.items);
  const dir = buildDoorDirectory(spec, plans);
  const leaves = Object.fromEntries(dir.map((d) => [d.mark, d.leaves]));

  it("число створок из названия: Д-1…Д-6 (700–900 мм) однопольные, Д-7 и Д-8 («ДО 21-13», 1300 мм) двупольные", () => {
    expect(["Д-1", "Д-2", "Д-3", "Д-4", "Д-5", "Д-6"].map((m) => leaves[m])).toEqual([1, 1, 1, 1, 1, 1]);
    expect(leaves["Д-7"]).toBe(2);
    expect(leaves["Д-8"]).toBe(2);
    expect(leaves["Д-11"]).toBe(2); // 2100×1310
    expect(leaves["Д-9"]).toBe(1);
  });

  it("точка внутри контура", () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
  });

  it("двери внутри контура считаются по категориям и створкам", () => {
    const items = [
      { str: "Д-1", x: 2, y: 4, w: 4, h: 4 }, // центр (4, 2)
      { str: "Д-7", x: 2, y: 8, w: 4, h: 4 }, // двупольная
      { str: "Д-9", x: 6, y: 9, w: 4, h: 4 }, // входная
      { str: "Д-1", x: 50, y: 4, w: 4, h: 4 }, // вне контура
      { str: "Д-99", x: 4, y: 4, w: 4, h: 4 }, // нет в справочнике
    ];
    const contour = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
    const found = doorsInContour(items, contour, dir);
    expect(found.map((d) => d.mark).sort()).toEqual(["Д-1", "Д-7", "Д-9"]);
    expect(summarizeDoors(found)).toEqual({ entrance: 1, single: 1, double: 1 });
    expect(doorsInContour(items, contour.slice(0, 2), dir)).toEqual([]);
  });
});

describe("работы по дверям для ВДЦ", () => {
  const thr = { no: "2.11", name: "Устройство декоративных порожков", unit: "м.п", priceVat: 1276, priceNoVat: 1100 };

  it("декоративные порожки: 0,9 м.п на каждую дверь (входная и все межкомнатные), расценка из базы", () => {
    const lines = doorWorkLines({ code: "1" }, { entrance: 1, interior: { 1: { single: "4", double: "1" } }, split: DEFAULT_DOOR_SPLIT, threshold: "0,9" }, rate, thr);
    const t = lines.find((l) => l.work === "Устройство декоративных порожков");
    expect(t.qty).toBe(5.4); // 6 дверей × 0,9
    expect(t.unit).toBe("м.п");
    expect(t.priceVat).toBe(1276);
    expect(t.sum).toBe(6890.4);
    expect(doorWorkLines({ code: "1" }, { entrance: 1, interior: {}, split: DEFAULT_DOOR_SPLIT, threshold: "0" }, rate, thr)).toHaveLength(1);
    expect(doorWorkLines({ code: "1" }, { entrance: 1, interior: {}, split: DEFAULT_DOOR_SPLIT, threshold: "0,9" }, rate, null)).toHaveLength(1);
  });
  const rate = { no: "2.7", name: "Установка двери (…)", unit: "шт", priceVat: 19720, priceNoVat: 17000 };

  it("входная — одна строка по полной расценке; межкомнатные — все три работы отдельно для однопольных и двупольных", () => {
    const lines = doorWorkLines({ code: "1" }, { entrance: 1, interior: { 1: { single: "5", double: "1" } }, split: DEFAULT_DOOR_SPLIT }, rate);
    expect(lines.map((l) => [l.work, l.qty, l.priceVat])).toEqual([
      ["Установка входной двери", 1, 19720],
      ["Устройство однопольных межкомнатных дверей", 5, 11832],
      ["Устройство двупольных межкомнатных дверей", 1, 11832],
      ["Устройство дверных откосов однопольных межкомнатных дверей", 5, 3944],
      ["Устройство дверных откосов двупольных межкомнатных дверей", 1, 3944],
      ["Монтаж замков, защёлок, ручек однопольных межкомнатных дверей", 5, 3944],
      ["Монтаж замков, защёлок, ручек двупольных межкомнатных дверей", 1, 3944],
    ]);
  });

  it("строки без дверей не добавляются; одни однопольные — без строки двупольных", () => {
    const lines = doorWorkLines({ code: "1" }, { entrance: 0, interior: { 1: { single: 4, double: 0 } }, split: DEFAULT_DOOR_SPLIT }, rate);
    expect(lines.map((l) => l.work)).toEqual([
      "Устройство однопольных межкомнатных дверей", "Устройство дверных откосов однопольных межкомнатных дверей", "Монтаж замков, защёлок, ручек однопольных межкомнатных дверей",
    ]);
  });

  it("процент можно менять; если сумма не 100 % — межкомнатные не добавляются", () => {
    const ok = doorWorkLines({ code: "1" }, { entrance: 0, interior: { 1: { single: 2 } }, split: { door: "50", slopes: "30", locks: "20" } }, rate);
    expect(ok.map((l) => l.priceVat)).toEqual([9860, 5916, 3944]);
    expect(splitIsValid({ door: "50", slopes: "30", locks: "30" })).toBe(false);
    expect(doorWorkLines({ code: "1" }, { entrance: 1, interior: { 1: { single: 2 } }, split: { door: "50", slopes: "30", locks: "30" } }, rate)).toHaveLength(1);
  });

  it("входных на тип квартиры берётся из подсчёта по контуру, иначе общее число", () => {
    const s = { entrance: 1, entranceByType: { 2: 0 }, interior: {}, split: DEFAULT_DOOR_SPLIT };
    expect(doorWorkLines({ code: "1" }, s, rate)).toHaveLength(1);
    expect(doorWorkLines({ code: "2" }, s, rate)).toHaveLength(0);
  });

  it("сверка по этажам: сколько межкомнатных на плане и сколько по числам типов", () => {
    const flats = [{ code: "1" }, { code: "2" }];
    const items = [{ str: "Д-1" }, { str: "Д-2" }, { str: "Д-1" }, { str: "Д-9" }];
    const plans2 = [{ page: 11, floors: [1, 2], items, flats }];
    expect(interiorCheck(plans2, ["Д-1", "Д-2"], { 1: { single: "2" }, 2: { single: "1", double: "0" } })).toEqual([{ page: 11, floors: [1, 2], onPlan: 3, byInput: 3 }]);
  });
});
