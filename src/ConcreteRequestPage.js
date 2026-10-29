// Страница заявки на бетон или раствор. Оформление — в стиле главной
// (ConcreteRequestPage.module.css); логика полей, проверок и отправки прежняя.
import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Select from 'react-select';
import { getAuth } from 'firebase/auth';
import { TbAlertCircle, TbCircleCheck, TbX } from 'react-icons/tb';
import css from './ConcreteRequestPage.module.css';
import {
  objectCategoryOptions,
  objectPositionOptions,
  positionBlockOptions,
  blockFloorOptions,
  floorConstructiveOptions,
  materialGradeOptions
} from './data/constructionData';
import ConcretePendingRequestsTable from './components/ConcretePendingRequestsTable';
import { fetchMissingGapDates, gapWarningMessage } from './peopleGapsGate';

// poaNumber/poaDate/poaName — доверенность на получение бетона (номер,
// дата, ФИО доверенного лица), обязательна в каждой строке. В таблице
// Google пишется в конец строки, после столбцов, которые заполняет
// диспетчер БРУ (см. doPost в Apps Script заявок на бетон).
const emptyConcreteRow = () => ({
  date: '', time: '', category: '', object: '', position: '',
  block: '', floor: '', constructive: '', material: '',
  concreteGrade: '', concreteClass: '', quantity: '',
  poaNumber: '', poaDate: '', poaName: '', note: ''
});

// Названия полей для сообщения «Не заполнено: …» и порядок обхода формы
// (по нему ищется первое пустое поле, куда переводится фокус).
const FIELD_LABELS = {
  date: 'Дата', time: 'Время', category: 'Категория', object: 'Объект',
  position: 'Позиция', block: 'Блок', floor: 'Этаж', constructive: 'Конструктив',
  material: 'Материал', concreteGrade: 'Марка', concreteClass: 'Подвижность',
  quantity: 'Количество', poaNumber: 'Номер доверенности',
  poaDate: 'Дата доверенности', poaName: 'ФИО по доверенности', note: 'Примечание'
};
const FORM_ORDER = Object.keys(FIELD_LABELS);

// «Реализация» — единственная категория без цепочки объект/позиция/блок/
// этаж/конструктив (это не объект строительства, а сбыт), поэтому эти поля
// для неё не обязательны, а примечание — наоборот, обязательно всегда.
const REALIZATION_CATEGORY = 'Реализация';

// Стирает поле-потомок только если оно реально стало невалидным для нового
// значения родителя в цепочке category -> object -> position -> block ->
// floor -> constructive -> material -> concreteGrade/concreteClass.
// Это позволяет ручной правке одного поля не затирать остальные поля,
// заполненные Умной заявкой, если они всё ещё согласованы.
const pruneConcreteChain = (row) => {
  const next = { ...row };

  if (!(objectCategoryOptions[next.category] || []).includes(next.object)) {
    next.object = '';
  }
  if (!(objectPositionOptions[next.object] || []).includes(next.position)) {
    next.position = '';
  }

  const hasBlocks = !!positionBlockOptions[next.position];

  if (!(positionBlockOptions[next.position] || []).includes(next.block)) {
    next.block = '';
  }
  if (!(blockFloorOptions[next.block] || []).includes(next.floor)) {
    next.floor = '';
  }
  if (!(floorConstructiveOptions[next.floor] || []).includes(next.constructive)) {
    next.constructive = '';
  }

  // У «Реализации» позиции нет и не будет — материал там выбирается
  // напрямую, не завязан на позицию/блок, как у остальных категорий.
  if (next.category === REALIZATION_CATEGORY) {
    if (!['Бетон', 'Раствор'].includes(next.material)) {
      next.material = '';
    }
  } else if (!next.position) {
    next.material = '';
  } else if (hasBlocks) {
    next.material = next.constructive
      ? (next.constructive === 'каменная кладка' ? 'Раствор' : 'Бетон')
      : '';
  } else if (!['Бетон', 'Раствор'].includes(next.material)) {
    next.material = '';
  }

  if (!(materialGradeOptions[next.material] || []).includes(next.concreteGrade)) {
    next.concreteGrade = '';
  }
  if (next.material !== 'Бетон') {
    next.concreteClass = '';
  }

  return next;
};

const MATERIAL_OPTIONS = ['Бетон', 'Раствор'];
const MOBILITY_OPTIONS = ['П3', 'П4'];

// Общий вид выпадающих списков формы (react-select) — в тон полям ввода.
const selectStyles = {
  control: (base, state) => ({
    ...base,
    minHeight: 48,
    fontSize: 16,
    borderRadius: 10,
    borderColor: state.selectProps['aria-invalid'] ? '#a61b1b' : (state.isFocused ? '#485875' : '#939ba7'),
    boxShadow: state.isFocused ? '0 0 0 3px rgba(72, 88, 117, 0.3)' : 'none',
    backgroundColor: state.isDisabled ? '#eef0f3' : '#fff',
    '&:hover': { borderColor: state.isFocused ? '#485875' : '#6b7280' },
  }),
  valueContainer: (base) => ({ ...base, padding: '0 12px' }),
  placeholder: (base, state) => ({ ...base, color: state.isDisabled ? '#5b6472' : '#4b5563' }),
  singleValue: (base) => ({ ...base, color: '#1f2937', whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' }),
  option: (base, state) => ({
    ...base,
    fontSize: 16,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    color: state.isSelected ? '#fff' : '#1f2937',
    backgroundColor: state.isSelected ? '#485875' : (state.isFocused ? '#e8ebf0' : '#fff'),
  }),
  menu: (base) => ({ ...base, zIndex: 20 }),
};

// Подпись над полем (настоящий <label>, привязан к полю через htmlFor);
// звёздочка — поле обязательно для этой строки. error — текст под полем.
const Field = ({ label, required, htmlFor, error, errorId, children }) => (
  <div className={css.field}>
    <label className={css.label} htmlFor={htmlFor}>
      {label}
      {required && (
        <>
          <span className={css.required} aria-hidden='true'>*</span>
          <span className={css.srOnly}> (обязательно)</span>
        </>
      )}
    </label>
    {children}
    {error && <span id={errorId} className={css.fieldError}>{error}</span>}
  </div>
);

// Выпадающий список, который отдаёт изменения в handleChange как обычный input.
// disabledHint — что написать в неактивном поле, чтобы было ясно, чего оно ждёт.
const SelectField = ({
  label, name, id, required, options, value, onChange, isDisabled = false, disabledHint, error
}) => (
  <Field label={label} required={required} htmlFor={id} error={error} errorId={`${id}-err`}>
    <Select
      inputId={id}
      options={options.map((opt) => ({ value: opt, label: opt }))}
      value={value ? { value, label: value } : null}
      onChange={(selected) => onChange({ target: { name, value: selected ? selected.value : '' } })}
      placeholder={isDisabled && disabledHint ? disabledHint : 'Выберите...'}
      noOptionsMessage={() => 'Нет вариантов'}
      isClearable
      isDisabled={isDisabled}
      menuPlacement='auto'
      styles={selectStyles}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-err` : undefined}
    />
  </Field>
);

const getActiveRequiredFields = (row) => {
  const activeFields = ['date', 'time', 'category', 'quantity', 'poaNumber', 'poaDate', 'poaName'];

  if (row.category === REALIZATION_CATEGORY) {
    activeFields.push('note');
  } else {
    activeFields.push('object', 'position');
  }

  const hasBlocks = positionBlockOptions[row.position];
  if (hasBlocks) {
    activeFields.push('block', 'floor', 'constructive');
  } else {
    activeFields.push('material');
    if (row.material === 'Бетон') {
      activeFields.push('concreteGrade', 'concreteClass');
    } else if (row.material === 'Раствор') {
      activeFields.push('concreteGrade');
    }
  }

  return activeFields;
};

const pluralRequests = (n) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'заявка';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'заявки';
  return 'заявок';
};

// Диалог: роль dialog, фокус внутрь при открытии и назад при закрытии,
// Tab не уходит за пределы окна, Escape закрывает.
const Dialog = ({ title, onClose, children }) => {
  const boxRef = useRef(null);

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
        aria-labelledby='concrete-dialog-title'
        onKeyDown={handleKeyDown}
      >
        <div className={css.dialogHead}>
          <h3 id='concrete-dialog-title' className={css.dialogTitle}>{title}</h3>
          <button type='button' className={css.dialogClose} onClick={onClose} aria-label='Закрыть' data-dialog-close>
            <TbX aria-hidden='true' />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

const ConcreteRequestPage = () => {
  const location = useLocation();
  // Заявка пришла из Умной заявки (см. SmartRequestPage.jsx: handleProceed) —
  // блокировку по пропускам отчётности для неё не проверяем (handleSubmit/
  // handleFinalSubmit ниже), см. также PeopleGapsGuard.jsx/GprReportGuard.jsx.
  const viaSmartRequest = !!location.state?.viaSmartRequest;
  const [formRows, setFormRows] = useState([emptyConcreteRow()]);

  const [showModal, setShowModal] = useState(false);
  const [showMortarWindowModal, setShowMortarWindowModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [userName, setUserName] = useState('');
  const [userPhone, setUserPhone] = useState('');
  // Сообщение над кнопками вместо window.alert: { kind: 'missing' | 'gap' | 'success', ... }.
  const [notice, setNotice] = useState(null);
  // Не заполненные обязательные поля после попытки отправки: ключи `${строка}:${поле}`.
  const [fieldErrors, setFieldErrors] = useState(() => new Set());
  // id поля, на которое нужно перевести фокус после показа ошибок.
  const [focusId, setFocusId] = useState(null);
  // Ошибка самой отправки — показывается в окне ответственного, данные не теряются.
  const [submitError, setSubmitError] = useState('');
  // Увеличивается после каждой успешно поданной заявки, чтобы таблица
  // неисполненных заявок сразу перезапросила список (см. ConcretePendingRequestsTable).
  const [pendingRefreshSignal, setPendingRefreshSignal] = useState(0);
  const noticeRef = useRef(null);

  useEffect(() => {
    const prefill = location.state?.prefill;
    if (!prefill?.rows?.length) return;
    setFormRows(prefill.rows.map((r) => ({ ...emptyConcreteRow(), ...r })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(focusId);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus({ preventScroll: true });
    }
    setFocusId(null);
  }, [focusId]);

  useEffect(() => {
    if (notice && !focusId && noticeRef.current) {
      noticeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [notice, focusId]);

  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const overmorrow = new Date();
  overmorrow.setDate(today.getDate() + 2);
  const nextWeek = new Date();
  nextWeek.setDate(today.getDate() + 7);
  const formatDate = (date) => date.toISOString().split('T')[0];
  const currentHour = today.getHours();
  const currentTimeInMinutes = today.getHours() * 60 + today.getMinutes();
  // Заявку на завтра обычный (бетонный) поток окна принимает до 15:00; для
  // раствора окно продлено до 17:00 (см. MORTAR_CUTOFF_MINUTES ниже) — но
  // материал выбирается в строке ПОСЛЕ даты, поэтому сам date-picker не может
  // заранее знать, раствор это будет или бетон. Разруливаем так: сам инпут
  // даты остаётся permissive до более позднего (раствор) окна — 17:00, чтобы
  // не мешать выбрать "завтра" тем, кто дальше укажет раствор, — а то, что
  // бетон на "завтра" в 15:00-17:00 на самом деле недопустим, проверяется
  // отдельно при отправке (см. handleSubmit/handleFinalSubmit).
  const CONCRETE_CUTOFF_MINUTES = 15 * 60;
  const MORTAR_CUTOFF_MINUTES = 17 * 60;
  const isMortarWindowOpen = currentTimeInMinutes >= 0 && currentTimeInMinutes <= MORTAR_CUTOFF_MINUTES;
  const isMortarExtensionWindow = currentTimeInMinutes > CONCRETE_CUTOFF_MINUTES && currentTimeInMinutes <= MORTAR_CUTOFF_MINUTES;

  const auth = getAuth();
  const currentUserEmail = auth.currentUser?.email?.toLowerCase();
  const hasUnrestrictedTodayAccess = currentUserEmail === 'd.salangin@vkdevgroup.kz';

  const minDate = hasUnrestrictedTodayAccess
    ? formatDate(today)
    : (isMortarWindowOpen ? formatDate(tomorrow) : formatDate(overmorrow));
  const maxDate = formatDate(nextWeek);
  const todayStr = formatDate(today);
  const tomorrowStr = formatDate(tomorrow);

  // Правило окна подачи — заранее, а не после неудачной отправки.
  let cutoffHint = 'Заявки на завтра принимаются до 15:00, на раствор — до 17:00.';
  if (hasUnrestrictedTodayAccess) {
    cutoffHint = '';
  } else if (isMortarExtensionWindow) {
    cutoffHint = 'Сейчас 15:00–17:00: на завтра принимаются только заявки на раствор.';
  } else if (!isMortarWindowOpen) {
    cutoffHint = 'Приём заявок на завтра закрыт, ближайшая дата — послезавтра.';
  }

  const addRow = () => {
    setFormRows(prev => [...prev, emptyConcreteRow()]);
  };

  const removeRow = (index) => {
    setFormRows(prev => prev.filter((_, i) => i !== index));
    setFieldErrors(new Set());
  };

  const handleChange = (e, index) => {
    const { name, value } = e.target;
    const chainFields = ['category', 'object', 'position', 'block', 'floor', 'constructive', 'material'];
    setFormRows(prevRows => {
      const updatedRows = [...prevRows];
      let row = { ...updatedRows[index] };

      if (name === 'quantity') {
        const regex = /^\d{0,6}([.,]\d?)?$/;
        if (value === '' || regex.test(value)) {
          row.quantity = value;
        }
      } else if (name === 'poaNumber') {
        // Номер доверенности — целое число, только цифры.
        if (/^\d{0,10}$/.test(value)) {
          row.poaNumber = value;
        }
      } else {
        row[name] = value;
        if (chainFields.includes(name)) {
          row = pruneConcreteChain(row);
        }
      }

      updatedRows[index] = row;
      return updatedRows;
    });

    // Поле тронули — его пометка об ошибке снимается; когда пометок не
    // осталось, уходит и сообщение «Не заполнено».
    if (fieldErrors.has(`${index}:${name}`)) {
      const next = new Set(fieldErrors);
      next.delete(`${index}:${name}`);
      setFieldErrors(next);
      if (!next.size && notice?.kind === 'missing') setNotice(null);
    }
  };

  // Не заполненные обязательные поля всех строк, в порядке обхода формы.
  const findMissingFields = () => {
    const missing = [];
    formRows.forEach((row, index) => {
      getActiveRequiredFields(row).forEach((field) => {
        if (!row[field]?.toString().trim()) missing.push({ index, field });
      });
    });
    missing.sort((a, b) => a.index - b.index || FORM_ORDER.indexOf(a.field) - FORM_ORDER.indexOf(b.field));
    return missing;
  };

  const showMissingFields = (missing) => {
    setFieldErrors(new Set(missing.map((m) => `${m.index}:${m.field}`)));
    const byRow = new Map();
    missing.forEach((m) => {
      if (!byRow.has(m.index)) byRow.set(m.index, []);
      byRow.get(m.index).push(FIELD_LABELS[m.field]);
    });
    setNotice({
      kind: 'missing',
      count: missing.length,
      rows: [...byRow.entries()].map(([index, labels]) => ({ index, labels })),
    });
    setShowModal(false);
    setFocusId(`r${missing[0].index}-${missing[0].field}`);
  };

  const showGapNotice = (missingDates) => {
    setNotice({ kind: 'gap', message: gapWarningMessage(missingDates) });
    setShowModal(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setNotice(null);

    // Заявка пришла из Умной заявки (SmartRequestPage.jsx) — блокировку по
    // пропускам отчётности для неё не проверяем, см. PeopleGapsGuard.jsx.
    if (!viaSmartRequest) {
      try {
        const missingDates = await fetchMissingGapDates();
        if (missingDates.length) {
          showGapNotice(missingDates);
          return;
        }
      } catch (err) {
        // Сама проверка недоступна (сеть/бэкенд) — не блокируем подачу заявки
        // из-за этого, только логируем.
        console.error('Не удалось проверить пропуски в отчётах по людям:', err);
      }
    }

    const missing = findMissingFields();
    if (missing.length) {
      showMissingFields(missing);
      return;
    }
    setFieldErrors(new Set());

    // С 15:00 до 17:00 "завтра" в date-picker доступно всем (см. minDate
    // выше), но на самом деле это окно продлено только для раствора — для
    // бетона по-прежнему действует старая граница 15:00. Ловим это здесь,
    // когда материал уже точно выбран.
    if (!hasUnrestrictedTodayAccess && isMortarExtensionWindow) {
      const hasInvalidConcreteRow = formRows.some(
        (row) => row.date === tomorrowStr && row.material !== 'Раствор'
      );
      if (hasInvalidConcreteRow) {
        setShowMortarWindowModal(true);
        return;
      }
    }

    // ✅ Только если всё ок — открываем модалку
    setSubmitError('');
    setShowModal(true);
  };

  const handleFinalSubmit = async () => {
  const missing = findMissingFields();
  if (missing.length) {
    showMissingFields(missing);
    return;
  }

  // То же самое ограничение окна 15:00-17:00 для раствора/бетона, что и в
  // handleSubmit — дублируем здесь по той же причине, что и ниже для
  // проверки пропусков: эта кнопка вызывается напрямую из модалки.
  if (!hasUnrestrictedTodayAccess && isMortarExtensionWindow) {
    const hasInvalidConcreteRow = formRows.some(
      (row) => row.date === tomorrowStr && row.material !== 'Раствор'
    );
    if (hasInvalidConcreteRow) {
      setShowModal(false);
      setShowMortarWindowModal(true);
      return;
    }
  }

  // Последний рубеж перед фактической отправкой (сам POST в Google Apps
  // Script ниже) — handleSubmit проверяет то же самое до открытия модалки,
  // но эта кнопка вызывается напрямую из модалки и должна быть защищена
  // независимо от того, что произошло на предыдущем шаге. viaSmartRequest —
  // см. комментарий в handleSubmit.
  if (!viaSmartRequest) {
    try {
      const missingDates = await fetchMissingGapDates();
      if (missingDates.length) {
        showGapNotice(missingDates);
        return;
      }
    } catch (err) {
      console.error('Не удалось проверить пропуски в отчётах по людям:', err);
    }
  }

  // продолжение отправки как прежде:
  setIsSubmitting(true);
  setSubmitError('');

  const payload = formRows.map(row => ({
    date: row.date,
    time: row.time,
    category: row.category,
    object: row.object,
    position: row.position,
    block: row.block,
    floor: row.floor,
    constructive: row.constructive,
    material: row.material,
    concreteGrade: row.concreteGrade,
    concreteClass: row.concreteClass,
    quantity: parseFloat((row.quantity || '').replace(',', '.')),
    poaNumber: parseInt(row.poaNumber, 10),
    poaDate: row.poaDate,
    poaName: row.poaName.trim(),
    note: row.note,
    responsibleName: userName,
    responsiblePhone: userPhone
  }));

  try {
    await fetch('https://script.google.com/macros/s/AKfycbx9_aWErej5qsHUaY_x8k0D7mrPYRcY-1WqdI2zge39VZoADllt7Xv12cxdys72-4U/exec', {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });

    setNotice({ kind: 'success', count: formRows.length });
    setShowModal(false);
    setUserName('');
    setUserPhone('');
    setFormRows([emptyConcreteRow()]);
    setFieldErrors(new Set());

    // Заявка ушла напрямую в Google Apps Script, а не через наш бэкенд —
    // просим сервер пересинкать таблицу немедленно, не дожидаясь планового
    // синка, и только потом обновляем список неисполненных заявок.
    try {
      await fetch(`${(process.env.REACT_APP_CONCRETE_CHAT_API_URL || 'http://localhost:4000')}/api/concrete-board/resync`, {
        method: 'POST',
      });
    } catch (resyncError) {
      console.error('Не удалось пересинхронизировать таблицу заявок:', resyncError);
    }
    setPendingRefreshSignal((prev) => prev + 1);
  } catch (error) {
    console.error('Ошибка отправки:', error);
    setSubmitError('Заявка не отправлена: нет связи с сервером. Данные сохранены, нажмите «Отправить заявку» ещё раз, когда появится связь.');
  } finally {
    setIsSubmitting(false);
  }
};

  const categoryOptions = Object.keys(objectCategoryOptions);

  const totalQuantity = formRows.reduce((sum, row) => {
    const n = parseFloat((row.quantity || '').replace(',', '.'));
    return Number.isNaN(n) ? sum : sum + n;
  }, 0);

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to='/' className={css.back}>← На главную</Link>
        <h1 className={css.title}>Заявка на бетон или раствор</h1>
        {cutoffHint && <p className={css.subtitle}>{cutoffHint}</p>}

        <form onSubmit={handleSubmit} noValidate>
          {formRows.map((row, index) => {
            const required = new Set(getActiveRequiredFields(row));
            const onChange = (e) => handleChange(e, index);
            const hasBlocks = !!positionBlockOptions[row.position];
            const idOf = (name) => `r${index}-${name}`;
            const errorOf = (name) => (fieldErrors.has(`${index}:${name}`) ? 'Заполните поле' : undefined);
            const inputProps = (name) => ({
              id: idOf(name),
              name,
              onChange,
              'aria-required': required.has(name) || undefined,
              'aria-invalid': errorOf(name) ? true : undefined,
              'aria-describedby': errorOf(name) ? `${idOf(name)}-err` : undefined,
            });
            const inputClass = (name) => `${css.input} ${errorOf(name) ? css.inputError : ''}`;
            const notNeeded = !!row.position && !hasBlocks;
            return (
              <section key={index} className={css.card} aria-label={formRows.length > 1 ? `Заявка ${index + 1}` : 'Заявка'}>
                <div className={css.cardHeader}>
                  <h2 className={css.cardTitle}>
                    {formRows.length > 1 ? `Заявка ${index + 1}` : 'Заявка'}
                  </h2>
                  {formRows.length > 1 && (
                    <button type='button' className={css.removeBtn} onClick={() => removeRow(index)}>
                      Удалить
                    </button>
                  )}
                </div>

                <div role='group' aria-labelledby={idOf('g-when')} className={css.group}>
                  <h3 id={idOf('g-when')} className={css.groupTitle}>Когда</h3>
                  <div className={css.gridWhen}>
                    <Field label='Дата' required={required.has('date')} htmlFor={idOf('date')} error={errorOf('date')} errorId={`${idOf('date')}-err`}>
                      <input
                        type='date'
                        className={inputClass('date')}
                        value={row.date}
                        min={minDate}
                        max={maxDate}
                        {...inputProps('date')}
                      />
                    </Field>

                    <Field label='Время' required={required.has('time')} htmlFor={idOf('time')} error={errorOf('time')} errorId={`${idOf('time')}-err`}>
                      <select className={inputClass('time')} value={row.time} {...inputProps('time')}>
                        <option value=''>--</option>
                        {[...Array(24)].map((_, h) => {
                          const hourStr = `${h.toString().padStart(2, '0')}:00`;
                          const isDisabled = row.date === todayStr && h <= currentHour;
                          return (
                            <option key={h} value={hourStr} disabled={isDisabled}>
                              {hourStr}
                            </option>
                          );
                        })}
                      </select>
                    </Field>
                  </div>
                </div>

                <div role='group' aria-labelledby={idOf('g-where')} className={css.group}>
                  <h3 id={idOf('g-where')} className={css.groupTitle}>Куда</h3>
                  <div className={css.gridWhere}>
                    <SelectField
                      label='Категория'
                      name='category'
                      id={idOf('category')}
                      required={required.has('category')}
                      options={categoryOptions}
                      value={row.category}
                      onChange={onChange}
                      error={errorOf('category')}
                    />
                    <SelectField
                      label='Объект'
                      name='object'
                      id={idOf('object')}
                      required={required.has('object')}
                      options={objectCategoryOptions[row.category] || []}
                      value={row.object}
                      onChange={onChange}
                      isDisabled={!row.category}
                      disabledHint='Сначала выберите категорию'
                      error={errorOf('object')}
                    />
                    <SelectField
                      label='Позиция'
                      name='position'
                      id={idOf('position')}
                      required={required.has('position')}
                      options={objectPositionOptions[row.object] || []}
                      value={row.position}
                      onChange={onChange}
                      isDisabled={!row.object}
                      disabledHint='Сначала выберите объект'
                      error={errorOf('position')}
                    />
                    <SelectField
                      label='Блок'
                      name='block'
                      id={idOf('block')}
                      required={required.has('block')}
                      options={positionBlockOptions[row.position] || []}
                      value={row.block}
                      onChange={onChange}
                      isDisabled={!row.position || !hasBlocks}
                      disabledHint={notNeeded ? 'Для этой позиции не нужен' : 'Сначала выберите позицию'}
                      error={errorOf('block')}
                    />
                    <SelectField
                      label='Этаж'
                      name='floor'
                      id={idOf('floor')}
                      required={required.has('floor')}
                      options={blockFloorOptions[row.block] || []}
                      value={row.floor}
                      onChange={onChange}
                      isDisabled={!row.block || !hasBlocks}
                      disabledHint={notNeeded ? 'Для этой позиции не нужен' : 'Сначала выберите блок'}
                      error={errorOf('floor')}
                    />
                    <SelectField
                      label='Конструктив'
                      name='constructive'
                      id={idOf('constructive')}
                      required={required.has('constructive')}
                      options={floorConstructiveOptions[row.floor] || []}
                      value={row.constructive}
                      onChange={onChange}
                      isDisabled={!row.floor || !hasBlocks}
                      disabledHint={notNeeded ? 'Для этой позиции не нужен' : 'Сначала выберите этаж'}
                      error={errorOf('constructive')}
                    />
                  </div>
                </div>

                <div role='group' aria-labelledby={idOf('g-what')} className={css.group}>
                  <h3 id={idOf('g-what')} className={css.groupTitle}>Что и сколько</h3>
                  <div className={css.gridWhat}>
                    <SelectField
                      label='Материал'
                      name='material'
                      id={idOf('material')}
                      required={required.has('material')}
                      options={MATERIAL_OPTIONS}
                      value={row.material}
                      onChange={onChange}
                      isDisabled={hasBlocks}
                      disabledHint='Определяется по конструктиву'
                      error={errorOf('material')}
                    />
                    <SelectField
                      label='Марка'
                      name='concreteGrade'
                      id={idOf('concreteGrade')}
                      required={required.has('concreteGrade')}
                      options={materialGradeOptions[row.material] || []}
                      value={row.concreteGrade}
                      onChange={onChange}
                      isDisabled={!row.material}
                      disabledHint='Сначала выберите материал'
                      error={errorOf('concreteGrade')}
                    />
                    {row.material === 'Бетон' ? (
                      <SelectField
                        label='Подвижность'
                        name='concreteClass'
                        id={idOf('concreteClass')}
                        required={required.has('concreteClass')}
                        options={MOBILITY_OPTIONS}
                        value={row.concreteClass}
                        onChange={onChange}
                        error={errorOf('concreteClass')}
                      />
                    ) : (
                      <Field label='Подвижность' htmlFor={idOf('concreteClass-na')}>
                        <input
                          id={idOf('concreteClass-na')}
                          className={css.input}
                          value=''
                          placeholder='Только для бетона'
                          disabled
                          readOnly
                        />
                      </Field>
                    )}

                    <Field label='Количество, м³' required={required.has('quantity')} htmlFor={idOf('quantity')} error={errorOf('quantity')} errorId={`${idOf('quantity')}-err`}>
                      <input
                        type='text'
                        inputMode='decimal'
                        className={inputClass('quantity')}
                        value={row.quantity}
                        placeholder='Например, 12,5'
                        autoComplete='off'
                        {...inputProps('quantity')}
                      />
                    </Field>
                  </div>
                </div>

                <div className={css.bottomRow}>
                  <div role='group' aria-labelledby={idOf('g-poa')} className={css.group}>
                    <h3 id={idOf('g-poa')} className={css.groupTitle}>Доверенность на получение</h3>
                    <div className={css.gridPoa}>
                      <Field label='Номер' required htmlFor={idOf('poaNumber')} error={errorOf('poaNumber')} errorId={`${idOf('poaNumber')}-err`}>
                        <input
                          type='text'
                          inputMode='numeric'
                          className={inputClass('poaNumber')}
                          value={row.poaNumber}
                          placeholder='№'
                          autoComplete='off'
                          {...inputProps('poaNumber')}
                        />
                      </Field>
                      <Field label='Дата' required htmlFor={idOf('poaDate')} error={errorOf('poaDate')} errorId={`${idOf('poaDate')}-err`}>
                        <input type='date' className={inputClass('poaDate')} value={row.poaDate} {...inputProps('poaDate')} />
                      </Field>
                      <Field label='ФИО' required htmlFor={idOf('poaName')} error={errorOf('poaName')} errorId={`${idOf('poaName')}-err`}>
                        <input
                          type='text'
                          className={inputClass('poaName')}
                          value={row.poaName}
                          placeholder='ФИО по доверенности'
                          autoComplete='off'
                          {...inputProps('poaName')}
                        />
                      </Field>
                    </div>
                  </div>

                  <div className={css.group}>
                    <Field label='Примечание' required={required.has('note')} htmlFor={idOf('note')} error={errorOf('note')} errorId={`${idOf('note')}-err`}>
                      <textarea
                        className={`${css.textarea} ${errorOf('note') ? css.inputError : ''}`}
                        value={row.note}
                        rows={3}
                        placeholder='Введите примечание...'
                        {...inputProps('note')}
                      />
                    </Field>
                  </div>
                </div>
              </section>
            );
          })}

          {notice && (
            <div
              ref={noticeRef}
              className={notice.kind === 'success' ? css.noticeOk : css.noticeError}
              role={notice.kind === 'success' ? 'status' : 'alert'}
            >
              <p className={css.noticeTitle}>
                {notice.kind === 'success'
                  ? <TbCircleCheck className={css.noticeIcon} aria-hidden='true' />
                  : <TbAlertCircle className={css.noticeIcon} aria-hidden='true' />}
                {notice.kind === 'missing' && `Не заполнено полей: ${notice.count}`}
                {notice.kind === 'gap' && 'Заявку пока нельзя отправить'}
                {notice.kind === 'success' && (notice.count > 1 ? 'Заявки отправлены' : 'Заявка отправлена')}
              </p>
              {notice.kind === 'missing' && (
                <ul className={css.noticeList}>
                  {notice.rows.map((r) => (
                    <li key={r.index}>
                      {formRows.length > 1 ? `Заявка ${r.index + 1}: ` : ''}{r.labels.join(', ')}
                    </li>
                  ))}
                </ul>
              )}
              {notice.kind === 'gap' && (
                <>
                  <p className={css.noticeText}>{notice.message}</p>
                  <Link to='/people-report' className={css.noticeAction}>Заполнить отчёт по людям →</Link>
                </>
              )}
              {notice.kind === 'success' && (
                <>
                  <p className={css.noticeText}>Проверьте её в списке «Текущие заявки» ниже.</p>
                  <a href='#current-requests' className={css.noticeAction}>Перейти к списку ↓</a>
                </>
              )}
            </div>
          )}

          <div className={css.actions}>
            <button type='button' onClick={addRow} className={css.btnSecondary}>Добавить ещё одну заявку</button>
            <button type='submit' className={css.btnPrimary}>Отправить заявку</button>
          </div>
        </form>

        <div id='current-requests'>
          <ConcretePendingRequestsTable refreshSignal={pendingRefreshSignal} />
        </div>
      </div>

      {showModal && (
        <Dialog title='Ответственный' onClose={() => setShowModal(false)}>
          <p className={css.dialogSummary}>
            {formRows.length} {pluralRequests(formRows.length)}
            {totalQuantity > 0 && ` · ${totalQuantity.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м³`}
          </p>

          <div className={css.field}>
            <label className={css.label} htmlFor='responsible-name'>ФИО</label>
            <input
              id='responsible-name'
              type='text'
              className={css.input}
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder='Введите ФИО'
              autoComplete='name'
            />
          </div>

          <div className={css.field}>
            <label className={css.label} htmlFor='responsible-phone'>Номер телефона</label>
            <input
              id='responsible-phone'
              type='tel'
              inputMode='tel'
              className={css.input}
              value={userPhone}
              onChange={(e) => setUserPhone(e.target.value)}
              placeholder='Введите номер'
              autoComplete='tel'
            />
          </div>

          {submitError && (
            <div className={css.noticeError} role='alert'>
              <p className={css.noticeTitle}>
                <TbAlertCircle className={css.noticeIcon} aria-hidden='true' />
                Не отправлено
              </p>
              <p className={css.noticeText}>{submitError}</p>
            </div>
          )}

          <button
            type='button'
            className={css.btnPrimary}
            onClick={handleFinalSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Отправка...' : 'Отправить заявку'}
          </button>
        </Dialog>
      )}

      {showMortarWindowModal && (
        <Dialog title='Заявка на завтра недоступна' onClose={() => setShowMortarWindowModal(false)}>
          <p className={css.dialogText}>
            С 15:00 до 17:00 подать заявку на завтра можно только для <strong>раствора</strong>.
            Для <strong>бетона</strong> такой возможности нет — выберите другую дату
            или измените материал на «Раствор».
          </p>
          <button type='button' className={css.btnPrimary} onClick={() => setShowMortarWindowModal(false)}>
            Понятно
          </button>
        </Dialog>
      )}

    </div>
  );
};

export default ConcreteRequestPage;
