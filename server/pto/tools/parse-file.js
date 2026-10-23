// Прогон разбора на файле без сервера и без записи в БД — для проверки
// парсера на реальном PDF:
//   node server/pto/tools/parse-file.js "C:\path\KZh.pdf" [--rows] [--section=КЖ]
const fs = require('fs');
const { extractPages } = require('../pdf');
const { SECTIONS } = require('../sections');
const { consolidate } = require('../consolidate');

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('Использование: node server/pto/tools/parse-file.js "<путь к pdf>" [--rows] [--section=КЖ]');
    process.exit(1);
  }
  const code = (process.argv.find((a) => a.startsWith('--section=')) || '--section=КЖ').split('=')[1];
  const section = SECTIONS[code];
  const t0 = Date.now();
  const { pageCount, pages } = await extractPages(fs.readFileSync(file));
  const parsed = section.parse(pages);
  const items = consolidate(parsed.rows);
  const works = section.deriveWorks(items);
  console.log(`Страниц: ${pageCount}, сырых строк: ${parsed.rows.length}, позиций: ${items.length}, работ: ${works.length}, ${Date.now() - t0} мс`);
  console.log('Листы:', parsed.sheets.map((s) => `${s.page}:${s.kind === 'steel_summary' ? 'СВОДНАЯ' : 'спец'}(${s.rows})`).join(' '));
  const sum = (f) => items.filter(f).reduce((s, i) => s + i.quantity, 0);
  console.log('Сталь (учитывается), кг:', sum((i) => i.kind === 'steel' && i.counted).toFixed(1));
  console.log('Закладные (учитываются), кг:', sum((i) => i.kind === 'embedded' && i.counted).toFixed(1));
  console.log('Бетон, м³:', sum((i) => i.kind === 'concrete' && !/подготовк/i.test(i.name)).toFixed(2));
  console.log('Бетонная подготовка, м³:', sum((i) => i.kind === 'concrete' && /подготовк/i.test(i.name)).toFixed(2));
  console.log('Сталь по спецификациям (справочно), кг:', sum((i) => i.kind === 'steel' && !i.counted).toFixed(1));
  console.log(`Замечаний: ${parsed.issues.length}`);
  for (const i of parsed.issues) console.log(`  ${i.level === 'info' ? 'i' : '!'} лист ${i.page ?? '—'}: ${i.message}`);
  if (process.argv.includes('--rows')) {
    for (const it of items) {
      console.log(`${it.kind.padEnd(8)} ${it.counted ? '✓' : '·'} ${it.element.slice(0, 34).padEnd(34)} ${it.name.slice(0, 44).padEnd(44)} ${it.mark_class.padEnd(6)} ${String(it.quantity).padStart(10)} ${it.unit}  листы ${it.sources.map((s) => s.page).join(',')}`);
    }
    console.log('\nВиды работ:');
    for (const w of works) console.log(`  ${w.element.slice(0, 40).padEnd(40)} ${w.name.slice(0, 40).padEnd(40)} ${String(w.quantity).padStart(10)} ${w.unit}`);
  }
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
