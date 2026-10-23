// Извлечение текста с координатами из векторного PDF (pdfjs-dist, legacy-
// сборка для Node). Только текстовый слой — растровые сканы не распознаём
// (OCR не подключён), для них вызывающий получает понятную ошибку.
//
// Страницы читаем по одной и сразу освобождаем (page.cleanup), чтобы большой
// PDF (десятки МБ, сотни листов) не раздувал память процесса.
//
// Элемент текста: { s, x, y, w, h } — строка, левый край и базовая линия в
// единицах страницы PDF (y растёт вверх, как в PDF), ширина и высота.

// pdfjs при загрузке в Node пишет в консоль предупреждения про DOMMatrix /
// Path2D (нужны только для отрисовки, которой тут нет) — глушим на время
// загрузки модуля.
function loadPdfjs() {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return require('pdfjs-dist/legacy/build/pdf.js');
  } finally {
    console.warn = warn;
  }
}

class PdfError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Меньше этого среднего числа символов на страницу — считаем, что текстового
// слоя нет (скан или рисунок без текста).
const MIN_CHARS_PER_PAGE = 15;

// buffer — Buffer/Uint8Array с PDF. Возвращает { pageCount, pages: [{ page,
// width, height, items }] }. onProgress(done, total) — необязательно.
async function extractPages(buffer, { onProgress } = {}) {
  const pdfjs = loadPdfjs();
  // Без копии: Uint8Array поверх того же буфера.
  const data = buffer instanceof Uint8Array && !Buffer.isBuffer(buffer)
    ? buffer
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);

  let doc;
  try {
    doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new PdfError('PDF защищён паролем — снимите защиту и загрузите снова', 'password');
    throw new PdfError('Не удалось прочитать файл: это не PDF или он повреждён', 'invalid');
  }

  const pages = [];
  let chars = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        const s = String(it.str || '');
        if (!s.trim()) continue;
        chars += s.length;
        items.push({ s, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), w: Math.round(it.width), h: Math.round(it.height) });
      }
      pages.push({ page: p, width: Math.round(viewport.width), height: Math.round(viewport.height), items });
      page.cleanup();
      if (onProgress) onProgress(p, doc.numPages);
      if (p % 10 === 0) await new Promise((r) => setImmediate(r)); // не держим сервер занятым целиком
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  if (!pages.length) throw new PdfError('В PDF нет страниц', 'empty');
  if (chars / pages.length < MIN_CHARS_PER_PAGE) {
    throw new PdfError(
      'В PDF нет текстового слоя — это скан. Загрузите векторный PDF (экспорт из CAD/Word), распознавание сканов не поддерживается.',
      'no-text-layer'
    );
  }
  return { pageCount: pages.length, pages };
}

module.exports = { extractPages, PdfError };
