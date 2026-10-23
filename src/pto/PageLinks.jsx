// Номера листов PDF как ссылки: клик открывает чертёж на этом листе в редакторе подсчёта объёмов
// (страница /takeoff, отдельная вкладка; PDF документа подгружается туда сам).
// pages — номера листов ([23, 25]) либо источники строки ([{ page, quantity }]) —
// тогда в подсказке виден вклад листа. Если файл документа не сохранён (загружен
// до появления просмотра), номера остаются обычным текстом.
import React, { useState } from "react";
import { openInTakeoff } from "./api";
import { fmtNum } from "./format";

const link = {
  background: "none", border: "none", padding: 0, margin: 0, color: "#0b5cad", textDecoration: "underline",
  cursor: "pointer", font: "inherit",
};

export default function PageLinks({ docId, hasFile, pages, max = 6 }) {
  const [all, setAll] = useState(false);
  const list = (pages || []).map((p) => (typeof p === "number" ? { page: p } : p));
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, max);

  return (
    <span>
      {shown.map((p, i) => (
        <React.Fragment key={p.page}>
          {i > 0 && ", "}
          {hasFile ? (
            <button type="button" style={link} onClick={() => openInTakeoff(docId, p.page)}
              title={`Открыть лист ${p.page} в редакторе объёмов${p.quantity != null ? ` (вклад листа: ${fmtNum(p.quantity)})` : ""}`}>
              {p.page}
            </button>
          ) : (
            <span title="Файл документа не сохранён — загрузите его заново, чтобы открывать листы">{p.page}</span>
          )}
        </React.Fragment>
      ))}
      {list.length > shown.length && (
        <> <button type="button" style={{ ...link, color: "#777" }} onClick={() => setAll(true)}>ещё {list.length - shown.length}</button></>
      )}
    </span>
  );
}
