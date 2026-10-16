import {
  buildStatement, measurementQuantity, metersPerUnitFromDistance, metersPerUnitFromScale, polygonArea, polylineLength,
} from "./model";

const sq = (s) => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];

test("геометрия: площадь и длина", () => {
  expect(polygonArea(sq(10))).toBe(100);
  expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
});

test("калибровка: по размеру и по масштабу листа", () => {
  expect(metersPerUnitFromDistance(200, 5)).toBe(0.025); // 200 ед. = 5 м
  // 1:100: 72 пункта = 1 дюйм на бумаге = 2,54 м в натуре
  expect(metersPerUnitFromScale(100) * 72).toBeCloseTo(2.54, 10);
});

test("количество: площадь, стены по высоте, объём, вычет, одинаковые", () => {
  const k = 0.05; // 1 ед. = 5 см -> квадрат 100 ед. = 5 × 5 м
  const room = { kind: "area", calc: "area", points: sq(100), page: 1 };
  expect(measurementQuantity(room, k)).toBeCloseTo(25);
  expect(measurementQuantity({ ...room, calc: "perimeter" }, k)).toBeCloseTo(20);
  expect(measurementQuantity({ ...room, calc: "volume", thickness: 0.05 }, k)).toBeCloseTo(1.25);
  expect(measurementQuantity({ ...room, calc: "volume" }, k)).toBeNull(); // без толщины
  const walls = { kind: "line", calc: "wall", points: [...sq(100), { x: 0, y: 0 }], height: 2.7 };
  expect(measurementQuantity(walls, k)).toBeCloseTo(54); // 20 м × 2,7
  expect(measurementQuantity({ ...walls, height: 0 }, k)).toBeNull();
  expect(measurementQuantity({ ...room, deduct: true }, k)).toBeCloseTo(-25);
  expect(measurementQuantity({ ...room, count: 3 }, k)).toBeCloseTo(75);
  expect(measurementQuantity(room, null)).toBeNull(); // страница не откалибрована
});

test("стены по плану минус двери и окна (вычет линией по ширине проёма); высота из поля ввода", () => {
  const k = 0.05; // 1 ед. = 5 см
  const walls = { id: "w", page: 1, kind: "line", calc: "wall", work: "Штукатурка стен", points: [...sq(100), { x: 0, y: 0 }], height: "2,7" };
  const door = { id: "d", page: 1, kind: "line", calc: "wall", work: "Штукатурка стен", points: [{ x: 0, y: 0 }, { x: 18, y: 0 }], height: "2,1", deduct: true }; // 0,9 м
  const windows = { id: "o", page: 1, kind: "line", calc: "wall", work: "Штукатурка стен", points: [{ x: 0, y: 0 }, { x: 30, y: 0 }], height: "1.5", deduct: true, count: 2 }; // 2 × 1,5 × 1,5
  expect(measurementQuantity(door, k)).toBeCloseTo(-1.89);
  expect(buildStatement([walls, door, windows], { 1: k }).rows).toEqual([
    { work: "Штукатурка стен", unit: "м²", quantity: 47.61 }, // 54 − 1,89 − 4,5
  ]);
});

test("ведомость: итог по виду работ с вычетами; неоткалиброванные — в пропущенных", () => {
  const k = 0.05;
  const measurements = [
    { id: "1", page: 1, kind: "line", calc: "wall", work: "Штукатурка стен", room: "Кухня", points: [...sq(100), { x: 0, y: 0 }], height: 2.7 },
    { id: "2", page: 1, kind: "area", calc: "area", work: "Штукатурка стен", room: "Кухня", points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }], deduct: true }, // окно 1,5 × 2
    { id: "3", page: 1, kind: "area", calc: "area", work: "Укладка ламината", room: "Кухня", points: sq(100) },
    { id: "4", page: 2, kind: "area", calc: "area", work: "Укладка ламината", room: "Спальня", points: sq(100) },
  ];
  const { rows, details, skipped } = buildStatement(measurements, { 1: k });
  expect(rows).toEqual([
    { work: "Укладка ламината", unit: "м²", quantity: 25 },
    { work: "Штукатурка стен", unit: "м²", quantity: 51 }, // 54 - 3
  ]);
  expect(details).toHaveLength(3);
  expect(skipped.map((m) => m.id)).toEqual(["4"]);
});
