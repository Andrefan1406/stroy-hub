import { PTO_ALLOWED_EMAILS, canUsePto } from "./access";
import { fmtMoney, fmtNum, formatSources } from "./format";

test("модуль ПТО виден только admin@vkdev.kz (регистр не важен), остальным — нет", () => {
  expect(PTO_ALLOWED_EMAILS).toEqual(["admin@vkdev.kz"]);
  expect(canUsePto("admin@vkdev.kz")).toBe(true);
  expect(canUsePto("ADMIN@vkdev.kz")).toBe(true);
  expect(canUsePto("nach.bsu@vkdevgroup.kz")).toBe(false);
  expect(canUsePto("")).toBe(false);
  expect(canUsePto(undefined)).toBe(false);
});

test("числа и деньги в русском формате, пустое значение — тире", () => {
  expect(fmtNum(null)).toBe("—");
  expect(fmtNum("")).toBe("—");
  expect(fmtNum(0)).toBe("0");
  expect(fmtNum(1234.5).replace(/\s/g, " ")).toBe("1 234,5");
  expect(fmtMoney(9744750).replace(/\s/g, " ")).toBe("9 744 750 ₸");
  expect(fmtMoney(null)).toBe("—");
});

test("листы-источники: один лист — номером, несколько — с вкладом каждого", () => {
  expect(formatSources([])).toBe("");
  expect(formatSources([{ page: 23, quantity: 92 }])).toBe("23");
  expect(formatSources([{ page: 61, quantity: 43.9 }, { page: 62, quantity: 40.1 }])).toBe("61 (43,9), 62 (40,1)");
});
