// Google Apps Script для записи заявок на бетон/раствор
// (src/ConcreteRequestPage.js). Привязан к таблице заявок: пишет в активный
// лист (у веб-приложения это первый лист книги — «Лист1»).
// После правки: Deploy → Manage deployments → Edit → Version: New version
// (тот же URL /exec остаётся рабочим, менять его в форме не нужно).
//
// Столбцы листа:
//   A–P  — заполняет doPost при отправке формы;
//   Q–V  — заполняет вручную диспетчер БРУ (Дата отгрузки, Фактический объём,
//          Отметка о исполнении, Согласование геодезистов, Согласование
//          энергетиков, Категория) — из них строятся отчёты, doPost их не трогает;
//   W–Y  — доверенность (номер, дата, ФИО) — заполняет doPost. Добавлены в
//          конец, чтобы не сдвигать A–V: в форме они стоят между «Количество»
//          и «Примечание», но в таблице место не обязано совпадать.

// Q–V оставляем пустыми — их заполняет диспетчер.
const DISPATCHER_COLUMNS = 6;

// ---- Защита от дублей ----------------------------------------------------
// Форма шлёт запрос без возможности прочитать ответ (no-cors); при обрыве по
// таймауту заявка могла дойти, и человек отправлял её снова. Поэтому каждая
// отправка несёт submissionId (одинаковый у всех повторов), а ID записывается
// в крайний правый столбец «ID отправки» (Z). Если такой ID уже есть среди
// последних DEDUPE_ROWS строк — повтор не записывается.
// Серверный синк (server/syncConcrete.js) читает таблицу по названиям
// столбцов, поэтому дополнительный столбец справа ему не мешает.
const ID_HEADER = 'ID отправки';
const DEDUPE_ROWS = 2000;
// Столбцов, которые пишет сама форма (A–Y); «ID отправки» идёт правее.
const FORM_COLUMNS = 25;

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

    const values = data.map(row => {
      const now = new Date();
      const line = [
        now,                          // A  Дата и время подачи заявки
        row.date || '',               // B
        row.time || '',               // C
        row.category || '',           // D
        row.object || '',             // E
        row.position || '',           // F
        row.block || '',              // G
        row.floor || '',              // H
        row.constructive || '',       // I
        row.material || '',           // J
        row.concreteGrade || '',      // K
        row.concreteClass || '',      // L
        row.quantity || '',           // M  Объём
        row.note || '',               // N  Примечание
        row.responsibleName || '',    // O  ФИО из модального окна
        row.responsiblePhone || '',   // P  Телефон из модального окна
        ...Array(DISPATCHER_COLUMNS).fill(''), // Q–V — диспетчер БРУ
        row.poaNumber ?? '',          // W  Доверенность: номер (целое число)
        row.poaDate || '',            // X  Доверенность: дата ("ГГГГ-ММ-ДД", как и date)
        row.poaName || ''             // Y  Доверенность: ФИО
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

// Разово, из редактора скрипта (Run → addPowerOfAttorneyHeaders): заголовки
// новых столбцов W–Y. Уже заполненные ячейки заголовков не перезаписывает.
function addPowerOfAttorneyHeaders() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Лист1');
  const headers = ['Доверенность: номер', 'Доверенность: дата', 'Доверенность: ФИО'];
  const range = sheet.getRange(1, 23, 1, headers.length); // W1:Y1
  const current = range.getValues()[0];
  range.setValues([headers.map((h, i) => current[i] || h)]);
}

// Заполняет пропуски в столбце A (время подачи) равномерной интерполяцией
// между соседними заполненными ячейками. Работает только со столбцом A.
function fillMissingDates() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Лист1");
  const columnA = sheet.getRange("A:A").getValues().flat();

  // Найти индексы заполненных ячеек
  let filledIndices = [];
  for (let i = 0; i < columnA.length; i++) {
    if (columnA[i] !== "") {
      filledIndices.push(i);
    }
  }

  if (filledIndices.length < 2) {
    SpreadsheetApp.getUi().alert("Нужно как минимум две заполненные ячейки в столбце A!");
    return;
  }

  // Обрабатываем каждый промежуток между заполненными ячейками
  for (let k = 0; k < filledIndices.length - 1; k++) {
    const startIndex = filledIndices[k];
    const endIndex = filledIndices[k + 1];
    const startDate = new Date(columnA[startIndex]);
    const endDate = new Date(columnA[endIndex]);
    const emptyCellsCount = endIndex - startIndex - 1;

    if (emptyCellsCount > 0) {
      const timeDiff = endDate - startDate;
      const timeStep = timeDiff / (emptyCellsCount + 1);

      // Заполняем пропуски
      for (let i = 1; i <= emptyCellsCount; i++) {
        const newDate = new Date(startDate.getTime() + timeStep * i);
        sheet.getRange(startIndex + 1 + i, 1).setValue(newDate);
      }
    }
  }
}
