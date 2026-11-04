// Общие поля форм заявок (бетон, техника) в стиле главной: подпись над полем,
// короткие списки — системный select, длинные — react-select с поиском.
// Стили — из ConcreteRequestPage.module.css (там же вся страница заявки).
import React from 'react';
import Select from 'react-select';
import css from '../ConcreteRequestPage.module.css';

// Общий вид выпадающих списков формы (react-select) — в тон полям ввода.
const selectStyles = {
  control: (base, state) => ({
    ...base,
    minHeight: 48,
    fontSize: 16,
    borderRadius: 10,
    borderColor: state.selectProps['aria-invalid'] ? '#a61b1b' : (state.isFocused ? '#485875' : '#6b7280'),
    boxShadow: state.isFocused ? '0 0 0 3px rgba(72, 88, 117, 0.3)' : 'none',
    backgroundColor: state.isDisabled ? '#eef0f3' : '#fff',
    '&:hover': { borderColor: state.isFocused ? '#485875' : '#4b5563' },
  }),
  valueContainer: (base) => ({ ...base, padding: '0 12px' }),
  // Кнопки «очистить» и «раскрыть» — не уже 44px, как остальные цели нажатия.
  indicatorsContainer: (base) => ({ ...base, alignSelf: 'stretch' }),
  clearIndicator: (base) => ({ ...base, padding: '0 10px', display: 'flex', alignItems: 'center', minWidth: 44, justifyContent: 'center' }),
  dropdownIndicator: (base) => ({ ...base, padding: '0 10px', display: 'flex', alignItems: 'center', minWidth: 44, justifyContent: 'center' }),
  // Подсказка светлее значения (но ≥4,5:1), чтобы пустое поле не выглядело заполненным.
  placeholder: (base, state) => ({ ...base, color: state.isDisabled ? '#5b6472' : '#6b7280' }),
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
const Field = ({ label, required, optional, htmlFor, error, errorId, help, helpId, children }) => (
  <div className={css.field}>
    <label className={css.label} htmlFor={htmlFor}>
      {label}
      {required && (
        <>
          <span className={css.required} aria-hidden='true'>*</span>
          <span className={css.srOnly}> (обязательно)</span>
        </>
      )}
      {optional && <span className={css.optional}> (необязательно)</span>}
    </label>
    {children}
    {help && <span id={helpId} className={css.help}>{help}</span>}
    {error && <span id={errorId} className={css.fieldError}>{error}</span>}
  </div>
);

// Короткие списки (до 6 вариантов) — обычный select: на телефоне это системный
// выбор без клавиатуры и мелких кнопок; длинные — react-select с поиском.
const NATIVE_SELECT_MAX = 6;

// Сенсорный экран (телефон, планшет): системный выбор вместо react-select,
// чтобы не поднималась клавиатура и не прыгала закреплённая панель отправки.
const isCoarsePointer = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

// Выпадающий список, который отдаёт изменения в handleChange как обычный input.
// disabledHint — что написать в неактивном поле, чтобы было ясно, чего оно ждёт.
const SelectField = ({
  label, name, id, required, optional, options, value, onChange, isDisabled = false, disabledHint, error, help
}) => {
  const placeholder = isDisabled && disabledHint ? disabledHint : 'Выберите...';
  // Значение, которого нет в списке (например, из Умной заявки), всё равно показываем.
  const nativeOptions = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <Field label={label} required={required} optional={optional} htmlFor={id} error={error} errorId={`${id}-err`} help={help} helpId={`${id}-help`}>
      {options.length <= NATIVE_SELECT_MAX || isCoarsePointer() ? (
        <select
          id={id}
          name={name}
          className={`${css.input} ${error ? css.inputError : ''}`}
          value={value}
          disabled={isDisabled}
          onChange={(e) => onChange({ target: { name, value: e.target.value } })}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={[help ? `${id}-help` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined}
        >
          <option value=''>{placeholder}</option>
          {nativeOptions.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : (
        <Select
          inputId={id}
          options={options.map((opt) => ({ value: opt, label: opt }))}
          value={value ? { value, label: value } : null}
          onChange={(selected) => onChange({ target: { name, value: selected ? selected.value : '' } })}
          placeholder={placeholder}
          noOptionsMessage={() => 'Нет вариантов'}
          isClearable
          isDisabled={isDisabled}
          menuPlacement='auto'
          styles={selectStyles}
          aria-invalid={error ? true : undefined}
          aria-errormessage={error ? `${id}-err` : undefined}
        />
      )}
    </Field>
  );
};

export { Field, SelectField };
