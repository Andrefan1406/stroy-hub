import { classifyWork, collectMeasureTasks, findRate, findRule, summarizeWorks, totalsOf, worksForFlat } from "./works";
import { assembleBlocks, attachFinishing } from "./blocks";
import { attachLoggias } from "./loggias";
import { parseExplication } from "./explication";
import { parseFinishing, parseLegend } from "./finishing";
import { planFlats } from "./plan";
import { parseTep } from "./tepParser";
import tepFixture from "./__fixtures__/tep-sheet3.json";
import finishingFixture from "./__fixtures__/finishing-p5.json";
import plan11 from "./__fixtures__/plan-p11.json";
import plan12 from "./__fixtures__/plan-p12.json";
import plan13 from "./__fixtures__/plan-p13.json";
import rates from "./data/rates.json";

describe("расценки и правила из файла", () => {
  it("24 расценки на внутреннюю отделку, цена с НДС = цена без НДС × 1,16", () => {
    expect(rates).toHaveLength(24);
    expect(rates.every((r) => Math.abs(r.priceNoVat * 1.16 - r.priceVat) < 0.5)).toBe(true);
  });

  it("название работы из правил находится в расценках, в т.ч. по «тоже что»", () => {
    expect(findRate("Устройство линолеума", "").no).toBe("2.8");
    expect(findRate("Устройство плинтуса ПВХ", "требуется обмер").no).toBe("2.13"); // «плинтуса» = «плинтусов»
    expect(findRate("Устройство фартука", "тоже что Облицовка стен керамической плиткой").no).toBe("2.5");
    expect(findRate("Устройство плинтуса керамического", "требуется обмер, тоже что устройство плинтуса из керамогранита").no).toBe("2.12");
    expect(findRate("Облицовка пола керамической плиткой", "").no).toBe("2.4"); // а не керамогранитной (2.3)
    expect(findRate("Несуществующая работа", "")).toBeNull();
  });

  it("помещение находится по названию, скобки с коэффициентом не мешают", () => {
    expect(findRule("Кухня").no).toBe(3);
    expect(findRule("Лоджия (к=0,5)").name).toBe("Лоджия");
    expect(findRule("Лоджия-балкон (к=0,4)").name).toBe("Лоджия-балкон");
    expect(findRule("Кладовая")).toBeNull();
  });

  it("основа объёма определяется по названию работы и примечанию", () => {
    expect(classifyWork("Улучшенное шпатлевание стен и потолков, сплошное выравнивание: черновой слой", "площадь минус фартук")).toBe("walls_ceilings");
    expect(classifyWork("Оклейка стен обоями", "")).toBe("walls");
    expect(classifyWork("Окраска водо-дисперсной краской стен 2 раза", "")).toBe("walls");
    expect(classifyWork("Окраска водо-дисперсной краской потолков за 2 раза", "")).toBe("ceiling");
    expect(classifyWork("Облицовка стен керамической плиткой", "")).toBe("wall_tile");
    expect(classifyWork("Облицовка пола керамической плиткой", "")).toBe("floor");
    expect(classifyWork("Устройство линолеума", "взять по потолку")).toBe("floor");
    expect(classifyWork("Устройство фартука", "тоже что Облицовка стен керамической плиткой")).toBe("apron");
    expect(classifyWork("Устройство плинтуса ПВХ", "требуется обмер")).toBe("measure");
  });
});

describe("работы квартиры по правилам помещений (лист 5 + лоджии)", () => {
  const sections = ["1", "2"];
  const tep = parseTep(tepFixture.items);
  const explications = [plan11, plan12, plan13].map((fx) => {
    const e = parseExplication(fx.items);
    return { page: fx.page, ...e, flats: planFlats({ items: fx.items, explication: e, sections }).flats };
  });
  const roomsByPage = Object.fromEntries(explications.map((e) => [e.page, e.rooms]));
  const { apartments } = parseFinishing(finishingFixture.items);
  const legend = parseLegend(finishingFixture.items);
  const built = assembleBlocks({ sections, explications, tep });
  const coefficients = { "11|Лоджия (к=0,5)": 0.5, "12|Лоджия-балкон (к=0,4)": 0.4 };
  const rows = attachLoggias(attachFinishing(built.rows, apartments, legend, roomsByPage), roomsByPage, coefficients)
    .map((r) => ({ ...r, works: worksForFlat(r) }));
  const flat1 = rows.find((r) => r.code === "1");
  const find = (flat, room, part) => flat.works.lines.find((l) => l.roomName.startsWith(room) && l.work.includes(part));

  it("прихожая: шпатлёвка только по стенам (потолки в помещениях 1–10 не учитываются), цены с НДС", () => {
    const rough = find(flat1, "Прихожая", "черновой слой");
    expect(rough).toMatchObject({ qty: 15.3, unit: "м2", priceVat: 1740, sum: 26622, rateNo: "2.1" });
    expect(rough.note).toMatch(/потолки не учтены/);
    expect(find(flat1, "Прихожая", "чистовой слой")).toMatchObject({ qty: 15.3, priceVat: 928, sum: 14198.4 });
    expect(find(flat1, "Прихожая", "обоями")).toMatchObject({ qty: 15.3, sum: 23072.4 });
  });

  it("линолеум берётся по площади потолка", () => {
    expect(find(flat1, "Прихожая", "линолеум")).toMatchObject({ qty: 4.83, sum: 6723.36 });
    expect(find(flat1, "Прихожая", "линолеум").note).toBe("по площади потолка");
  });

  it("плинтус: количество не считается (требуется обмер), цена показана", () => {
    const skirting = find(flat1, "Прихожая", "плинтуса");
    expect(skirting).toMatchObject({ qty: null, sum: null, priceVat: 754, unit: "м.п", note: "требуется обмер" });
  });

  it("кухня: шпатлёвка и обои — стены минус фартук; фартук — по расценке облицовки стен плиткой", () => {
    expect(find(flat1, "Кухня", "черновой слой")).toMatchObject({ qty: 27.52, sum: 47884.8 });
    expect(find(flat1, "Кухня", "обоями")).toMatchObject({ qty: 27.52 });
    expect(find(flat1, "Кухня", "фартука")).toMatchObject({ qty: 3.15, priceVat: 6960, sum: 21924, rateNo: "2.5" });
    expect(find(flat1, "Кухня", "линолеум")).toMatchObject({ qty: 10.66, sum: 14838.72 });
  });

  it("ванная и туалет: плитка на стены только там, где в «Видах отделки» облицовка, плитка на пол по площади пола", () => {
    expect(find(flat1, "Ванная", "Облицовка стен")).toMatchObject({ qty: 10.97, sum: 76351.2 });
    expect(find(flat1, "Ванная", "Облицовка пола")).toMatchObject({ qty: 2.76, sum: 19209.6 });
    expect(find(flat1, "Туалет", "Облицовка стен")).toMatchObject({ qty: 8.15, sum: 56724 });
    expect(find(flat1, "Туалет", "Облицовка пола")).toMatchObject({ qty: 1.46, sum: 10161.6 });
    expect(flat1.works.lines.filter((l) => l.roomName === "Ванная комната").some((l) => /шпатлеван/i.test(l.work))).toBe(false);
  });

  it("лоджия: потолки и пол по подтверждённой площади, стены — нужен обмер", () => {
    expect(find(flat1, "Лоджия", "краской потолков")).toMatchObject({ qty: 3.26, sum: 4537.92 }); // потолки лоджии (№11) учитываются
    expect(find(flat1, "Лоджия", "Облицовка пола")).toMatchObject({ qty: 3.26, sum: 22689.6 });
    expect(find(flat1, "Лоджия", "черновой слой")).toMatchObject({ qty: null });
    expect(find(flat1, "Лоджия", "стен 2 раза")).toMatchObject({ qty: null });
  });

  it("итог по квартире типа 1 и число позиций, требующих обмера", () => {
    const t = totalsOf([flat1]);
    expect(t.sumVat).toBe(552832.8);
    expect(t.sumNoVat).toBe(476580);
    expect(t.pending).toBeGreaterThan(0);
  });

  it("сводка по работам складывает объёмы всех квартир; фартук и облицовка стен — отдельные строки", () => {
    const sum = summarizeWorks(rows.slice(0, 4)); // квартиры 1-го этажа секции 1
    const apron = sum.find((x) => x.work === "Устройство фартука");
    const tile = sum.find((x) => x.work === "Облицовка стен керамической плиткой");
    expect(apron).toBeTruthy();
    expect(tile).toBeTruthy();
    expect(apron.rateNo).toBe(tile.rateNo);
    expect(apron.qty).toBeCloseTo(3.15 * 2 + (apartments["3"].rooms.find((r) => r.room === "3").walls.find((w) => w.id === "3").flat) * 2, 2);
  });

  it("помещение без правил — предупреждение, а не падение", () => {
    const r = worksForFlat({ rooms: [{ no: "5", name: "Кладовая", ceiling: { area: 1 }, walls: [] }] });
    expect(r.lines).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/нет правил/);
  });
});

describe("обмер: подстановка в ВДЦ", () => {
  const sections = ["1", "2"];
  const tep = parseTep(tepFixture.items);
  const explications = [plan11, plan12, plan13].map((fx) => {
    const e = parseExplication(fx.items);
    return { page: fx.page, ...e, flats: planFlats({ items: fx.items, explication: e, sections }).flats };
  });
  const roomsByPage = Object.fromEntries(explications.map((e) => [e.page, e.rooms]));
  const { apartments } = parseFinishing(finishingFixture.items);
  const legend = parseLegend(finishingFixture.items);
  const built = assembleBlocks({ sections, explications, tep });
  const coefficients = { "11|Лоджия (к=0,5)": 0.5, "12|Лоджия-балкон (к=0,4)": 0.4 };
  const base = attachLoggias(attachFinishing(built.rows, apartments, legend, roomsByPage), roomsByPage, coefficients);
  const withWorks = (measured) => base.map((r) => ({ ...r, works: worksForFlat(r, { measured }) }));

  it("без обмера: плинтус и стены лоджий требуют обмера", () => {
    const rows = withWorks({});
    const tasks = collectMeasureTasks(rows);
    // тип 1: плинтус в 5 комнатах (1, 3, 6, 9 + ...) — только в помещениях с «требуется обмер»; лоджия: плинтус и стены
    const t1 = tasks.filter((t) => t.code === "1");
    expect(t1.filter((t) => t.kind === "plinth").map((t) => t.roomName)).toEqual(["Прихожая", "Кухня", "Гостинная", "Гардеробная", "Лоджия (к=0,5)"]);
    expect(t1.find((t) => t.kind === "walls")).toMatchObject({ roomName: "Лоджия (к=0,5)", unit: "м²" });
    const t3 = tasks.filter((t) => t.code === "3");
    expect(t3.filter((t) => t.kind === "walls").map((t) => t.roomName)).toEqual(["Лоджия (к=0,5)", "Лоджия-балкон (к=0,4)"]);
    expect(t3.every((t) => t.works.length > 0)).toBe(true);
  });

  it("обмер одной квартиры типа заполняет все квартиры этого типа", () => {
    const measured = { "1|1|plinth": 8.5, "1|11|walls": 6 };
    const rows = withWorks(measured);
    const t1 = rows.filter((r) => r.code === "1");
    expect(t1.length).toBe(36);
    t1.forEach((r) => {
      const plinth = r.works.lines.find((l) => l.roomNo === "1" && /плинтус/i.test(l.work));
      expect(plinth).toMatchObject({ qty: 8.5, sum: 6409, note: "по обмеру" }); // 8,5 × 754
    });
    // другой тип не затронут
    expect(rows.find((r) => r.code === "3").works.lines.find((l) => l.roomNo === "1" && /плинтус/i.test(l.work)).qty).toBeNull();
  });

  it("стены лоджии по обмеру дают шпатлёвку (стены + потолок лоджии) и окраску стен", () => {
    const r = withWorks({ "1|11|walls": 6 }).find((x) => x.code === "1");
    const rough = r.works.lines.find((l) => l.roomNo === "11" && l.work.includes("черновой слой"));
    expect(rough).toMatchObject({ qty: 9.26, sum: 16112.4 }); // 6 + потолок 3,26, × 1740
    expect(r.works.lines.find((l) => l.roomNo === "11" && l.work.includes("краской стен"))).toMatchObject({ qty: 6, sum: 8352 });
    expect(collectMeasureTasks([r]).some((t) => t.kind === "walls")).toBe(false);
  });

  it("введённый обмер уменьшает число позиций без объёма", () => {
    const before = totalsOf(withWorks({}).filter((r) => r.code === "1")).pending;
    const after = totalsOf(withWorks({ "1|1|plinth": 8.5, "1|3|plinth": 10 }).filter((r) => r.code === "1")).pending;
    expect(after).toBe(before - 2 * 36);
  });
});
