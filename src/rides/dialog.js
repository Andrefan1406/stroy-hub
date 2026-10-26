// Общее поведение модальных окон системы поездок: фокус внутрь при открытии,
// Tab не уходит за пределы окна, Escape закрывает, по закрытии фокус
// возвращается туда, откуда окно открыли (кнопка «Отменить заявку» и т.п.).
import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// initialFocus: "first" — первый интерактивный элемент (или [data-autofocus]);
// "container" — само окно: в окне карты фокус в поле ввода открыл бы на
// телефоне клавиатуру и сжал карту.
export function useDialog(onClose, { initialFocus = "first" } = {}) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    const node = ref.current;
    const first = initialFocus === "container" ? null : node?.querySelector("[data-autofocus]") || node?.querySelector(FOCUSABLE);
    (first || node)?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ref;
}
