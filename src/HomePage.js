import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAuth } from "firebase/auth";
import { fetchMissingGapDates, gapWarningMessage } from './peopleGapsGate';
import { fetchGprReportBlock, gprBlockMessage } from './gprReportGate';
import { ridesApiFetch } from './rides/api';
import { ROLE_HOME_PATH } from './rides/constants';
import { fetchManualBlock, manualBlockMessage } from './manualBlockGate';
import {
  TbAlertTriangle, TbBolt, TbCar, TbChartBar, TbChevronRight, TbCrane, TbFlask,
  TbLayoutGrid, TbLoader2, TbLock, TbRulerMeasure, TbSparkles, TbTruck, TbUsers, TbWall,
} from 'react-icons/tb';
import styles from './HomePage.module.css';

const BLOCK_NOTICE_ID = 'home-block-reasons';
const BLOCK_NOTICE_TITLE_ID = 'home-block-reasons-title';
const GATE_CHECKS_COUNT = 3;
const GATE_CHECKS_TIMEOUT_MS = 8000;

const HomePage = () => {
  const currentEmail = getAuth().currentUser?.email?.toLowerCase() || "";

  // Сколько из трёх проверок блокировки (люди, ГПР, ручная) ещё не ответили.
  // Пока ждём, плитки техники и бетона показывают «Проверяем доступ…» и не
  // ведут в форму — иначе они сначала активны, а через секунду сереют, и
  // плашка с причинами сдвигает сетку под пальцем. Ошибка проверки, как и
  // раньше, ничего не блокирует (fail-open): .finally срабатывает и на ней.
  const [gateChecksPending, setGateChecksPending] = useState(currentEmail ? GATE_CHECKS_COUNT : 0);
  const markGateChecked = () => setGateChecksPending((n) => Math.max(0, n - 1));

  // Зависшая проверка не должна запирать плитки навсегда: один таймер с
  // момента открытия страницы. Сработал раньше, чем ответили все проверки, —
  // плитки открываются (fail-open), а опоздавшие ответы на главной уже не
  // показываем: иначе плашка вставилась бы сверху и сдвинула сетку. Сама
  // блокировка от этого не теряется — её всё равно проверят гварды форм.
  const [gateChecksGaveUp, setGateChecksGaveUp] = useState(false);
  // Хотя бы одна проверка упала с ошибкой — плитки открыты (fail-open), но
  // честно пишем, что доступ проверят уже в форме.
  const [gateCheckFailed, setGateCheckFailed] = useState(false);
  const gateTimerRef = useRef(null);

  useEffect(() => {
    if (!currentEmail) return undefined;
    gateTimerRef.current = setTimeout(() => setGateChecksGaveUp(true), GATE_CHECKS_TIMEOUT_MS);
    return () => clearTimeout(gateTimerRef.current);
  }, [currentEmail]);

  useEffect(() => {
    if (gateChecksPending === 0) clearTimeout(gateTimerRef.current);
  }, [gateChecksPending]);

  // Показываем предупреждение сразу на главной (а не только в момент
  // отправки заявки на бетон/раствор — см. ConcreteRequestPage.js), чтобы
  // пользователь не тратил время на заполнение формы, которую всё равно
  // не даст отправить.
  const [missingGapDates, setMissingGapDates] = useState([]);

  useEffect(() => {
    if (!currentEmail) return;
    fetchMissingGapDates()
      .then(setMissingGapDates)
      .catch((err) => {
        console.error('Не удалось проверить пропуски в отчётах по людям:', err);
        setGateCheckFailed(true);
      })
      .finally(markGateChecked);
  }, [currentEmail]);

  // Отдельная, независимая проверка — блокировка за незакрытый пропуск в
  // ГПР (позиция 64), см. gprReportGate.js. Свой список email
  // (gpr_report_check_rules) и своё сообщение — но та же механика "нельзя
  // подать заявку, пока не закрыто", что и у пропусков по людям выше.
  const [gprBlocked, setGprBlocked] = useState(false);
  const [gprGaps, setGprGaps] = useState([]);

  useEffect(() => {
    if (!currentEmail) return;
    fetchGprReportBlock()
      .then(({ blocked, gaps }) => {
        setGprBlocked(blocked);
        setGprGaps(gaps);
      })
      .catch((err) => {
        console.error('Не удалось проверить пропуски в отчётах ГПР:', err);
        setGateCheckFailed(true);
      })
      .finally(markGateChecked);
  }, [currentEmail]);

  // Если у сотрудника уже есть роль в системе поездок и при этом включён
  // "Доступ ко всему сайту" (иначе он сюда физически не попал бы —
  // см. RideAccessGate.jsx), даём ему кнопку назад на его страницу
  // поездок — иначе с главной до неё не добраться, кроме как вручную
  // вбив адрес в браузере.
  const [rideRole, setRideRole] = useState(null);
  useEffect(() => {
    if (!currentEmail) return;
    ridesApiFetch('/api/v1/users/me')
      .then(({ user }) => setRideRole(user?.role || null))
      .catch(() => {});
  }, [currentEmail]);

  // Ручная блокировка администратором (см. manualBlockGate.js) — её
  // комментарий показываем первым, выше автоматических причин.
  const [manualBlock, setManualBlock] = useState({ blocked: false, comment: '' });

  useEffect(() => {
    if (!currentEmail) return;
    fetchManualBlock()
      .then(setManualBlock)
      .catch((err) => {
        console.error('Не удалось проверить ручную блокировку:', err);
        setGateCheckFailed(true);
      })
      .finally(markGateChecked);
  }, [currentEmail]);

  const isRequestsBlocked = manualBlock.blocked || missingGapDates.length > 0 || gprBlocked;
  const blockedTitle = manualBlock.blocked
    ? manualBlockMessage(manualBlock.comment)
    : missingGapDates.length > 0
      ? gapWarningMessage(missingGapDates)
      : gprBlocked
        ? gprBlockMessage(gprGaps)
        : undefined;

  const rideHomePath = rideRole && ROLE_HOME_PATH[rideRole];
  // 'unverified' — проверки не успели (тайм-аут) или упали: плитки открыты,
  // а опоздавшие ответы на главной уже не показываем — иначе блок с
  // причинами вставился бы в сетку и сдвинул её.
  const gateState = gateChecksGaveUp
    ? 'unverified'
    : gateChecksPending > 0
      ? 'pending'
      : isRequestsBlocked
        ? 'blocked'
        : gateCheckFailed
          ? 'unverified'
          : 'open';

  // Все причины блокировки — одним блоком, у каждой свой путь к исправлению.
  // Тексты — из тех же gate-модулей, что и у форм.
  const blockReasons = [
    manualBlock.blocked && {
      key: 'manual',
      text: manualBlockMessage(manualBlock.comment),
    },
    missingGapDates.length > 0 && {
      key: 'people',
      // Заголовок блока уже говорит, что заявки закрыты, — убираем повтор.
      text: gapWarningMessage(missingGapDates).replace(/^Подача заявок недоступна\.\s*/, ''),
      action: { label: 'Заполнить отчёт по людям', path: '/people-report' },
    },
    gprBlocked && {
      key: 'gpr',
      text: gprBlockMessage(gprGaps),
      action: { label: 'Открыть таблицы ГПР', path: '/grafiki' },
    },
  ].filter(Boolean);

  // Тап по заблокированной плитке не ведёт в форму (как и раньше), а
  // показывает причину: на телефоне подсказка title не видна.
  const noticeRef = useRef(null);
  const showBlockReasons = () => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    noticeRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    noticeRef.current?.focus({ preventScroll: true });
  };

  // Причины — под плитками техники и бетона, а не над всей сеткой:
  // так при их появлении ничего выше не сдвигается под пальцем.
  // Показываем, когда ответили все проверки (иначе блок дорастал бы
  // по одной причине); появление — плавным раскрытием по высоте.
  const resourceNotice = gateState === 'blocked' && blockReasons.length > 0 ? (
    <div className={styles.noticeReveal}>
      <div className={styles.noticeClip}>
        <div
          id={BLOCK_NOTICE_ID}
          ref={noticeRef}
          tabIndex={-1}
          role="region"
          aria-labelledby={BLOCK_NOTICE_TITLE_ID}
          className={styles.notice}
        >
          <p id={BLOCK_NOTICE_TITLE_ID} className={styles.noticeTitle}>
            <TbAlertTriangle className={styles.noticeIcon} aria-hidden="true" />
            Заявки на технику и бетон пока закрыты
          </p>
          <ul className={blockReasons.length > 1 ? styles.noticeList : styles.noticeListSingle}>
            {blockReasons.map(({ key, text, action }) => (
              <li key={key} className={styles.noticeItem}>
                <span>{text}</span>
                {action && (
                  <Link to={action.path} className={styles.noticeAction}>
                    {action.label}
                    <TbChevronRight aria-hidden="true" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {/* Умная заявка намеренно не проверяет блокировки (см.
              SmartRequestPage.jsx) — это и есть выход для заблокированных. */}
          <p className={styles.noticeAlt}>
            Подать заявку можно и сейчас — через{' '}
            <Link to="/smart-request" className={styles.noticeAction}>
              Умную заявку
              <TbChevronRight aria-hidden="true" />
            </Link>
          </p>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <img src="/Логотип.png" alt="VK Development Group" className={styles.logo} />
        </div>
      </header>

      <main className={styles.content}>
        <h1 className={styles.title}>Добро пожаловать!</h1>
        <p className={styles.subtitle}>Внутренний портал VK Development Group</p>

        {/* Живой регион есть на странице всегда, а текст в него попадает, когда
            ответили проверки, — так скринридер его зачитывает (регион,
            появившийся сразу с текстом, многие не озвучивают). */}
        <div role="status" className={styles.srOnly}>
          {gateState === 'blocked' ? 'Заявки на технику и бетон пока закрыты. Причины — в блоке ниже.' : ''}
        </div>

        <Link to="/smart-request" className={styles.smart}>
          <span className={styles.tileIcon} aria-hidden="true"><TbSparkles /></span>
          <span className={styles.tileLabel}>Умная заявка (AI)</span>
          <TbChevronRight className={styles.chevron} aria-hidden="true" />
        </Link>

        <Section title="Заявки на ресурсы" after={resourceNotice}>
          <Tile
            icon={<TbCrane />}
            to="/request"
            gate={gateState}
            onBlockedClick={showBlockReasons}
            title={blockedTitle}
          >
            Заявка на технику
          </Tile>
          <Tile
            icon={<TbTruck />}
            to="/concrete-request"
            gate={gateState}
            onBlockedClick={showBlockReasons}
            title={blockedTitle}
          >
            Заявка на бетон и раствор
          </Tile>
          <Tile icon={<TbLayoutGrid />} to="/blbrequest">
            Заявка на брусчатку
          </Tile>
          <Tile icon={<TbWall />} to="/znbrequest">
            Заявка на ж/б изделия
          </Tile>
        </Section>

        <Section title="Инженерные службы">
          <Tile icon={<TbBolt />} to="/electricans-request">
            Заявка электриков
          </Tile>
          <Tile icon={<TbRulerMeasure />} to="/geo-request">
            Заявка геодезистов
          </Tile>
          <Tile icon={<TbFlask />} to="/lab-request">
            Лабораторные испытания
          </Tile>
        </Section>

        <Section title="Отчёты">
          <Tile icon={<TbUsers />} to="/people-report">
            Отчёты по людям
          </Tile>
          <Tile icon={<TbChartBar />} to="/reports-dashboard">
            Графики и отчёты
          </Tile>
        </Section>

        {/* Кнопка поездок — только у кого есть роль в системе поездок, поэтому
            без неё не показываем и сам раздел. */}
        {rideHomePath && (
          <Section title="Транспорт">
            <Tile icon={<TbCar />} to={rideHomePath}>
              Служебный транспорт
            </Tile>
          </Section>
        )}
      </main>
    </div>
  );
};

const Section = ({ title, children, after = null }) => (
  <section className={styles.section}>
    <h2 className={styles.sectionTitle}>{title}</h2>
    <div className={styles.grid}>{children}</div>
    {after}
  </section>
);

// gate — состояние плиток, закрываемых проверками блокировки:
// 'pending' — проверки ещё идут, 'blocked' — есть причина, 'open' — можно,
// 'unverified' — проверить не удалось (форма проверит сама).
// Во всех состояниях это одна и та же ссылка (<Link>): смена типа элемента
// перемонтировала бы её, и фокус с клавиатуры/скринридера улетал бы в начало
// страницы. Закрытая плитка не ведёт в форму, а показывает причины; пока
// идёт проверка — не делает ничего.
const Tile = ({ icon, children, to, gate = 'open', onBlockedClick, title }) => {
  const blocked = gate === 'blocked';
  const pending = gate === 'pending';
  const unverified = gate === 'unverified';
  const tileClass = [styles.tile, blocked && styles.tileBlocked, pending && styles.tilePending]
    .filter(Boolean)
    .join(' ');

  const handleClick = (event) => {
    if (pending) event.preventDefault();
    if (blocked) {
      event.preventDefault();
      onBlockedClick?.();
    }
  };

  return (
    <Link
      to={to}
      className={tileClass}
      onClick={handleClick}
      aria-disabled={pending || undefined}
      aria-describedby={blocked ? BLOCK_NOTICE_TITLE_ID : undefined}
      title={blocked ? title : undefined}
    >
      <span className={styles.tileIcon} aria-hidden="true">{icon}</span>
      <span className={styles.tileLabel}>
        {children}
        {blocked && <span className={styles.tileStatus}>Закрыто — нажмите, чтобы узнать почему</span>}
        {pending && <span className={styles.tileStatusMuted}>Проверяем доступ…</span>}
        {unverified && (
          <span className={styles.tileStatusMuted}>Не удалось проверить доступ — проверим при открытии формы</span>
        )}
      </span>
      {blocked && <TbLock className={styles.chevron} aria-hidden="true" />}
      {pending && <TbLoader2 className={`${styles.chevron} ${styles.spinner}`} aria-hidden="true" />}
      {!blocked && !pending && <TbChevronRight className={styles.chevron} aria-hidden="true" />}
    </Link>
  );
};

export default HomePage;