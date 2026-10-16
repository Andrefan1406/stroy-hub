import {
  buildStatement, measurementQuantity, metersPerUnitFromDistance, metersPerUnitFromScale, polygonArea, polylineLength,
} from "./model";
import {
  buildMasonryStatement, effectiveHeight, importOpenings, masonryMeasure, materialUse, placeRect, rectQuantity, wallQuantity,
} from "./masonry";
import {
  angleOf, applyT, guessTransform, invertT, pageMapConflicts, scaleOf, similarityFromPairs, transferProject, transformedBounds,
} from "./revision";

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

// --- каменная кладка (masonry.js) ---

const mk = (name, unit, method, thickness, materialName, materialUnit, materialRate, countOpenings) => ({
  version: 1, name, groupName: "Каменная кладка", groupSort: 1, unit, method, thickness, materialName, materialUnit, materialRate,
  workPrice: null, materialPrice: null, countOpenings,
});
const W = {
  partition: mk("Кирпичная кладка перегородок толщиной 120 мм", "м²", "wall_length", 0.12, "Кирпич", "шт", 40, true),
  brick250: mk("Кирпичная кладка стен толщиной 250 мм", "м³", "wall_length", 0.25, "Кирпич", "шт", 305, true),
  gas200: mk("Кладка стен из газоблока толщиной 200 мм", "м³", "wall_length", 0.2, "Газоблок", "м³", 1.05, true),
  pgp: mk("Кладка стен из пазогребневых плит", "м²", "wall_length", null, "Пазогребневая плита", "шт", 3, true),
  shaft: mk("Кладка вентшахт", "м³", "rect_channels", null, "Кирпич", "шт", 305, false),
};

test("перегородка 120 мм: 5 × 3 м минус дверь 0,8 × 2,1 → 13,32 м², кирпич 532,8 (в ведомости 533)", () => {
  const r = wallQuantity({ length: 5, height: 3, unit: "м²", countOpenings: true, openings: [{ width: 0.8, height: 2.1, qty: 1 }] });
  expect(r.quantity).toBeCloseTo(13.32, 10);
  expect(materialUse(r.quantity, W.partition)).toBeCloseTo(532.8, 10);

  // То же через замер на листе: 1 ед. = 5 см, линия 100 ед. = 5 м, этаж 3 м, дверь из ведомости.
  const k = 0.05;
  const openings = [{ id: "d1", mark: "Д-1", type: "door", width: 0.8, height: 2.1, qty: 1 }];
  const wall = { id: "w", page: 1, kind: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], workId: "p", snapshot: W.partition, floorId: "f1", openings: [{ openingId: "d1", qty: 1 }] };
  const st = buildMasonryStatement([wall], { calibrations: { 1: k }, floors: [{ id: "f1", height: 3 }], openings });
  expect(st.rows[0].quantity).toBeCloseTo(13.32, 10);
  expect(st.rows[0].materialExact).toBeCloseTo(532.8, 10);
  expect(st.rows[0].material).toBe(533);
});

test("стена 250 мм: 10 × 3 м без проёмов → 7,5 м³, кирпич 2287,5", () => {
  const r = wallQuantity({ length: 10, height: 3, thickness: 0.25, unit: "м³", countOpenings: true });
  expect(r.quantity).toBeCloseTo(7.5, 10);
  expect(materialUse(r.quantity, W.brick250)).toBeCloseTo(2287.5, 10);
});

test("стена 250 мм с дверью 0,9 × 2,1 → 7,0275 м³, кирпич ≈ 2143,39", () => {
  const r = wallQuantity({ length: 10, height: 3, thickness: 0.25, unit: "м³", countOpenings: true, openings: [{ width: 0.9, height: 2.1, qty: 1 }] });
  expect(r.quantity).toBeCloseTo(7.0275, 10);
  expect(materialUse(r.quantity, W.brick250)).toBeCloseTo(2143.39, 2);
});

test("газоблок 200 мм: 6 × 3 м → 3,6 м³, газоблок 3,78 м³", () => {
  const r = wallQuantity({ length: 6, height: 3, thickness: 0.2, unit: "м³", countOpenings: true });
  expect(r.quantity).toBeCloseTo(3.6, 10);
  expect(materialUse(r.quantity, W.gas200)).toBeCloseTo(3.78, 10);
});

test("пазогребень: 4 × 3 м → 12 м², 36 шт", () => {
  const r = wallQuantity({ length: 4, height: 3, unit: "м²", countOpenings: true });
  expect(r.quantity).toBeCloseTo(12, 10);
  expect(materialUse(r.quantity, W.pgp)).toBeCloseTo(36, 10);
  // Штучное в ведомости не должно округлиться до 37 из-за погрешности float.
  const k = 0.05;
  const wall = { id: "w", page: 1, kind: "line", points: [{ x: 0, y: 0 }, { x: 80, y: 0 }], workId: "pgp", snapshot: W.pgp, height: "3", heightOverride: true };
  expect(buildMasonryStatement([wall], { calibrations: { 1: k } }).rows[0].material).toBe(36);
});

test("вентшахта 0,77 × 0,51 с каналом 0,27 × 0,14, высота 3 м → 1,0647 м³, кирпич ≈ 324,73", () => {
  const r = rectQuantity({ outer: { w: 0.77, h: 0.51 }, channels: [{ w: 0.27, h: 0.14 }], height: 3, unit: "м³" });
  expect(r.quantity).toBeCloseTo(1.0647, 10);
  expect(materialUse(r.quantity, W.shaft)).toBeCloseTo(324.73, 2);

  // На листе: 1 ед. = 1 см; канал внутри шахты привязывается к ней, за границей — ошибка.
  const shaft = { id: "s", page: 1, kind: "rect", points: [{ x: 0, y: 0 }, { x: 77, y: 51 }], channels: [] };
  const channel = [{ x: 10, y: 10 }, { x: 37, y: 24 }];
  expect(placeRect(channel, [shaft])).toEqual({ channelOf: "s" });
  expect(placeRect([{ x: 70, y: 10 }, { x: 90, y: 20 }], [shaft]).error).toMatch(/за границы/);
  expect(placeRect([{ x: 100, y: 100 }, { x: 150, y: 150 }], [shaft])).toEqual({ shaft: true });
  const m = { ...shaft, channels: [channel], workId: "sh", snapshot: W.shaft, height: "3", heightOverride: true, count: 2 };
  expect(masonryMeasure(m, { metersPerUnit: 0.01 }).quantity).toBeCloseTo(2 * 1.0647, 10); // × одинаковых
});

test("вентшахта без каналов 0,77 × 0,51, высота 3 м → 1,1781 м³", () => {
  expect(rectQuantity({ outer: { w: 0.77, h: 0.51 }, height: 3, unit: "м³" }).quantity).toBeCloseTo(1.1781, 10);
});

test("ручная высота замера не меняется при смене высоты этажа в общих данных", () => {
  const manual = { floorId: "f1", height: "2,8", heightOverride: true };
  const byFloor = { floorId: "f1", height: "2,8" };
  expect(effectiveHeight(manual, [{ id: "f1", height: 3 }])).toBe(2.8);
  expect(effectiveHeight(manual, [{ id: "f1", height: "3,3" }])).toBe(2.8);
  expect(effectiveHeight(byFloor, [{ id: "f1", height: "3,3" }])).toBe(3.3);
});

test("импорт проёмов: та же марка обновляется, а не дублируется", () => {
  let n = 0;
  const id = () => `o${++n}`;
  const first = importOpenings([], "manual", [{ mark: "Д-1", type: "door", width: "0,8", height: "2,1", qty: 4 }, { mark: "ОК-2", type: "window", width: 1.5, height: 1.5, qty: 6 }], id);
  expect(first).toMatchObject({ added: 2, updated: 0 });
  const second = importOpenings(first.openings, "spec", [{ mark: " д-1 ", type: "door", width: 0.9, height: 2.1, qty: 5 }], id);
  expect(second).toMatchObject({ added: 0, updated: 1 });
  expect(second.openings).toHaveLength(2);
  expect(second.openings[0]).toEqual({ id: "o1", mark: "д-1", type: "door", width: 0.9, height: 2.1, qty: 5, source: "spec" });
});

test("проёмы не вычитаются, если у работы «учитывать проёмы» = нет; отрицательный объём — предупреждение", () => {
  const op = [{ width: 0.9, height: 2.1, qty: 1 }];
  expect(wallQuantity({ length: 10, height: 3, unit: "м²", countOpenings: false, openings: op }).quantity).toBeCloseTo(30, 10);
  const r = wallQuantity({ length: 1, height: 2, unit: "м²", countOpenings: true, openings: [{ width: 2, height: 2.1, qty: 1 }] });
  expect(r.quantity).toBe(0);
  expect(r.warnings[0]).toMatch(/Проёмов больше/);
});

// --- новая редакция чертежа (revision.js) ---

test("совмещение по двум точкам: сдвиг, поворот 90°, масштаб 2; обратное преобразование", () => {
  const t = similarityFromPairs({ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 5, y: 0 }, { x: 10, y: 30 });
  expect(scaleOf(t)).toBeCloseTo(2, 10);
  expect(angleOf(t)).toBeCloseTo(90, 10);
  const p = applyT(t, { x: 3, y: 4 }); // (3,4) -> поворот (-4,3) -> ×2 (-8,6) -> +(10,20)
  expect(p.x).toBeCloseTo(2, 10);
  expect(p.y).toBeCloseTo(26, 10);
  const back = applyT(invertT(t), p);
  expect(back.x).toBeCloseTo(3, 10);
  expect(back.y).toBeCloseTo(4, 10);
  expect(similarityFromPairs({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 })).toBeNull();
});

test("перенос на новую редакцию: объёмы и метры не меняются, листы переставляются", () => {
  const k = 0.05;
  const wall = { id: "w", page: 2, kind: "line", calc: "wall", work: "Штукатурка стен", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], height: 3 };
  const room = { id: "r", page: 2, kind: "area", calc: "area", work: "Стяжка", points: sq(100) };
  const shaft = { id: "s", page: 2, kind: "rect", points: [{ x: 0, y: 0 }, { x: 77, y: 51 }], channels: [[{ x: 10, y: 10 }, { x: 37, y: 24 }]], workId: "sh", snapshot: W.shaft, height: "3", heightOverride: true };
  const door = { id: "d", page: 2, kind: "line", role: "opening", wallId: "gone", points: [{ x: 0, y: 0 }, { x: 18, y: 0 }] };
  const other = { id: "o", page: 5, kind: "area", calc: "area", work: "Стяжка", points: sq(10) };
  // Новый лист 3: чертёж повёрнут на 90°, уменьшен вдвое и сдвинут.
  const t = similarityFromPairs({ x: 0, y: 0 }, { x: 300, y: 50 }, { x: 100, y: 0 }, { x: 300, y: 100 });
  const res = transferProject({ measurements: [wall, room, shaft, door, other], calibrations: { 2: k, 5: k } }, { pageMap: { 2: 3, 5: null }, transforms: { 2: t } });
  expect(res.calibrations).toEqual({ 3: k / 0.5 });
  expect(res.dropped.map((m) => m.id).sort()).toEqual(["d", "o"]);
  const byId = Object.fromEntries(res.measurements.map((m) => [m.id, m]));
  expect(byId.w.page).toBe(3);
  expect(measurementQuantity(byId.w, res.calibrations[3])).toBeCloseTo(15, 10); // 5 м × 3 м
  expect(measurementQuantity(byId.r, res.calibrations[3])).toBeCloseTo(25, 10);
  expect(masonryMeasure(byId.s, { metersPerUnit: 0.01 / 0.5 }).quantity).toBeCloseTo(1.0647, 10);
  expect(placeRect(byId.s.channels[0], [{ ...byId.s, channels: [] }])).toEqual({ channelOf: "s" }); // канал остался внутри
  expect(pageMapConflicts({ 1: 2, 3: 2, 4: null })).toEqual([2]);
});

test("начальное совмещение по размеру листа: тот же чертёж на листе другого формата", () => {
  const t = guessTransform({ width: 842, height: 595 }, { width: 303.12, height: 214.2 });
  expect(scaleOf(t)).toBeCloseTo(0.36, 3);
  expect(guessTransform({ width: 842, height: 595 }, { width: 842, height: 595 })).toBeNull(); // тот же размер
  expect(guessTransform({ width: 842, height: 595 }, { width: 595, height: 842 })).toBeNull(); // другие пропорции
  expect(transformedBounds({ width: 100, height: 50 }, t)).toEqual({ x0: 0, y0: 0, x1: 100 * t.a, y1: 50 * t.a });
});
