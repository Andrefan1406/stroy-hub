import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAuth } from "firebase/auth";
import { fetchMissingGapDates, gapWarningMessage } from './peopleGapsGate';
import { fetchGprReportBlock, gprBlockMessage } from './gprReportGate';
import { ridesApiFetch } from './rides/api';
import { ROLE_HOME_PATH } from './rides/constants';
import { fetchManualBlock, manualBlockMessage } from './manualBlockGate';


const HomePage = () => {
  const navigate = useNavigate();

  const currentEmail = getAuth().currentUser?.email?.toLowerCase() || "";

  // Показываем предупреждение сразу на главной (а не только в момент
  // отправки заявки на бетон/раствор — см. ConcreteRequestPage.js), чтобы
  // пользователь не тратил время на заполнение формы, которую всё равно
  // не даст отправить.
  const [missingGapDates, setMissingGapDates] = useState([]);

  useEffect(() => {
    if (!currentEmail) return;
    fetchMissingGapDates()
      .then(setMissingGapDates)
      .catch((err) => console.error('Не удалось проверить пропуски в отчётах по людям:', err));
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
      .catch((err) => console.error('Не удалось проверить пропуски в отчётах ГПР:', err));
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
      .catch((err) => console.error('Не удалось проверить ручную блокировку:', err));
  }, [currentEmail]);

  const isRequestsBlocked = manualBlock.blocked || missingGapDates.length > 0 || gprBlocked;
  const blockedTitle = manualBlock.blocked
    ? manualBlockMessage(manualBlock.comment)
    : missingGapDates.length > 0
      ? gapWarningMessage(missingGapDates)
      : gprBlocked
        ? gprBlockMessage(gprGaps)
        : undefined;

  return (
    <div style={styles.container}>
      <img src="/Логотип.png" alt="Логотип" style={styles.logo} />

      <h1>Добро пожаловать!</h1>

      {manualBlock.blocked && (
        <div style={{ ...styles.gapWarning, whiteSpace: 'pre-wrap' }}>{manualBlockMessage(manualBlock.comment)}</div>
      )}

      {missingGapDates.length > 0 && (
        <div style={styles.gapWarning}>{gapWarningMessage(missingGapDates)}</div>
      )}

      {gprBlocked && (
        <div style={styles.gapWarning}>{gprBlockMessage(gprGaps)}</div>
      )}

      <button onClick={() => navigate('/smart-request')} style={styles.smartButton}>
        ✦ Умная заявка (AI)
      </button>

      <button
        onClick={() => navigate('/request')}
        disabled={isRequestsBlocked}
        style={isRequestsBlocked ? styles.buttonDisabled : styles.button}
        title={blockedTitle}
      >
        Заявка на технику
      </button>

      <button
        onClick={() => navigate('/concrete-request')}
        disabled={isRequestsBlocked}
        style={isRequestsBlocked ? styles.buttonDisabled : styles.button}
        title={blockedTitle}
      >
        Заявка на бетон и раствор
      </button>

      <button onClick={() => navigate('/electricans-request')} style={styles.button}>
        Заявка электриков
      </button>

      <button onClick={() => navigate('/geo-request')} style={styles.button}>
        Заявка геодезистов
      </button>

      <button onClick={() => navigate('/lab-request')} style={styles.button}>
        Лабораторные испытания
      </button>

      <button onClick={() => navigate('/blbrequest')} style={styles.button}>
        Заявка на брусчатку
      </button>

      <button onClick={() => navigate('/znbrequest')} style={styles.button}>
        Заявка на ж/б изделия
      </button>

      <button onClick={() => navigate('/people-report')} style={styles.button}>
        Отчёты по людям
      </button>

      <button
        onClick={() => navigate('/reports-dashboard')}
        style={{ ...styles.button, background: 'red' }}
      >
        Графики и отчёты
      </button>

      {rideRole && ROLE_HOME_PATH[rideRole] && (
        <button onClick={() => navigate(ROLE_HOME_PATH[rideRole])} style={styles.rideButton}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle', marginRight: '8px' }}>
            <path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16C5.67 16 5 15.33 5 14.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z" />
          </svg>
          Служебный транспорт
        </button>
      )}
    </div>
  );
};

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minHeight: '100vh',
    textAlign: 'center',
    gap: '20px',
    paddingTop: '40px',
    position: 'relative'
  },

  logo: {
    width: '300px',
    maxWidth: '80%'
  },





  gapWarning: {
    background: '#fff0f0',
    color: '#c00',
    border: '1px solid #f5b5b5',
    borderRadius: '8px',
    padding: '12px 18px',
    maxWidth: '420px',
    fontSize: '14px',
    fontWeight: '600',
  },
  button: {
    padding: '10px 20px',
    background: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
    fontSize: '16px',
    width: '300px'
  },
  buttonDisabled: {
    padding: '10px 20px',
    background: '#b0b0b0',
    color: '#e8e8e8',
    border: 'none',
    borderRadius: '5px',
    cursor: 'not-allowed',
    fontSize: '16px',
    width: '300px'
  },
  smartButton: {
    padding: '12px 20px',
    background: 'linear-gradient(135deg, #6610f2, #007bff)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '16px',
    fontWeight: '700',
    width: '300px',
    boxShadow: '0 4px 12px rgba(102,16,242,0.35)',
  },
  rideButton: {
    padding: '10px 20px',
    background: '#28a745',
    color: 'white',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
    fontSize: '16px',
    width: '300px'
  }
};

export default HomePage;