// Чтение настоящих PDF: векторный с текстом, без текстового слоя (скан),
// битый файл — и (если файл есть на машине) реальный раздел КЖ целиком.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { extractPages, PdfError } = require('../pdf');
const { SECTIONS } = require('../sections');
const { consolidate } = require('../consolidate');
const { reconcileKzh } = require('../reconcile');

// Минимальный PDF из одной страницы: content — содержимое страницы (операторы PDF).
function buildPdf(content) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

test('векторный PDF: текст с координатами и размер страницы', async () => {
  const pdf = buildPdf('BT /F1 12 Tf 72 700 Td (Hello PTO world 12345) Tj ET');
  const { pageCount, pages } = await extractPages(pdf);
  assert.equal(pageCount, 1);
  assert.deepEqual([pages[0].width, pages[0].height], [600, 800]);
  const item = pages[0].items.find((i) => /Hello PTO/.test(i.s));
  assert.ok(item);
  assert.equal(item.x, 72);
  assert.equal(item.y, 700);
});

test('скан без текстового слоя: понятная ошибка, а не падение', async () => {
  await assert.rejects(extractPages(buildPdf('')), (err) => {
    assert.ok(err instanceof PdfError);
    assert.equal(err.code, 'no-text-layer');
    assert.match(err.message, /нет текстового слоя/);
    return true;
  });
});

test('не PDF и битый PDF: понятная ошибка', async () => {
  await assert.rejects(extractPages(Buffer.from('это просто текст, а не PDF')), (err) => err instanceof PdfError && err.code === 'invalid');
  const broken = buildPdf('BT /F1 12 Tf 72 700 Td (Hello PTO world 12345) Tj ET').subarray(0, 120);
  await assert.rejects(extractPages(broken), (err) => err instanceof PdfError && err.code === 'invalid');
});

// Реальный раздел КЖ (проект «Аван Гард Проект Инжиниринг», 118 листов, 41 МБ) —
// в репозиторий не входит; путь можно задать PTO_SAMPLE_PDF. Без файла тест пропускается.
const SAMPLE = process.env.PTO_SAMPLE_PDF || 'C:/Users/a.kuznecov/pto-samples/AB_25-01-201-4.1-КЖ.pdf';
test('реальный КЖ: ведомость стали, спецификации, сверка', { skip: !fs.existsSync(SAMPLE), timeout: 180000 }, async () => {
  const { pageCount, pages } = await extractPages(fs.readFileSync(SAMPLE));
  assert.equal(pageCount, 118);
  const parsed = SECTIONS['КЖ'].parse(pages);
  const items = consolidate(parsed.rows);
  const sum = (f) => items.filter(f).reduce((s, i) => s + i.quantity, 0);

  // Сводная ведомость стали (лист 4): 18 элементов, ~575 т арматуры.
  assert.ok(parsed.sheets.some((s) => s.page === 4 && s.kind === 'steel_summary'));
  const steel = sum((i) => i.kind === 'steel' && i.counted);
  assert.ok(Math.abs(steel - 574890.9) < 1, `сталь ${steel}`);
  assert.equal(new Set(items.filter((i) => i.basis === 'summary').map((i) => i.element)).size, 18);

  // ППм 1 (из «Ведомости»): ∅10 А400 — 18598 кг.
  const ppm1 = items.find((i) => i.basis === 'summary' && i.element === 'ППм 1' && i.name === 'Арматура ∅10');
  assert.equal(ppm1.quantity, 18598);

  // Спецификации элементов: бетон есть, у плит ППдм 1 расход умножен на 2 элемента (∅10: 35,1 × 2).
  assert.ok(sum((i) => i.kind === 'concrete') > 3000);
  const ppdm = items.find((i) => i.basis === 'spec' && i.element === 'ППдм 1' && i.name === 'Арматура ∅10');
  assert.equal(ppdm.quantity, 70.2);

  // Сверка: плиты сходятся со сводной ведомостью, стены — в ~2 раза больше (две секции).
  const rec = reconcileKzh(parsed.rows);
  const slabs = rec.find((r) => r.id === 'slabs');
  const walls = rec.find((r) => r.id === 'walls');
  assert.equal(slabs.status, 'ok');
  assert.equal(walls.status, 'factor');
  assert.equal(walls.factor, 2);

  // Ни один лист не упал; единственное предупреждение — «Итого» на листе 27 (в самом чертеже).
  const warnings = parsed.issues.filter((i) => i.level !== 'info');
  assert.deepEqual(warnings.map((i) => i.page), [27]);
});
