// Заявка электриков. Оформление — в стиле заявок на бетон, технику, брусчатку и ж/б
// (ConcreteRequestPage.module.css): карточки «Когда / Куда / Что сделать», ошибки и
// подсказки на странице, окна — components/RequestDialog. Данные и отправка в
// Google Apps Script (google-apps-scripts/elec_script.js) — прежние.
import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { getAuth } from 'firebase/auth';
import { TbAlertCircle } from 'react-icons/tb';
import css from './ConcreteRequestPage.module.css';
import { objectCategoryOptions, objectPositionOptions, workCategoryOptions } from './data/constructionData';
import Dialog from './components/RequestDialog';
import { Field, SelectField } from './components/RequestFormFields';

// Скрипт Google Apps Script для записи в таблицу (адрес — в переменной окружения сборки).
const SCRIPT_URL = process.env.REACT_APP_ELEC_SCRIPT_URL || '';
// Ответ скрипта прочитать нельзя (no-cors): зависшую отправку обрываем сами
// и просим убедиться, что заявка не дошла, прежде чем отправлять повторно.
const SEND_TIMEOUT_MS = 20000;

// Контакты заявителя запоминаем на этом устройстве.
const RESPONSIBLE_KEY = 'electricRequestResponsible';
const loadResponsible = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(RESPONSIBLE_KEY) || '{}');
    return { fullName: saved.fullName || '', position: saved.position || '', phone: saved.phone || '' };
  } catch {
    return { fullName: '', position: '', phone: '' };
  }
};

const getCurrentDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const hoursOptions = Array.from({ length: 17 }, (_, i) => i + 6); // 6..22
const applicantPositions = ['Начальник участка', 'Производитель работ', 'Мастер'];

const emptyRow = () => ({
  objectCategory: '', object: '', position: '',
  workCategory: '', workDescription: '', startTime: '',
});

// Обязательны только эти поля (как и раньше); порядок — порядок обхода формы.
const FIELD_LABELS = { objectCategory: 'Категория объекта', object: 'Объект', workCategory: 'Категория работ' };
const FIELD_ERRORS = { objectCategory: 'Выберите категорию', object: 'Выберите объект', workCategory: 'Выберите категорию работ' };
const FORM_ORDER = Object.keys(FIELD_LABELS);

const missingFields = (row) => FORM_ORDER.filter((name) => !row[name]);
const isRowEmpty = (row) => Object.values(row).every((v) => v === '');

const ElectricansRequestPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState(getCurrentDate());
  const [rows, setRows] = useState([emptyRow()]);
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
  const [userFullName, setUserFullName] = useState(() => loadResponsible().fullName);
  const [userPosition, setUserPosition] = useState(() => loadResponsible().position);
  const [userPhone, setUserPhone] = useState(() => loadResponsible().phone);

  // Заявка, подготовленная «Умной заявкой».
  useEffect(() => {
    const prefill = location.state?.prefill;
    if (!prefill) return;
    if (prefill.date) setSelectedDate(prefill.date);
    if (prefill.rows?.length) {
      setRows(prefill.rows.map((r) => ({ ...emptyRow(), ...r })));
    }
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

  const handleDateChange = (e) => {
    const newDate = e.target.value;
    if (newDate < getCurrentDate()) {
      setNotice({ kind: 'rule', message: 'Нельзя выбрать дату меньше текущей.' });
      return;
    }
    setNotice(null);
    setSelectedDate(newDate);
  };

  const handleChange = (index, field, value) => {
    setRows((prev) => prev.map((row, i) => {
      if (i !== index) return row;
      const next = { ...row, [field]: value };
      if (field === 'objectCategory') { next.object = ''; next.position = ''; }
      if (field === 'object') next.position = '';
      return next;
    }));
    setFieldErrors((prev) => {
      if (!prev.has(`${index}:${field}`)) return prev;
      const next = new Set(prev);
      next.delete(`${index}:${field}`);
      return next;
    });
  };

  const missingNotice = (list, hint) => ({
    kind: 'missing',
    count: list.reduce((n, r) => n + r.fields.length, 0),
    rows: list,
    hint
  });

  const addRow = () => {
    const last = rows.length - 1;
    const missing = missingFields(rows[last]);
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
    const prev = rows[last];
    setRows([...rows, {
      ...emptyRow(),
      objectCategory: prev.objectCategory, object: prev.object, position: prev.position, startTime: prev.startTime
    }]);
    setCopiedRows((set) => new Set(set).add(rows.length));
  };

  const removeRow = (index) => {
    if (rows.length <= 1) return;
    setRows(rows.filter((_, i) => i !== index));
    setCopiedRows(new Set());
    setFieldErrors(new Set());
    setNotice(null);
  };

  const clearForm = () => {
    setRows([emptyRow()]);
    setCopiedRows(new Set());
    setFieldErrors(new Set());
    setNotice(null);
    setShowClear(false);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setNotice(null);

    if (!getAuth().currentUser) {
      setNotice({ kind: 'rule', message: 'Пожалуйста, войдите в систему.' });
      return;
    }

    const errors = new Set();
    const list = [];
    rows.forEach((row, index) => {
      const missing = missingFields(row);
      missing.forEach((name) => errors.add(`${index}:${name}`));
      if (missing.length) list.push({ index, fields: missing.map((field) => ({ field, label: FIELD_LABELS[field] })) });
    });
    setFieldErrors(errors);
    if (list.length) {
      setNotice(missingNotice(list));
      setFocusId(`r${list[0].index}-${list[0].fields[0].field}`);
      return;
    }

    setSubmitError('');
    setShowModal(true);
  };

  const handleFinalSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!userFullName.trim() || !userPhone.trim() || !userPosition.trim()) {
      setSubmitError('Пожалуйста, заполните ФИО, должность и номер телефона.');
      return;
    }
    // Раньше без адреса скрипта страница ничего не отправляла, но писала «Заявка отправлена».
    if (!SCRIPT_URL) {
      setSubmitError('Отправка заявок электриков не настроена: нет адреса скрипта. Сообщите администратору сайта.');
      return;
    }
    setSubmitError('');
    setIsSubmitting(true);

    const payload = rows.map((row) => ({
      date: selectedDate,
      startTime: row.startTime ? `${row.startTime}:00` : '',
      objectCategory: row.objectCategory,
      object: row.object,
      position: row.position,
      workCategory: row.workCategory,
      workDescription: row.workDescription,
      fullName: `${userFullName} - ${userPosition}`,
      phone: userPhone,
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      localStorage.setItem(RESPONSIBLE_KEY, JSON.stringify({
        fullName: userFullName.trim(), position: userPosition.trim(), phone: userPhone.trim()
      }));
      setRows([emptyRow()]);
      setCopiedRows(new Set());
      setFieldErrors(new Set());
      setShowModal(false);
      setSent(true);
    } catch (err) {
      console.error(err);
      // Обрыв по таймауту: запрос мог дойти, а ответ — нет. Повтор без проверки даст дубль.
      setSubmitError(
        err && err.name === 'AbortError'
          ? 'Нет ответа за 20 секунд — связь слабая. Заявка могла дойти: уточните у диспетчера электриков, прежде чем отправлять ещё раз, иначе получится дубль.'
          : 'Заявка не отправлена: нет связи с сервером. Проверьте интернет и нажмите «Отправить заявку» ещё раз — введённые данные сохранены.'
      );
    } finally {
      clearTimeout(timer);
      setIsSubmitting(false);
    }
  };

  const formDirty = rows.length > 1 || !isRowEmpty(rows[0]);
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to='/' className={css.back}>← На главную</Link>
        <h1 className={css.title}>Заявка электриков</h1>

        <p className={css.legend}>
          <span className={css.required} aria-hidden='true'>*</span> — обязательное поле.
        </p>

        <section className={css.card} aria-label='Дата заявки'>
          <div className={css.gridWhen}>
            <Field label='Дата заявки' required htmlFor='request-date'>
              <input
                id='request-date'
                type='date'
                className={css.input}
                value={selectedDate}
                min={getCurrentDate()}
                onChange={handleDateChange}
              />
            </Field>
          </div>
        </section>

        <form onSubmit={handleSubmit} noValidate>
          {rows.map((row, index) => {
            const idOf = (name) => `r${index}-${name}`;
            const errorOf = (name) => (fieldErrors.has(`${index}:${name}`) ? FIELD_ERRORS[name] : undefined);
            const onChange = (e) => handleChange(index, e.target.name, e.target.value);

            return (
              <section key={index} className={css.card} aria-label={rows.length > 1 ? `Работа ${index + 1}` : 'Работа'}>
                <div className={css.cardHeader}>
                  <h2 className={css.cardTitle}>{rows.length > 1 ? `Работа ${index + 1}` : 'Работа'}</h2>
                  {rows.length > 1 && (
                    <button type='button' className={css.removeBtn} onClick={() => removeRow(index)}>
                      Удалить
                    </button>
                  )}
                </div>

                {copiedRows.has(index) && (
                  <p className={css.help}>Время и место подставлены из предыдущей работы — измените, если нужно.</p>
                )}

                <div role='group' aria-labelledby={idOf('g-when')} className={css.group}>
                  <h3 id={idOf('g-when')} className={css.groupTitle}>Когда</h3>
                  <div className={css.gridWhen}>
                    <Field label='Время начала' optional htmlFor={idOf('startTime')}>
                      <select
                        id={idOf('startTime')}
                        name='startTime'
                        className={css.input}
                        value={row.startTime}
                        onChange={onChange}
                      >
                        <option value=''>--</option>
                        {hoursOptions.map((h) => (
                          <option key={h} value={String(h)}>{hh(h)}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </div>

                <div role='group' aria-labelledby={idOf('g-where')} className={css.group}>
                  <h3 id={idOf('g-where')} className={css.groupTitle}>Куда</h3>
                  <div className={css.gridWhere}>
                    <SelectField
                      label='Категория объекта'
                      name='objectCategory'
                      id={idOf('objectCategory')}
                      required
                      options={Object.keys(objectCategoryOptions)}
                      value={row.objectCategory}
                      onChange={onChange}
                      error={errorOf('objectCategory')}
                    />
                    <SelectField
                      label='Объект'
                      name='object'
                      id={idOf('object')}
                      required
                      options={objectCategoryOptions[row.objectCategory] || []}
                      value={row.object}
                      onChange={onChange}
                      isDisabled={!row.objectCategory}
                      disabledHint='Сначала выберите категорию'
                      error={errorOf('object')}
                    />
                    <SelectField
                      label='Позиция или строение'
                      name='position'
                      id={idOf('position')}
                      optional
                      options={objectPositionOptions[row.object] || []}
                      value={row.position}
                      onChange={onChange}
                      isDisabled={!row.object}
                      disabledHint='Сначала выберите объект'
                    />
                  </div>
                </div>

                <div role='group' aria-labelledby={idOf('g-what')} className={css.group}>
                  <h3 id={idOf('g-what')} className={css.groupTitle}>Что сделать</h3>
                  <div className={css.gridWhen}>
                    <SelectField
                      label='Категория работ'
                      name='workCategory'
                      id={idOf('workCategory')}
                      required
                      options={workCategoryOptions}
                      value={row.workCategory}
                      onChange={onChange}
                      error={errorOf('workCategory')}
                    />
                  </div>
                  <div className={css.group}>
                    <Field label='Описание работ' optional htmlFor={idOf('workDescription')}>
                      <textarea
                        id={idOf('workDescription')}
                        name='workDescription'
                        className={css.textarea}
                        value={row.workDescription}
                        onChange={onChange}
                        rows={3}
                        placeholder='Укажите детали работ...'
                      />
                    </Field>
                  </div>
                </div>
              </section>
            );
          })}

          {notice && (
            <div ref={noticeRef} className={css.noticeError} role='alert'>
              <p className={css.noticeTitle}>
                <TbAlertCircle className={css.noticeIcon} aria-hidden='true' />
                {notice.kind === 'missing' ? `Не заполнено полей: ${notice.count}` : 'Заявку пока нельзя отправить'}
              </p>
              {notice.kind === 'rule' && <p className={css.noticeText}>{notice.message}</p>}
              {notice.kind === 'missing' && (
                <>
                  {notice.hint && <p className={css.noticeText}>{notice.hint}</p>}
                  <ul className={css.noticeList}>
                    {notice.rows.map((r) => (
                      <li key={r.index}>
                        {rows.length > 1 ? `Работа ${r.index + 1}: ` : ''}
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
                </>
              )}
            </div>
          )}

          <button type='button' onClick={addRow} className={css.addBtn}>+ Добавить ещё работу</button>

          <div className={`${css.actions} ${keyboardOpen ? css.actionsStatic : ''}`}>
            {formDirty && (
              <button type='button' className={css.btnGhost} onClick={() => setShowClear(true)}>
                Очистить заявку
              </button>
            )}
            <button type='submit' className={css.btnPrimary}>
              {rows.length > 1 ? `Отправить заявки (${rows.length})` : 'Отправить заявку'}
            </button>
          </div>
        </form>
      </div>

      {showModal && (
        <Dialog title='Данные заявителя' onClose={() => setShowModal(false)}>
          <form onSubmit={handleFinalSubmit} className={css.dialogForm} noValidate>
            <p className={css.dialogSummary}>
              Работ в заявке: {rows.length} · дата {selectedDate.split('-').reverse().join('.')}
            </p>

            <Field label='ФИО' required htmlFor='applicant-name'>
              <input
                id='applicant-name'
                type='text'
                className={css.input}
                value={userFullName}
                onChange={(e) => setUserFullName(e.target.value)}
                placeholder='Иванов Иван Иванович'
                autoComplete='name'
              />
            </Field>

            <Field label='Должность' required htmlFor='applicant-position'>
              <select
                id='applicant-position'
                className={css.input}
                value={userPosition}
                onChange={(e) => setUserPosition(e.target.value)}
              >
                <option value=''>Выберите должность</option>
                {applicantPositions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>

            <Field label='Телефон' required htmlFor='applicant-phone'>
              <input
                id='applicant-phone'
                type='tel'
                inputMode='tel'
                className={css.input}
                value={userPhone}
                onChange={(e) => setUserPhone(e.target.value)}
                placeholder='+7 (XXX) XXX-XX-XX'
                autoComplete='tel'
              />
            </Field>

            <p className={css.help}>ФИО, должность и телефон запоминаются на этом устройстве, в следующий раз вводить не придётся.</p>

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
            {rows.length > 1
              ? `Все работы (${rows.length}) будут удалены, останется одна пустая.`
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
          <p className={css.dialogText}>Заявка электриков отправлена.</p>
          <div className={css.dialogActions}>
            <button type='button' className={css.btnGhost} onClick={() => navigate('/')}>На главную</button>
            <button type='button' className={css.btnPrimary} onClick={() => setSent(false)}>Понятно</button>
          </div>
        </Dialog>
      )}
    </div>
  );
};

export default ElectricansRequestPage;
