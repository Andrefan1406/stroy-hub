// Google Apps Script для записи заявок на технику
// Автономный скрипт (проект «заявка на технику»), пишет в таблицу «все заявки v.2», лист «Лист1».
// URL /exec задаётся в переменной окружения REACT_APP_EQUIPMENT_SCRIPT_URL (Netlify / .env), см. src/config/scriptUrls.js.
// После правки: Deploy → Manage deployments → Edit → Version: New version
// (тот же URL /exec остаётся рабочим, менять его в форме не нужно).
// Копия того, что развёрнуто в Apps Script — держать в синхроне.

const SPREADSHEET_ID = '1Khg-GECzGqdvrC3rs5dxRanP6FbJsWkYk3gOQVrGZXE';
const SHEET_NAME = 'Лист1';

// Столбцов, которые пишет сама форма: A–M (последний, M — дата и время подачи).
// «ID отправки» идёт правее (N).
const FORM_COLUMNS = 13;
const TS_COLUMN = 13;

// ---- Защита от дублей ----------------------------------------------------
// Форма шлёт запрос без возможности прочитать ответ (no-cors); при обрыве по
// таймауту заявка могла дойти, и человек отправлял её снова. Поэтому каждая
// отправка несёт submissionId (одинаковый у всех повторов), а ID записывается
// в крайний правый столбец «ID отправки». Если такой ID уже есть среди
// последних DEDUPE_ROWS строк — повтор не записывается.
const ID_HEADER = 'ID отправки';
const DEDUPE_ROWS = 2000;

function ensureIdColumn_(sheet, minCol) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const found = headers.indexOf(ID_HEADER);
  if (found >= 0) return found + 1;
  const col = Math.max(lastCol + 1, minCol);
  sheet.getRange(1, col).setValue(ID_HEADER);
  return col;
}

function hasSubmission_(sheet, idCol, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const start = Math.max(2, lastRow - DEDUPE_ROWS + 1);
  const ids = sheet.getRange(start, idCol, lastRow - start + 1, 1).getValues();
  return ids.some(r => String(r[0]) === id);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.getActiveSheet();
    const data = JSON.parse(e.postData.contents);
    const rows = Array.isArray(data) ? data : [data];
    const submissionId = String((rows[0] && rows[0].submissionId) || '');

    // Проверка и запись — под одной блокировкой, чтобы два почти одновременных
    // повтора не прошли проверку оба.
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const idCol = ensureIdColumn_(sheet, FORM_COLUMNS + 1);
      if (submissionId && hasSubmission_(sheet, idCol, submissionId)) {
        return json_({ status: 'duplicate', added: 0 });
      }

      const ts = new Date(); // реальная дата и время отправки
      const values = rows.map(request => {
        const line = [
          request.date,            // A
          request.startTime,       // B
          request.endTime,         // C
          request.objectCategory,  // D
          request.object,          // E
          request.position,        // F
          request.category,        // G
          request.equipmentName,   // H
          request.quantity,        // I
          request.fullName || '',  // J
          request.phone || '',     // K
          request.note || '',      // L
          ts,                      // M: дата и время подачи
        ];
        while (line.length < idCol - 1) line.push('');
        line[idCol - 1] = submissionId; // крайний правый столбец
        return line;
      });
      // Одной записью — чтобы обрыв посреди отправки не оставил половину заявки.
      const firstRow = sheet.getLastRow() + 1;
      sheet.getRange(firstRow, 1, values.length, idCol).setValues(values);
      // Формат «дата+время» — именно у столбца времени подачи, а не у последнего.
      sheet.getRange(firstRow, TS_COLUMN, values.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
    } finally {
      lock.releaseLock();
    }

    return json_({ status: 'success', added: rows.length });
  } catch (err) {
    return json_({ status: 'error', message: err.message });
  }
}
