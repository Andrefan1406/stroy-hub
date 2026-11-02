// Блокировка заявок на технику и бетон из-за просроченных замечаний в
// PlanRadar (server/planradar.js): за сотрудником закреплены объекты
// (scripts/planradar/projects.json), и пока по ним есть незакрытые
// замечания, срок которых истёк три дня назад и раньше, подать заявку
// нельзя. Для email без закреплённых объектов — blocked:false. Как и
// остальные gate-модули, при сбое сети/бэкенда страницу не блокируем.
import { getAuth } from 'firebase/auth';

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || 'http://localhost:4000';

// items: [{ project, count }] -> «Жилой дом поз.63 — 5 шт., Лицей — 2 шт.»
export const planradarBlockMessage = (items) =>
  `Подача заявок недоступна: есть не закрытые замечания в PlanRadar, срок которых истёк более трёх дней назад — ${items
    .map((i) => `${i.project} — ${i.count} шт.`)
    .join(', ')}.`;

export async function fetchPlanradarBlock() {
  const email = getAuth().currentUser?.email;
  if (!email) return { blocked: false, items: [] };

  const params = new URLSearchParams({ email });
  const res = await fetch(`${API_URL}/api/planradar/check?${params.toString()}`);
  const data = await res.json();
  return { blocked: !!data.blocked, items: data.items || [] };
}
