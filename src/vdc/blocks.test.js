import { detectSections, parseSectionIds, firstSectionId } from "./sections";
import { parseExplication, parseFloorsFromTitle, parseScope, findExplicationTitle } from "./explication";
import { assembleBlocks, attachFinishing, splitFirstBlock, typeCodeFromName, flatLabel } from "./blocks";
import { planFlats } from "./plan";
import { checkRoomNames, parseFinishing, parseLegend } from "./finishing";
import { parseTep } from "./tepParser";
import tepFixture from "./__fixtures__/tep-sheet3.json";
import sectionsFixture from "./__fixtures__/sections-all-pages.json";
import finishingFixture from "./__fixtures__/finishing-p5.json";
import p11 from "./__fixtures__/expl-p11.json";
import p12 from "./__fixtures__/expl-p12.json";
import p13 from "./__fixtures__/expl-p13.json";
import plan11 from "./__fixtures__/plan-p11.json";
import plan12 from "./__fixtures__/plan-p12.json";
import plan13 from "./__fixtures__/plan-p13.json";

describe("секции дома", () => {
  it("находит секции №1 и №2 по схеме блокировки, а не по числу упоминаний", () => {
    const r = detectSections(sectionsFixture);
    expect(r.ids).toEqual(["1", "2"]);
    expect(r.source).toBe("scheme");
    expect(r.schemePages).toContain(11);
  });

  it("без схемы блокировки берёт номера из всего текста; нет номеров — пусто", () => {
    expect(detectSections([{ page: 1, text: "Количество ступеней секции №1 - 9 шт.; секции №2 - 8 шт." }])).toMatchObject({ ids: ["1", "2"], source: "all" });
    expect(detectSections([{ page: 1, text: "блок -секция №3 блок-секция №10" }]).ids).toEqual(["3", "10"]);
    expect(detectSections([{ page: 1, text: "Блоки дверные, оконные блоки" }])).toMatchObject({ ids: [], source: "none" });
  });

  it("«Блок №3/2» читается целиком", () => {
    expect(detectSections([{ page: 1, text: "БЛОК №3/2 Подвал" }]).ids).toEqual(["3/2"]);
  });

  it("ввод пользователя и первый блок = секция 1", () => {
    expect(parseSectionIds("1, 2; №3  2")).toEqual(["1", "2", "3"]);
    expect(parseSectionIds("abc")).toEqual([]);
    expect(firstSectionId(["2", "1"])).toBe("1");
    expect(firstSectionId(["2", "3"])).toBe("2");
    expect(firstSectionId([])).toBeNull();
  });
});

describe("заголовок экспликации", () => {
  it("этажи и область", () => {
    expect(parseFloorsFromTitle("1-го")).toEqual([1]);
    expect(parseFloorsFromTitle("2...6-го")).toEqual([2, 3, 4, 5, 6]);
    expect(parseFloorsFromTitle("7…9-го")).toEqual([7, 8, 9]);
    expect(parseFloorsFromTitle("2-6-го")).toEqual([2, 3, 4, 5, 6]);
    expect(parseScope("секцию")).toEqual({ kind: "section", id: null });
    expect(parseScope("секцию №2")).toEqual({ kind: "section", id: "2" });
    expect(parseScope("две секции")).toEqual({ kind: "several", id: null });
    expect(parseScope("дом")).toEqual({ kind: "house", id: null });
  });

  it("экспликации подвала и чердака (в осях) не принимаются за этажи квартир", () => {
    const item = (str) => [{ str, x: 1300, y: 50, w: 100, h: 10 }];
    expect(findExplicationTitle(item("Экспликация помещений подвала в осях 1...11"))).toBeNull();
    expect(findExplicationTitle(item("Экспликация кровли на две секции"))).toBeNull();
    expect(findExplicationTitle(item("Экспликация помещений 1-го этажа на секцию")).floors).toEqual([1]);
  });
});

describe("экспликации этажей на реальных листах (PDF-листы 11, 12, 13)", () => {
  it.each([
    [p11, [1]],
    [p12, [2, 3, 4, 5, 6]],
    [p13, [7, 8, 9]],
  ])("читает типы, жилую площадь и количество квартир на этаже", (fx, floors) => {
    const e = parseExplication(fx.items);
    expect(e.floors).toEqual(floors);
    expect(e.scope).toEqual({ kind: "section", id: null });
    expect(e.types).toEqual([{ code: "1", qty: 2, living: "16,65" }, { code: "3", qty: 2, living: "54,07" }]);
  });

  it("лист без экспликации — понятная ошибка", () => {
    expect(() => parseExplication([{ str: "Общие данные", x: 100, y: 50, w: 50, h: 10 }])).toThrow(/не найден заголовок/);
  });

  it("«АР-13» в той же строке, что и заголовок, не сдвигает границу таблицы влево", () => {
    const items = [
      { str: "АР-13", x: 500, y: 45, w: 30, h: 10 },
      { str: "Маркировочный план 1-го этажа", x: 560, y: 45, w: 200, h: 10 },
      ...p11.items.map((i) => (/экспликация помещений/i.test(i.str) ? { ...i, y: 45 } : i)),
      { str: "Тип квартиры", x: 600, y: 142, w: 60, h: 8 },
      { str: "7", x: 650, y: 142, w: 5, h: 8 },
    ];
    const e = parseExplication(items);
    expect(e.floors).toEqual([1]);
    expect(e.types.map((t) => [t.code, t.qty])).toEqual([["1", 2], ["3", 2]]);
  });
});

// Экспликации с квартирами по планам листов 11, 12, 13 (у листа 13 плана в тестовых данных нет только в явном виде — он есть).
const withPlan = (planFx, sections) => {
  const e = parseExplication(planFx.items);
  const { flats, warnings } = planFlats({ items: planFx.items, explication: e, sections });
  return { page: planFx.page, ...e, flats, planWarnings: warnings };
};

describe("сборка по секциям: каждая квартира отдельно, с осями", () => {
  const tep = parseTep(tepFixture.items);
  const sections = ["1", "2"];
  const explications = [plan11, plan12, plan13].map((fx) => withPlan(fx, sections));

  it("на плане находятся 4 квартиры; секция 1 — в/о 1-6 и 6-11, секция 2 — в/о 12-17 и 17-22", () => {
    const flats = explications[0].flats;
    expect(flats).toHaveLength(4);
    expect(explications.every((e) => e.planWarnings.length === 0)).toBe(true);
    expect(flats.map((f) => [f.code, f.labels["1"], f.labels["2"]])).toEqual([
      ["3", "в/о 1-6", "в/о 12-17"],
      ["1", "в/о 1-6", "в/о 12-17"],
      ["3", "в/о 6-11", "в/о 17-22"],
      ["1", "в/о 6-11", "в/о 17-22"],
    ]);
  });

  it("2 секции × 9 этажей × 4 квартиры = 72 строки, все проверки с ТЭП зелёные", () => {
    const r = assembleBlocks({ sections, explications, tep });
    expect(r.rows).toHaveLength(72);
    expect(r.warnings).toEqual([]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.rows.every((x) => x.qty === 1)).toBe(true);
    const floor1 = r.rows.filter((x) => x.section === "1" && x.floor === 1).map((x) => x.label);
    expect(floor1).toEqual(["Тип 1 в/о 1-6", "Тип 1 в/о 6-11", "Тип 3 в/о 1-6", "Тип 3 в/о 6-11"]);
    const floor9 = r.rows.filter((x) => x.section === "2" && x.floor === 9).map((x) => x.label);
    expect(floor9).toEqual(["Тип 1 в/о 12-17", "Тип 1 в/о 17-22", "Тип 3 в/о 12-17", "Тип 3 в/о 17-22"]);
  });

  it("первый блок отдельно, остальные вместе", () => {
    const r = assembleBlocks({ sections, explications, tep });
    const { first, others } = splitFirstBlock(r.rows, "1");
    expect(first).toHaveLength(36);
    expect(first.every((x) => x.section === "1")).toBe(true);
    expect(others).toHaveLength(36);
    expect(others.every((x) => x.section === "2")).toBe(true);
  });

  it("оси можно поправить вручную: правка подписи попадает в строки", () => {
    const edited = explications.map((e, i) => (i === 0 ? { ...e, flats: e.flats.map((f, k) => (k === 0 ? { ...f, labels: { ...f.labels, 1: "в/о 2-5" } } : f)) } : e));
    const r = assembleBlocks({ sections, explications: edited, tep });
    expect(r.rows.find((x) => x.section === "1" && x.floor === 1 && x.code === "3" && x.axes === "в/о 2-5")).toBeTruthy();
  });

  it("неверное число секций ловится проверкой по ТЭП", () => {
    const three = assembleBlocks({ sections: ["1", "2", "3"], explications, tep });
    expect(three.checks.some((c) => !c.ok)).toBe(true);
    const one = assembleBlocks({ sections: ["1"], explications, tep });
    expect(one.checks.some((c) => !c.ok)).toBe(true);
  });

  it("не выбран лист этажей — непройденная проверка", () => {
    const r = assembleBlocks({ sections, explications: explications.slice(0, 2), tep });
    expect(r.checks.some((c) => !c.ok && /этажи 7, 8, 9/.test(c.text))).toBe(true);
  });

  it("без найденных квартир на плане — строки без осей, одинаковые подписи дают предупреждение", () => {
    const bare = [p11, p12, p13].map((fx) => ({ page: fx.page, ...parseExplication(fx.items) }));
    const r = assembleBlocks({ sections, explications: bare, tep });
    expect(r.rows).toHaveLength(72);
    expect(r.rows.every((x) => x.axes === "")).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/Одинаковые подписи/);
  });

  it("экспликация для конкретной секции перекрывает типовую", () => {
    const own = { page: 99, floors: [1], scope: { kind: "section", id: "2" }, types: [{ code: "1", qty: 3 }, { code: "3", qty: 1 }] };
    const r = assembleBlocks({ sections, explications: [explications[0], own], tep: null });
    const s2 = r.rows.filter((x) => x.section === "2");
    expect(s2.map((x) => x.code)).toEqual(["1", "1", "1", "3"]);
    expect(r.rows.filter((x) => x.section === "1")).toHaveLength(4);
  });

  it("«на две секции» пропускается с предупреждением", () => {
    const both = { page: 5, floors: [1], scope: { kind: "several", id: null }, types: [{ code: "1", qty: 4 }] };
    const r = assembleBlocks({ sections, explications: [both], tep: null });
    expect(r.rows).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/нескольким секциям/);
  });

  it("код типа и подпись квартиры", () => {
    expect(typeCodeFromName("Однокомнатная Тип 1")).toBe("1");
    expect(typeCodeFromName("Студия Тип 5а")).toBe("5а");
    expect(typeCodeFromName("Студия")).toBeNull();
    expect(flatLabel("1", "в/о 1-6")).toBe("Тип 1 в/о 1-6");
    expect(flatLabel("1", "")).toBe("Тип 1");
  });
});

describe("ведомость отделки помещений (PDF-лист 5)", () => {
  const tep = parseTep(tepFixture.items);
  const { apartments } = parseFinishing(finishingFixture.items);
  const legend = parseLegend(finishingFixture.items);

  it("типы 1 и 3: помещения, виды отделки потолка и стен, площади на 1 квартиру", () => {
    expect(Object.keys(apartments)).toEqual(["1", "3"]);
    expect(apartments["1"].rooms.map((r) => r.room)).toEqual(["1", "3", "4", "5", "6", "9"]);
    // тип 3 продолжается во второй таблице листа («окончание»): помещения 9 и 10
    expect(apartments["3"].rooms.map((r) => r.room)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    const room3 = apartments["1"].rooms.find((r) => r.room === "3");
    expect(room3.ceiling).toMatchObject({ id: "1", flat: 10.66, section: 191.88, house: 383.76 });
    expect(room3.walls.map((w) => [w.id, w.flat])).toEqual([["2", 27.52], ["3", 3.15]]);
  });

  it("виды отделки с объёмами на квартиру", () => {
    const rows = attachFinishing([{ code: "1" }, { code: "3" }, { code: "7" }], apartments, legend);
    expect(rows[0].finish.map((f) => [f.element, f.id, f.area])).toEqual([["ceiling", "1", 38.16], ["walls", "2", 81.03], ["walls", "3", 3.15], ["walls", "4", 19.12]]);
    expect(rows[1].finish.map((f) => [f.element, f.id, f.area])).toEqual([["ceiling", "1", 88.96], ["walls", "2", 249.41], ["walls", "3", 2.79], ["walls", "4", 19.12]]);
    expect(rows[2].finish).toBeNull(); // типа 7 в ведомости нет
    expect(rows[0].finish[1].title).toMatch(/^Улучшенная штукатурка поверхностей стен/);
  });

  it("легенда видов отделки: номера, включая «6а», без списка примечаний", () => {
    expect(Object.keys(legend).sort()).toEqual(["1", "10", "11", "2", "3", "4", "5", "6", "6а", "8", "9"]);
    expect(legend["1"].title).toMatch(/^Сплошное выравнивание/);
    expect(legend["6а"].text).toMatch(/^Штукатурная цементно-песчаная смесь/);
  });

  it("сверка с ТЭП: потолки = общая площадь квартиры, «на дом» = «на 1 кв-ру» × число квартир", () => {
    const { checkFinishing } = require("./finishing");
    const checks = checkFinishing(apartments, tep.types, typeCodeFromName);
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("названия помещений из экспликации плана подставляются в ведомость отделки по номерам", () => {
    const e = parseExplication(p11.items);
    expect(e.rooms).toHaveLength(12);
    expect(e.rooms.slice(0, 4).map((r) => [r.no, r.name])).toEqual([["1", "Прихожая"], ["2", "Коридор"], ["3", "Кухня"], ["4", "Ванная комната"]]);
    expect(e.rooms.find((r) => r.no === "3").areas).toEqual({ 1: 10.66, 3: 11.51 });
    expect(e.rooms.find((r) => r.no === "7").areas).toEqual({ 1: null, 3: 15.12 }); // спальня есть только в типе 3
    expect(e.rooms.find((r) => r.no === "12").name).toBe("Лоджия-балкон (к=0,4)");

    const rows = attachFinishing([{ code: "1", page: 11 }, { code: "3", page: 11 }], apartments, legend, { 11: e.rooms });
    expect(rows[0].rooms.map((r) => `${r.no} ${r.name}`)).toEqual(["1 Прихожая", "3 Кухня", "4 Ванная комната", "5 Туалет", "6 Гостинная", "9 Гардеробная"]);
    const kitchen = rows[0].rooms.find((r) => r.name === "Кухня");
    expect(kitchen.ceiling).toMatchObject({ id: "1", area: 10.66 });
    expect(kitchen.walls.map((w) => [w.id, w.area])).toEqual([["2", 27.52], ["3", 3.15]]);
    expect(rows[1].rooms.map((r) => r.no)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(rows[1].rooms.find((r) => r.no === "10").name).toBe("Коридор");
  });

  it("проверка названий: площади помещений в экспликации и в ведомости отделки совпадают", () => {
    const e = parseExplication(p11.items);
    const ok = checkRoomNames(apartments, e.rooms);
    expect(ok).toHaveLength(2);
    expect(ok.every((c) => c.ok)).toBe(true);
    // без экспликации (или с другой нумерацией) проверка не проходит
    expect(checkRoomNames(apartments, []).every((c) => !c.ok)).toBe(true);
    expect(checkRoomNames(apartments, e.rooms.map((r) => ({ ...r, no: String(Number(r.no) + 100) }))).every((c) => !c.ok)).toBe(true);
  });
});
