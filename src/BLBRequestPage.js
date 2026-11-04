// Заявка на брусчатку, лотки и бордюры. Оформление — в стиле заявок на бетон и
// технику (ConcreteRequestPage.module.css): карточки «Когда / Куда / Что и сколько»,
// ошибки и подсказки на странице, окна — components/RequestDialog. Подбор марки по
// серии/цвету/размерам, правило «не раньше чем через 14 дней» и отправка — прежние.
import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { TbAlertCircle, TbInfoCircle } from 'react-icons/tb';
import css from './ConcreteRequestPage.module.css';
import {
  objectCategoryOptions,
  objectPositionOptions,
  positionBlockOptions
} from './data/constructionData';
import Dialog from './components/RequestDialog';
import { Field, SelectField } from './components/RequestFormFields';

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyMz5pFG3eMxFU-W5bYcPEmYCySf2mNsrLSYYFCfLqY6p5-fuNSySuFKmUohEImS_F_zQ/exec';
// Ответ скрипта прочитать нельзя (no-cors): зависшую отправку обрываем сами
// и просим убедиться, что заявка не дошла, прежде чем отправлять повторно.
const SEND_TIMEOUT_MS = 20000;
const MIN_DAYS_AHEAD = 14;

// Контакты ответственного запоминаем на этом устройстве.
const RESPONSIBLE_KEY = 'brickRequestResponsible';
const loadResponsible = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(RESPONSIBLE_KEY) || '{}');
    return { name: saved.name || '', phone: saved.phone || '' };
  } catch {
    return { name: '', phone: '' };
  }
};

// Справочники для второй группы
const productBrandOptions = {
  'Брусчатка': ['Б.1.П.7', 'Б.2.П.7', 'Б.3.П.7', 'Б.5.П.7', 'Б.6.П.7', 'Б.7.П.7', 'Б.8.П.7',
    'Б.9.П.7', 'Б.10.П.7', 'Б.11.П.7', 'Б.12.П.7', 'Б.13.П.7', 'Б.14.П.7', 'Б.15.П.7'],
  'Бордюр': ['БР 100.30.15'],
  'Лоток': ['50.25.9']
};

const brandSeriesOption = {
  'Б.1.П.7': ['Новый город'], 'Б.10.П.7': ['Крупноформат'], 'Б.11.П.7': ['Крупноформат'],
  'Б.12.П.7': ['Крупноформат'], 'Б.13.П.7': ['Старый Город'], 'Б.14.П.7': ['Старый Город'],
  'Б.15.П.7': ['Старый Город'], 'Б.2.П.7': ['Новый город'], 'Б.3.П.7': ['Новый город'],
  'Б.5.П.7': ['Классика'], 'Б.6.П.7': ['Крупноформат'], 'Б.7.П.7': ['Крупноформат'],
  'Б.8.П.7': ['Крупноформат'], 'Б.9.П.7': ['Крупноформат']
};

const branColorsOption = {
  'Б.1.П.7': 'Серый', 'Б.2.П.7': 'Белый', 'Б.3.П.7': 'Черный', 'Б.6.П.7': 'Серый',
  'Б.7.П.7': 'Белый', 'Б.8.П.7': 'Черный', 'Б.12.П.7': 'Красный', 'Б.9.П.7': 'Серый',
  'Б.10.П.7': 'Белый', 'Б.11.П.7': 'Черный', 'Б.5.П.7': 'Серый', 'Б.13.П.7': 'Белый',
  'Б.14.П.7': 'Черный', 'Б.15.П.7': 'Серый'
};

const branDimensionsOption = {
  'Б.1.П.7': ['160*160*7,\n160*200*7,\n160*240*7'], 'Б.10.П.7': ['320*320*7'],
  'Б.11.П.7': ['320*320*7'], 'Б.12.П.7': ['320*160*7'], 'Б.13.П.7': ['120*120*7,\n120*90*7,\n180*120*7'],
  'Б.14.П.7': ['120*120*7,\n120*90*7,\n180*120*7'], 'Б.15.П.7': ['120*120*7,\n120*90*7,\n180*120*7'],
  'Б.2.П.7': ['160*160*7,\n160*200*7,\n160*240*7'], 'Б.3.П.7': ['160*160*7,\n160*200*7,\n160*240*7'],
  'Б.5.П.7': ['100*200*7'], 'Б.6.П.7': ['320*160*7'], 'Б.7.П.7': ['320*160*7'], 'Б.8.П.7': ['320*160*7'],
  'Б.9.П.7': ['320*320*7']
};

// Общий каталог для фильтрации (один раз)
const catalog = {};
Object.entries(productBrandOptions).forEach(([product, codes]) => {
  codes.forEach((code) => {
    catalog[code] = {
      product,
      series: brandSeriesOption[code] || [],
      color: branColorsOption[code] || '',
      dimensions: branDimensionsOption[code] || []
    };
  });
});

const emptyBLBRow = () => ({
  date: '', category: '', object: '', position: '', block: '',
  product: '', brand: '', series: '', color: '', dimensions: '',
  unit: '', quantity: '', note: ''
});

// Обязательны только эти поля (как и раньше); порядок — порядок обхода формы.
const FIELD_LABELS = {
  date: 'Дата', category: 'Категория', object: 'Объект', position: 'Позиция', quantity: 'Количество'
};
const FIELD_ERRORS = {
  category: 'Выберите категорию', object: 'Выберите объект', position: 'Выберите позицию',
  quantity: 'Введите количество'
};
const FORM_ORDER = Object.keys(FIELD_LABELS);

const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ruDate = (iso) => iso.split('-').reverse().join('.');

const isRowEmpty = (row) => Object.entries(row).every(([key, v]) => key === 'unit' || v === '');

// Какие значения второй группы ещё подходят под уже выбранные.
const filterCodes = (row) => Object.keys(catalog).filter((code) => {
  const item = catalog[code];
  return (
    (!row.product || item.product === row.product) &&
    (!row.brand || code === row.brand) &&
    (!row.series || item.series.includes(row.series)) &&
    (!row.color || item.color === row.color) &&
    (!row.dimensions || item.dimensions.includes(row.dimensions))
  );
});

const BLBRequestPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [formRows, setFormRows] = useState([emptyBLBRow()]);
  const [fieldErrors, setFieldErrors] = useState(() => new Set());
  const [notice, setNotice] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const noticeRef = useRef(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [copiedRows, setCopiedRows] = useState(() => new Set());

  const [showModal, setShowModal] = useState(false);
  const [showClear, setShowClear] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [userName, setUserName] = useState(() => loadResponsible().name);
  const [userPhone, setUserPhone] = useState(() => loadResponsible().phone);

  // Заявка, подготовленная «Умной заявкой».
  useEffect(() => {
    const prefill = location.state?.prefill;
    if (!prefill?.rows?.length) return;
    setFormRows(prefill.rows.map((r) => ({ ...emptyBLBRow(), ...r })));
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

  // Экранная клавиатура открыта — панель отправки не закреплена (как на странице бетона).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const update = () => setKeyboardOpen(vv.scale <= 1.01 && vv.height < window.innerHeight * 0.75);
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (notice && !focusId && noticeRef.current) {
      noticeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [notice, focusId]);

  // Не раньше чем через 14 дней от сегодняшнего.
  const minDateObj = new Date();
  minDateObj.setHours(0, 0, 0, 0);
  minDateObj.setDate(minDateObj.getDate() + MIN_DAYS_AHEAD);
  const minDate = toIso(minDateObj);

  const missingFields = (row) => FORM_ORDER.filter((name) => {
    if (name === 'date') return !row.date || row.date < minDate;
    return !(row[name] || '').toString().trim();
  });

  const errorOf = (index, name) => {
    if (!fieldErrors.has(`${index}:${name}`)) return undefined;
    if (name === 'date') return formRows[index].date ? `Не раньше ${ruDate(minDate)}` : 'Выберите дату';
    return FIELD_ERRORS[name];
  };

  const missingNotice = (rows, hint) => ({
    kind: 'missing',
    count: rows.reduce((n, r) => n + r.fields.length, 0),
    rows,
    hint
  });

  const addRow = () => {
    const last = formRows.length - 1;
    const missing = missingFields(formRows[last]);
    if (missing.length) {
      setFieldErrors(new Set(missing.map((name) => `${last}:${name}`)));
      setNotice(missingNotice(
        [{ index: last, fields: missing.map((field) => ({ field, label: FIELD_LABELS[field] })) }],
        'Заполните текущую строку перед добавлением новой.'
      ));
      setFocusId(`r${last}-${missing[0]}`);
      return;
    }
    setNotice(null);
    const prev = formRows[last];
    setFormRows([...formRows, {
      ...emptyBLBRow(),
      date: prev.date, category: prev.category, object: prev.object, position: prev.position, block: prev.block
    }]);
    setCopiedRows((rows) => new Set(rows).add(formRows.length));
  };

  const removeRow = (index) => {
    if (formRows.length <= 1) return;
    setFormRows(formRows.filter((_, i) => i !== index));
    setCopiedRows(new Set());
    setFieldErrors(new Set());
    setNotice(null);
  };

  const clearForm = () => {
    setFormRows([emptyBLBRow()]);
    setCopiedRows(new Set());
    setFieldErrors(new Set());
    setNotice(null);
    setShowClear(false);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setNotice(null);

    const errors = new Set();
    const rows = [];
    formRows.forEach((row, index) => {
      const missing = missingFields(row);
      missing.forEach((name) => errors.add(`${index}:${name}`));
      if (missing.length) rows.push({ index, fields: missing.map((field) => ({ field, label: FIELD_LABELS[field] })) });
    });
    setFieldErrors(errors);
    if (rows.length) {
      setNotice(missingNotice(rows));
      setFocusId(`r${rows[0].index}-${rows[0].fields[0].field}`);
      return;
    }

    setSubmitError('');
    setShowModal(true);
  };

  // Финальная отправка данных (после ввода ФИО и телефона)
  const handleFinalSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!userName.trim() || !userPhone.trim()) {
      setSubmitError('Пожалуйста, заполните ФИО и номер телефона.');
      return;
    }
    setSubmitError('');
    setIsSubmitting(true);

    const payload = JSON.stringify(formRows.map((row) => ({
      date: row.date,
      category: row.category,
      object: row.object,
      position: row.position,
      block: row.block,
      product: row.product,
      brand: row.brand,
      series: row.series,
      color: row.color,
      dimensions: row.dimensions,
      unit: row.unit,
      quantity: row.quantity,
      note: row.note,
      responsibleName: userName,
      responsiblePhone: userPhone
    })));

    const formData = new FormData();
    formData.append('data', payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: formData,
        signal: controller.signal
      });
      localStorage.setItem(RESPONSIBLE_KEY, JSON.stringify({ name: userName.trim(), phone: userPhone.trim() }));
      setShowModal(false);
      setFormRows([emptyBLBRow()]);
      setCopiedRows(new Set());
      setFieldErrors(new Set());
      setSent(true);
    } catch (error) {
      console.error('Ошибка отправки:', error);
      // Обрыв по таймауту: запрос мог дойти, а ответ — нет. Повтор без проверки даст дубль.
      setSubmitError(
        error && error.name === 'AbortError'
          ? 'Нет ответа за 20 секунд — связь слабая. Заявка могла дойти: уточните у ответственного за заявки на брусчатку, прежде чем отправлять ещё раз, иначе получится дубль.'
          : 'Заявка не отправлена: нет связи с сервером. Проверьте интернет и нажмите «Отправить заявку» ещё раз — введённые данные сохранены.'
      );
    } finally {
      clearTimeout(timer);
      setIsSubmitting(false);
    }
  };

  const handleChange = (e, index) => {
    const { name, value } = e.target;
    const isCleared = value === ''; // флаг, что поле очищено вручную

    setFormRows((prevRows) => {
      const updated = [...prevRows];
      const row = { ...updated[index] };

      // Сброс цепочки при изменении иерархии
      if (name === 'category') {
        row.category = value;
        row.object = '';
        row.position = '';
        row.block = '';
      } else if (name === 'object') {
        row.object = value;
        row.position = '';
        row.block = '';
      } else if (name === 'position') {
        row.position = value;
        row.block = '';
      } else if (name === 'block') {
        row.block = value;
      } else if (['product', 'brand', 'series', 'color', 'dimensions'].includes(name)) {
        row[name] = value;
      } else if (name === 'quantity') {
        const regex = /^\d{0,6}$/; // только целые числа
        if (value === '' || regex.test(value)) {
          row.quantity = value;
        }
      } else {
        row[name] = value;
      }

      // Устанавливаем единицу измерения
      if (row.product === 'Брусчатка') {
        row.unit = 'м²';
      } else if (row.product === 'Бордюр' || row.product === 'Лоток') {
        row.unit = 'м.пог.';
      } else {
        row.unit = '';
      }

      // === Автозаполнение, но НЕ если пользователь очистил поле ===
      if (!isCleared) {
        const filteredCodes = filterCodes(row);
        const productValues = [...new Set(filteredCodes.map((c) => catalog[c].product))];
        const brandValues = filteredCodes.map((c) => c);
        const seriesValues = [...new Set(filteredCodes.flatMap((c) => catalog[c].series))];
        const colorValues = [...new Set(filteredCodes.map((c) => catalog[c].color))];
        const dimensionValues = [...new Set(filteredCodes.flatMap((c) => catalog[c].dimensions))];

        if (!row.product && productValues.length === 1) row.product = productValues[0];
        if (!row.brand && brandValues.length === 1) row.brand = brandValues[0];
        if (!row.series && seriesValues.length === 1) row.series = seriesValues[0];
        if (!row.color && colorValues.length === 1) row.color = colorValues[0];
        if (!row.dimensions && dimensionValues.length === 1) row.dimensions = dimensionValues[0];
      }

      updated[index] = row;
      return updated;
    });

    setFieldErrors((prev) => {
      if (!prev.has(`${index}:${name}`)) return prev;
      const next = new Set(prev);
      next.delete(`${index}:${name}`);
      return next;
    });
  };

  const formDirty = formRows.length > 1 || !isRowEmpty(formRows[0]);

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to='/' className={css.back}>← На главную</Link>
        <h1 className={css.title}>Заявка на брусчатку, лотки и бордюры</h1>

        <p className={css.info}>
          <TbInfoCircle className={css.infoIcon} aria-hidden='true' />
          Заявки принимаются не раньше чем за {MIN_DAYS_AHEAD} дней: ближайшая дата — {ruDate(minDate)}.
        </p>

        <p className={css.legend}>
          <span className={css.required} aria-hidden='true'>*</span> — обязательное поле. Марку, серию, цвет и размеры можно не выбирать подряд: после выбора части полей остальные подбираются сами.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          {formRows.map((row, index) => {
            const idOf = (name) => `r${index}-${name}`;
            const onChange = (e) => handleChange(e, index);

            // Что ещё подходит под уже выбранное в этой строке
            const filteredCodes = filterCodes(row);
            const productOptions = [...new Set(filteredCodes.map((c) => catalog[c].product))];
            const seriesOptions = [...new Set(filteredCodes.flatMap((c) => catalog[c].series))];
            const colorOptions = [...new Set(filteredCodes.map((c) => catalog[c].color))];
            const dimensionOptions = [...new Set(filteredCodes.flatMap((c) => catalog[c].dimensions))];

            const blocks = positionBlockOptions[row.position] || [];
            const hasBlocks = blocks.length > 0;
            const dateError = errorOf(index, 'date');
            const qtyError = errorOf(index, 'quantity');
            const unitLabel = row.unit ? `Количество, ${row.unit}` : 'Количество';

            return (
              <section key={index} className={css.card} aria-label={formRows.length > 1 ? `Заявка ${index + 1}` : 'Заявка'}>
                <div className={css.cardHeader}>
                  <h2 className={css.cardTitle}>{formRows.length > 1 ? `Заявка ${index + 1}` : 'Заявка'}</h2>
                  {formRows.length > 1 && (
                    <button type='button' className={css.removeBtn} onClick={() => removeRow(index)}>
                      Удалить
                    </button>
                  )}
                </div>

                {copiedRows.has(index) && (
                  <p className={css.help}>Дата и место подставлены из предыдущей заявки — измените, если нужно.</p>
                )}

                <div role='group' aria-labelledby={idOf('g-when')} className={css.group}>
                  <h3 id={idOf('g-when')} className={css.groupTitle}>Когда</h3>
                  <div className={css.gridWhen}>
                    <Field label='Дата' required htmlFor={idOf('date')} error={dateError} errorId={`${idOf('date')}-err`}>
                      <input
                        id={idOf('date')}
                        type='date'
                        name='date'
                        className={`${css.input} ${dateError ? css.inputError : ''}`}
                        value={row.date}
                        min={minDate}
                        onChange={onChange}
                        aria-required='true'
                        aria-invalid={dateError ? true : undefined}
                        aria-describedby={dateError ? `${idOf('date')}-err` : undefined}
                      />
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
                      required
                      options={Object.keys(objectCategoryOptions)}
                      value={row.category}
                      onChange={onChange}
                      error={errorOf(index, 'category')}
                    />
                    <SelectField
                      label='Объект'
                      name='object'
                      id={idOf('object')}
                      required
                      options={objectCategoryOptions[row.category] || []}
                      value={row.object}
                      onChange={onChange}
                      isDisabled={!row.category}
                      disabledHint='Сначала выберите категорию'
                      error={errorOf(index, 'object')}
                    />
                    <SelectField
                      label='Позиция'
                      name='position'
                      id={idOf('position')}
                      required
                      options={objectPositionOptions[row.object] || []}
                      value={row.position}
                      onChange={onChange}
                      isDisabled={!row.object}
                      disabledHint='Сначала выберите объект'
                      error={errorOf(index, 'position')}
                    />
                    <SelectField
                      label='Блок'
                      name='block'
                      id={idOf('block')}
                      optional
                      options={blocks}
                      value={row.block}
                      onChange={onChange}
                      isDisabled={!row.position || !hasBlocks}
                      disabledHint={row.position && !hasBlocks ? 'Для этой позиции не нужен' : 'Сначала выберите позицию'}
                    />
                  </div>
                </div>

                <div role='group' aria-labelledby={idOf('g-what')} className={css.group}>
                  <h3 id={idOf('g-what')} className={css.groupTitle}>Что и сколько</h3>
                  <div className={css.gridWhere}>
                    <SelectField
                      label='Изделие'
                      name='product'
                      id={idOf('product')}
                      optional
                      options={productOptions}
                      value={row.product}
                      onChange={onChange}
                    />
                    <SelectField
                      label='Серия'
                      name='series'
                      id={idOf('series')}
                      optional
                      options={seriesOptions}
                      value={row.series}
                      onChange={onChange}
                    />
                    <SelectField
                      label='Цвет'
                      name='color'
                      id={idOf('color')}
                      optional
                      options={colorOptions}
                      value={row.color}
                      onChange={onChange}
                    />
                    <SelectField
                      label='Размеры'
                      name='dimensions'
                      id={idOf('dimensions')}
                      optional
                      options={dimensionOptions}
                      value={row.dimensions}
                      onChange={onChange}
                    />

                    <Field
                      label='Марка'
                      optional
                      htmlFor={idOf('brand')}
                      help={row.brand ? undefined : 'Подбирается по серии, цвету и размерам'}
                      helpId={`${idOf('brand')}-help`}
                    >
                      <input
                        id={idOf('brand')}
                        type='text'
                        className={css.input}
                        value={row.brand}
                        readOnly
                        disabled={!row.brand}
                        placeholder='Подбирается сама'
                        aria-describedby={row.brand ? undefined : `${idOf('brand')}-help`}
                      />
                      {row.brand && (
                        <button
                          type='button'
                          className={css.noticeLink}
                          onClick={() => handleChange({ target: { name: 'brand', value: '' } }, index)}
                        >
                          Сбросить марку
                        </button>
                      )}
                    </Field>

                    <Field label={unitLabel} required htmlFor={idOf('quantity')} error={qtyError} errorId={`${idOf('quantity')}-err`}>
                      <input
                        id={idOf('quantity')}
                        type='text'
                        inputMode='numeric'
                        name='quantity'
                        className={`${css.input} ${qtyError ? css.inputError : ''}`}
                        value={row.quantity}
                        onChange={onChange}
                        placeholder='Введите количество'
                        autoComplete='off'
                        aria-required='true'
                        aria-invalid={qtyError ? true : undefined}
                        aria-describedby={qtyError ? `${idOf('quantity')}-err` : undefined}
                      />
                    </Field>
                  </div>
                </div>

                <div className={css.group}>
                  <Field label='Примечание' optional htmlFor={idOf('note')}>
                    <textarea
                      id={idOf('note')}
                      name='note'
                      className={css.textarea}
                      value={row.note}
                      onChange={onChange}
                      rows={3}
                      placeholder='Введите примечание...'
                    />
                  </Field>
                </div>
              </section>
            );
          })}

          {notice && (
            <div ref={noticeRef} className={css.noticeError} role='alert'>
              <p className={css.noticeTitle}>
                <TbAlertCircle className={css.noticeIcon} aria-hidden='true' />
                {`Не заполнено полей: ${notice.count}`}
              </p>
              {notice.hint && <p className={css.noticeText}>{notice.hint}</p>}
              <ul className={css.noticeList}>
                {notice.rows.map((r) => (
                  <li key={r.index}>
                    {formRows.length > 1 ? `Заявка ${r.index + 1}: ` : ''}
                    {r.fields.map((f, i) => (
                      <React.Fragment key={f.field}>
                        {i > 0 && ', '}
                        <button type='button' className={css.noticeLink} onClick={() => setFocusId(`r${r.index}-${f.field}`)}>
                          {f.label}
                        </button>
                      </React.Fragment>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button type='button' onClick={addRow} className={css.addBtn}>+ Добавить ещё позицию</button>

          <div className={`${css.actions} ${keyboardOpen ? css.actionsStatic : ''}`}>
            {formDirty && (
              <button type='button' className={css.btnGhost} onClick={() => setShowClear(true)}>
                Очистить заявку
              </button>
            )}
            <button type='submit' className={css.btnPrimary}>
              {formRows.length > 1 ? `Отправить заявки (${formRows.length})` : 'Отправить заявку'}
            </button>
          </div>
        </form>
      </div>

      {showModal && (
        <Dialog title='Ответственный' onClose={() => setShowModal(false)}>
          <form onSubmit={handleFinalSubmit} className={css.dialogForm} noValidate>
            <p className={css.dialogSummary}>Позиций в заявке: {formRows.length}</p>

            <Field label='ФИО' required htmlFor='responsible-name'>
              <input
                id='responsible-name'
                type='text'
                className={css.input}
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder='Введите ФИО'
                autoComplete='name'
              />
            </Field>

            <Field label='Номер телефона' required htmlFor='responsible-phone'>
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
            </Field>

            <p className={css.help}>ФИО и номер запоминаются на этом устройстве, в следующий раз вводить не придётся.</p>

            {submitError && (
              <div className={css.noticeError} role='alert'>
                <p className={css.noticeTitle}>
                  <TbAlertCircle className={css.noticeIcon} aria-hidden='true' />
                  Не отправлено
                </p>
                <p className={css.noticeText}>{submitError}</p>
              </div>
            )}

            <button type='submit' className={css.btnPrimary} disabled={isSubmitting}>
              {isSubmitting ? 'Отправка...' : 'Отправить заявку'}
            </button>
          </form>
        </Dialog>
      )}

      {showClear && (
        <Dialog title='Очистить заявку?' onClose={() => setShowClear(false)}>
          <p className={css.dialogText}>
            {formRows.length > 1
              ? `Все позиции (${formRows.length}) будут удалены, останется одна пустая.`
              : 'Все введённые данные будут удалены.'}
          </p>
          <div className={css.dialogActions}>
            <button type='button' className={css.btnGhost} onClick={() => setShowClear(false)}>Отмена</button>
            <button type='button' className={css.btnPrimary} onClick={clearForm}>Очистить</button>
          </div>
        </Dialog>
      )}

      {sent && (
        <Dialog title='Заявка отправлена' onClose={() => setSent(false)}>
          <p className={css.dialogText}>Заявка на брусчатку, лотки и бордюры отправлена.</p>
          <div className={css.dialogActions}>
            <button type='button' className={css.btnGhost} onClick={() => navigate('/')}>На главную</button>
            <button type='button' className={css.btnPrimary} onClick={() => setSent(false)}>Понятно</button>
          </div>
        </Dialog>
      )}
    </div>
  );
};

export default BLBRequestPage;
