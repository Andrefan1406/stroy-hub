// Открытие PDF и отрисовка страницы в canvas (pdf.js). Воркер pdf.js
// собирается вместе с сайтом (webpack: new URL(..., import.meta.url)) —
// без внешних CDN.
import * as pdfjsLib from "pdfjs-dist/build/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.js", import.meta.url).toString();

export async function openPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjsLib.getDocument({ data }).promise;
}

// Самая длинная сторона отрисованной страницы — не больше стольких пикселей:
// чертёж A1 остаётся чётким при увеличении и не съедает память.
const MAX_SIDE_PX = 6000;

// Рисует страницу в canvas. Возвращает { width, height } страницы в
// единицах PDF (пунктах) и task — отменить, если страница сменилась.
export async function renderPage(pdf, pageNumber, canvas) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, MAX_SIDE_PX / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvasContext: ctx, viewport });
  return { width: base.width, height: base.height, task };
}

// Лист для подсветки изменений между редакциями: линии чертежа одним цветом
// (rgb), белое — прозрачное. Два таких слоя (старый красный, новый синий)
// в режиме multiply: совпавшее — тёмное, только в старом — красное,
// только в новом — синее. Разрешение ниже основного — это слой для сравнения.
const TINT_MAX_SIDE_PX = 3500;

export async function renderTinted(pdf, pageNumber, [r, g, b]) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2.5, TINT_MAX_SIDE_PX / Math.max(base.width, base.height)) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const ink = 255 - (d[i] + d[i + 1] + d[i + 2]) / 3; // тёмное — сильнее
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = Math.min(255, ink * 1.6);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, width: base.width, height: base.height };
}

// Размер страницы в единицах PDF (без отрисовки).
export async function pageSize(pdf, pageNumber) {
  const vp = (await pdf.getPage(pageNumber)).getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}
