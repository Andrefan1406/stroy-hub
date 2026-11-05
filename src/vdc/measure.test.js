import { findCeilingHeight, parseManual, suggestScale, taskTotal } from "./measure";
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
