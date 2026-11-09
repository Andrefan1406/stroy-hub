import { parseExplication } from "./explication";
import { parseFinishing, parseLegend, parseCommonFloors } from "./finishing";
import { buildCommonRows } from "./blocks";
import { collectMeasureTasks, stairCounts, worksForFlat } from "./works";
import { taskTotal } from "./measure";
import p11 from "./__fixtures__/expl-p11.json";
import p12 from "./__fixtures__/expl-p12.json";
import finishingFixture from "./__fixtures__/finishing-p5.json";

const e11 = { page: 11, ...parseExplication(p11.items) };
const e12 = { page: 12, ...parseExplication(p12.items) };

describe("общие помещения в экспликации", () => {
  it("читает номер, название и площадь общих помещений этажа", () => {
    expect(e11.commonRooms).toEqual([
      { no: "13", name: "Внеквартирный коридор", area: 24.48 },
      { no: "14", name: "Лифтовой холл", area: 8.97 },
    ]);
    expect(e12.commonRooms).toEqual([
      { no: "13", name: "Внеквартирный коридор", area: 24.48 },
      { no: "14а", name: "Лифтовой холл", area: 15.37 },
    ]);
  });
});

describe("общие помещения в ведомости отделки", () => {
  it("находит группу «общее имущество» и этажи в её названии", () => {
    expect(parseCommonFloors("Помещения являющиеся общим имуществом 1-9 этаж")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const { common } = parseFinishing(finishingFixture.items);
    expect(common).toHaveLength(1);
    expect(common[0].floors).toHaveLength(9);
    const r13 = common[0].rooms.find((r) => r.room === "13");
    expect(r13.ceiling).toMatchObject({ id: "1", flat: 220.32 });
    expect(common[0].rooms.some((r) => r.room.replace(/\s+/g, "") === "14а")).toBe(true);
  });
});

describe("строки «Лестница» и «МОП» по этажам", () => {
  const { common } = parseFinishing(finishingFixture.items);
  const legend = parseLegend(finishingFixture.items);
  const explications = [{ ...e11, floors: [1], scope: { kind: "section", id: null } }, { ...e12, floors: [2, 3, 4, 5, 6, 7, 8, 9], scope: { kind: "section", id: null } }];
  const { rows, warnings } = buildCommonRows({ sections: ["1", "2"], explications, common, legend });

  it("на каждом этаже каждой секции — группа МОП (лестницы в этих листах нет)", () => {
    expect(rows.every((r) => r.common && r.code === "mop" && r.label === "МОП")).toBe(true);
    expect(rows).toHaveLength(2 * 9);
    expect(warnings).toEqual([]);
  });

  it("площадь потолка — по экспликации, стены — площадь на секцию ÷ число этажей", () => {
    const f1 = rows.find((r) => r.section === "1" && r.floor === 1);
    const r13 = f1.rooms.find((r) => r.no === "13");
    expect(r13.ceiling.area).toBe(24.48);
    expect(r13.walls[0].area).toBe(Math.round((235.62 / 9 + Number.EPSILON) * 100) / 100);
    // холл 1 этажа (№14) есть только на одном этаже группы — делить не на что
    expect(f1.rooms.find((r) => r.no === "14").ceiling.area).toBe(8.97);
    const f2 = rows.find((r) => r.section === "1" && r.floor === 2);
    expect(f2.rooms.find((r) => r.no === "14а").ceiling.area).toBe(15.37);
  });
});

describe("работы для групп «МОП» и «Лестница»", () => {
  const rooms = [
    { no: "13", name: "Внеквартирный коридор", ceiling: { area: 24.48 }, walls: [{ area: 26.18 }, { area: 47.97 }] },
    { no: "14а", name: "Лифтовой холл", ceiling: { area: 15.37 }, walls: [{ area: 13.66 }] },
  ];
  const lineOf = (lines, part) => lines.find((l) => l.work.includes(part));

  it("МОП: пол по площади потолка, шпатлёвка раздельно по стенам и потолкам, окраска стен и потолков", () => {
    const { lines } = worksForFlat({ common: true, code: "mop", label: "МОП", rooms });
    const ceiling = 39.85;
    const walls = 87.81;
    expect(lineOf(lines, "керамогранитной")).toMatchObject({ rateNo: "2.3", qty: ceiling, note: "по площади потолка" });
    const plinth = lines.filter((l) => l.rateNo === "2.12");
    expect(plinth.map((l) => [l.roomNo, l.qty, l.need.kind])).toEqual([["13", null, "plinth"], ["14а", null, "plinth"]]); // по помещениям
    const rough = lines.filter((l) => l.rateNo === "2.1");
    expect(rough.map((l) => [l.work.includes("потолков"), l.qty])).toEqual([[false, walls], [true, ceiling]]);
    expect(lines.filter((l) => l.rateNo === "2.2")).toHaveLength(2);
    expect(lineOf(lines, "Декоративная окраска стен")).toMatchObject({ rateNo: "2.25", qty: walls, priceVat: 2100, sum: Math.round(walls * 2100 * 100) / 100 });
    expect(lineOf(lines, "потолков за 2 раза")).toMatchObject({ rateNo: "2.16", qty: ceiling });
  });

  it("обмер подступенков: ширина ступени × 0,15 м × число ступеней", () => {
    const line = { page: 1, kind: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], count: 9 };
    // 100 пунктов × 0,01 м = 1 м ширины; 1 × 0,15 × 9 = 1,35 м²
    expect(taskTotal([line], { 1: 0.01 }, { kind: "risers" }).total).toBe(1.35);
  });
});

describe("чердак, кровля и группы обмера", () => {
  const { common } = parseFinishing(finishingFixture.items);
  const legend = parseLegend(finishingFixture.items);
  const explications = [{ ...e11, floors: [1], scope: { kind: "section", id: null } }, { ...e12, floors: [2, 3], scope: { kind: "section", id: null } }];
  const { rows } = buildCommonRows({ sections: ["1"], explications, common, legend });

  it("коридор №13 одинаков на этажах — плинтус обмеряется один раз, холлы 1 этажа и типовых — отдельно", () => {
    const tasks = collectMeasureTasks(rows.map((r) => ({ ...r, works: worksForFlat(r) })));
    expect(tasks.filter((t) => t.kind === "plinth").map((t) => t.key)).toEqual(["mop|13|plinth", "mop|14|plinth", "mop|14а|plinth"]);
    // обмер 13 подставляется на все этажи
    const withValue = rows.map((r) => worksForFlat(r, { measured: { "mop|13|plinth": 30 } }).lines.find((l) => l.rateNo === "2.12" && l.roomNo === "13"));
    expect(withValue.every((l) => l.qty === 30)).toBe(true);
  });

  it("лестницы нет в этих листах — чердак и кровля не добавляются", () => {
    expect(rows.filter((r) => r.code === "stairs")).toHaveLength(0);
  });
});

describe("лестница: элементы (марши и площадки)", () => {
  const legend = parseLegend(finishingFixture.items);
  const withStairs = [{ ...e12, floors: [1, 2, 3, 4], scope: { kind: "section", id: null }, commonRooms: [{ no: "16", name: "Лестничная клетка", area: 14.25 }] }];
  const fin = [{ title: "x", floors: [1, 2, 3, 4], rooms: [{ room: "16", ceiling: { id: "1", flat: 57 }, walls: [{ id: "2", flat: 160 }] }] }];
  const rows = buildCommonRows({ sections: ["1"], explications: withStairs, common: fin, legend }).rows.filter((x) => x.code === "stairs");
  const floorLine = (row, measured) => worksForFlat(row, { measured }).lines.find((l) => l.rateNo === "2.3" && !l.work.endsWith("под лестницей"));

  it("уровни: 1 этаж, типовые, верхний этаж (малый марш), чердак и кровля", () => {
    expect(rows.map((r) => [r.levelLabel || r.floor, r.stairLevel])).toEqual([[1, "first"], [2, "mid"], [3, "mid"], [4, "last"], ["Чердак", "attic"], ["Кровля", "roof"]]);
    expect(rows[4].rooms).toHaveLength(1); // чердак — копия верхнего этажа
    expect(rows[5].rooms).toEqual([]);
  });

  it("сколько элементов на этаж: два марша, межэтажная и этажная площадки; на 1 этаже — всё под лестницей; наверху малый марш", () => {
    expect(stairCounts("mid")).toEqual({ flight: 2, mid: 1, landing: 1 });
    expect(stairCounts("first")).toEqual({ flight: 2, mid: 1, under: 1 });
    expect(stairCounts("last")).toEqual({ flight: 1, flightTop: 1, mid: 1, landing: 1 });
    expect(stairCounts("attic")).toEqual({ landingTop: 1 });
  });

  it("каждый элемент обмеряется один раз: задачи на элементы, а не на этажи", () => {
    const tasks = collectMeasureTasks(rows.slice(0, 5).map((r) => ({ ...r, works: worksForFlat(r) })));
    const stairs = tasks.filter((t) => t.code === "stairs");
    expect(stairs.map((t) => t.key)).toEqual([
      "stairs|flight|steps",
      "stairs|flightTop|steps",
      "stairs|mid|platform",
      "stairs|landing|platform",
      "stairs|landingTop|platform",
      "stairs|under|stairarea", "stairs|under|plinth",
    ]);
  });

  it("пол этажа = Σ элементов (число × (площадь + подступенки)); под лестницей на 1 этаже — отдельной строкой", () => {
    const m = {
      "stairs|flight|steps": 12, "stairs|flightTop|steps": 7,
      "stairs|mid|platform": 4, "stairs|landing|platform": 5, "stairs|landingTop|platform": 7, "stairs|under|stairarea": 12,
    };
    expect(floorLine(rows[1], m)).toMatchObject({ qty: 2 * 12 + 4 + 5 }); // типовой: 2 марша + межэтажная + этажная
    expect(floorLine(rows[0], m)).toMatchObject({ qty: 2 * 12 + 4 }); // 1 этаж: без этажной площадки
    expect(worksForFlat(rows[0], { measured: m }).lines.find((l) => l.work.endsWith("под лестницей"))).toMatchObject({ qty: 12, sum: 83520 });
    expect(floorLine(rows[3], m)).toMatchObject({ qty: 12 + 7 + 4 + 5 }); // верхний этаж: марш + малый марш + межэтажная + этажная
    expect(floorLine(rows[4], m)).toMatchObject({ qty: 7 }); // чердак: верхняя этажная площадка
  });

  it("пока элемент не обмерен, пол без объёма и ждёт именно его", () => {
    const l = floorLine(rows[1], { "stairs|flight|steps": 12 });
    expect(l.qty).toBeNull();
    expect(l.needs.map((n) => n.roomNo + ":" + n.kind)).toEqual(["mid:platform", "landing:platform"]);
    expect(floorLine(rows[1], {}).needs.map((n) => n.roomNo + ":" + n.kind)).toEqual(["flight:steps", "mid:platform", "landing:platform"]);
  });

  it("плинтус: Σ по элементам этажа", () => {
    const m = { "stairs|flight|plinth": 8, "stairs|mid|plinth": 3, "stairs|landing|plinth": 5 };
    expect(worksForFlat(rows[1], { measured: m }).lines.find((l) => l.rateNo === "2.12").qty).toBe(2 * 8 + 3 + 5);
  });

  it("кровля считается по-прежнему целиком: площадь + подступенки + плинтус группы", () => {
    const roof = worksForFlat(rows[5], { measured: { "stairs-roof||stairarea": 10, "stairs-roof||risers": 3.2, "stairs-roof||plinth": 12 } }).lines;
    expect(roof.find((l) => l.rateNo === "2.3")).toMatchObject({ qty: 13.2 });
    expect(roof.find((l) => l.rateNo === "2.12")).toMatchObject({ qty: 12 });
  });
});

const rowsForPlinth = () => ({ common: true, code: "stairs", mcode: "stairs", label: "Лестница", stairLevel: "mid", rooms: [] });

describe("площадка: площадь и плинтус из одного обмера", () => {
  it("плинтус = две короткие стороны + одна длинная", () => {
    // масштаб 0,01 м/пункт: площадка 2,0 × 1,2 м = 2,4 м²; плинтус 2 × 1,2 + 2,0 = 4,4 м.п
    const r = taskTotal([{ page: 1, kind: "area", points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 0, y: 120 }], count: 1 }], { 1: 0.01 }, { kind: "platform" });
    expect(r).toMatchObject({ area: 2.4, total: 2.4, plinth: 4.4 });
  });
  it("ориентация не важна: короткие стороны определяются по размерам, а не по осям", () => {
    const r = taskTotal([{ page: 1, kind: "area", points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 200 }, { x: 0, y: 200 }], count: 1 }], { 1: 0.01 }, { kind: "platform" });
    expect(r.plinth).toBe(4.4);
  });
  it("плинтус площадки отдельной задачи не требует — ждёт только обмер площадки", () => {
    const row = rowsForPlinth();
    const l = worksForFlat(row, { measured: { "stairs|flight|plinth": 4.95 } }).lines.find((x) => x.rateNo === "2.12");
    expect(l.needs.map((n) => n.roomNo + ":" + n.kind)).toEqual(["mid:platform", "landing:platform"]);
  });
});

describe("марш: одна ступень × число ступеней", () => {
  const step = (count) => ({ page: 1, kind: "area", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 0, y: 30 }], count });
  it("проступи = площадь ступени × N; подступенков столько же: ширина × 0,15 м × N", () => {
    // масштаб 0,01 м на пункт: ступень 1,0 × 0,3 м = 0,3 м²; ширина 1,0 м
    const r = taskTotal([step(9)], { 1: 0.01 }, { kind: "steps" });
    expect(r.area).toBe(2.7); // 0,3 × 9
    expect(r.risers).toBe(1.35); // 1,0 × 0,15 × 9
    expect(r.total).toBe(4.05);
    // плинтус: на каждую ступень малая сторона 0,3 + 0,1 + 0,15 = 0,55 м.п × 9
    expect(r.plinth).toBe(4.95);
  });
  it("плинтус марша не требует отдельного обмера: ждёт только обмер ступени", () => {
    const row = rowsForPlinth();
    const l = worksForFlat(row, { measured: { "stairs|mid|plinth": 3, "stairs|landing|plinth": 5 } }).lines.find((x) => x.rateNo === "2.12");
    expect(l.qty).toBeNull();
    expect(l.needs.map((n) => n.roomNo + ":" + n.kind)).toEqual(["flight:steps"]);
    expect(worksForFlat(row, { measured: { "stairs|flight|plinth": 4.95, "stairs|mid|plinth": 3, "stairs|landing|plinth": 5 } }).lines.find((x) => x.rateNo === "2.12").qty).toBe(2 * 4.95 + 3 + 5);
  });
  it("ширина — большая сторона контура, а не глубина; несколько форм ступеней складываются", () => {
    const rotated = { page: 1, kind: "area", points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 100 }, { x: 0, y: 100 }], count: 2 };
    const r = taskTotal([step(1), rotated], { 1: 0.01 }, { kind: "steps" });
    expect(r.area).toBe(0.9); // 0,3 + 0,3 × 2
    expect(r.risers).toBe(0.45); // 0,15 + 0,15 × 2
  });
  it("без калибровки листа не считается", () => {
    expect(taskTotal([step(5)], {}, { kind: "steps" })).toMatchObject({ total: 0, uncounted: 1 });
  });
});

describe("площадь пола лестницы по контурам", () => {
  it("контуры на плане складываются", () => {
    const sq = (x) => ({ page: 1, kind: "area", points: [{ x, y: 0 }, { x: x + 100, y: 0 }, { x: x + 100, y: 100 }, { x, y: 100 }], count: 1 });
    expect(taskTotal([sq(0), sq(200)], { 1: 0.01 }, { kind: "stairarea" }).total).toBe(2);
  });
});
