// Google Apps Script для записи заявок на лабораторные испытания
// Скрипт привязан к таблице (getActiveSpreadsheet), пишет в её активный лист.
// URL /exec задаётся в переменной окружения REACT_APP_LAB_SCRIPT_URL (Netlify / .env), см. src/config/scriptUrls.js.
// После правки: Deploy → Manage deployments → Edit → Version: New version
// (тот же URL /exec остаётся рабочим, менять его в форме не нужно).
// Копия того, что развёрнуто в Apps Script — держать в синхроне.

// Столбцов, которые пишет сама форма: A–L; «ID отправки» идёт правее (M).
const FORM_COLUMNS = 12;

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

function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = JSON.parse(e.postData.contents);
  const submissionId = String((data[0] && data[0].submissionId) || '');

  // Проверка и запись — под одной блокировкой, чтобы два почти одновременных
  // повтора не прошли проверку оба.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const idCol = ensureIdColumn_(sheet, FORM_COLUMNS + 1);
    if (submissionId && hasSubmission_(sheet, idCol, submissionId)) {
      return ContentService.createTextOutput('DUPLICATE');
    }

    const now = new Date();
    const values = data.map(row => {
      const line = [
        now,
        row.test || '',
        row.date || '',
        row.category || '',
        row.object || '',
        row.position || '',
        row.block || '',
        row.floor || '',
        row.constructive || '',
        row.note || '',
        row.responsibleName || '',   // ФИО из модального окна
        row.responsiblePhone || '',  // Телефон из модального окна
      ];
      while (line.length < idCol - 1) line.push('');
      line[idCol - 1] = submissionId; // крайний правый столбец
      return line;
    });
    // Одной записью — чтобы обрыв посреди отправки не оставил половину заявки.
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, idCol).setValues(values);
  } finally {
    lock.releaseLock();
  }

  return ContentService.createTextOutput('OK');
}
