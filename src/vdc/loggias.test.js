import { attachLoggias, checkLoggiaAreas, findLoggiaFloorAreas, isLoggiaName, proposeCoefficient, proposeLoggias } from "./loggias";
import { assembleBlocks } from "./blocks";
import { parseExplication } from "./explication";
import { planFlats } from "./plan";
import { parseTep } from "./tepParser";
import tepFixture from "./__fixtures__/tep-sheet3.json";
import floorsFixture from "./__fixtures__/floors-p6.json";
import plan11 from "./__fixtures__/plan-p11.json";
import plan12 from "./__fixtures__/plan-p12.json";
import plan13 from "./__fixtures__/plan-p13.json";

describe("предложение коэффициентов", () => {
  it("коэффициент из скобок в названии берётся как есть, но помечен источником «чертёж»", () => {
    expect(proposeCoefficient("Лоджия (к=0,5)")).toEqual({ k: 0.5, source: "drawing" });
    expect(proposeCoefficient("Лоджия-балкон (к=0,4)")).toEqual({ k: 0.4, source: "drawing" });
    expect(proposeCoefficient("Балкон (к = 0.3)")).toEqual({ k: 0.3, source: "drawing" });
  });

  it("если в названии коэффициента нет — предлагаем типовой и помечаем «типовой»", () => {
    expect(proposeCoefficient("Лоджия")).toMatchObject({ k: 0.5, source: "default" });
    expect(proposeCoefficient("Балкон")).toMatchObject({ k: 0.3, source: "default" });
    expect(proposeCoefficient("Терраса")).toMatchObject({ k: 0.3, source: "default" });
    expect(proposeCoefficient("Лоджия-балкон")).toMatchObject({ k: 0.4, source: "default" });
  });

  it("нелепый коэффициент в названии (больше 1) игнорируется", () => {
    expect(proposeCoefficient("Лоджия (к=5)")).toMatchObject({ k: 0.5, source: "default" });
  });

  it("лоджии и балконы отличаются от обычных помещений", () => {
    expect(isLoggiaName("Лоджия (к=0,5)")).toBe(true);
    expect(isLoggiaName("Кухня")).toBe(false);
  });
});

describe("лоджии на реальном чертеже", () => {
  const sections = ["1", "2"];
  const tep = parseTep(tepFixture.items);
  const explications = [plan11, plan12, plan13].map((fx) => {
    const e = parseExplication(fx.items);
    return { page: fx.page, ...e, flats: planFlats({ items: fx.items, explication: e, sections }).flats };
  });
  const roomsByPage = Object.fromEntries(explications.map((e) => [e.page, e.rooms]));
  const built = assembleBlocks({ sections, explications, tep });

  it("в экспликации две лоджии: №11 (к=0,5) и №12 (к=0,4)", () => {
    const list = proposeLoggias(roomsByPage);
    expect(list.map((l) => [l.no, l.name, l.k, l.source])).toEqual([
      ["11", "Лоджия (к=0,5)", 0.5, "drawing"],
      ["12", "Лоджия-балкон (к=0,4)", 0.4, "drawing"],
    ]);
    expect(list[0].areas).toEqual({ 1: 1.63, 3: 1.42 });
    expect(list[1].areas).toEqual({ 1: null, 3: 1.86 });
  });

  it("фактическая площадь = площадь по экспликации ÷ коэффициент; у типа 1 одна лоджия, у типа 3 две", () => {
    const rows = attachLoggias(built.rows, roomsByPage, { "11|Лоджия (к=0,5)": 0.5, "12|Лоджия-балкон (к=0,4)": 0.4 });
    const t1 = rows.find((r) => r.code === "1");
    const t3 = rows.find((r) => r.code === "3");
    expect(t1.loggias.map((l) => [l.no, l.reduced, l.k, l.area])).toEqual([["11", 1.63, 0.5, 3.26]]);
    expect(t3.loggias.map((l) => [l.no, l.reduced, l.k, l.area])).toEqual([["11", 1.42, 0.5, 2.84], ["12", 1.86, 0.4, 4.65]]);
  });

  it("экспликация полов: «Балконы, лоджии» — 193,5 м² на секцию, 387 на дом", () => {
    const fa = findLoggiaFloorAreas([{ page: 6, items: floorsFixture.items }]);
    expect(fa).toMatchObject({ perSection: [193.5, 193.5], total: 387 });
    expect(findLoggiaFloorAreas([{ page: 1, items: [{ str: "Общие данные", x: 1, y: 1, w: 1, h: 1 }] }])).toBeNull();
  });

  it("предложенные коэффициенты дают ровно 193,5 м² на секцию — сверка зелёная", () => {
    const fa = findLoggiaFloorAreas([{ page: 6, items: floorsFixture.items }]);
    const rows = attachLoggias(built.rows, roomsByPage, { "11|Лоджия (к=0,5)": 0.5, "12|Лоджия-балкон (к=0,4)": 0.4 });
    const checks = checkLoggiaAreas(rows, sections, fa);
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("неверный коэффициент ловится сверкой", () => {
    const fa = findLoggiaFloorAreas([{ page: 6, items: floorsFixture.items }]);
    const rows = attachLoggias(built.rows, roomsByPage, { "11|Лоджия (к=0,5)": 0.3, "12|Лоджия-балкон (к=0,4)": 0.4 });
    expect(checkLoggiaAreas(rows, sections, fa).some((c) => !c.ok)).toBe(true);
  });

  it("без строки «Балконы, лоджии» в экспликации полов — предупреждение вместо сверки", () => {
    const rows = attachLoggias(built.rows, roomsByPage, { "11|Лоджия (к=0,5)": 0.5, "12|Лоджия-балкон (к=0,4)": 0.4 });
    expect(checkLoggiaAreas(rows, sections, null)[0].ok).toBe(false);
  });
});
