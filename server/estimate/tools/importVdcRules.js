// Переносит расценки и правила работ по помещениям из Excel в данные страницы «ВДЦ на внутреннюю отделку».
//   node server/estimate/tools/importVdcRules.js "<Расценки на внутреннюю отделку….xlsx>"
// Лист «Расценки»: №, подраздел, наименование, ед. изм., цена без НДС, цена с НДС, … → src/vdc/data/rates.json
// Лист «Помещения»: номер и название помещения (первая строка группы), в каждой строке — работа и примечание
//   → src/vdc/data/roomRules.json. Примечания сохраняются как есть, их смысл разбирает src/vdc/works.js.
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Использование: node importVdcRules.js "<файл.xlsx>"');
  process.exit(1);
}
const outDir = path.join(__dirname, '..', '..', '..', 'src', 'vdc', 'data');

const text = (cell) => {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return v.richText ? v.richText.map((t) => t.text).join('') : String(v.result ?? v.text ?? '');
  return String(v).trim();
};

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const rates = [];
  const rs = wb.getWorksheet('Расценки');
  if (!rs) throw new Error('В файле нет листа «Расценки»');
  rs.eachRow((row, i) => {
    const no = text(row.getCell(1));
    if (i < 5 || !/^\d+\.\d+$/.test(no)) return;
    rates.push({
      no,
      name: text(row.getCell(3)),
      unit: text(row.getCell(4)),
      priceNoVat: Number(row.getCell(5).value),
      priceVat: Number(row.getCell(6).value),
    });
  });

  const rules = [];
  const ps = wb.getWorksheet('Помещения');
  if (!ps) throw new Error('В файле нет листа «Помещения»');
  let current = null;
  ps.eachRow((row) => {
    const no = text(row.getCell(1));
    const name = text(row.getCell(2));
    const work = text(row.getCell(3));
    if (no && name) {
      current = { no: Number(no), name, works: [] };
      rules.push(current);
    }
    if (current && work) current.works.push({ work, note: text(row.getCell(4)) });
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'rates.json'), `${JSON.stringify(rates, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, 'roomRules.json'), `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
  console.log(`расценок: ${rates.length}; помещений с правилами: ${rules.length}; строк «работа»: ${rules.reduce((s, r) => s + r.works.length, 0)}`);
})().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
