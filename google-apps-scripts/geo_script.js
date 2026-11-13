// Google Apps Script для записи заявок геодезистов
// Автономный скрипт (script.google.com/home) — не привязан к таблице,
// пишет в таблицу "Заявки на геодезию" по её ID.
// Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
// Полученный URL /exec положить в переменную окружения REACT_APP_GEO_SCRIPT_URL (Netlify).
// После правки: Deploy → Manage deployments → Edit → Version: New version
// (тот же URL /exec остаётся рабочим).

const SPREADSHEET_ID = '1qZ3ud2_-0ZhkwpwY-hUdXNnliOGKMq067E02pX2zP5c';
const SHEET_NAME = 'Заявки';

// Заголовки колонок (вставляются автоматически при создании листа)
const HEADERS = [
  'Отметка времени',     // A
  'Дата работ',          // B
  'Категория объекта',   // C
  'Объект',              // D
  'Позиция',             // E
  'Конструктив',         // F
  'Вид работы',          // G
  'Описание работ',      // H
  'ФИО и должность',     // I
  'Телефон',             // J
  'Выполнено',           // K
  'ID отправки',         // L — защита от дублей, см. ensureIdColumn_
];

// ---- Защита от дублей ----------------------------------------------------
// Форма шлёт запрос без возможности прочитать ответ (no-cors); при обрыве по
// таймауту заявка могла дойти, и человек отправлял её снова. Поэтому каждая
// отправка несёт submissionId (одинаковый у всех повторов), а ID записывается
// в крайний правый столбец «ID отправки». Если такой ID уже есть среди
// последних DEDUPE_ROWS строк — повтор не записывается.
const ID_HEADER = 'ID отправки';
const DEDUPE_ROWS = 2000;

// Номер столбца «ID отправки»: найденный в заголовке или новый — правее всех
// заполненных (но не левее minCol, чтобы не залезть на столбцы формы).
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
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
    }

    // Вставить заголовки если лист пустой
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length)
        .setFontWeight('bold')
        .setBackground('#4a86e8')
        .setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }

    const data = JSON.parse(e.postData.contents);
    const rows = Array.isArray(data) ? data : [data];
    const submissionId = String((rows[0] && rows[0].submissionId) || '');

    const now = new Date();
    const timestamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');

    // Проверка и запись — под одной блокировкой, чтобы два почти одновременных
    // повтора не прошли проверку оба.
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const idCol = ensureIdColumn_(sheet, HEADERS.length);
      if (submissionId && hasSubmission_(sheet, idCol, submissionId)) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'duplicate', added: 0 }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const values = rows.map(row => {
        const line = [
          timestamp,                  // A: Отметка времени
          row.date            || '', // B: Дата работ
          row.objectCategory  || '', // C: Категория объекта
          row.object          || '', // D: Объект
          row.position        || '', // E: Позиция
          row.konstruktiv     || '', // F: Конструктив
          row.workType        || '', // G: Вид работы
          row.workDescription || '', // H: Описание работ
          row.fullName        || '', // I: ФИО и должность
          row.phone           || '', // J: Телефон
          '',                        // K: Выполнено (заполняется вручную)
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

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', added: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
