// Заявка на ж/б изделия. Оформление — в стиле заявок на бетон, технику и брусчатку
// (ConcreteRequestPage.module.css): карточки «Когда / Куда / Что и сколько», ошибки
// и подсказки на странице, окна — components/RequestDialog. Справочники изделий,
// подбор серии по марке и отправка — прежние.
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
import { clearSubmissionId, getSubmissionId } from './utils/submissionId';
import { SCRIPT_URLS } from './config/scriptUrls';

const SCRIPT_URL = SCRIPT_URLS.znb;
// Ответ скрипта прочитать нельзя (no-cors): зависшую отправку обрываем сами
// и просим убедиться, что заявка не дошла, прежде чем отправлять повторно.
const SEND_TIMEOUT_MS = 20000;
const MIN_DAYS_AHEAD = 14;

// Контакты ответственного запоминаем на этом устройстве.
const RESPONSIBLE_KEY = 'znbRequestResponsible';
const loadResponsible = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(RESPONSIBLE_KEY) || '{}');
    return { name: saved.name || '', phone: saved.phone || '' };
  } catch {
    return { name: '', phone: '' };
  }
};

// Справочники для второй группы
const znbBrandOptions = {
    'Балка': [
      'Б-6', 
      'Б-7', 
      'Б-8', 
      'другое'
    ],
    'Блоки бетонные для стен подвалов': [
      'ФБС 12.4.6т', 
      'ФБС 12.5.6т', 
      'ФБС 24.4.6т', 
      'ФБС 24.5.6т',
      'ФБС 24.6.6т', 
      'ФБС 9.4.6т', 
      'ФБС 9.5.6т', 
      'ФБС 9.6.6т', 
      'ФБС12.6.6т', 
      'другое'
    ],
    'Ж/б опора для передвижного ограждения': [
      'ОП-1', 
      'другое'
    ],
    'Железобетонный фундамент для опоры наружного освещения': [
      'ФН-1', 
      'ФН-2', 
      'другое'
    ],
    'Кабель канал': [
      'К 20.6.3', 
      'другое'
    ],
    'Камни бетонные бортовые': [
      'БР100.20.8', 
      'другое'
    ],
    'Кольцо стеновое цилиндрическое (Технологический бетон)': [
      'КС 10.3 (КЦ-10-3)', 
      'КС 10.6 (КЦ-10-6)', 
      'КС 10.9 (КЦ-10-9)', 
      'КС 15.6 (КЦ-15-6)',
      'КС 15.9 (КЦ-15-9)', 
      'КС 20.6 (КЦ-20-6)', 
      'КС 20.9 (КЦ-20-9)', 
      'КС 7.3 (КЦ-7-3)',
      'КС 7.9 (КЦ-7-9)', 
      'другое'
    ],
    'Лоток': [
      'Л11-8/2', 
      'другое'
    ],
    'Лоток водоотводный': [
      'Л-100.15.15', 
      'Л-100.25.15', 
      'Л-150.15.15', 
      'другое'
    ],
    'Лоток водоотводный (Технологический бетон)': [
      'Л-100.25.15', 
      'другое'
    ],
    'Опора освещения': [
      'СВ 105-3,5', 
      'СВ 95-2а', 
      'другое'
    ],
    'Опорное кольцо': [
      'КО-6 (КЦО-1)', 
      'другое'
    ],
    'Панель ограждения': [
      '3ПБ30.20', 
      'ПО1В', 
      'ПО1В*', 
      'другое'
    ],
    'Перемычка плитная': [
      '2ПП17-5', 
      '2ПП18-5', 
      '3ПП16-71', 
      '3ПП18-71', 
      '3ПП27-71', 
      '6ПП16-72', 
      '6ПП21-72', 
      '6ПП27-72', 
      '6ПП30-13',
      'другое'
    ],
    'Перемычка брусковая': [
      '1ПБ 13-1п', 
      '1ПБ 16-1п', 
      '2ПБ 10-1п', 
      '2ПБ 13-1п', 
      '2ПБ 16-2п', 
      '2ПБ 17-2п',
      '2ПБ 19-3п', 
      '2ПБ 25-3п', 
      '2ПБ 29-4п', 
      '3ПБ 13-37п', 
      '3ПБ 16-37п', 
      '3ПБ 18-37п', 
      '3ПБ 30-8п',
      '4ПБ 44-8п', 
      '5ПБ 18-27п', 
      '5ПБ 21-27п', 
      '5ПБ 25-27п', 
      '5ПБ 27-27п', 
      '5ПБ 27-37п', 
      'другое'
    ],
    'Плита': [
      'ОП 200', 
      'ОП 220', 
      'П11-8', 
      'П-4', 
      'ПД 300.150.14-9', 
      'ПД 300.240.20-9', 
      'ПД 300.300.20-9',
      'ПД 75.240.20-9', 
      'ПД 75.300.20-9', 
      'ПД43-15', 
      'ПТ 300.120.14-9', 
      'ПТ 300.150.14-9', 
      'ПТ 300.180.14-9',
      'ПТ 300.180.14-9*', 
      'ПТ 300.210.16-9', 
      'ПТ 300.300.25-9', 
      'ПТ 30-15', 
      'ПТ 30-15/2000', 
      'ПТ 75.180.14-9', 
      'ПТ 75.210.16-9', 
      'ПТ 75.300.25-9', 
      'ПТ40-12', 
      'ПТ40-15', 
      'другое'
    ],
    'Плита для железнодорожных переездов': [
      'ПЖ 03.00.00', 
      'ПЖ 04.00.00', 
      'другое'
    ],
    'Плита днища': [
      'ПН10', 
      'ПН15', 
      'ПН20', 
      'ПН7', 
      'другое'
    ],
    'Плита дорожная': [
      '1П30.18-30', 
      'другое'
    ],
    'Плита канала': [
      'ППк1', 
      'ППк1.1', 
      'ППк2', 
      'ППк2.1', 
      'ППк2.2', 
      'другое'
    ],
    'Плита лотка': [
      'П28-15', 
      'П28д-15', 
      'другое'
    ],
    'Плита перекрытия': [
      'КЦП 2-7', 
      '1ПП15-1 (КЦП1-15-1)', 
      '1ПП15-2 (КЦП1-15-2)', 
      '1ПП20-1 (КЦП1-20-1)', 
      '1ПП20-2 (КЦП1-20-2)', 
      'ПП10-1 (КЦП1-10-1)', 
      'ПП10-2 (КЦП1-10-2)', 
      'другое'
    ],
    'Плита перекрытия лотков': [
      'П11д-8а', 
      'П12/2-12а', 
      'П15д-8а', 
      'П18д-8а', 
      'П21д-8', 
      'ПО-2', 
      'ПО-3', 
      'ПО-4', 
      'другое'],
    'Плита переходная': [
      'П800.98.40-ТАIII', 
      'другое'
    ],
    'Противовес': [
      'ПР-2', 
      'другое'
    ],
    'Пртивовес (Технологический бетон)': [
      'ПР-1', 
      'другое'
    ],
    'Ригель': [
      'Р-5100', 
      'другое'
    ],
    'Стакан под панель ограждения': [
      'ОФ-1а', 
      'другое'
    ],
    'Другое': [] 
};

const seriesBrandOptions = {
    'ГОСТ 3579-78': [
      'ФБС 12.4.6т', 
      'ФБС 12.5.6т', 
      'ФБС 24.4.6т', 
      'ФБС 24.5.6т',
      'ФБС 24.6.6т', 
      'ФБС 9.4.6т', 
      'ФБС 9.5.6т', 
      'ФБС 9.6.6т', 
      'ФБС12.6.6т'],
    'ГОСТ 6665-91': [
      'БР100.20.8'
    ],
    'ТП 902-09-46.88': [
      'КЦП 2-7'
    ],
    'серия 1.038.1-1 вып.1': [
      '1ПБ 13-1п', 
      '1ПБ 16-1п', 
      '2ПБ 10-1п', 
      '2ПБ 13-1п', 
      '2ПБ 16-2п', 
      '2ПБ 17-2п', 
      '2ПБ 19-3п', 
      '2ПБ 25-3п', 
      '2ПБ 29-4п', 
      '3ПБ 13-37п', 
      '3ПБ 16-37п', 
      '3ПБ 18-37п', 
      '3ПБ 30-8п', 
      '4ПБ 44-8п', 
      '5ПБ 18-27п',
      '5ПБ 21-27п', 
      '5ПБ 25-27п', 
      '5ПБ 27-27п', 
      '5ПБ 27-37п'
    ],
    'серия 1.038.1-1 вып.2': [
      '2ПП17-5', 
      '2ПП18-5', 
      '3ПП16-71', 
      '3ПП18-71', 
      '3ПП27-71', 
      '6ПП16-72', 
      '6ПП21-72', 
      '6ПП27-72', 
      '6ПП30-13'
    ],
    'ТМП 902-09-46.88': [
      'КЦП 2-7'
    ],
    'серия 3.006.1-2.87': [
      'ПО-2', 
      'ПО-3', 
      'ПО-4'
    ],
    'серия 3.900.1-4 в.1 (c.3.900-3 в.7)': [
      'КС 10.3 (КЦ-10-3)', 
      'КС 10.6 (КЦ-10-6)', 
      'КС 10.9 (КЦ-10-9)', 
      'КС 15.6 (КЦ-15-6)', 
      'КС 15.9 (КЦ-15-9)', 
      'КС 20.6 (КЦ-20-6)', 
      'КС 20.9 (КЦ-20-9)', 
      'КС 7.3 (КЦ-7-3)',
      'КС 7.9 (КЦ-7-9)', 
      'КО-6 (КЦО-1)'
    ],
    'серия 3.900.1-4 в.1 (c.3.900-3 в.7) ': [
      'ПН10 (КЦД-10)', 
      'ПН15 (КЦД-15)', 
      'ПН20 (КЦД-20)', 
      'ПН7 (КЦД-7)', 
      '1ПП15-1 (КЦП1-15-1)', 
      '1ПП15-2 (КЦП1-15-2)', 
      '1ПП20-1 (КЦП1-20-1)', 
      '1ПП20-2 (КЦП1-20-2)', 
      'ПП10-1 (КЦП1-10-1)', 
      'ПП10-2 (КЦП1-10-2)'
    ]
};

const emptyZnbRow = () => ({
  date: '', category: '', object: '', position: '', block: '',
  product: '', brand: '', series: '', quantity: '', note: ''
});

const OTHER_PRODUCT = 'Другое';
const OTHER_BRAND = 'другое';

// Порядок обхода формы (по нему ищется первое пустое поле, куда переводится фокус).
const FIELD_LABELS = {
  date: 'Дата', category: 'Категория', object: 'Объект', position: 'Позиция', block: 'Блок',
  product: 'Изделие', brand: 'Марка', quantity: 'Количество', note: 'Примечание'
};
const FIELD_ERRORS = {
  category: 'Выберите категорию', object: 'Выберите объект', position: 'Выберите позицию',
  block: 'Выберите блок', product: 'Выберите изделие', brand: 'Выберите марку',
  quantity: 'Введите количество', note: 'Опишите изделие: выбрано «Другое»'
};
const FORM_ORDER = Object.keys(FIELD_LABELS);

const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ruDate = (iso) => iso.split('-').reverse().join('.');

const isRowEmpty = (row) => Object.entries(row).every(([key, v]) => key === 'series' || v === '');

// Серия/ГОСТ по марке (первая найденная).
const seriesForBrand = (brand) => Object.keys(seriesBrandOptions).find((series) =>
  (seriesBrandOptions[series] || []).includes(brand)
) || '';

const ZnbRequestPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [formRows, setFormRows] = useState([emptyZnbRow()]);
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

  // Заявка, подготовленная «Умной заявкой» (серия подбирается по марке).
  useEffect(() => {
    const prefill = location.state?.prefill;
    if (!prefill?.rows?.length) return;
    setFormRows(prefill.rows.map((r) => {
      const row = { ...emptyZnbRow(), ...r };
      if (row.brand) row.series = seriesForBrand(row.brand);
      return row;
    }));
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

  const needsBlock = (row) => (positionBlockOptions[row.position] || []).length > 0;
  const noteRequired = (row) => row.product === OTHER_PRODUCT || row.brand === OTHER_BRAND;

  const missingFields = (row) => FORM_ORDER.filter((name) => {
    if (name === 'date') return !row.date || row.date < minDate;
    if (name === 'block') return needsBlock(row) && !row.block.trim();
    if (name === 'brand') return row.product !== OTHER_PRODUCT && !row.brand.trim(); // для «Другое» марки нет
    if (name === 'note') return noteRequired(row) && !row.note.trim();
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
      ...emptyZnbRow(),
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
    setFormRows([emptyZnbRow()]);
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

    const rows = formRows.map((row) => ({
      date: row.date,
      category: row.category,
      object: row.object,
      position: row.position,
      block: row.block,
      product: row.product,
      brand: row.brand,
      series: row.series,
      quantity: row.quantity,
      note: row.note,
      responsibleName: userName,
      responsiblePhone: userPhone
    }));

    // Тот же набор данных — тот же ID при любом числе повторов: скрипт запишет заявку один раз,
    // даже если ответ не дошёл (см. utils/submissionId.js).
    const submissionId = getSubmissionId('znb', rows);

    const formData = new FormData();
    formData.append('data', JSON.stringify(rows.map((row) => ({ ...row, submissionId }))));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: formData,
        signal: controller.signal
      });
      clearSubmissionId('znb');
      localStorage.setItem(RESPONSIBLE_KEY, JSON.stringify({ name: userName.trim(), phone: userPhone.trim() }));
      setShowModal(false);
      setFormRows([emptyZnbRow()]);
      setCopiedRows(new Set());
      setFieldErrors(new Set());
      setSent(true);
    } catch (error) {
      console.error('Ошибка отправки:', error);
      // Обрыв по таймауту: запрос мог дойти, а ответ — нет. Повтор безопасен: у заявки тот же ID,
      // и скрипт второй раз её не запишет.
      setSubmitError(
        error && error.name === 'AbortError'
          ? 'Нет ответа за 20 секунд — связь слабая. Заявка могла дойти. Нажмите «Отправить заявку» ещё раз: если она уже дошла, повторно не запишется.'
          : 'Заявка не отправлена: нет связи с сервером. Проверьте интернет и нажмите «Отправить заявку» ещё раз — введённые данные сохранены.'
      );
    } finally {
      clearTimeout(timer);
      setIsSubmitting(false);
    }
  };

  // Обработчик изменений
  const handleChange = (e, index) => {
    const { name, value } = e.target;
    setFormRows((prevRows) => {
      const updated = [...prevRows];
      const row = { ...updated[index] };

      // Первая группа (иерархия)
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
      // Вторая группа (иерархия)
      } else if (name === 'product') {
        row.product = value;
        row.brand = '';
        row.series = '';
      } else if (name === 'brand') {
        row.brand = value;
        row.series = seriesForBrand(value); // автоподбор ГОСТ/серии; не нашли — пусто
      } else if (name === 'quantity') {
        const regex = /^\d{0,4}$/; // только целые числа, до 4 цифр
        if (value === '' || regex.test(value)) {
          row.quantity = value;
        }
      } else {
        row[name] = value;
      }
      updated[index] = row;
      return updated;
    });

    setFieldErrors((prev) => {
      const next = new Set(prev);
      next.delete(`${index}:${name}`);
      // смена изделия или марки меняет и то, что считается обязательным
      if (name === 'product') { next.delete(`${index}:brand`); next.delete(`${index}:note`); }
      if (name === 'brand') next.delete(`${index}:note`);
      return next.size === prev.size ? prev : next;
    });
  };

  const formDirty = formRows.length > 1 || !isRowEmpty(formRows[0]);

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to='/' className={css.back}>← На главную</Link>
        <h1 className={css.title}>Заявка на ж/б изделия</h1>

        <p className={css.info}>
          <TbInfoCircle className={css.infoIcon} aria-hidden='true' />
          Заявки принимаются не раньше чем за {MIN_DAYS_AHEAD} дней: ближайшая дата — {ruDate(minDate)}.
        </p>

        <p className={css.legend}>
          <span className={css.required} aria-hidden='true'>*</span> — обязательное поле. Часть полей становится обязательной после выбора в полях выше.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          {formRows.map((row, index) => {
            const idOf = (name) => `r${index}-${name}`;
            const onChange = (e) => handleChange(e, index);

            const blocks = positionBlockOptions[row.position] || [];
            const hasBlocks = blocks.length > 0;
            const isOtherProduct = row.product === OTHER_PRODUCT;
            const dateError = errorOf(index, 'date');
            const qtyError = errorOf(index, 'quantity');
            const isNoteRequired = noteRequired(row);

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
                      required={hasBlocks}
                      optional={!hasBlocks}
                      options={blocks}
                      value={row.block}
                      onChange={onChange}
                      isDisabled={!row.position || !hasBlocks}
                      disabledHint={row.position && !hasBlocks ? 'Для этой позиции не нужен' : 'Сначала выберите позицию'}
                      error={errorOf(index, 'block')}
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
                      required
                      options={Object.keys(znbBrandOptions)}
                      value={row.product}
                      onChange={onChange}
                      error={errorOf(index, 'product')}
                    />
                    <SelectField
                      label='Марка'
                      name='brand'
                      id={idOf('brand')}
                      required={!isOtherProduct}
                      optional={isOtherProduct}
                      options={znbBrandOptions[row.product] || []}
                      value={row.brand}
                      onChange={onChange}
                      isDisabled={isOtherProduct || !row.product}
                      disabledHint={isOtherProduct ? 'Для «Другое» не нужна' : 'Сначала выберите изделие'}
                      error={errorOf(index, 'brand')}
                    />
                    <Field
                      label='ГОСТ / серия'
                      optional
                      htmlFor={idOf('series')}
                      help={row.series ? undefined : 'Подставляется по марке'}
                      helpId={`${idOf('series')}-help`}
                    >
                      <input
                        id={idOf('series')}
                        type='text'
                        name='series'
                        className={css.input}
                        value={row.series}
                        readOnly
                        disabled={!row.series}
                        placeholder='Подставляется сама'
                        aria-describedby={row.series ? undefined : `${idOf('series')}-help`}
                      />
                    </Field>
                    <Field label='Количество, шт.' required htmlFor={idOf('quantity')} error={qtyError} errorId={`${idOf('quantity')}-err`}>
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
                  <Field
                    label='Примечание'
                    required={isNoteRequired}
                    optional={!isNoteRequired}
                    htmlFor={idOf('note')}
                    error={errorOf(index, 'note')}
                    errorId={`${idOf('note')}-err`}
                  >
                    <textarea
                      id={idOf('note')}
                      name='note'
                      className={`${css.textarea} ${errorOf(index, 'note') ? css.inputError : ''}`}
                      value={row.note}
                      onChange={onChange}
                      rows={3}
                      placeholder={isNoteRequired ? 'Укажите наименование и размеры изделия' : 'Введите примечание...'}
                      aria-required={isNoteRequired || undefined}
                      aria-invalid={errorOf(index, 'note') ? true : undefined}
                      aria-describedby={errorOf(index, 'note') ? `${idOf('note')}-err` : undefined}
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

          <button type='button' onClick={addRow} className={css.addBtn}>+ Добавить ещё изделие</button>

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
          <p className={css.dialogText}>Заявка на ж/б изделия отправлена.</p>
          <div className={css.dialogActions}>
            <button type='button' className={css.btnGhost} onClick={() => navigate('/')}>На главную</button>
            <button type='button' className={css.btnPrimary} onClick={() => setSent(false)}>Понятно</button>
          </div>
        </Dialog>
      )}
    </div>
  );
};

export default ZnbRequestPage;
