import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import MeasureDialog from "./MeasureDialog";
import { metersPerUnitFromScale } from "../takeoff/model";
import plan11 from "./__fixtures__/plan-p11.json";

// Холст из инструмента подсчёта рисует PDF (в тестовой среде canvas нет) — подменяем заглушкой с кнопками,
// которые вызывают те же обратные вызовы, что и настоящий холст.
jest.mock("../takeoff/TakeoffCanvas", () => {
  const React = require("react");
  return function FakeCanvas({ onFinish, onCalibrated, measurements, labelFor, mode, polarStep, deduct }) {
    return (
      <div>
        <div data-testid="canvas-props">{JSON.stringify({ mode, polarStep, deduct })}</div>
        <button onClick={() => onFinish({ kind: "line", points: [{ x: 0, y: 0 }, { x: 25, y: 0 }] })}>нарисовать-короткую</button>
        <button onClick={() => onFinish({ kind: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })}>нарисовать-линию</button>
        <button onClick={() => onFinish({ kind: "rect", points: [{ x: 0, y: 0 }, { x: 100, y: 50 }] })}>нарисовать-прямоугольник</button>
        <button onClick={() => onCalibrated([{ x: 0, y: 0 }, { x: 91, y: 0 }])}>отметить-размер</button>
        <div data-testid="labels">{measurements.map((m) => labelFor(m)).join("|")}</div>
      </div>
    );
  };
});

const plinthTask = { key: "1|1|plinth", code: "1", roomNo: "1", roomName: "Прихожая", kind: "plinth", unit: "м", label: "Устройство плинтуса ПВХ", works: [] };
const wallsTask = { key: "1|11|walls", code: "1", roomNo: "11", roomName: "Лоджия (к=0,5)", kind: "walls", unit: "м²", label: "Площадь стен (длина × высота)", works: [] };

function Harness({ task, initialHeight = "2,72", onState }) {
  const [lines, setLines] = useState([]);
  const [calibrations, setCalibrations] = useState({});
  const [height, setHeight] = useState(initialHeight);
  onState?.({ lines, calibrations });
  return (
    <MeasureDialog
      doc={{}}
      numPages={26}
      task={task}
      flatsHint="Квартира типа 1 на плане: в/о 1-6."
      initialPage={11}
      itemsOf={() => plan11.items}
      lines={lines}
      onLinesChange={setLines}
      calibrations={calibrations}
      onCalibrate={(page, k) => setCalibrations((c) => ({ ...c, [page]: k }))}
      height={height}
      onHeightChange={setHeight}
      onClose={() => {}}
    />
  );
}

describe("окно обмера", () => {
  it("предлагает масштаб по размеру между осями; после принятия линия даёт длину в метрах", () => {
    let state;
    render(<Harness task={plinthTask} onState={(s) => { state = s; }} />);
    expect(screen.getByText(/лист не откалиброван/)).toBeTruthy();
    expect(screen.getByText(/Предложено: масштаб 1:100/)).toBeTruthy();

    fireEvent.click(screen.getByText("Принять масштаб 1:100"));
    expect(state.calibrations[11]).toBeCloseTo(metersPerUnitFromScale(100), 8);
    expect(screen.getByText(/✓ лист откалиброван/)).toBeTruthy();
    expect(screen.queryByText(/Предложено: масштаб/)).toBeNull(); // принято — предложение пропало

    fireEvent.click(screen.getByText(/✏️ Обвести/));
    fireEvent.click(screen.getByText("нарисовать-линию")); // 100 пунктов PDF на листе в масштабе 1:100
    expect(state.lines).toHaveLength(1);
    expect(screen.getByText(/Итого по задаче: 3,53 м/)).toBeTruthy();
    expect(screen.getByTestId("labels").textContent).toBe("3,53 м");

    // вторая линия складывается с первой
    fireEvent.click(screen.getByText("нарисовать-линию"));
    expect(screen.getByText(/Итого по задаче: 7,06 м/)).toBeTruthy();
  });

  it("без калибровки линия не даёт длины и это видно", () => {
    render(<Harness task={plinthTask} />);
    fireEvent.click(screen.getByText(/✏️ Обвести/));
    fireEvent.click(screen.getByText("нарисовать-линию"));
    expect(screen.getByText(/Итого по задаче: —/)).toBeTruthy();
    expect(screen.getByText(/1 лин\. не посчитано/)).toBeTruthy();
  });

  it("калибровка по известному размеру: отрезок 91 пункт = 3,2 м", () => {
    let state;
    render(<Harness task={plinthTask} onState={(s) => { state = s; }} />);
    fireEvent.click(screen.getByText(/📏 Калибровка по размеру/));
    fireEvent.click(screen.getByText("отметить-размер"));
    fireEvent.change(screen.getByPlaceholderText("например 3,2"), { target: { value: "3,2" } });
    fireEvent.click(screen.getByText("Применить"));
    expect(state.calibrations[11]).toBeCloseTo(3.2 / 91, 8);
  });

  it("стены: площадь = длина × высота, высоту можно менять", () => {
    render(<Harness task={wallsTask} />);
    fireEvent.click(screen.getByText("Принять масштаб 1:100"));
    fireEvent.click(screen.getByText(/✏️ Обвести/));
    fireEvent.click(screen.getByText("нарисовать-линию"));
    expect(screen.getByText(/Итого по задаче: 9,60 м²/)).toBeTruthy(); // 3,5277 × 2,72
    fireEvent.change(screen.getByLabelText ? screen.getByDisplayValue("2,72") : screen.getByDisplayValue("2,72"), { target: { value: "3" } });
    expect(screen.getByText(/Итого по задаче: 10,58 м²/)).toBeTruthy(); // 3,5277 × 3
  });

  it("проёмы: вычитаются из площади стен (ширина × высота проёма), высоту можно поправить у каждого", () => {
    render(<Harness task={wallsTask} />);
    fireEvent.click(screen.getByText("Принять масштаб 1:100"));
    fireEvent.click(screen.getByText(/✏️ Обвести стены/));
    expect(JSON.parse(screen.getByTestId("canvas-props").textContent)).toMatchObject({ mode: "line", deduct: false });
    fireEvent.click(screen.getByText("нарисовать-линию")); // стены: 3,5277 × 2,72 = 9,60 м²
    expect(screen.getByText(/Итого по задаче: 9,60 м²/)).toBeTruthy();

    fireEvent.click(screen.getByText(/🚪 Проём/));
    expect(JSON.parse(screen.getByTestId("canvas-props").textContent)).toMatchObject({ mode: "opening", deduct: true });
    fireEvent.click(screen.getByText("нарисовать-короткую")); // дверь: 0,8819 м × 2,1 м = 1,85 м²
    expect(screen.getByText("Проёмы (вычитаются)")).toBeTruthy();
    expect(screen.getByText(/Стены 9,60 − проёмы 1,85 м²/)).toBeTruthy();
    expect(screen.getByText(/Итого по задаче: 7,74 м²/)).toBeTruthy();

    // у окна своя высота: 1,5 м → вычет 1,32 м²
    fireEvent.change(screen.getByLabelText("Высота проёма 1, м"), { target: { value: "1,5" } });
    expect(screen.getByText(/Итого по задаче: 8,27 м²/)).toBeTruthy();
  });

  it("тип проёма подставляет типовую высоту: дверь 2,1, окно 1,5, витраж 1,82 (правится)", () => {
    render(<Harness task={wallsTask} />);
    expect(screen.getByLabelText("Высота проёма, м").value).toBe("2,1");
    fireEvent.change(screen.getByLabelText("Тип проёма"), { target: { value: "window" } });
    expect(screen.getByLabelText("Высота проёма, м").value).toBe("1,5");
    fireEvent.change(screen.getByLabelText("Тип проёма"), { target: { value: "glazing" } });
    expect(screen.getByLabelText("Высота проёма, м").value).toBe("1,82");
  });

  it("прямоугольник по двум точкам: контур по периметру, стены = периметр × высота", () => {
    render(<Harness task={wallsTask} />);
    fireEvent.click(screen.getByText("Принять масштаб 1:100"));
    fireEvent.click(screen.getByText(/▭ Стены прямоугольником/));
    expect(JSON.parse(screen.getByTestId("canvas-props").textContent)).toMatchObject({ mode: "rect" });
    fireEvent.click(screen.getByText("нарисовать-прямоугольник")); // 100×50 пунктов: периметр 300 п. = 10,58 м
    expect(screen.getByText(/Итого по задаче: 28,79 м²/)).toBeTruthy(); // 10,5833 × 2,72
  });

  it("плинтус: проём вычитает только ширину, высота не спрашивается", () => {
    render(<Harness task={plinthTask} />);
    expect(screen.queryByLabelText("Высота проёма, м")).toBeNull();
    fireEvent.click(screen.getByText("Принять масштаб 1:100"));
    fireEvent.click(screen.getByText(/✏️ Обвести/));
    fireEvent.click(screen.getByText("нарисовать-линию")); // 3,53 м
    fireEvent.click(screen.getByText(/🚪 Проём/));
    fireEvent.click(screen.getByText("нарисовать-короткую")); // дверь 0,88 м
    expect(screen.getByText(/Длина 3,53 − проёмы 0,88 м/)).toBeTruthy();
    expect(screen.getByText(/Итого по задаче: 2,65 м/)).toBeTruthy();
  });

  it("площадь марша или площадки: есть «Прямоугольник» по двум точкам, площадь = ширина × длина", () => {
    let state;
    const stairTask = { key: "stairs|flight|stairarea", code: "stairs", roomNo: "flight", roomName: "Марш (типовой)", kind: "stairarea", unit: "м²", label: "Площадь пола (контуры на плане)", common: true, element: true, works: [] };
    render(<Harness task={stairTask} onState={(st) => { state = st; }} />);
    expect(screen.getByText(/⬠ Обвести марш \/ площадку/)).toBeTruthy();
    fireEvent.click(screen.getByText("Принять масштаб 1:100"));
    fireEvent.click(screen.getByText(/▭ Прямоугольник/));
    expect(JSON.parse(screen.getByTestId("canvas-props").textContent).mode).toBe("rect");
    fireEvent.click(screen.getByText("нарисовать-прямоугольник")); // 100×50 пунктов на листе 1:100
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]).toMatchObject({ kind: "area" });
    expect(state.lines[0].points).toHaveLength(4);
    // 100 п. = 3,53 м, 50 п. = 1,76 м → 6,23 м²
    expect(screen.getByText(/Итого по задаче: 6,2\d м²/)).toBeTruthy();
    // второй прямоугольник складывается с первым
    fireEvent.click(screen.getByText("нарисовать-прямоугольник"));
    expect(screen.getByText(/Итого по задаче: 12,4\d м²/)).toBeTruthy();
  });

  it("марш: обводится одна ступень, указывается число ступеней — площадь и подступенки считаются вместе", () => {
    let state;
    const stepsTask = { key: "stairs|flight|steps", code: "stairs", roomNo: "flight", roomName: "Марш (типовой)", kind: "steps", unit: "м²", label: "Ступень и число ступеней", common: true, element: true, works: [] };
    render(<Harness task={stepsTask} onState={(st) => { state = st; }} />);
    fireEvent.click(screen.getByText("Принять масштаб 1:100"));
    fireEvent.click(screen.getByText(/▭ Прямоугольник/));
    fireEvent.click(screen.getByText("нарисовать-прямоугольник")); // ступень 100×50 пунктов = 3,53 × 1,76 м
    expect(state.lines).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Число ступеней для контура 1"), { target: { value: "9" } });
    expect(state.lines[0].count).toBe(9);
    // проступи 3,53 × 1,76 × 9 ≈ 56,0; подступенки 3,53 × 0,15 × 9 ≈ 4,8
    expect(screen.getByText(/проступи 5\d,\d\d м² \+ подступенки 4,\d\d м²/)).toBeTruthy();
    expect(screen.getByText(/Итого по задаче: 6\d,\d\d м²/)).toBeTruthy();
  });

  it("полярное отслеживание: по умолчанию шаг 45°, шаг передаётся холсту и попадает в подсказку", () => {
    render(<Harness task={plinthTask} />);
    expect(JSON.parse(screen.getByTestId("canvas-props").textContent).polarStep).toBe(45);
    expect(screen.getByText(/Удерживайте Shift — линия зафиксируется по углам, кратным 45°/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Шаг полярного отслеживания"), { target: { value: "15" } });
    expect(JSON.parse(screen.getByTestId("canvas-props").textContent).polarStep).toBe(15);
    expect(screen.getByText(/кратным 15°/)).toBeTruthy();
  });
});
