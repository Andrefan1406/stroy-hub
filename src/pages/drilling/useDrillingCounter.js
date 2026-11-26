// Заявки на бурение и резку, требующие действия пользователя: ответ исполнителя,
// решение автора по возвращённой, отметка выполнения по принятой. Опрос раз в
// минуту; ошибки сети не показываем — индикатор просто не появляется.
import { useEffect, useState } from "react";
import { fetchCounter } from "./drillingApi";

export const ATTENTION_LABELS = {
  respond: "Ждёт вашего ответа",
  returned: "Отклонена — решите, что делать",
  mark: "Принята — отметьте выполнение",
};

const EMPTY = { total: 0, items: [] };

export function useDrillingAttention() {
  const [state, setState] = useState(EMPTY);
  useEffect(() => {
    let alive = true;
    const load = () => fetchCounter()
      .then((c) => alive && setState({ total: c.total || 0, items: c.items || [] }))
      .catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return state;
}

// Только число — для красных бейджей на карточках кабинета.
export default function useDrillingCounter() {
  return useDrillingAttention().total;
}
