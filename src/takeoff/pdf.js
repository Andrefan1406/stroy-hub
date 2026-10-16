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
