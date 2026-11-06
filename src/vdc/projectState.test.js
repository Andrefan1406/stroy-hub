import { applyAxisLabels, axisLabelsOf, collectState, describeState, findObjectName, findPosition, findProjectCode, normalizeState, pickedList, pickedMap, projectKeyFor } from "./projectState";

describe("ключ проекта по шифру из штампа", () => {
  it("шифр находится, даже если разбит на части; берётся самый частый", () => {
    const pages = [
      { page: 2, text: "Раздел: АР АВ /24-11/187-1.6 Многоэтажный жилой дом Поз. 1.6" },
      { page: 3, text: "ТЭП ... АВ/24-11/187-1.6-АР Общие данные" },
      { page: 4, text: "АВ /24-11/187-1.6 - АР Общие данные (продолжение) ссылка на АВ/24-11/187-1.7-КЖ" },
      { page: 5, text: "АВ/24-11/187-1.6-АР" },
    ];
    expect(findProjectCode(pages)).toBe("АВ/24-11/187-1.6-АР");
  });

  it("нет шифра — ключ из имени и размера файла; нет и файла — null", () => {
    const file = { name: "чертежи.pdf", size: 123 };
    expect(projectKeyFor([{ page: 1, text: "Общие данные" }], file)).toBe("файл:чертежи.pdf:123");
    expect(projectKeyFor([], null)).toBeNull();
    expect(projectKeyFor([{ page: 1, text: "АВ/24-11/187-1.6-АР" }], file)).toBe("АВ/24-11/187-1.6-АР");
  });
});

describe("оси квартир: сохранить и подставить обратно", () => {
  const layout = [
    { page: 11, flats: [{ code: "3", labels: { 1: "в/о 1-6", 2: "в/о 12-17" } }, { code: "1", labels: { 1: "в/о 1-6", 2: "в/о 12-17" } }] },
    { page: 12, flats: [{ code: "3", labels: { 1: "в/о 1-6" } }] },
  ];

  it("правка подписи переживает пересборку квартир", () => {
    const edited = layout.map((e, i) => (i === 0 ? { ...e, flats: e.flats.map((f, k) => (k === 0 ? { ...f, labels: { ...f.labels, 1: "в/о 2-5" } } : f)) } : e));
    const saved = axisLabelsOf(edited);
    const rebuilt = applyAxisLabels(layout, saved); // как будто листы разобраны заново
    expect(rebuilt[0].flats[0].labels[1]).toBe("в/о 2-5");
    expect(rebuilt[0].flats[1].labels[1]).toBe("в/о 1-6");
    expect(rebuilt[1].flats[0].labels[1]).toBe("в/о 1-6");
  });

  it("если лист или порядок типов не совпал — сохранённые подписи не применяются", () => {
    const saved = [{ page: 11, flats: [{ code: "1", labels: { 1: "в/о 9-9" } }, { code: "3", labels: { 1: "в/о 9-9" } }] }];
    expect(applyAxisLabels(layout, saved)[0].flats[0].labels[1]).toBe("в/о 1-6");
    expect(applyAxisLabels(layout, [{ page: 99, flats: [] }])).toEqual(layout);
    expect(applyAxisLabels(layout, null)).toBe(layout);
  });

  it("пустые подписи не затирают найденные на плане", () => {
    const saved = [{ page: 12, flats: [{ code: "3", labels: { 1: "  " } }] }];
    expect(applyAxisLabels(layout, saved)[1].flats[0].labels[1]).toBe("в/о 1-6");
  });
});

describe("состояние проекта", () => {
  const fields = {
    numPages: 26,
    tepPage: "3",
    sections: "1, 2",
    explPicked: { 11: true, 12: true, 13: false },
    finPicked: { 5: true },
    axisLabels: [{ page: 11, flats: [{ code: "1", labels: { 1: "в/о 1-6" } }] }],
    loggias: [{ key: "11|Лоджия (к=0,5)", k: "0,5", areas: { 1: 1.63 }, source: "drawing" }],
    loggiasConfirmed: true,
    wallHeight: "2,72",
    calibrations: { 11: 0.0352778 },
    measureLines: { "1|1|plinth": [{ id: "a", page: 11, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }] },
    manualValues: { "1|3|plinth": "9,5" },
  };

  it("в сохранение попадают только решения и вводы (без вычисляемых полей лоджий)", () => {
    const s = collectState(fields);
    expect(s.explPages).toEqual([11, 12]);
    expect(s.finPages).toEqual([5]);
    expect(s.loggias).toEqual([{ key: "11|Лоджия (к=0,5)", k: "0,5" }]);
    expect(s.tepPage).toBe(3);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("сохранить → восстановить даёт то же самое", () => {
    const back = normalizeState(JSON.parse(JSON.stringify(collectState(fields))));
    expect(back.tepPage).toBe("3");
    expect(back.sections).toBe("1, 2");
    expect(back.explPicked).toEqual({ 11: true, 12: true });
    expect(back.finPicked).toEqual({ 5: true });
    expect(back.loggiasConfirmed).toBe(true);
    expect(back.calibrations).toEqual({ 11: 0.0352778 });
    expect(back.measureLines["1|1|plinth"]).toHaveLength(1);
    expect(back.manualValues).toEqual({ "1|3|plinth": "9,5" });
  });

  it("повреждённые или чужие данные не ломают страницу", () => {
    const back = normalizeState({ numPages: "x", tepPage: "3", sections: 5, explPages: "нет", loggias: [1, null, { key: "a", k: "1" }], measureLines: [], manualValues: 7 });
    expect(back).toMatchObject({ numPages: null, tepPage: "", sections: "", explPicked: {}, loggiasConfirmed: false, measureLines: {}, manualValues: {} });
    expect(back.loggias).toEqual([{ key: "a", k: "1" }]);
    expect(normalizeState(null).axisLabels).toEqual([]);
  });

  it("наименование объекта берётся с титульного листа / штампа", () => {
    const title = 'Стадия: РП - рабочий проект Раздел: АР "Строительство многоэтажных жилых домов (поз.1.6, 1.7) и многоэтажного жилого дома со встроенными коммерческими помещениями (поз.1.5) с инженерными сетями и благоустройством в 1 микрорайоне 26 жилого района г. Усть-Каменогорска, ВКО." АВ/24-11/187-1.6';
    const pages = [{ page: 1, text: title }, { page: 2, text: title }, { page: 3, text: "Общие данные" }];
    expect(findObjectName(pages)).toBe("Строительство многоэтажных жилых домов (поз.1.6, 1.7) и многоэтажного жилого дома со встроенными коммерческими помещениями (поз.1.5) с инженерными сетями и благоустройством в 1 микрорайоне 26 жилого района г. Усть-Каменогорска, ВКО");
    expect(findObjectName([{ page: 1, text: "Общие данные" }])).toBeNull();
  });

  it("позиция дома из штампа", () => {
    const stamp = "ВКО.\" АВ/24-11/187-1.6 Многоэтажный жилой дом Поз. 1.6";
    const pages = [{ page: 1, text: stamp }, { page: 5, text: "План Многоэтажный жилой дом Поз. 1.6 Лист" }, { page: 6, text: "(поз.1.6, 1.7) и жилого дома" }];
    expect(findPosition(pages)).toBe("Многоэтажный жилой дом поз.1.6");
    expect(findPosition([{ page: 1, text: "Общие данные" }])).toBeNull();
  });

  it("список и карта листов", () => {
    expect(pickedList({ 13: true, 5: true, 7: false })).toEqual([5, 13]);
    expect(pickedMap([5, 13])).toEqual({ 5: true, 13: true });
  });

  it("описание сохранённого для пользователя", () => {
    const text = describeState(collectState(fields)).join("; ");
    expect(text).toMatch(/секции: 1, 2/);
    expect(text).toMatch(/линий обмера: 1/);
    expect(text).toMatch(/значений вручную: 1/);
    expect(text).toMatch(/откалибровано листов: 1/);
    expect(text).toMatch(/высота от пола до потолка: 2,72 м/);
    expect(text).toMatch(/подтверждены/);
  });
});
