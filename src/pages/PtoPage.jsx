// ПТО — ведомости материалов и работ по проектной документации (этап 1: раздел КЖ):
// загрузка PDF → ведомость → виды работ → расценки → стоимость → Excel.
// Доступ: только admin@vkdev.kz (гвард маршрута — PtoRoute, настоящая проверка — на сервере).
// Адрес /pto — список, /pto/:docId — открытый документ.
import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import DocumentView from "../pto/DocumentView";
import DocumentsScreen from "../pto/DocumentsScreen";
import { s } from "../pto/styles";

export default function PtoPage() {
  const navigate = useNavigate();
  const { docId } = useParams();
  return (
    <div style={s.page}>
      <div style={s.header}>
        <button style={s.back} onClick={() => navigate("/admin")}>← Личный кабинет</button>
        <h1 style={s.title}>ПТО — ведомости по проектной документации</h1>
      </div>
      {docId
        ? <DocumentView key={docId} id={docId} onBack={() => navigate("/pto")} />
        : <DocumentsScreen onOpen={(id) => navigate(`/pto/${id}`)} />}
    </div>
  );
}
