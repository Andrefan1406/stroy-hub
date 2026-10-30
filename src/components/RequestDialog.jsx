// Диалог страницы заявки на бетон: роль dialog, фокус внутрь при открытии и
// назад при закрытии, Tab не уходит за пределы окна, Escape закрывает.
// Используется и формой заявки, и таблицей текущих заявок (удаление строки),
// чтобы окна вели себя одинаково. Цвета приходят от обёртки страницы заявки.
// На телефоне окно следует за видимой областью (visualViewport): когда
// открывается экранная клавиатура, оно остаётся над ней, а не под ней,
// а страница под окном не прокручивается.
import React, { useEffect, useId, useRef } from 'react';
import { TbX } from 'react-icons/tb';
import css from './RequestDialog.module.css';

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])';

const RequestDialog = ({ title, onClose, children }) => {
  const overlayRef = useRef(null);
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

  // Страница под окном не прокручивается.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Окно занимает только видимую часть экрана (над клавиатурой).
  useEffect(() => {
    const vv = window.visualViewport;
    const overlay = overlayRef.current;
    if (!vv || !overlay) return undefined;
    const update = () => {
      overlay.style.top = `${vv.offsetTop}px`;
      overlay.style.height = `${vv.height}px`;
      overlay.style.bottom = 'auto';
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !boxRef.current) return;
    const items = boxRef.current.querySelectorAll(FOCUSABLE);
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
    <div ref={overlayRef} className={css.overlay}>
      <div
        ref={boxRef}
        className={css.dialog}
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <div className={css.head}>
          <h2 id={titleId} className={css.title}>{title}</h2>
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
