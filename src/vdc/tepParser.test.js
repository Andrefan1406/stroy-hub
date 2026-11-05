import { parseTep, parseFloors } from "./tepParser";
import fixture from "./__fixtures__/tep-sheet3.json";

describe("parseFloors", () => {
  it("разворачивает диапазоны и списки", () => {
    expect(parseFloors("1-9")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(parseFloors("1, 3-5")).toEqual([1, 3, 4, 5]);
    expect(parseFloors("2")).toEqual([2]);
  });
  it("мусор и обратные диапазоны отклоняет", () => {
    expect(parseFloors("9-1")).toBeNull();
    expect(parseFloors("1-к")).toBeNull();
    expect(parseFloors("")).toBeNull();
  });
});

describe("parseTep — лист 3 чертежей АВ/24-11/187-1.6-АР", () => {
  const result = parseTep(fixture.items);

  it("находит оба типа квартир", () => {
    expect(result.types.map((t) => t.name)).toEqual(["Однокомнатная Тип 1", "Трехкомнатная Тип 3"]);
    expect(result.types.map((t) => t.qtyPerFloor)).toEqual([4, 4]);
    expect(result.types.map((t) => t.qtyHouse)).toEqual([36, 36]);
  });

  it("разворачивает по этажам: 9 этажей × 2 типа", () => {
    expect(result.rows).toHaveLength(18);
    expect(result.rows[0]).toEqual({ floor: 1, type: "Однокомнатная Тип 1", qty: 4 });
    expect(result.rows[1]).toEqual({ floor: 1, type: "Трехкомнатная Тип 3", qty: 4 });
    expect(result.rows[17]).toEqual({ floor: 9, type: "Трехкомнатная Тип 3", qty: 4 });
    expect(result.rows.every((r) => r.qty === 4)).toBe(true);
  });

  it("итог 72 квартиры совпадает со строкой «Всего на дом», все проверки зелёные", () => {
    expect(result.totalHouse).toBe(72);
    expect(result.total).toBe(72);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });
});

describe("parseTep — ошибки и особые случаи", () => {
  const tok = (str, x, y) => ({ str, x, y, w: 10, h: 8 });
  const header = [
    tok("ТЭП по типам квартир, на дом III класса проживания", 800, 30),
    tok("№ п/п", 620, 70),
  ];
  const dataRow = (y, no, name, perFloor, floors, perHouse) => [
    tok(String(no), 630, y), tok(name, 680, y), tok(String(perFloor), 815, y), tok(floors, 867, y),
    tok("16,65", 923, y), tok("38,16", 978, y), tok("39,79", 1034, y), tok(String(perHouse), 1098, y),
    tok("599,4", 1149, y), tok("1373,76", 1204, y), tok("1432,44", 1275, y),
  ];

  it("лист без таблицы — понятная ошибка", () => {
    expect(() => parseTep([tok("Общие данные", 100, 50)])).toThrow(/не найдена таблица/);
    expect(() => parseTep([])).toThrow(/не найдена таблица/);
  });

  it("заголовок есть, строк нет — отдельная ошибка", () => {
    expect(() => parseTep(header)).toThrow(/строки с типами квартир разобрать не удалось/);
  });

  it("не совпало кол-во на дом — предупреждение, а не ошибка", () => {
    const items = [
      ...header,
      ...dataRow(100, 1, "Студия Тип 5", 3, "1-9", 20), // 3 × 9 = 27, а в таблице 20
      tok("Всего на дом", 979, 150), tok("20", 1099, 150),
    ];
    const r = parseTep(items);
    expect(r.rows).toHaveLength(9);
    expect(r.checks.filter((c) => !c.ok)).toHaveLength(2); // по типу и по итогу (27 ≠ 20)
  });

  it("этажи списком: «1, 3-5» → 4 строки; название из двух кусков склеивается", () => {
    const items = [
      ...header,
      ...dataRow(100, 1, "Двухкомнатная", 2, "1, 3-5", 8).map((t) => t),
      tok("Всего на дом", 979, 150), tok("8", 1099, 150),
    ];
    // «Тип 2» отдельным элементом: должен попасть в название, а не в числовой хвост
    items.push(tok("Тип 2", 740, 100));
    const r = parseTep(items);
    expect(r.rows.map((x) => x.floor)).toEqual([1, 3, 4, 5]);
    expect(r.types[0].name).toBe("Двухкомнатная Тип 2");
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("текст слева от таблицы (Общие данные) в строки не попадает", () => {
    const items = [
      ...header,
      tok("Размеры в плане в осях А-К - 1-22 составляют 17,8 х 54,4 м;", 80, 100),
      ...dataRow(100, 1, "Однокомнатная Тип 1", 4, "1-9", 36),
      tok("Всего на дом", 979, 150), tok("36", 1099, 150),
    ];
    const r = parseTep(items);
    expect(r.types).toHaveLength(1);
    expect(r.types[0].name).toBe("Однокомнатная Тип 1");
  });
});
