// Заявка на лабораторные испытания. Оформление — в стиле остальных заявок
// (ConcreteRequestPage.module.css): карточки «Что / Когда / Куда / Место в здании»,
// ошибки и подсказки на странице, окна — components/RequestDialog. Справочники,
// правила обязательности полей и отправка в Google Apps Script — прежние.
import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { TbAlertCircle, TbInfoCircle } from 'react-icons/tb';
import css from './ConcreteRequestPage.module.css';
import {
  objectCategoryOptions,
  objectPositionOptions,
  positionBlockOptions,
  blockFloorOptions,
  concreteConstructiveOptions
} from './data/constructionData';
import Dialog from './components/RequestDialog';
import { Field, SelectField } from './components/RequestFormFields';
import { clearSubmissionId, getSubmissionId } from './utils/submissionId';
import { SCRIPT_URLS } from './config/scriptUrls';

const SCRIPT_URL = SCRIPT_URLS.lab;
// Ответ скрипта прочитать нельзя (no-cors): зависшую отправку обрываем сами
// и просим убедиться, что заявка не дошла, прежде чем отправлять повторно.
const SEND_TIMEOUT_MS = 20000;
const MAX_DAYS_AHEAD = 7;

// Контакты ответственного запоминаем на этом устройстве.
const RESPONSIBLE_KEY = 'labRequestResponsible';
const loadResponsible = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(RESPONSIBLE_KEY) || '{}');
    return { name: saved.name || '', phone: saved.phone || '' };
  } catch {
    return { name: '', phone: '' };
  }
};

const SOIL_TEST = 'Степень уплотнения грунта';
const TEST_OPTIONS = [SOIL_TEST, 'Прочность бетона с помощью ИПС'];
const SOIL_CONSTRUCTIVE = 'Основание';
const ENGINEERING_NETWORKS = 'Инженерные сети';

const emptyRow = () => ({
  test: '', date: '', category: '', object: '', position: '',
  block: '', floor: '', constructive: '', note: ''
});

// Порядок обхода формы (по нему ищется первое пустое поле, куда переводится фокус).
const FIELD_LABELS = {
  test: 'Наименование испытания', date: 'Дата', category: 'Категория', object: 'Объект',
  position: 'Позиция', block: 'Блок', floor: 'Этаж', constructive: 'Конструктив', note: 'Примечание'
};
const FIELD_ERRORS = {
  test: 'Выберите испытание', category: 'Выберите категорию', object: 'Выберите объект',
  position: 'Выберите позицию', block: 'Выберите блок', floor: 'Выберите этаж',
  constructive: 'Выберите конструктив', note: 'Укажите протяжённость, номера колодцев и т. п.'
};
const FORM_ORDER = Object.keys(FIELD_LABELS);

const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ruDate = (iso) => iso.split('-').reverse().join('.');

const isSoil = (row) => row.test === SOIL_TEST;
const hasBlocks = (row) => (positionBlockOptions[row.position] || []).length > 0;
const isRowEmpty = (row) => Object.values(row).every((v) => v === '');

const LabTestRequestPaje = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [formRows, setFormRows] = useState([emptyRow()]);
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
    setFormRows(prefill.rows.map((r) => ({ ...emptyRow(), ...r })));
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

  // Дата испытания — от сегодняшнего дня до +7 дней.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDay = new Date(today);
  maxDay.setDate(maxDay.getDate() + MAX_DAYS_AHEAD);
  const minDate = toIso(today);
  const maxDate = toIso(maxDay);

  const missingFields = (row) => FORM_ORDER.filter((name) => {
    if (name === 'test') return !row.test;
    if (name === 'date') return !row.date || row.date < minDate || row.date > maxDate;
    if (name === 'block' || name === 'floor') return !isSoil(row) && hasBlocks(row) && !row[name];
    if (name === 'constructive') return (isSoil(row) || hasBlocks(row)) && !row.constructive;
    if (name === 'note') return row.object === ENGINEERING_NETWORKS && !row.note.trim();
    return !row[name];
  });

  const errorOf = (index, name) => {
    if (!fieldErrors.has(`${index}:${name}`)) return undefined;
    if (name === 'date') {
      return formRows[index].date ? `Дата — от ${ruDate(minDate)} до ${ruDate(maxDate)}` : 'Выберите дату';
    }
    return FIELD_ERRORS[name];
  };

  const missingNotice = (rows, hint) => ({
    kind: 'missing',
    count: rows.reduce((n, r) => n + r.fields.length, 0),
    rows,
    hint
  });

  const handleChange = (e, index) => {
    const { name, value } = e.target;
    setFormRows((prevRows) => prevRows.map((current, i) => {
      if (i !== index) return current;
      const row = { ...current, [name]: value };

      // Сбрасываем только то, что зависит от изменённого поля.
      if (name === 'test') {
        if (value === SOIL_TEST) {
          row.block = '';
          row.floor = '';
          row.constructive = SOIL_CONSTRUCTIVE;
        } else if (current.test === SOIL_TEST) {
          row.constructive = '';
        }
      } else if (name === 'category') {
        row.object = '';
        row.position = '';
        row.block = '';
        row.floor = '';
        row.constructive = isSoil(row) ? SOIL_CONSTRUCTIVE : '';
      } else if (name === 'object') {
        row.position = '';
        row.block = '';
        row.floor = '';
        row.constructive = isSoil(row) ? SOIL_CONSTRUCTIVE : '';
      } else if (name === 'position') {
        row.block = '';
        row.floor = '';
        row.constructive = isSoil(row) ? SOIL_CONSTRUCTIVE : '';
      } else if (name === 'block') {
        row.floor = '';
        row.constructive = isSoil(row) ? SOIL_CONSTRUCTIVE : '';
      } else if (name === 'floor') {
        row.constructive = isSoil(row) ? SOIL_CONSTRUCTIVE : '';
      }
      return row;
    }));

    setFieldErrors((prev) => {
      const next = new Set(prev);
      next.delete(`${index}:${name}`);
      // смена испытания или места меняет набор обязательных полей ниже
      if (['test', 'category', 'object', 'position', 'block', 'floor'].includes(name)) {
        ['block', 'floor', 'constructive', 'note'].forEach((f) => next.delete(`${index}:${f}`));
      }
      return next.size === prev.size ? prev : next;
    });
  };

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
    // Следующий конструктив на том же месте: всё, кроме конструктива и примечания, как в предыдущей.
    setFormRows([...formRows, {
      ...prev,
      constructive: isSoil(prev) ? SOIL_CONSTRUCTIVE : '',
      note: ''
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
    setFormRows([emptyRow()]);
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

  const handleFinalSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!userName.trim() || !userPhone.trim()) {
      setSubmitError('Пожалуйста, заполните ФИО и номер телефона.');
      return;
    }
    setSubmitError('');
    setIsSubmitting(true);

    const payload = formRows.map((row) => ({
      test: row.test,
      date: row.date,
      category: row.category,
      object: row.object,
      position: row.position,
      block: row.block,
      floor: row.floor,
      constructive: row.constructive,
      note: row.note,
      responsibleName: userName,
      responsiblePhone: userPhone
    }));

    // Тот же набор данных — тот же ID при любом числе повторов: скрипт запишет заявку один раз,
    // даже если ответ не дошёл (см. utils/submissionId.js).
    const submissionId = getSubmissionId('lab', payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify(payload.map((row) => ({ ...row, submissionId }))),
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      });
      clearSubmissionId('lab');
      localStorage.setItem(RESPONSIBLE_KEY, JSON.stringify({ name: userName.trim(), phone: userPhone.trim() }));
      setShowModal(false);
      setFormRows([emptyRow()]);
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

  const formDirty = formRows.length > 1 || !isRowEmpty(formRows[0]);

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to='/' className={css.back}>← На главную</Link>
        <h1 className={css.title}>Заявка на лабораторные испытания</h1>

        <p className={css.info}>
          <TbInfoCircle className={css.infoIcon} aria-hidden='true' />
          Испытание можно заказать на ближайшие {MAX_DAYS_AHEAD} дней: с {ruDate(minDate)} по {ruDate(maxDate)}.
        </p>

        <p className={css.legend}>
          <span className={css.required} aria-hidden='true'>*</span> — обязательное поле. Часть полей становится обязательной после выбора в полях выше.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          {formRows.map((row, index) => {
            const idOf = (name) => `r${index}-${name}`;
            const onChange = (e) => handleChange(e, index);

            const soil = isSoil(row);
            const blocks = positionBlockOptions[row.position] || [];
            const withBlocks = blocks.length > 0;
            const dateError = errorOf(index, 'date');
            const networks = row.object === ENGINEERING_NETWORKS;
            const noteError = errorOf(index, 'note');

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
                  <p className={css.help}>Испытание, дата и место подставлены из предыдущей заявки — выберите другой конструктив или измените, если нужно.</p>
                )}

                <div role='group' aria-labelledby={idOf('g-what')} className={css.group}>
                  <h3 id={idOf('g-what')} className={css.groupTitle}>Что и когда</h3>
                  <div className={css.gridWhere}>
                    <SelectField
                      label='Наименование испытания'
                      name='test'
                      id={idOf('test')}
                      required
                      options={TEST_OPTIONS}
                      value={row.test}
                      onChange={onChange}
                      error={errorOf(index, 'test')}
                    />
                    <Field label='Дата' required htmlFor={idOf('date')} error={dateError} errorId={`${idOf('date')}-err`}>
                      <input
                        id={idOf('date')}
                        type='date'
                        name='date'
                        className={`${css.input} ${dateError ? css.inputError : ''}`}
                        value={row.date}
                        min={minDate}
                        max={maxDate}
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
                  </div>
                </div>

                <div role='group' aria-labelledby={idOf('g-where-in')} className={css.group}>
                  <h3 id={idOf('g-where-in')} className={css.groupTitle}>Место в здании</h3>
                  <div className={css.gridWhere}>
                    <SelectField
                      label='Блок'
                      name='block'
                      id={idOf('block')}
                      required={!soil && withBlocks}
                      optional={soil || !withBlocks}
                      options={blocks}
                      value={row.block}
                      onChange={onChange}
                      isDisabled={soil || !row.position || !withBlocks}
                      disabledHint={soil ? 'Для этого испытания не нужен' : (row.position && !withBlocks ? 'Для этой позиции не нужен' : 'Сначала выберите позицию')}
                      error={errorOf(index, 'block')}
                    />
                    <SelectField
                      label='Этаж'
                      name='floor'
                      id={idOf('floor')}
                      required={!soil && withBlocks}
                      optional={soil || !withBlocks}
                      options={blockFloorOptions[row.block] || []}
                      value={row.floor}
                      onChange={onChange}
                      isDisabled={soil || !row.block || !withBlocks}
                      disabledHint={soil ? 'Для этого испытания не нужен' : 'Сначала выберите блок'}
                      error={errorOf(index, 'floor')}
                    />
                    <SelectField
                      label='Конструктив'
                      name='constructive'
                      id={idOf('constructive')}
                      required={soil || withBlocks}
                      optional={!soil && !withBlocks}
                      options={soil ? [SOIL_CONSTRUCTIVE] : (concreteConstructiveOptions[row.floor] || [])}
                      value={row.constructive}
                      onChange={onChange}
                      isDisabled={soil || !row.floor || !withBlocks}
                      disabledHint={soil ? SOIL_CONSTRUCTIVE : 'Сначала выберите этаж'}
                      error={errorOf(index, 'constructive')}
                    />
                  </div>
                </div>

                <div className={css.group}>
                  <Field
                    label='Примечание'
                    required={networks}
                    optional={!networks}
                    htmlFor={idOf('note')}
                    error={noteError}
                    errorId={`${idOf('note')}-err`}
                  >
                    <textarea
                      id={idOf('note')}
                      name='note'
                      className={`${css.textarea} ${noteError ? css.inputError : ''}`}
                      value={row.note}
                      onChange={onChange}
                      rows={3}
                      placeholder={networks ? 'Укажите протяжённость, номера колодцев и т. п.' : 'Введите примечание...'}
                      aria-required={networks || undefined}
                      aria-invalid={noteError ? true : undefined}
                      aria-describedby={noteError ? `${idOf('note')}-err` : undefined}
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

          <button type='button' onClick={addRow} className={css.addBtn}>+ Добавить ещё испытание</button>

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
            <p className={css.dialogSummary}>Испытаний в заявке: {formRows.length}</p>

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
              ? `Все строки (${formRows.length}) будут удалены, останется одна пустая.`
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
          <p className={css.dialogText}>Заявка на лабораторные испытания отправлена.</p>
          <div className={css.dialogActions}>
            <button type='button' className={css.btnGhost} onClick={() => navigate('/')}>На главную</button>
            <button type='button' className={css.btnPrimary} onClick={() => setSent(false)}>Понятно</button>
          </div>
        </Dialog>
      )}
    </div>
  );
};

export default LabTestRequestPaje;
