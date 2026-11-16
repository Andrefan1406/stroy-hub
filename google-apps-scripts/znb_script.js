// Google Apps Script для записи заявок на ж/б изделия
// Автономный скрипт, пишет в таблицу по SPREADSHEET_ID, лист «Лист1».
// Данные приходят form-data: поле data с JSON-массивом строк (e.parameter.data).
// URL /exec задаётся в переменной окружения REACT_APP_ZNB_SCRIPT_URL (Netlify / .env), см. src/config/scriptUrls.js.
// После правки: Deploy → Manage deployments → Edit → Version: New version
// (тот же URL /exec остаётся рабочим, менять его в форме не нужно).
// Копия того, что развёрнуто в Apps Script — держать в синхроне.

const SPREADSHEET_ID = '1rmWd7on1P7V6O6bMDDguGLZ7fTxcHylZ7ED9KsM-NZ8';
const SHEET_NAME = 'Лист1';

// Столбцов, которые пишет сама форма: A–M; «ID отправки» идёт правее (N).
const FORM_COLUMNS = 13;

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
  try {
    const rawData = e.parameter.data;
    if (!rawData) {
      return ContentService.createTextOutput('Нет данных').setMimeType(ContentService.MimeType.TEXT);
    }

    const rows = JSON.parse(rawData);
    const submissionId = String((rows[0] && rows[0].submissionId) || '');

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);

    const now = new Date();
    const timestamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

    // Проверка и запись — под одной блокировкой, чтобы два почти одновременных
    // повтора не прошли проверку оба.
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const idCol = ensureIdColumn_(sheet, FORM_COLUMNS + 1);
      if (submissionId && hasSubmission_(sheet, idCol, submissionId)) {
        return ContentService.createTextOutput('DUPLICATE').setMimeType(ContentService.MimeType.TEXT);
      }

      const dataToWrite = rows.map(row => {
        const line = [
          timestamp,                  // A: дата и время
          row.date || '',
          row.category || '',
          row.object || '',
          row.position || '',
          row.block || '',
          row.product || '',
          row.brand || '',
          row.series || '',
          row.quantity || '',
          row.note || '',
          row.responsibleName || '',
          row.responsiblePhone || '', // M
        ];
        while (line.length < idCol - 1) line.push('');
        line[idCol - 1] = submissionId; // крайний правый столбец
        return line;
      });

      // Одной записью — чтобы обрыв посреди отправки не оставил половину заявки.
      sheet.getRange(sheet.getLastRow() + 1, 1, dataToWrite.length, idCol).setValues(dataToWrite);
    } finally {
      lock.releaseLock();
    }

    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    return ContentService.createTextOutput('Ошибка: ' + err.message).setMimeType(ContentService.MimeType.TEXT);
  }
}
