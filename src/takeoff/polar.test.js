import { polarAngle, snapPolar } from "./polar";

const last = { x: 100, y: 100 };
const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

describe("полярное отслеживание", () => {
  it("шаг 90° (и без шага) — прежнее поведение: горизонталь или вертикаль", () => {
    expect(snapPolar({ x: 180, y: 110 }, last, 90)).toEqual({ x: 180, y: 100 });
    expect(snapPolar({ x: 110, y: 180 }, last)).toEqual({ x: 100, y: 180 });
    expect(snapPolar({ x: 5, y: 5 }, null, 45)).toEqual({ x: 5, y: 5 });
  });

  it("шаг 45°: почти диагональный курсор ложится на диагональ", () => {
    const p = snapPolar({ x: 190, y: 175 }, last, 45); // курсор ≈ 40° вниз-вправо
    expect(p.x - last.x).toBeCloseTo(p.y - last.y, 6); // ровно 45°
    expect(p.x).toBeGreaterThan(last.x);
    expect(p.y).toBeGreaterThan(last.y);
  });

  it("шаг 45°: почти горизонтальный курсор — строго горизонталь; длина — проекция на луч", () => {
    const p = snapPolar({ x: 200, y: 108 }, last, 45);
    expect(p.y).toBeCloseTo(100, 6);
    expect(p.x).toBeCloseTo(200, 0); // проекция почти равна исходному смещению
  });

  it("шаг 15°: 30° остаётся 30°, а 36° уходит на 30°", () => {
    const at = (deg) => ({ x: last.x + 100 * Math.cos((deg * Math.PI) / 180), y: last.y - 100 * Math.sin((deg * Math.PI) / 180) });
    expect(polarAngle(last, snapPolar(at(30), last, 15))).toBeCloseTo(30, 6);
    expect(polarAngle(last, snapPolar(at(36), last, 15))).toBeCloseTo(30, 6);
    expect(polarAngle(last, snapPolar(at(40), last, 15))).toBeCloseTo(45, 6);
  });

  it("угол как в CAD: вверх по листу — 90°, влево — 180°, вниз — 270°", () => {
    expect(polarAngle(last, { x: 100, y: 50 })).toBeCloseTo(90, 6);
    expect(polarAngle(last, { x: 50, y: 100 })).toBeCloseTo(180, 6);
    expect(polarAngle(last, { x: 100, y: 150 })).toBeCloseTo(270, 6);
    expect(polarAngle(last, { x: 150, y: 100 })).toBeCloseTo(0, 6);
  });

  it("совпавшая с началом точка не ломает расчёт", () => {
    expect(snapPolar({ x: 100, y: 100 }, last, 45)).toEqual({ x: 100, y: 100 });
    expect(len(last, snapPolar({ x: 130, y: 100 }, last, 30))).toBeCloseTo(30, 6);
  });
});
