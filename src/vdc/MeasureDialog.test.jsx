import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import MeasureDialog from "./MeasureDialog";
import { metersPerUnitFromScale } from "../takeoff/model";
import plan11 from "./__fixtures__/plan-p11.json";

// Холст из инструмента подсчёта рисует PDF (в тестовой среде canvas нет) — подменяем заглушкой с кнопками,
// которые вызывают те же обратные вызовы, что и настоящий холст.
jest.mock("../takeoff/TakeoffCanvas", () => {
  const React = require("react");
  return function FakeCanvas({ onFinish, onCalibrated, measurements, labelFor }) {
    return (
      <div>
        <button onClick={() => onFinish({ kind: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })}>нарисовать-линию</button>
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
});
