import { bindCabins, buildSummary, NO_OBJECT } from "./model";

const title = (id, text, x, y) => ({ id, type: "title", text, x, y });
const cabin = (id, size, x, y) => ({ id, type: "cabin", size, x, y, rotation: 0 });
const label = (id, parentId, text, sort = 0) => ({ id, type: "label", parentId, text, sort });

test("привязка по цепочке: соседние бытовки не дальше 20 м (промежуток между краями)", () => {
  // Бытовки 12×2,5 горизонтально: края по x — [x-6, x+6].
  const objects = [
    title("t1", "Поз. 59", 0, 0),
    cabin("c1", "12x2.5", 15, 0), // край на 9 м от заголовка
    cabin("c2", "12x2.5", 45, 0), // промежуток с c1: 39-21 = 18 м — по цепочке
    cabin("c3", "12x2.5", 78, 0), // промежуток с c2: 72-51 = 21 м — уже нет
    cabin("c4", "12x2.5", 15, 30), // от c1 по вертикали: 30 - 2,5 = 27,5 м — нет
  ];
  expect(bindCabins(objects)).toEqual({ c1: "t1", c2: "t1", c3: null, c4: null });
});

test("повёрнутая бытовка: промежуток считается по реальным краям", () => {
  const objects = [
    title("t1", "Поз. 59", 0, 0),
    cabin("c1", "12x2.5", 10, 0),
    { ...cabin("c2", "12x2.5", 16 + 20 + 1.25 - 0.1, 0), rotation: 90 }, // повёрнута: по x занимает ±1,25 — промежуток 19,9 м
  ];
  expect(bindCabins(objects).c2).toBe("t1");
});

test("цепочка к двум заголовкам — каждая бытовка к тому, до которого ближе по цепочке", () => {
  const objects = [
    title("t1", "Поз. 59", 0, 0),
    title("t2", "Поз. 72", 100, 0),
    cabin("c1", "12x2.5", 10, 0),
    cabin("c2", "12x2.5", 30, 0),
    cabin("c3", "12x2.5", 70, 0),
    cabin("c4", "12x2.5", 90, 0),
    cabin("c5", "12x2.5", 50, 0), // посередине: до t1 и до t2 одинаково — по алфавиту id заголовка
  ];
  expect(bindCabins(objects)).toEqual({ c1: "t1", c2: "t1", c5: "t1", c3: "t2", c4: "t2" });
});

test("таблица: кол-во одинаковых, разные подписи — отдельными строками, сортировка по алфавиту", () => {
  const objects = [
    title("t1", "Поз. 59", 0, 0),
    cabin("c1", "12x2.5", 5, 0),
    cabin("c2", "12x2.5", 8, 0),
    cabin("c3", "12x2.5", 11, 0),
    cabin("c4", "6x2.5", 14, 0),
    cabin("c5", "6x2.5", 0, 200),
    label("l1", "c1", "склад инструмента"),
    label("l2", "c2", "склад инструмента"),
    label("l3", "c3", "кабинет прораба"),
    label("l4", "c3", "аптечка", 1), // вторая подпись той же бытовки
  ];
  // Типы — по числу: 6×2,5 раньше 12×2,5.
  expect(buildSummary(objects)).toEqual([
    { object: "Поз. 59", cabinType: "Бытовка 6×2,5", count: 1, content: "—" },
    { object: "Поз. 59", cabinType: "Бытовка 12×2,5", count: 1, content: "аптечка" },
    { object: "Поз. 59", cabinType: "Бытовка 12×2,5", count: 1, content: "кабинет прораба" },
    { object: "Поз. 59", cabinType: "Бытовка 12×2,5", count: 2, content: "склад инструмента" },
    { object: NO_OBJECT, cabinType: "Бытовка 6×2,5", count: 1, content: "—" },
  ]);
});
