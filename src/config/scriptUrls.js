// Адреса Google Apps Script (веб-приложения, URL вида .../exec), в которые формы пишут заявки.
// Единое место: страницы берут адрес отсюда, а не хранят у себя.
//
// Значение задаётся переменной окружения REACT_APP_<ФОРМА>_SCRIPT_URL (Netlify / .env).
// CRA подставляет переменные при сборке, поэтому после смены значения сайт нужно пересобрать.
// Для форм, чей адрес уже был в коде, остался запасной вариант — чтобы сайт не сломался,
// пока переменные не заведены. Для электриков и геодезии запасного адреса нет: пустой адрес
// страница показывает как ошибку настройки.
//
// Адрес берётся в Apps Script: Deploy → Manage deployments → Web app URL.
// Исходный код скриптов лежит в google-apps-scripts/.

const trim = (value) => (value || '').trim();

export const SCRIPT_URLS = {
  // google-apps-scripts/concrete_script.js
  concrete:
    trim(process.env.REACT_APP_CONCRETE_SCRIPT_URL) ||
    'https://script.google.com/macros/s/AKfycbx9_aWErej5qsHUaY_x8k0D7mrPYRcY-1WqdI2zge39VZoADllt7Xv12cxdys72-4U/exec',
  // google-apps-scripts/elec_script.js
  elec: trim(process.env.REACT_APP_ELEC_SCRIPT_URL),
  // google-apps-scripts/geo_script.js
  geo: trim(process.env.REACT_APP_GEO_SCRIPT_URL),
  // google-apps-scripts/equipment_script.js
  equipment:
    trim(process.env.REACT_APP_EQUIPMENT_SCRIPT_URL) ||
    'https://script.google.com/macros/s/AKfycbyyXRi_lPGYJZI-C1uHmqRhlIOtKQtkrFW7-ha772JZbMxP3oXwcsH5QvHAprH-4fnL/exec',
  // google-apps-scripts/blb_script.js
  blb:
    trim(process.env.REACT_APP_BLB_SCRIPT_URL) ||
    'https://script.google.com/macros/s/AKfycbyMz5pFG3eMxFU-W5bYcPEmYCySf2mNsrLSYYFCfLqY6p5-fuNSySuFKmUohEImS_F_zQ/exec',
  // google-apps-scripts/znb_script.js
  znb:
    trim(process.env.REACT_APP_ZNB_SCRIPT_URL) ||
    'https://script.google.com/macros/s/AKfycbxcWkEmO50NPCIubp2VkZV73QuvNkCMhItjgn1ecy2BxRWglx3l7kGXzIzrBHT5FETuoQ/exec',
  // google-apps-scripts/lab_script.js
  lab:
    trim(process.env.REACT_APP_LAB_SCRIPT_URL) ||
    'https://script.google.com/macros/s/AKfycbxQJ1OVUlO-Qp9t5J0bAB2zMC5jMgOb79VT3GVi0_xaEazGClzYaR9sVo82gosrDwFj/exec',
  // отчёт по людям (скрипта в google-apps-scripts/ нет)
  peopleReport:
    trim(process.env.REACT_APP_PEOPLE_REPORT_SCRIPT_URL) ||
    'https://script.google.com/macros/s/AKfycbwuh3ksOR53O039FnsoYsgAfPjhgUAQbbX-EG1mUgmqQXubFwgmDZf0tCBNz23rVomA/exec',
};
