// Работа с PDF чертежей в браузере (pdf.js). Файл никуда не отправляется.
import * as pdfjsLib from "pdfjs-dist/build/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.js", import.meta.url).toString();

export async function openPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjsLib.getDocument({ data }).promise;
}

// Текстовые элементы листа: { str, x, y, w, h }, y растёт вниз (левый верхний угол листа — 0,0).
export async function pageItems(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  return content.items
    .filter((i) => i.str && i.str.trim())
    .map((i) => {
      const t = pdfjsLib.Util.transform(viewport.transform, i.transform);
      return { str: i.str, x: t[4], y: t[5], w: i.width, h: i.height };
    });
}

export async function renderPage(doc, pageNo, canvas, targetWidth = 900) {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
}

// Подсказка: на каком из первых листов есть заголовок таблицы ТЭП по типам квартир.
export async function findPageWithText(doc, needle, limit = 10) {
  const want = needle.toLowerCase();
  for (let n = 1; n <= Math.min(doc.numPages, limit); n += 1) {
    const items = await pageItems(doc, n);
    const text = items.map((i) => i.str).join(" ").replace(/\s+/g, " ").toLowerCase();
    if (text.includes(want)) return n;
  }
  return null;
}

// Читает текст всех листов (один раз): [{ page, items, text }]. onProgress(готово, всего).
export async function scanDocument(doc, onProgress) {
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const items = await pageItems(doc, n);
    pages.push({ page: n, items, text: items.map((i) => i.str).join(" ").replace(/\s+/g, " ") });
    if (onProgress) onProgress(n, doc.numPages);
  }
  return pages;
}
