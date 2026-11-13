import React, { useState, useEffect, useCallback } from "react";
import styles from './RequestPage.module.css';
import { useNavigate } from "react-router-dom";
import { getAuth } from "firebase/auth";
import { objectCategoryOptions, objectPositionOptions } from "./data/constructionData";
import { peopleSiteOptions as siteOptions } from "./data/peopleSites";
import { SCRIPT_URLS } from "./config/scriptUrls";

const API_URL = process.env.REACT_APP_CONCRETE_CHAT_API_URL || "http://localhost:4000";

const professionOptions = [
  "каменщики", "монолитчики", "отделочники",
  "разнорабочие", "сантехники",
  "фасадчики", "электрики", "прочие"
];

const dayOffStyles = {
  button: {
    padding: "10px 20px",
    background: "#8e6f00",
    color: "#fff",
    border: "none",
    borderRadius: "5px",
    cursor: "pointer",
    fontSize: "16px",
  },
  confirmModal: {
    position: "relative",
    background: "#fff",
    padding: "28px 24px 20px",
    borderRadius: "14px",
    width: "340px",
    maxWidth: "90vw",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: "10px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
  },
  confirmIcon: {
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    background: "#fff3cd",
    color: "#8e6f00",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "24px",
    marginBottom: "4px",
  },
  confirmTitle: {
    margin: 0,
    fontSize: "17px",
    color: "#333",
  },
  confirmText: {
    margin: 0,
    fontSize: "14px",
    color: "#555",
    lineHeight: 1.5,
  },
  confirmBtn: {
    padding: "9px 18px",
    background: "#8e6f00",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
  },
  cancelBtn: {
    padding: "9px 18px",
    background: "#f0f0f0",
    color: "#333",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "14px",
  },
};

const PeopleReportPage = () => {
  const [wasSubmitted, setWasSubmitted] = useState(false);
  const [requests, setRequests] = useState(() => {
    const saved = localStorage.getItem("peopleReportData");
    return saved ? JSON.parse(saved) : [{
      startTime: "", objectCategory: "", endTime: "", object: "",
      position: "", category: "", equipmentName: ""
    }];
  });
  const [isAlreadySubmitted, setIsAlreadySubmitted] = useState(false);
  const [selectedDate, setSelectedDate] = useState(getCurrentDate());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [userName, setUserName] = useState("");
  const [userPhone, setUserPhone] = useState("");
  const [invalidFields, setInvalidFields] = useState([]);
  const [dateError, setDateError] = useState("");

  // Отметить день выходным/нерабочим для участка без заполнения всей
  // таблицы — пишет решение 'confirm_no_report' сразу в people_gap_decisions
  // (см. server/peopleGapsCheck.js:/mark-day-off), то же самое действие,
  // что администратор применяет вручную на /admin/people-gaps, только сразу
  // от начальника участка, без ожидания разбора пропуска админом. Участок
  // берём из уже заполненной первой строки таблицы (форма обычно и так
  // сохранена в localStorage с прошлого раза, см. useState(requests) выше —
  // заново выбирать участок отдельно не нужно).
  const [dayOffSubmitting, setDayOffSubmitting] = useState(false);
  const [showDayOffModal, setShowDayOffModal] = useState(false);

  const navigate = useNavigate();

  function getCurrentDate() {
    return new Date().toISOString().slice(0, 10);
  }

  const getTotalCount = () => {
    return requests.reduce((sum, row) => sum + (parseInt(row.equipmentName) || 0), 0);
  };

  const hasEmptyFields = useCallback(() => {
    const emptyFields = [];

    requests.forEach((row, index) => {
      for (const field of ["startTime", "objectCategory", "endTime", "object", "position", "category", "equipmentName"]) {
        if (!row[field]) {
          emptyFields.push({ index, field });
        }
      }
    });

    setInvalidFields(emptyFields);
    return emptyFields.length > 0;
  }, [requests]);

  useEffect(() => {
    localStorage.setItem("peopleReportData", JSON.stringify(requests));
  }, [requests]);

  useEffect(() => {
    if (wasSubmitted) {
      hasEmptyFields();
    }
  }, [requests, wasSubmitted, hasEmptyFields]);

  useEffect(() => {
    const submittedDates = JSON.parse(localStorage.getItem("submittedDates") || "{}");
    setIsAlreadySubmitted(submittedDates[selectedDate] === true);
  }, [selectedDate]);  

  const handleChange = (index, field, value) => {
    const newRequests = [...requests];
    newRequests[index][field] = value;

    if (field === "objectCategory") {
      newRequests[index].endTime = "";
      newRequests[index].object = "";
    }
    if (field === "endTime") {
      newRequests[index].object = "";
    }

    setRequests(newRequests);
  };

  const addRequest = (index) => {
    const newRequests = [...requests];
    newRequests.splice(index + 1, 0, {
      startTime: "", objectCategory: "", endTime: "", object: "",
      position: "", category: "", equipmentName: ""
    });
    setRequests(newRequests);
  };

  const removeRequest = (index) => {
    const newRequests = [...requests];
    newRequests.splice(index, 1);
    setRequests(newRequests);
  };

  const isInvalid = (index, field) =>
    wasSubmitted && invalidFields.some(f => f.index === index && f.field === field);

  const handleSubmit = () => {
    setWasSubmitted(true);
    if (hasEmptyFields()) {
      alert("Пожалуйста, заполните все поля перед отправкой отчёта.");
      return;
    }
    setShowModal(true);
  };

  const confirmSubmit = async () => {
    if (!userName.trim() || !userPhone.trim()) {
      alert("Пожалуйста, введите ФИО и номер телефона.");
      return;
    }

    const submittedDates = JSON.parse(localStorage.getItem("submittedDates") || "{}");
    if (submittedDates[selectedDate]) {
      alert("Вы уже отправляли отчёт на эту дату. Повторная отправка запрещена.");
      return;
    }


    setIsSubmitting(true);
    setShowModal(false);

    const updatedRequests = requests.map(r => ({
      ...r,
      date: selectedDate,
      submittedBy: userName,
      phone: userPhone
    }));

    try {
      await fetch(SCRIPT_URLS.peopleReport, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedRequests)
      });

      const submittedDates = JSON.parse(localStorage.getItem("submittedDates") || "{}");
      submittedDates[selectedDate] = true;
      localStorage.setItem("submittedDates", JSON.stringify(submittedDates));

      setIsAlreadySubmitted(true);
      alert("Отчёт успешно отправлен!");
    } catch (e) {
      console.error("Ошибка при отправке", e);
      alert("Ошибка при отправке!");
    } finally {
      setIsSubmitting(false);
      setUserName("");
      setUserPhone("");
    }
  };

  // Открывает модалку с подтверждением (см. showDayOffModal ниже) — сама
  // отправка происходит в confirmMarkDayOff по кнопке в модалке.
  const handleMarkDayOff = () => {
    const dayOffSite = requests[0]?.startTime;
    if (!dayOffSite) {
      alert("Сначала выберите участок в таблице.");
      return;
    }

    const submittedDates = JSON.parse(localStorage.getItem("submittedDates") || "{}");
    if (submittedDates[selectedDate]) {
      alert("Вы уже отправляли отчёт (или отмечали выходной) на эту дату.");
      return;
    }

    setShowDayOffModal(true);
  };

  const confirmMarkDayOff = async () => {
    const dayOffSite = requests[0]?.startTime;
    setShowDayOffModal(false);

    const decidedBy = getAuth().currentUser?.email || "неизвестно";

    setDayOffSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/people-gaps/mark-day-off`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: dayOffSite, report_date: selectedDate, decided_by: decidedBy }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Ошибка сервера (${res.status})`);
      }

      const updatedSubmittedDates = JSON.parse(localStorage.getItem("submittedDates") || "{}");
      updatedSubmittedDates[selectedDate] = true;
      localStorage.setItem("submittedDates", JSON.stringify(updatedSubmittedDates));
      setIsAlreadySubmitted(true);

      alert("Выходной день отмечен!");
    } catch (err) {
      console.error("Не удалось отметить выходной день:", err);
      alert(err.message || "Не удалось отметить выходной день");
    } finally {
      setDayOffSubmitting(false);
    }
  };

  return (
    <div className={`${styles.container} ${styles.peopleReportPage}`}>
      <h2>Ежедневный отчёт по людям</h2>
      <label>Дата:
        <input
          type="date"
          value={selectedDate}
          min="2025-01-01"
          max={getCurrentDate()}
          onChange={(e) => {
            const inputDate = e.target.value;
            const today = getCurrentDate();
            if (inputDate > today) {
              setDateError("Нельзя выбрать дату из будущего.");
              setSelectedDate(today);
            } else {
              setDateError("");
              setSelectedDate(inputDate);
            }
          }}
        />
      </label>

      {dateError && <div className={styles.errorText}>{dateError}</div>}

      <table className={styles.requestTable}>
        <thead>
          <tr>
            <th>Участок</th><th>Категория объекта</th><th>Объект</th>
            <th>Позиция</th><th>Наименование работ/подрядчика</th><th>Профессия</th>
            <th>Количество</th><th>Действия</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((row, index) => (
            <tr key={index}>
              <td data-label="Участок">
                <select
                  value={row.startTime}
                  onChange={e => handleChange(index, "startTime", e.target.value)}
                  className={isInvalid(index, "startTime") ? styles.invalidField : ""}
                >
                  <option value="">Выберите</option>
                  {siteOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </td>
              <td data-label="Категория объекта">
                <select
                  value={row.objectCategory}
                  onChange={e => handleChange(index, "objectCategory", e.target.value)}
                  className={isInvalid(index, "objectCategory") ? styles.invalidField : ""}
                >
                  <option value="">Выберите</option>
                  {Object.keys(objectCategoryOptions).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                </select>
              </td>
              <td data-label="Объект">
                <select
                  value={row.endTime}
                  onChange={e => handleChange(index, "endTime", e.target.value)}
                  disabled={!row.objectCategory}
                  className={isInvalid(index, "endTime") ? styles.invalidField : ""}
                >
                  <option value="">Выберите</option>
                  {(objectCategoryOptions[row.objectCategory] || []).map(obj => <option key={obj} value={obj}>{obj}</option>)}
                </select>
              </td>
              <td data-label="Позиция">
                <select
                  value={row.object}
                  onChange={e => handleChange(index, "object", e.target.value)}
                  disabled={!row.endTime}
                  className={isInvalid(index, "object") ? styles.invalidField : ""}
                >
                  <option value="">Выберите</option>
                  {(objectPositionOptions[row.endTime] || []).map(pos => <option key={pos} value={pos}>{pos}</option>)}
                </select>
              </td>
              <td data-label="Наименование работ/подрядчика">
                <input
                  value={row.position}
                  onChange={e => handleChange(index, "position", e.target.value)}
                  className={isInvalid(index, "position") ? styles.invalidField : ""}
                />
              </td>
              <td data-label="Профессия">
                <select
                  value={row.category}
                  onChange={e => handleChange(index, "category", e.target.value)}
                  className={isInvalid(index, "category") ? styles.invalidField : ""}
                >
                  <option value="">Выберите</option>
                  {professionOptions.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
              </td>
              <td data-label="Количество">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={row.equipmentName}
                  onChange={e => /^\d*$/.test(e.target.value) && handleChange(index, "equipmentName", e.target.value)}
                  className={isInvalid(index, "equipmentName") ? styles.invalidField : ""}
                />
              </td>
              <td data-label="Действия" className={styles.actionsCell}>
                <button className={`${styles.iconButton} ${styles.green}`} onClick={() => addRequest(index)}>＋</button>
                {requests.length > 1 && <button className={`${styles.iconButton} ${styles.red}`} onClick={() => removeRequest(index)}>−</button>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan="6" style={{ textAlign: 'right', fontWeight: 'bold' }}>Итого:</td>
            <td style={{ fontWeight: 'bold' }}>{getTotalCount()}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <div className={styles.buttonsContainer}>
        <button
          className={styles.submitButton}
          onClick={handleSubmit}
          disabled={isSubmitting || isAlreadySubmitted}
        >
          {isAlreadySubmitted
            ? "Отчёт уже отправлен"
            : isSubmitting
            ? "Отправка..."
            : "Отправить отчёт"}
        </button>
        <button
          type="button"
          onClick={handleMarkDayOff}
          disabled={dayOffSubmitting || isAlreadySubmitted}
          style={dayOffStyles.button}
        >
          {dayOffSubmitting ? "Отмечаю..." : "Отметить выходной"}
        </button>
        <button className={styles.backButton} onClick={() => navigate("/")}>← Назад</button>
        <button
          className={styles.removeButton}
          onClick={() => setRequests([{
            startTime: "", objectCategory: "", endTime: "", object: "",
            position: "", category: "", equipmentName: ""
          }])}
        >
          Очистить
        </button>
      </div>

      {showModal && (
        <div className={styles.modalOverlay}>
          <div className={styles.modal}>
            <h3>Введите ФИО и номер телефона</h3>
            <input type="text" placeholder="ФИО" value={userName} onChange={e => setUserName(e.target.value)} />
            <input type="tel" placeholder="Телефон" value={userPhone} onChange={e => setUserPhone(e.target.value)} />
            <div className={styles.modalButtons}>
              <button onClick={confirmSubmit}>Подтвердить</button>
              <button onClick={() => setShowModal(false)}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {showDayOffModal && (
        <div className={styles.modalOverlay}>
          <div style={dayOffStyles.confirmModal}>
            <div style={dayOffStyles.confirmIcon}>⚠</div>
            <h3 style={dayOffStyles.confirmTitle}>Подтвердите выходной день</h3>
            <p style={dayOffStyles.confirmText}>
              Участок «{requests[0]?.startTime}» не работал <strong>{selectedDate}</strong>.
              За эту дату не будет отчёта по людям.
            </p>
            <div className={styles.modalButtons}>
              <button style={dayOffStyles.confirmBtn} onClick={confirmMarkDayOff}>Подтвердить</button>
              <button style={dayOffStyles.cancelBtn} onClick={() => setShowDayOffModal(false)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PeopleReportPage;
