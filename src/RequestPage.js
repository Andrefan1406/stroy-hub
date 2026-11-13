// =========================
//     ЗАЯВКА НА ТЕХНИКУ
// =========================
// Оформление — в стиле заявки на бетон (ConcreteRequestPage.module.css) и главной:
// одна колонка карточек «Когда / Куда / Что и сколько», подсказки и ошибки прямо
// на странице вместо всплывающих окон браузера, окна — components/RequestDialog.
// Данные, правила окна подачи и отправка в Google Apps Script — прежние.
import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getAuth } from 'firebase/auth';
import { TbAlertCircle, TbInfoCircle } from 'react-icons/tb';
import css from './ConcreteRequestPage.module.css';
import { objectCategoryOptions, objectPositionOptions, equipmentCategoryOptions } from './data/constructionData';
import Dialog from './components/RequestDialog';
import { Field, SelectField } from './components/RequestFormFields';
import { clearSubmissionId, getSubmissionId } from './utils/submissionId';
import { SCRIPT_URLS } from './config/scriptUrls';

const SCRIPT_URL = SCRIPT_URLS.equipment;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1nd1AxUUgxLcd6GYlnY5ZJZ0WYr-qmvrP67CGe1Ut4i8/edit?pli=1&gid=0#gid=0';

// Ответ скрипта таблицы прочитать нельзя (no-cors), поэтому зависшую отправку
// обрываем сами и просим проверить таблицу, прежде чем отправлять повторно.
const SEND_TIMEOUT_MS = 20000;

// Контакты ответственного запоминаем на этом устройстве, чтобы не вводить при каждой заявке.
const RESPONSIBLE_KEY = 'equipmentRequestResponsible';
const loadResponsible = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(RESPONSIBLE_KEY) || '{}');
    return { fullName: saved.fullName || '', position: saved.position || '', phone: saved.phone || '' };
  } catch {
    return { fullName: '', position: '', phone: '' };
  }
};

const hoursOptions = Array.from({ length: 17 }, (_, i) => i + 6);
const quantityOptions = Array.from({ length: 10 }, (_, i) => String(i + 1));
const responsiblePositions = ['Начальник участка', 'Производитель работ', 'Мастер'];

const emptyRow = () => ({
  startTime: '', endTime: '', objectCategory: '', object: '', position: '',
  category: '', equipmentName: '', quantity: '', note: ''
});

// Названия полей для сообщения «Не заполнено» и порядок обхода формы
// (по нему ищется первое пустое поле, куда переводится фокус).
const FIELD_LABELS = {
  startTime: 'Время начала', endTime: 'Время окончания', objectCategory: 'Категория объекта',
  object: 'Объект', position: 'Позиция', category: 'Категория техники',
  equipmentName: 'Наименование техники', quantity: 'Количество', note: 'Примечание'
};
const FIELD_ERRORS = {
  startTime: 'Выберите время', endTime: 'Выберите время', objectCategory: 'Выберите категорию',
  object: 'Выберите объект', position: 'Выберите позицию', category: 'Выберите категорию',
  equipmentName: 'Выберите наименование', quantity: 'Выберите количество',
  note: 'Укажите наименование, вес и местоположение груза'
};
const FORM_ORDER = Object.keys(FIELD_LABELS);

// Для манипуляторов и длинномеров примечание обязательно (груз и место).
const isNoteRequired = (category) => category === 'Манипуляторы' || category === 'Длинномеры';

const missingFields = (row) => FORM_ORDER.filter((name) => (
  name === 'note'
    ? isNoteRequired(row.category) && (row.note || '').trim() === ''
    : row[name] === ''
));

const isRowEmpty = (row) => Object.values(row).every((v) => v === '');

const getCurrentDate = () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (minutes) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;

// Окно подачи: на сегодня — с 07:00 до 10:00 (у Samat до 12:00), на другие даты —
// с 12:00 до 21:00. open — можно отправить прямо сейчас; text — что сказать
// пользователю (в том числе когда откроется и что можно сделать сейчас).
const submissionWindow = (dateStr, now, isSamat) => {
  const m = now.getHours() * 60 + now.getMinutes();
  const todayEnd = isSamat ? 12 * 60 : 10 * 60;
  const [, month, day] = dateStr.split('-');
  if (dateStr === getCurrentDate()) {
    if (m < 7 * 60) return { open: false, text: 'Приём заявок на сегодня откроется в 07:00.' };
    if (m <= todayEnd) return { open: true, text: `Приём заявок на сегодня открыт до ${hhmm(todayEnd)}.` };
    const tail = m < 12 * 60
      ? 'На другую дату заявки принимаются с 12:00 до 21:00.'
      : m <= 21 * 60
        ? 'Выберите другую дату: такие заявки принимаются до 21:00.'
        : 'Заявки на другие даты — завтра с 12:00 до 21:00.';
    return { open: false, text: `Приём заявок на сегодня закрыт (был до ${hhmm(todayEnd)}). ${tail}` };
  }
  if (m < 12 * 60) {
    const today = m >= 7 * 60 && m <= todayEnd ? ` Заявку на сегодня ещё можно подать до ${hhmm(todayEnd)}.` : '';
    return { open: false, text: `Приём заявок на ${day}.${month} откроется в 12:00.${today}` };
  }
  if (m <= 21 * 60) return { open: true, text: `Приём заявок на ${day}.${month} открыт до 21:00.` };
  return { open: false, text: `Приём заявок на ${day}.${month} закрыт (до 21:00), откроется завтра в 12:00.` };
};

const RequestPage = () => {
  const [requests, setRequests] = useState([emptyRow()]);
  const [fieldErrors, setFieldErrors] = useState(() => new Set());
  const [notice, setNotice] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const noticeRef = useRef(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const [showResponsible, setShowResponsible] = useState(false);
  const [showResend, setShowResend] = useState(false);
  const [showSunday, setShowSunday] = useState(false);
  const [showClear, setShowClear] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmedResend, setConfirmedResend] = useState(false);

  const [userFullName, setUserFullName] = useState(() => loadResponsible().fullName);
  const [userPhone, setUserPhone] = useState(() => loadResponsible().phone);
  const [userPosition, setUserPosition] = useState(() => loadResponsible().position);
  // Строки, у которых «Когда» и «Куда» подставлены из предыдущей — для пометки в карточке.
  const [copiedRows, setCopiedRows] = useState(() => new Set());

  // Дата из «Умной заявки» (одноразовая) — если она не в прошлом.
  const [selectedDate, setSelectedDate] = useState(() => {
    const smartDate = localStorage.getItem('smartRequestDate');
    localStorage.removeItem('smartRequestDate');
    return smartDate && smartDate >= getCurrentDate() ? smartDate : getCurrentDate();
  });

  const currentEmail = getAuth().currentUser?.email?.toLowerCase();
  const isSamat = currentEmail === 'samat88877@gmail.com';

  // Раз в 30 секунд пересчитываем статус окна подачи.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  const windowState = submissionWindow(selectedDate, now, isSamat);

  // Восстановление прошлой заявки (без даты и контактов).
  useEffect(() => {
    const saved = localStorage.getItem('lastRequestData');
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setRequests(parsed.map(({ date, fullName, phone, ...rest }) => ({ ...emptyRow(), ...rest })));
      }
    } catch (err) {
      console.error('Ошибка при загрузке сохранённой заявки:', err);
    }
  }, []);

  // Перевод фокуса на поле (из сводки «Не заполнено»).
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
    setRequests((prev) => prev.map((row, i) => {
      if (i !== index) return row;
      const next = { ...row, [field]: value };
      if (field === 'objectCategory') { next.object = ''; next.position = ''; }
      if (field === 'object') next.position = '';
      if (field === 'category') next.equipmentName = '';
      if (field === 'startTime' && next.endTime !== '' && Number(next.endTime) <= Number(value)) {
        next.endTime = '';
      }
      return next;
    }));
    setFieldErrors((prev) => {
      if (!prev.has(`${index}:${field}`)) return prev;
      const next = new Set(prev);
      next.delete(`${index}:${field}`);
      return next;
    });
  };

  const addRequest = () => {
    const last = requests.length - 1;
    const missing = missingFields(requests[last]);
    if (missing.length) {
      setFieldErrors(new Set(missing.map((name) => `${last}:${name}`)));
      setNotice({
        kind: 'missing',
        count: missing.length,
        rows: [{ index: last, fields: missing.map((field) => ({ field, label: FIELD_LABELS[field] })) }],
        hint: 'Заполните все поля текущей техники перед добавлением новой.'
      });
      setFocusId(`r${last}-${missing[0]}`);
      return;
    }
    setNotice(null);
    const prev = requests[last];
    setRequests([...requests, {
      ...emptyRow(),
      startTime: prev.startTime,
      endTime: prev.endTime,
      objectCategory: prev.objectCategory,
      object: prev.object,
      position: prev.position,
    }]);
    setCopiedRows((rows) => new Set(rows).add(requests.length));
  };

  const removeRequest = (index) => {
    if (requests.length <= 1) return;
    setRequests(requests.filter((_, i) => i !== index));
    setCopiedRows(new Set());
    setFieldErrors(new Set());
    setNotice(null);
  };

  const clearForm = () => {
    localStorage.removeItem('lastRequestData');
    setRequests([emptyRow()]);
    setCopiedRows(new Set());
    setFieldErrors(new Set());
    setNotice(null);
    setShowClear(false);
  };

  // opts.sundayOk / opts.resendOk — пользователь уже подтвердил соответствующее предупреждение.
  const submitRequest = (opts = {}) => {
    setNotice(null);

    if (!selectedDate) {
      setNotice({ kind: 'rule', message: 'Пожалуйста, выберите дату.' });
      return;
    }

    const current = submissionWindow(selectedDate, new Date(), isSamat);
    if (!current.open) {
      setNotice({ kind: 'rule', message: current.text });
      return;
    }

    const errors = new Set();
    const rows = [];
    requests.forEach((row, index) => {
      const missing = missingFields(row);
      missing.forEach((name) => errors.add(`${index}:${name}`));
      if (missing.length) {
        rows.push({ index, fields: missing.map((field) => ({ field, label: FIELD_LABELS[field] })) });
      }
    });
    setFieldErrors(errors);
    if (rows.length) {
      setNotice({ kind: 'missing', count: rows.reduce((n, r) => n + r.fields.length, 0), rows });
      setFocusId(`r${rows[0].index}-${rows[0].fields[0].field}`);
      return;
    }

    if (new Date(selectedDate).getDay() === 0 && !opts.sundayOk) {
      setShowSunday(true);
      return;
    }

    if (localStorage.getItem('lastRequestDate') === selectedDate && !confirmedResend && !opts.resendOk) {
      setShowResend(true);
      return;
    }

    setSubmitError('');
    setShowResponsible(true);
  };

  const handleFinalSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!userFullName.trim() || !userPhone.trim() || !userPosition.trim()) {
      setSubmitError('Пожалуйста, заполните ФИО, должность и номер телефона.');
      return;
    }
    setSubmitError('');
    setIsSubmitting(true);

    const updatedRequests = requests.map((request) => ({
      ...request,
      date: selectedDate,
      fullName: `${userFullName} - ${userPosition}`,
      phone: userPhone
    }));

    // Тот же набор данных — тот же ID при любом числе повторов: скрипт запишет заявку один раз,
    // даже если ответ не дошёл (см. utils/submissionId.js).
    const submissionId = getSubmissionId('equipment', updatedRequests);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedRequests.map((row) => ({ ...row, submissionId }))),
        signal: controller.signal,
      });
      clearSubmissionId('equipment');
      localStorage.setItem('lastRequestData', JSON.stringify(updatedRequests));
      localStorage.setItem('lastRequestDate', selectedDate);
      localStorage.setItem(RESPONSIBLE_KEY, JSON.stringify({ fullName: userFullName.trim(), position: userPosition.trim(), phone: userPhone.trim() }));
      setRequests([emptyRow()]);
      setCopiedRows(new Set());
      setFieldErrors(new Set());
      setSelectedDate(getCurrentDate());
      setShowResponsible(false);
      setSent(true);
    } catch (error) {
      console.error('Ошибка при отправке:', error);
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

  const formDirty = requests.length > 1 || !isRowEmpty(requests[0]);

  return (
    <div className={css.page}>
      <div className={css.content}>
        <Link to='/' className={css.back}>← На главную</Link>
        <h1 className={css.title}>Заявка на технику</h1>

        <p className={`${css.info} ${windowState.open ? '' : css.infoClosed}`} role='status'>
          {windowState.open
            ? <TbInfoCircle className={css.infoIcon} aria-hidden='true' />
            : <TbAlertCircle className={css.infoIcon} aria-hidden='true' />}
          {windowState.text}
        </p>

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

        <form onSubmit={(e) => { e.preventDefault(); submitRequest(); }} noValidate>
          {requests.map((request, index) => {
            const idOf = (name) => `r${index}-${name}`;
            const errorOf = (name) => (fieldErrors.has(`${index}:${name}`) ? FIELD_ERRORS[name] : undefined);
            const onChange = (e) => handleChange(index, e.target.name, e.target.value);
            const noteRequired = isNoteRequired(request.category);
            const inputClass = (name) => `${css.input} ${errorOf(name) ? css.inputError : ''}`;
            const nativeProps = (name) => ({
              id: idOf(name),
              name,
              value: request[name],
              onChange,
              'aria-required': true,
              'aria-invalid': errorOf(name) ? true : undefined,
              'aria-describedby': errorOf(name) ? `${idOf(name)}-err` : undefined,
            });
            return (
              <section key={index} className={css.card} aria-label={requests.length > 1 ? `Техника ${index + 1}` : 'Техника'}>
                <div className={css.cardHeader}>
                  <h2 className={css.cardTitle}>{requests.length > 1 ? `Техника ${index + 1}` : 'Техника'}</h2>
                  {requests.length > 1 && (
                    <button type='button' className={css.removeBtn} onClick={() => removeRequest(index)}>
                      Удалить
                    </button>
                  )}
                </div>

                {copiedRows.has(index) && (
                  <p className={css.help}>Время и объект подставлены из предыдущей техники — измените, если нужно.</p>
                )}

                <div role='group' aria-labelledby={idOf('g-when')} className={css.group}>
                  <h3 id={idOf('g-when')} className={css.groupTitle}>Когда</h3>
                  <div className={css.gridWhen}>
                    <Field label='Время начала' required htmlFor={idOf('startTime')} error={errorOf('startTime')} errorId={`${idOf('startTime')}-err`}>
                      <select className={inputClass('startTime')} {...nativeProps('startTime')}>
                        <option value=''>--</option>
                        {hoursOptions.map((hour) => (
                          <option key={hour} value={String(hour)}>{pad2(hour)}:00</option>
                        ))}
                      </select>
                    </Field>
                    <Field label='Время окончания' required htmlFor={idOf('endTime')} error={errorOf('endTime')} errorId={`${idOf('endTime')}-err`}>
                      <select className={inputClass('endTime')} disabled={!request.startTime} {...nativeProps('endTime')}>
                        <option value=''>{request.startTime ? '--' : 'Сначала время начала'}</option>
                        {hoursOptions.filter((hour) => hour > Number(request.startTime)).map((hour) => (
                          <option key={hour} value={String(hour)}>{pad2(hour)}:00</option>
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
                      value={request.objectCategory}
                      onChange={onChange}
                      error={errorOf('objectCategory')}
                    />
                    <SelectField
                      label='Объект'
                      name='object'
                      id={idOf('object')}
                      required
                      options={objectCategoryOptions[request.objectCategory] || []}
                      value={request.object}
                      onChange={onChange}
                      isDisabled={!request.objectCategory}
                      disabledHint='Сначала выберите категорию'
                      error={errorOf('object')}
                    />
                    <SelectField
                      label='Позиция или строение'
                      name='position'
                      id={idOf('position')}
                      required
                      options={objectPositionOptions[request.object] || []}
                      value={request.position}
                      onChange={onChange}
                      isDisabled={!request.object}
                      disabledHint='Сначала выберите объект'
                      error={errorOf('position')}
                    />
                  </div>
                </div>

                <div role='group' aria-labelledby={idOf('g-what')} className={css.group}>
                  <h3 id={idOf('g-what')} className={css.groupTitle}>Что и сколько</h3>
                  <div className={css.gridWhere}>
                    <SelectField
                      label='Категория техники'
                      name='category'
                      id={idOf('category')}
                      required
                      options={Object.keys(equipmentCategoryOptions)}
                      value={request.category}
                      onChange={onChange}
                      error={errorOf('category')}
                    />
                    <SelectField
                      label='Наименование техники'
                      name='equipmentName'
                      id={idOf('equipmentName')}
                      required
                      options={equipmentCategoryOptions[request.category] || []}
                      value={request.equipmentName}
                      onChange={onChange}
                      isDisabled={!request.category}
                      disabledHint='Сначала выберите категорию'
                      error={errorOf('equipmentName')}
                    />
                    <SelectField
                      label='Количество'
                      name='quantity'
                      id={idOf('quantity')}
                      required
                      options={quantityOptions}
                      value={request.quantity}
                      onChange={onChange}
                      error={errorOf('quantity')}
                    />
                  </div>
                </div>

                <div className={css.group}>
                  <Field
                    label='Примечание'
                    required={noteRequired}
                    optional={!noteRequired}
                    htmlFor={idOf('note')}
                    error={errorOf('note')}
                    errorId={`${idOf('note')}-err`}
                  >
                    <textarea
                      className={`${css.textarea} ${errorOf('note') ? css.inputError : ''}`}
                      id={idOf('note')}
                      name='note'
                      value={request.note}
                      onChange={onChange}
                      rows={3}
                      placeholder={noteRequired ? 'Укажите наименование, вес и местоположение груза' : 'Введите примечание...'}
                      aria-required={noteRequired || undefined}
                      aria-invalid={errorOf('note') ? true : undefined}
                      aria-describedby={errorOf('note') ? `${idOf('note')}-err` : undefined}
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
                {notice.kind === 'missing' ? `Не заполнено полей: ${notice.count}` : 'Заявку пока нельзя отправить'}
              </p>
              {notice.kind === 'rule' && <p className={css.noticeText}>{notice.message}</p>}
              {notice.kind === 'missing' && (
                <>
                  {notice.hint && <p className={css.noticeText}>{notice.hint}</p>}
                  <ul className={css.noticeList}>
                    {notice.rows.map((r) => (
                      <li key={r.index}>
                        {requests.length > 1 ? `Техника ${r.index + 1}: ` : ''}
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

          <button type='button' onClick={addRequest} className={css.addBtn}>+ Добавить ещё технику</button>

          {!windowState.open && (
            <p className={css.help}>Пока приём закрыт, заявку можно заполнить, но отправить её получится, когда окно откроется.</p>
          )}

          <div className={`${css.actions} ${keyboardOpen ? css.actionsStatic : ''}`}>
            {formDirty && (
              <button type='button' className={css.btnGhost} onClick={() => setShowClear(true)}>
                Очистить заявку
              </button>
            )}
            <button type='submit' className={css.btnPrimary}>Отправить заявку</button>
          </div>
        </form>
      </div>

      {showSunday && (
        <Dialog title='Заявка на выходной' onClose={() => setShowSunday(false)}>
          <p className={css.dialogText}>Вы подаёте заявку на воскресенье. Вы уверены?</p>
          <div className={css.dialogActions}>
            <button type='button' className={css.btnGhost} onClick={() => setShowSunday(false)}>Отмена</button>
            <button
              type='button'
              className={css.btnPrimary}
              onClick={() => { setShowSunday(false); submitRequest({ sundayOk: true }); }}
            >
              Да, подать
            </button>
          </div>
        </Dialog>
      )}

      {showResend && (
        <Dialog title='Заявка уже отправлена' onClose={() => setShowResend(false)}>
          <p className={css.dialogText}>На эту дату вы уже отправляли заявку. Вы уверены, что хотите отправить ещё одну?</p>
          <div className={css.dialogActions}>
            <button type='button' className={css.btnGhost} onClick={() => setShowResend(false)}>Отмена</button>
            <button
              type='button'
              className={css.btnPrimary}
              onClick={() => {
                setShowResend(false);
                setConfirmedResend(true);
                setSubmitError('');
                setShowResponsible(true);
              }}
            >
              Отправить ещё одну
            </button>
          </div>
        </Dialog>
      )}

      {showResponsible && (
        <Dialog title='Ответственный' onClose={() => setShowResponsible(false)}>
          <form onSubmit={handleFinalSubmit} className={css.dialogForm} noValidate>
            <p className={css.dialogSummary}>
              Позиций техники: {requests.length} · дата {selectedDate.split('-').reverse().join('.')}
            </p>

            <Field label='ФИО' required htmlFor='responsible-name'>
              <input
                id='responsible-name'
                type='text'
                className={css.input}
                value={userFullName}
                onChange={(e) => setUserFullName(e.target.value)}
                placeholder='Введите ФИО'
                autoComplete='name'
              />
            </Field>

            <Field label='Должность' required htmlFor='responsible-position'>
              <input
                id='responsible-position'
                type='text'
                list='responsiblePositions'
                className={css.input}
                value={userPosition}
                onChange={(e) => setUserPosition(e.target.value)}
                placeholder='Выберите или введите должность'
                autoComplete='organization-title'
              />
              <datalist id='responsiblePositions'>
                {responsiblePositions.map((position) => (
                  <option key={position} value={position} />
                ))}
              </datalist>
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

            <p className={css.help}>ФИО, должность и номер запоминаются на этом устройстве, в следующий раз вводить не придётся.</p>

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
            {requests.length > 1
              ? `Вся техника (${requests.length}) будет удалена, останется одна пустая строка.`
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
          <p className={css.dialogText}>
            Таблица не присылает подтверждение, поэтому убедитесь, что ваша заявка появилась в списке заявок на технику.
          </p>
          <div className={css.dialogActions}>
            <button type='button' className={css.btnGhost} onClick={() => setSent(false)}>Закрыть</button>
            <button type='button' className={css.btnPrimary} onClick={() => { window.location.href = SHEET_URL; }}>
              Открыть таблицу и проверить
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
};

export default RequestPage;
