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

function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = JSON.parse(e.postData.contents);

  data.forEach(row => {
    const now = new Date();
    sheet.appendRow([
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
    ]);
  });

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
