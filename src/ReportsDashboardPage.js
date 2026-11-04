// «Графики и отчёты» — выбор направления отчётности. Оформление — как у главной
// (HomePage.js): те же панель с логотипом, плитки и стили из HomePage.module.css.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  TbCalendarStats, TbChartBar, TbChevronLeft, TbChevronRight, TbCoin, TbCrane, TbSparkles, TbTruck, TbUsers,
} from 'react-icons/tb';
import { auth } from './firebase';
import { canSeeFinancingPlan } from './components/FinancingRoute';
import styles from './HomePage.module.css';

const ReportsDashboardPage = () => {
  // Панель с логотипом выше обычной — AccountBar сдвигается на её середину
  // (html.has-home-topbar, см. index.css), как на главной.
  useEffect(() => {
    document.documentElement.classList.add('has-home-topbar');
    return () => document.documentElement.classList.remove('has-home-topbar');
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link to="/" aria-label="На главную">
            <img src="/Логотип.png" alt="VK Development Group" className={styles.logo} />
          </Link>
        </div>
      </header>

      <main className={styles.content}>
        <Link to="/" className={styles.backLink}>
          <TbChevronLeft aria-hidden="true" />
          На главную
        </Link>
        <h1 className={styles.title}>Графики и отчёты</h1>
        <p className={styles.subtitle}>Выберите направление отчётности</p>

        <Link to="/ai-assistant" className={styles.smart}>
          <span className={styles.tileIcon}><TbSparkles aria-hidden="true" /></span>
          <span className={styles.tileLabel}>Чат-аналитика (AI)</span>
          <TbChevronRight className={styles.chevron} aria-hidden="true" />
        </Link>

        <Section title="Люди и техника">
          <Tile to="/people-dashboard" icon={<TbUsers />}>Отчётность по людям</Tile>
          <Tile to="/equipment-report" icon={<TbCrane />}>Отчётность по технике</Tile>
        </Section>

        <Section title="Бетон и раствор">
          <Tile to="/concrete-report" icon={<TbTruck />}>Отчётность БРУ</Tile>
          <Tile to="/concrete-daily-report" icon={<TbCalendarStats />}>Ежедневный отчёт БРУ</Tile>
          <Tile to="/concrete-dashboard" icon={<TbChartBar />}>Дашборд по бетону и раствору</Tile>
        </Section>

        {canSeeFinancingPlan(auth.currentUser?.email) && (
          <Section title="Финансы">
            <Tile to="/financing-plan" icon={<TbCoin />}>Финплан</Tile>
          </Section>
        )}
      </main>
    </div>
  );
};

const Section = ({ title, children }) => (
  <section className={styles.section}>
    <h2 className={styles.sectionTitle}>{title}</h2>
    <div className={styles.grid}>{children}</div>
  </section>
);

const Tile = ({ to, icon, children }) => (
  <Link to={to} className={styles.tile}>
    <span className={styles.tileIcon} aria-hidden="true">{icon}</span>
    <span className={styles.tileLabel}>{children}</span>
    <TbChevronRight className={styles.chevron} aria-hidden="true" />
  </Link>
);

export default ReportsDashboardPage;
