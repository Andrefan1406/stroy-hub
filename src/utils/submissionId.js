// Идентификатор отправки заявки — защита от дублей. Форма уходит в Google Apps
// Script запросом no-cors: ответа браузер не видит, и при обрыве по таймауту
// заявка могла дойти, а пользователь этого не знает и отправляет ещё раз.
// Один и тот же заполненный набор данных получает один и тот же ID при любом
// числе повторов, а скрипт (google-apps-scripts/) пишет заявку с этим ID один раз.
//
// ID хранится в localStorage вместе с отпечатком данных: если человек поправил
// заявку после неудачной отправки — это другая заявка, ID новый; обновил страницу
// и отправил то же самое — ID прежний. После успешной отправки ID сбрасывается
// (clearSubmissionId), и такая же заявка потом уйдёт как новая.
const PREFIX = 'submission:';

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function getSubmissionId(name, payload) {
  const key = JSON.stringify(payload);
  try {
    const saved = JSON.parse(localStorage.getItem(PREFIX + name) || 'null');
    if (saved && saved.id && saved.key === key) return saved.id;
  } catch (err) { /* хранилище недоступно — просто новый ID */ }
  const id = newId();
  try { localStorage.setItem(PREFIX + name, JSON.stringify({ key, id })); } catch (err) { /* без хранилища повтор после перезагрузки даст новый ID */ }
  return id;
}

export function clearSubmissionId(name) {
  try { localStorage.removeItem(PREFIX + name); } catch (err) { /* ничего */ }
}
