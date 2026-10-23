import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PageLinks from "./PageLinks";
import { ptoOpenPdfPage } from "./api";

jest.mock("./api", () => ({ ptoOpenPdfPage: jest.fn() }));

beforeEach(() => ptoOpenPdfPage.mockReset());

test("номера листов — ссылки: клик открывает PDF на этом листе", async () => {
  ptoOpenPdfPage.mockResolvedValue();
  render(<PageLinks docId={7} hasFile pages={[{ page: 23, quantity: 92 }, { page: 25, quantity: 92.5 }]} />);
  fireEvent.click(screen.getByRole("button", { name: "25" }));
  await waitFor(() => expect(ptoOpenPdfPage).toHaveBeenCalledWith(7, 25));
  expect(screen.getByRole("button", { name: "23" }).title).toMatch(/Открыть лист 23/);
});

test("работает и с обычным списком номеров листов", () => {
  render(<PageLinks docId={1} hasFile pages={[4, 9]} />);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["4", "9"]);
});

test("файл не сохранён — номера без ссылок, с подсказкой", () => {
  render(<PageLinks docId={1} hasFile={false} pages={[23]} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("23").title).toMatch(/не сохранён/);
});

test("листов много — показываем первые, остальные по клику", () => {
  render(<PageLinks docId={1} hasFile pages={[1, 2, 3, 4, 5, 6, 7, 8]} max={3} />);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["1", "2", "3", "ещё 5"]);
  fireEvent.click(screen.getByRole("button", { name: "ещё 5" }));
  expect(screen.getAllByRole("button")).toHaveLength(8);
});

test("не открылось — ошибка уходит в onError, а не падает", async () => {
  ptoOpenPdfPage.mockRejectedValue(new Error("Файл документа не сохранён"));
  const onError = jest.fn();
  render(<PageLinks docId={1} hasFile pages={[3]} onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "3" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Файл документа не сохранён"));
});

test("листов нет — ничего не показываем", () => {
  const { container } = render(<PageLinks docId={1} hasFile pages={[]} />);
  expect(container).toBeEmptyDOMElement();
});
