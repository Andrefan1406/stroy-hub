import React from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from './firebase';
import { canSeeFinancingPlan } from './components/FinancingRoute';

const ReportsDashboardPage = () => {
  const navigate = useNavigate();

  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h2>Направления отчётности</h2>
      <button
        onClick={() => navigate('/ai-assistant')}
        style={styles.smartButton}
      >
        ✦ Чат-аналитика (AI)
      </button>
      <button
        onClick={() => navigate('/people-dashboard')}
        style={styles.button}
      >
        Отчётность по людям
      </button>
      <button
        onClick={() => navigate('/equipment-report')}
        style={styles.button}
      >
        Отчётность по технике
      </button>
      <button
        onClick={() => navigate('/concrete-report')}
        style={styles.button}
      >
        Отчётность БРУ
      </button>
      <button
        onClick={() => navigate('/concrete-daily-report')}
        style={styles.button}
      >
        Ежедневный отчет БРУ
      </button>
      <button
        onClick={() => navigate('/concrete-dashboard')}
        style={{ ...styles.button, background: '#6c3ba3' }}
      >
        Дашборд по бетону и раствору
      </button>
      {canSeeFinancingPlan(auth.currentUser?.email) && (
        <button
          onClick={() => navigate('/financing-plan')}
          style={{ ...styles.button, background: 'linear-gradient(135deg, #7c5cff, #33d6c0)' }}
        >
          Финплан
        </button>
      )}
    </div>

  );
};

const styles = {
  button: {
    display: 'block',
    margin: '10px auto',
    padding: '10px 20px',
    background: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
    fontSize: '16px',
    width: '250px'
  },
  smartButton: {
    display: 'block',
    margin: '10px auto',
    padding: '10px 20px',
    background: 'linear-gradient(135deg, #6610f2, #007bff)',
    color: 'white',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
    fontSize: '16px',
    fontWeight: '700',
    width: '250px',
    boxShadow: '0 4px 12px rgba(102,16,242,0.35)',
  }
};

export default ReportsDashboardPage;
