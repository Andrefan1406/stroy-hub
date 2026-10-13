// Обновлённый компонент с ограничением времени и даты
import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import Select from 'react-select';
import { getAuth } from 'firebase/auth';
import styles from './RequestPage.module.css';
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

// Стилизованная замена window.confirm() для предупреждения об окне 15:00-17:00
// (см. handleSubmit/handleFinalSubmit) — та же визуальная логика, что и
// модалка подтверждения выходного на странице отчёта по людям
// (см. src/PeopleReportPage.js), только в предупреждающей (красной) палитре,
// т.к. эта модалка не спрашивает подтверждение, а объясняет отказ: заявка не
// отправляется независимо от того, как её закрыть.
const mortarModalStyles = {
  box: {
    position: 'relative',
    background: '#fff',
    padding: '28px 24px 20px',
    borderRadius: '14px',
    width: '360px',
    maxWidth: '90vw',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: '10px',
    boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
  },
  icon: {
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    background: '#fdeaea',
    color: '#c0392b',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '22px',
    marginBottom: '4px',
  },
  title: {
    margin: 0,
    fontSize: '17px',
    color: '#333',
  },
  text: {
    margin: 0,
    fontSize: '14px',
    color: '#555',
    lineHeight: 1.5,
  },
  okBtn: {
    marginTop: '8px',
    padding: '9px 24px',
    background: '#c0392b',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 600,
  },
};

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

// Общий вид выпадающих списков формы (react-select) — в тон обычным полям.
const selectStyles = {
  control: (base, state) => ({
    ...base,
    minHeight: 36,
    fontSize: 14,
    borderRadius: 6,
    borderColor: state.isFocused ? '#1976d2' : '#c8d0da',
    boxShadow: state.isFocused ? '0 0 0 2px rgba(25, 118, 210, 0.15)' : 'none',
    backgroundColor: state.isDisabled ? '#f2f4f7' : '#fff',
  }),
  valueContainer: (base) => ({ ...base, padding: '0 8px' }),
  menu: (base) => ({ ...base, fontSize: 14, zIndex: 20 }),
  singleValue: (base) => ({ ...base, whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' }),
};

// Подпись над полем; звёздочка — поле обязательно для этой строки.
const Field = ({ label, required, children }) => (
  <div className={css.field}>
    <span className={css.label}>
      {label}
      {required && <span className={css.required}>*</span>}
    </span>
    {children}
  </div>
);

// Выпадающий список, который отдаёт изменения в handleChange как обычный input.
const SelectField = ({ label, name, required, options, value, onChange, isDisabled = false }) => (
  <Field label={label} required={required}>
    <Select
      options={options.map((opt) => ({ value: opt, label: opt }))}
      value={value ? { value, label: value } : null}
      onChange={(selected) => onChange({ target: { name, value: selected ? selected.value : '' } })}
      placeholder='Выберите...'
      isClearable
      isDisabled={isDisabled}
      menuPlacement='auto'
      styles={selectStyles}
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
  // Увеличивается после каждой успешно поданной заявки, чтобы таблица
  // неисполненных заявок сразу перезапросила список (см. ConcretePendingRequestsTable).
  const [pendingRefreshSignal, setPendingRefreshSignal] = useState(0);

  useEffect(() => {
    const prefill = location.state?.prefill;
    if (!prefill?.rows?.length) return;
    setFormRows(prefill.rows.map((r) => ({ ...emptyConcreteRow(), ...r })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const addRow = () => {
    setFormRows(prev => [...prev, emptyConcreteRow()]);
  };

  const removeRow = (index) => {
    setFormRows(prev => prev.filter((_, i) => i !== index));
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
  };
  

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Заявка пришла из Умной заявки (SmartRequestPage.jsx) — блокировку по
    // пропускам отчётности для неё не проверяем, см. PeopleGapsGuard.jsx.
    if (!viaSmartRequest) {
      try {
        const missingDates = await fetchMissingGapDates();
        if (missingDates.length) {
          alert(gapWarningMessage(missingDates));
          return;
        }
      } catch (err) {
        // Сама проверка недоступна (сеть/бэкенд) — не блокируем подачу заявки
        // из-за этого, только логируем.
        console.error('Не удалось проверить пропуски в отчётах по людям:', err);
      }
    }

    const hasEmptyRequiredField = formRows.some(row => {
      const activeFields = getActiveRequiredFields(row);
      return activeFields.some(field => !row[field]?.toString().trim());
    });

    if (hasEmptyRequiredField) {
      alert('Пожалуйста, заполните все обязательные поля.');
      return;
    }

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
    setShowModal(true);
  };

  const handleFinalSubmit = async () => {
  const hasEmptyRequiredField = formRows.some(row => {
    const activeFields = getActiveRequiredFields(row);
    return activeFields.some(field => !row[field]?.toString().trim());
  });

  if (hasEmptyRequiredField) {
    alert('Пожалуйста, заполните все обязательные поля.');
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
        alert(gapWarningMessage(missingDates));
        return;
      }
    } catch (err) {
      console.error('Не удалось проверить пропуски в отчётах по людям:', err);
    }
  }

  // продолжение отправки как прежде:
  setIsSubmitting(true);

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

    alert('Заявка отправлена!');
    setShowModal(false);
    setUserName('');
    setUserPhone('');
    setFormRows([emptyConcreteRow()]);

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
    alert('Ошибка при отправке!');
  } finally {
    setIsSubmitting(false);
  }
};

  
  
  const categoryOptions = Object.keys(objectCategoryOptions);

  return (
    <div className={css.page}>
      <h2 className={css.title}>Заявка на бетон или раствор</h2>
      <form onSubmit={handleSubmit}>
        {formRows.map((row, index) => {
          const required = new Set(getActiveRequiredFields(row));
          const onChange = (e) => handleChange(e, index);
          const hasBlocks = !!positionBlockOptions[row.position];
          return (
            <section key={index} className={css.card}>
              <div className={css.cardHeader}>
                <span className={css.cardTitle}>
                  {formRows.length > 1 ? `Заявка ${index + 1}` : 'Заявка'}
                </span>
                {formRows.length > 1 && (
                  <button type='button' className={css.removeLink} onClick={() => removeRow(index)}>
                    Удалить
                  </button>
                )}
              </div>

              <div className={css.grid}>
                <Field label='Дата' required={required.has('date')}>
                  <input
                    type='date'
                    name='date'
                    className={css.input}
                    value={row.date}
                    min={minDate}
                    max={maxDate}
                    onChange={onChange}
                  />
                </Field>

                <Field label='Время' required={required.has('time')}>
                  <select name='time' className={css.input} value={row.time} onChange={onChange}>
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

                <SelectField
                  label='Категория'
                  name='category'
                  required={required.has('category')}
                  options={categoryOptions}
                  value={row.category}
                  onChange={onChange}
                />
                <SelectField
                  label='Объект'
                  name='object'
                  required={required.has('object')}
                  options={objectCategoryOptions[row.category] || []}
                  value={row.object}
                  onChange={onChange}
                  isDisabled={!row.category}
                />
                <SelectField
                  label='Позиция'
                  name='position'
                  required={required.has('position')}
                  options={objectPositionOptions[row.object] || []}
                  value={row.position}
                  onChange={onChange}
                  isDisabled={!row.object}
                />
                <SelectField
                  label='Блок'
                  name='block'
                  required={required.has('block')}
                  options={positionBlockOptions[row.position] || []}
                  value={row.block}
                  onChange={onChange}
                  isDisabled={!row.position || !hasBlocks}
                />
                <SelectField
                  label='Этаж'
                  name='floor'
                  required={required.has('floor')}
                  options={blockFloorOptions[row.block] || []}
                  value={row.floor}
                  onChange={onChange}
                  isDisabled={!row.block || !hasBlocks}
                />
                <SelectField
                  label='Конструктив'
                  name='constructive'
                  required={required.has('constructive')}
                  options={floorConstructiveOptions[row.floor] || []}
                  value={row.constructive}
                  onChange={onChange}
                  isDisabled={!row.floor || !hasBlocks}
                />
                <SelectField
                  label='Материал'
                  name='material'
                  required={required.has('material')}
                  options={MATERIAL_OPTIONS}
                  value={row.material}
                  onChange={onChange}
                  isDisabled={hasBlocks}
                />
                <SelectField
                  label='Марка'
                  name='concreteGrade'
                  required={required.has('concreteGrade')}
                  options={materialGradeOptions[row.material] || []}
                  value={row.concreteGrade}
                  onChange={onChange}
                  isDisabled={!row.material}
                />
                {row.material === 'Бетон' ? (
                  <SelectField
                    label='Подвижность'
                    name='concreteClass'
                    required={required.has('concreteClass')}
                    options={MOBILITY_OPTIONS}
                    value={row.concreteClass}
                    onChange={onChange}
                  />
                ) : (
                  <Field label='Подвижность'>
                    <div className={css.placeholderBox} />
                  </Field>
                )}

                <Field label='Количество, м³' required={required.has('quantity')}>
                  <input
                    type='text'
                    inputMode='decimal'
                    name='quantity'
                    className={css.input}
                    value={row.quantity}
                    onChange={onChange}
                    placeholder='Введите число'
                  />
                </Field>
              </div>

              <div className={css.bottomRow}>
                <fieldset className={css.group}>
                  <legend className={css.groupTitle}>Доверенность</legend>
                  <div className={css.groupGrid}>
                    <Field label='Номер' required>
                      <input
                        type='text'
                        inputMode='numeric'
                        name='poaNumber'
                        className={css.input}
                        value={row.poaNumber}
                        onChange={onChange}
                        placeholder='№'
                      />
                    </Field>
                    <Field label='Дата' required>
                      <input type='date' name='poaDate' className={css.input} value={row.poaDate} onChange={onChange} />
                    </Field>
                    <Field label='ФИО' required>
                      <input
                        type='text'
                        name='poaName'
                        className={css.input}
                        value={row.poaName}
                        onChange={onChange}
                        placeholder='ФИО по доверенности'
                      />
                    </Field>
                  </div>
                </fieldset>

                <Field label='Примечание' required={required.has('note')}>
                  <textarea
                    name='note'
                    className={css.textarea}
                    value={row.note}
                    onChange={onChange}
                    rows={2}
                    placeholder='Введите примечание...'
                  />
                </Field>
              </div>
            </section>
          );
        })}

        <div className={css.actions}>
          <button type='button' onClick={addRow} className={styles.addButton}>Добавить строку</button>
          <button type='submit' className={styles.submitButton}>Отправить заявку</button>
        </div>
      </form>
      <ConcretePendingRequestsTable refreshSignal={pendingRefreshSignal} />
      {showModal && (
        <div className={styles.modalOverlay}>
          <div className={styles.modal}>
            <button className={styles.modalClose} onClick={() => setShowModal(false)}>×</button>

            <h3>Ответственный</h3>

            <label>
              ФИО:
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Введите ФИО"
              />
            </label>

            <label>
              Номер телефона:
              <input
                type="text"
                value={userPhone}
                onChange={(e) => setUserPhone(e.target.value)}
                placeholder="Введите номер"
              />
            </label>

            <button
              className={styles.submitButton}
              onClick={handleFinalSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Отправка...' : 'Отправить заявку'}
            </button>
          </div>
        </div>
      )}

      {showMortarWindowModal && (
        <div className={styles.modalOverlay}>
          <div style={mortarModalStyles.box}>
            <div style={mortarModalStyles.icon}>⛔</div>
            <h3 style={mortarModalStyles.title}>Заявка на завтра недоступна</h3>
            <p style={mortarModalStyles.text}>
              С 15:00 до 17:00 подать заявку на завтра можно только для <strong>раствора</strong>.
              Для <strong>бетона</strong> такой возможности нет — выберите другую дату
              или измените материал на «Раствор».
            </p>
            <button style={mortarModalStyles.okBtn} onClick={() => setShowMortarWindowModal(false)}>
              Понятно
            </button>
          </div>
        </div>
      )}

    </div>
  );
};

export default ConcreteRequestPage;
