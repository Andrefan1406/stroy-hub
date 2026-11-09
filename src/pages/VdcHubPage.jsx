// Раздел «Черновик ВДЦ»: выбор вида ведомости договорной цены. Пока один пункт —
// черновик на внутреннюю отделку по чертежам АР (/vdc-ar); новые виды добавлять в ITEMS.
import React from 'react';
import { Link } from 'react-router-dom';
import { TbChevronLeft, TbChevronRight, TbFileSpreadsheet } from 'react-icons/tb';
import styles from '../HomePage.module.css';

const ITEMS = [
  { label: 'ВДЦ по чертежам АР', to: '/vdc-ar' },
];

const VdcHubPage = () => (
  <div className={styles.page}>
    <header className={styles.topbar}>
      <div className={styles.topbarInner}>
        <img src="/Логотип.png" alt="VK Development Group" className={styles.logo} />
      </div>
    </header>

    <main className={styles.content}>
      <Link to="/" className={styles.backLink}>
        <TbChevronLeft aria-hidden="true" />
        На главную
      </Link>
      <h1 className={styles.title}>Черновик ВДЦ</h1>
      <p className={styles.subtitle}>Выберите вид ведомости договорной цены</p>

      <section className={styles.section}>
        <div className={styles.grid}>
          {ITEMS.map(({ label, to }) =>
            to ? (
              <Link key={label} to={to} className={styles.tile}>
                <span className={styles.tileIcon} aria-hidden="true"><TbFileSpreadsheet /></span>
                <span className={styles.tileLabel}>{label}</span>
                <TbChevronRight className={styles.chevron} aria-hidden="true" />
              </Link>
            ) : (
              <div key={label} className={`${styles.tile} ${styles.tileBlocked}`} aria-disabled="true">
                <span className={styles.tileIcon} aria-hidden="true"><TbFileSpreadsheet /></span>
                <span className={styles.tileLabel}>
                  {label}
                  <span className={styles.tileStatusMuted}>Скоро</span>
                </span>
              </div>
            ),
          )}
        </div>
      </section>
    </main>
  </div>
);

export default VdcHubPage;
