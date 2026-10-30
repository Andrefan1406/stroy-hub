// Проверка поиска адресов вживую (настоящий OpenStreetMap, кэш во временной
// папке): что отвечает поиск на каждый адрес.
//
//   node server/rides/tools/checkAddresses.js "Кайсенова 119" "Бажова 5"
//   node server/rides/tools/checkAddresses.js            (список по умолчанию)
//   node server/rides/tools/checkAddresses.js --root <папка репозитория> ...
//
// --root — запустить код другой копии репозитория (например, ветки main в
// `git worktree`), чтобы сравнить поиск до и после правки. Адрес без
// населённого пункта ищется в Усть-Каменогорске; для другого города пишите
// «г. Семей, ул. Ленина, 5». Один запрос к карте в секунду — список из
// десятка адресов идёт около 20 секунд.
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
let root = path.resolve(__dirname, '..', '..', '..');
const rootAt = args.indexOf('--root');
if (rootAt >= 0) {
  root = path.resolve(args[rootAt + 1]);
  args.splice(rootAt, 2);
}

const DEFAULTS = [
  'Кайсенова 119',
  'ул. Кайсенова, 119',
  'Қайсенов 119',
  'Протозанова 10',
  'Бажова 119',
  'проспект Назарбаева 50',
  'Ермакова 1',
  'Нигде и никогда 5',
];

process.env.RIDES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rides-check-'));
// node_modules лежат в основном репозитории, а не в рабочей копии ветки.
module.paths.push(path.resolve(__dirname, '..', '..', '..', 'node_modules'));
process.env.NODE_PATH = module.paths.join(path.delimiter);
require('module').Module._initPaths();

const { initSchema } = require(path.join(root, 'server/rides/db'));
const { lookupAddress } = require(path.join(root, 'server/rides/routeEstimate'));

const LABEL = {
  found: 'найден (точка принята)',
  street: 'только улица (точка вручную)',
  not_found: 'не найден (точка вручную)',
  unavailable: 'карта не ответила',
};

(async () => {
  initSchema();
  console.log(`Код: ${root}\n`);
  for (const address of args.length ? args : DEFAULTS) {
    const r = await lookupAddress(address);
    const where = r.lat != null ? ` ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}` : '';
    const name = r.matched ? ` «${r.matched}»` : '';
    console.log(`${address}\n    ${LABEL[r.status] || r.status}${name}${where}`);
  }
})();
