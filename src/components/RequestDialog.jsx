// Диалог страницы заявки на бетон: роль dialog, фокус внутрь при открытии и
// назад при закрытии, Tab не уходит за пределы окна, Escape закрывает.
// Используется и формой заявки, и таблицей текущих заявок (удаление строки),
// чтобы окна вели себя одинаково. Цвета приходят от обёртки страницы заявки.
import React, { useEffect, useId, useRef } from 'react';
import { TbX } from 'react-icons/tb';
import css from './RequestDialog.module.css';

const RequestDialog = ({ title, onClose, children }) => {
  const boxRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement;
    const box = boxRef.current;
    const first = box && box.querySelector('input, select, textarea, button:not([data-dialog-close])');
    if (first) first.focus();
    return () => {
      if (previous && previous.focus) previous.focus();
    };
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !boxRef.current) return;
    const items = boxRef.current.querySelectorAll('input, select, textarea, button:not([disabled])');
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

  return (
    <div className={css.overlay}>
      <div
        ref={boxRef}
        className={css.dialog}
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <div className={css.head}>
          <h3 id={titleId} className={css.title}>{title}</h3>
          <button type='button' className={css.close} onClick={onClose} aria-label='Закрыть' data-dialog-close>
            <TbX aria-hidden='true' />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

export default RequestDialog;
