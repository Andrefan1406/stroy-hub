// Блокирует переход НА САМУ страницу заявки (не только отправку формы) для
// сотрудника, за чьим объектом в PlanRadar есть просроченные замечания
// (planradarGate.js) — аналог PlanradarGuard.jsx, только по другому источнику. Работает и при прямом переходе по ссылке —
// это обёртка вокруг самого роута (см. App.js), а не кнопка на главной.
// Исключение: заявки, пришедшие из Умной заявки (SmartRequestPage.jsx
// передаёт location.state.viaSmartRequest), блокировку не проходят —
// пользователь уже осознанно подаёт заявку через AI-помощника.
import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getAuth } from 'firebase/auth';
import { fetchPlanradarBlock, planradarBlockMessage } from '../planradarGate';

const PlanradarGuard = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const currentEmail = getAuth().currentUser?.email?.toLowerCase() || '';
  const bypassed = !!location.state?.viaSmartRequest;

  // Кого проверять, сервер решает сам по справочнику объектов — для email
  // без закреплённых объектов fetchPlanradarBlock вернёт blocked:false. 'clear' по умолчанию без залогиненного email (или при
  // обходе через Умную заявку) — им не нужно ждать сетевой запрос, чтобы
  // увидеть страницу.
  const [status, setStatus] = useState(currentEmail && !bypassed ? 'checking' : 'clear');
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!currentEmail || bypassed) return;
    let cancelled = false;

    fetchPlanradarBlock()
      .then(({ blocked, items: list }) => {
        if (cancelled) return;
        setItems(list);
        setStatus(blocked ? 'blocked' : 'clear');
      })
      .catch((err) => {
        // Проверка недоступна (сеть/бэкенд) — не блокируем страницу из-за
        // этого, тот же fail-open, что и в остальных местах (planradarGate.js).
        console.error('Не удалось проверить замечания PlanRadar:', err);
        if (!cancelled) setStatus('clear');
      });

    return () => {
      cancelled = true;
    };
  }, [currentEmail, bypassed]);

  if (status === 'checking') {
    return <div style={styles.wrap}>Проверка доступа...</div>;
  }

  if (status === 'blocked') {
    return (
      <div style={styles.wrap}>
        <div style={styles.box}>
          <p style={{ margin: 0 }}>{planradarBlockMessage(items)}</p>
          <button style={styles.button} onClick={() => navigate('/')}>
            На главную
          </button>
        </div>
      </div>
    );
  }

  return children;
};

const styles = {
  wrap: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '60vh',
    padding: '20px',
    textAlign: 'center',
  },
  box: {
    maxWidth: '480px',
    background: '#fff0f0',
    border: '1px solid #f5b5b5',
    borderRadius: '10px',
    padding: '24px',
    color: '#c00',
    fontWeight: 600,
  },
  button: {
    marginTop: '16px',
    padding: '10px 20px',
    background: '#007bff',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
  },
};

export default PlanradarGuard;
