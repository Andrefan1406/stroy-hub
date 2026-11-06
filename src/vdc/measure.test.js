import { OPENING_TYPES, findCeilingHeight, parseManual, suggestScale, taskTotal } from "./measure";
import { findAxisRows } from "./plan";
import { metersPerUnitFromDistance, metersPerUnitFromScale } from "../takeoff/model";
import plan11 from "./__fixtures__/plan-p11.json";

describe("масштаб листа по размеру между осями", () => {
  it("на плане 1-го этажа: 1:100 по размеру 26 800 мм между осями 1 и 11 (а не 1:200 по 54 400)", () => {
    const rows = findAxisRows(plan11.items, 500);
    const s = suggestScale(plan11.items, rows[0].labels);
    expect(s).toEqual({ scale: 100, dimensionMm: 26800 });
  });

  it("без осей или без размеров — предложения нет", () => {
    expect(suggestScale(plan11.items, [])).toBeNull();
    expect(suggestScale([{ str: "Кухня", x: 1, y: 1 }], [{ value: 1, x: 0 }, { value: 2, x: 100 }])).toBeNull();
  });
});

describe("высота помещений из общих данных", () => {
  it("«Высота от пола до потолка - 2,72 м»", () => {
    expect(findCeilingHeight([{ page: 3, text: "Высота этажа 3,0 м; Высота от пола до потолка 2,72 м; Для вентиляции" }])).toEqual({ value: 2.72, page: 3 });
    expect(findCeilingHeight([{ page: 1, text: "ничего подходящего" }])).toBeNull();
  });
});

describe("замеры → количество", () => {
  // 1 пункт PDF на бумаге = 0,3528 мм; при масштабе 1:100 — 0,0353 м
  const mpu = metersPerUnitFromScale(100);
  const line = (points, page = 11) => ({ id: "a", page, points });

  it("длина линии по калибровке листа", () => {
    const l = line([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]); // 150 пунктов
    const r = taskTotal([l], { 11: mpu }, { kind: "plinth" });
    expect(r.total).toBeCloseTo(150 * mpu, 2);
    expect(r.uncounted).toBe(0);
  });

  it("стены: длина × высота; без высоты не считается", () => {
    const l = line([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(taskTotal([l], { 11: mpu }, { kind: "walls", height: "2,72" }).total).toBeCloseTo(100 * mpu * 2.72, 2);
    expect(taskTotal([l], { 11: mpu }, { kind: "walls", height: "" })).toMatchObject({ total: 0, uncounted: 1 });
  });

  it("лист без калибровки не даёт количества", () => {
    const l = line([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(taskTotal([l], {}, { kind: "plinth" })).toMatchObject({ total: 0, uncounted: 1 });
  });

  it("калибровка по известному размеру: 3200 мм между осями", () => {
    const k = metersPerUnitFromDistance(91, 3.2);
    const l = line([{ x: 0, y: 0 }, { x: 91, y: 0 }]);
    expect(taskTotal([l], { 11: k }, { kind: "plinth" }).total).toBe(3.2);
  });

  it("ручной ввод: запятая и точка, мусор и ноль не принимаются", () => {
    expect(parseManual("12,5")).toBe(12.5);
    expect(parseManual(" 7.25 ")).toBe(7.25);
    expect(parseManual("")).toBeNull();
    expect(parseManual("abc")).toBeNull();
    expect(parseManual("0")).toBeNull();
  });
});

describe("проёмы: вычет из площади стен и длины плинтуса", () => {
  const mpu = metersPerUnitFromScale(100);
  const wall = { id: "w", page: 11, points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] }; // 400 пунктов ≈ 14,11 м
  const door = { id: "d", page: 11, deduct: true, height: "2,1", points: [{ x: 0, y: 0 }, { x: 25, y: 0 }] }; // 25 пунктов ≈ 0,88 м
  const win = { id: "o", page: 11, deduct: true, height: "1,5", points: [{ x: 0, y: 0 }, { x: 50, y: 0 }] }; // 50 пунктов ≈ 1,76 м

  it("стены: длина × высота минус ширина × высота каждого проёма", () => {
    const r = taskTotal([wall, door, win], { 11: mpu }, { kind: "walls", height: "2,72" });
    const grossExpected = 400 * mpu * 2.72;
    const deductExpected = 25 * mpu * 2.1 + 50 * mpu * 1.5;
    expect(r.gross).toBeCloseTo(grossExpected, 2);
    expect(r.deducted).toBeCloseTo(deductExpected, 2);
    expect(r.total).toBeCloseTo(grossExpected - deductExpected, 1);
    expect(r.uncounted).toBe(0);
  });

  it("у каждого проёма своя высота; проём без высоты не считается и помечается", () => {
    const noHeight = { ...door, id: "x", height: "" };
    const r = taskTotal([wall, noHeight], { 11: mpu }, { kind: "walls", height: "2,72" });
    expect(r.deducted).toBe(0);
    expect(r.uncounted).toBe(1);
  });

  it("плинтус: проём вычитает только ширину", () => {
    const r = taskTotal([wall, door], { 11: mpu }, { kind: "plinth" });
    expect(r.gross).toBeCloseTo(400 * mpu, 2);
    expect(r.deducted).toBeCloseTo(25 * mpu, 2);
    expect(r.total).toBeCloseTo(375 * mpu, 1);
  });

  it("проёмов больше стен — итог не уходит в минус", () => {
    const big = { ...win, points: [{ x: 0, y: 0 }, { x: 900, y: 0 }] };
    expect(taskTotal([wall, big], { 11: mpu }, { kind: "walls", height: "2,72" }).total).toBe(0);
  });

  it("одно лишь число типов проёмов: у витража высоту нужно указать", () => {
    expect(OPENING_TYPES.door.height).toBe("2,1");
    expect(OPENING_TYPES.glazing.height).toBe("");
  });
});
