// Выгрузка замечаний PlanRadar за период в Excel (server/planradarExport.js):
// период — по дате создания в Алматы, постраничный забор, справочники имён,
// сбой по одному объекту не рушит выгрузку, содержимое файла.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planradar-export-'));
process.env.PLANRADAR_API_KEY = 'k';
process.env.PLANRADAR_CUSTOMER_ID = '1';
process.env.PLANRADAR_EXPORT_PAUSE_MS = '0';
process.env.PLANRADAR_EXPORT_RETRY_MS = '0';
process.env.PLANRADAR_PROJECTS_FILE = path.join(dir, 'projects.json');
fs.writeFileSync(process.env.PLANRADAR_PROJECTS_FILE, JSON.stringify({
  'Жилой дом поз.63': { id: 'p63', emails: [] },
  'Лицей': { id: 'lic', emails: [] },
  'КОС': { id: 'kos', emails: [] },
}));

const { startExport, filterByPeriod, almatyDate, deadlineOf, STATUS_NAMES, imageInfo, classifyPhoto } = require('./planradarExport');

const ticket = (n, created, extra = {}) => ({
  id: `t${n}`,
  attributes: {
    'sequential-id': n,
    subject: `Замечание ${n}`,
    'status-id': '1',
    'created-at': created,
    'due-date': '2026-11-20',
    'author-id': 'u1',
    'assigned-to-id': 'u2',
    'component-id': 'c1',
    ...extra,
  },
});

test('период — по дате создания в Алматы (UTC+5), границы включительно', () => {
  assert.equal(almatyDate('2026-10-31T20:00:00.000Z'), '2026-11-01', 'ночью по Алматы уже следующий день');
  assert.equal(almatyDate('2026-11-01T18:59:00.000Z'), '2026-11-01');
  assert.equal(almatyDate(null), null);
  const list = [
    ticket(1, '2026-10-31T18:59:00.000Z'), // 31.10 23:59 Алматы — до периода
    ticket(2, '2026-10-31T19:00:00.000Z'), // 01.11 00:00 — первый день
    ticket(3, '2026-11-12T18:59:00.000Z'), // 12.11 23:59 — последний день
    ticket(4, '2026-11-12T19:00:00.000Z'), // 13.11 00:00 — после
    { id: 'x', attributes: {} }, // без даты создания — не берём
  ];
  assert.deepEqual(filterByPeriod(list, '2026-11-01', '2026-11-12').map((t) => t.id), ['t2', 't3']);
});

test('действующий срок — дата продления, если она позже; статусы переведены', () => {
  assert.equal(deadlineOf({ attributes: { 'due-date': '2026-11-01', 'extension-date': '2026-11-10' } }), '2026-11-10');
  assert.equal(deadlineOf({ attributes: {} }), null);
  assert.equal(STATUS_NAMES['3'], 'Устранено');
});

function mockApi(handlers) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [re, fn] of handlers) {
      if (re.test(u)) return fn(u);
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  return calls;
}
const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });
const readSheet = async (buffer, name = 'Замечания') => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.getWorksheet(name);
};

test('выгрузка: нужный период, имена из справочников, сбой одного объекта виден в файле', async () => {
  mock.restoreAll();
  const calls = mockApi([
    [/projects\/p63\/tickets/, () => ok([
      ticket(5, '2026-11-05T05:00:00.000Z', { 'closed-at': '2026-11-07T05:00:00.000Z', 'status-id': '5' }),
      ticket(6, '2026-09-01T05:00:00.000Z'), // вне периода
      ticket(7, '2026-11-02T05:00:00.000Z', { 'status-id': 'ol' }),
    ])],
    [/projects\/p63\/users/, () => ok([
      { id: 'u1', attributes: { firstname: 'Иван', lastname: 'Петров' } },
      { id: 'u2', attributes: { mail: 'sub@x.kz' } },
    ])],
    [/projects\/p63\/project_groups/, () => ok([])],
    [/projects\/p63\/components\/project_components/, () => ok([{ id: 'c1', attributes: { name: 'Блок А, 3 этаж' } }])],
    [/projects\/lic\/tickets/, () => fail(503)],
    [/projects\/kos\/tickets/, () => ok([ticket(1, '2026-11-03T05:00:00.000Z')])],
  ]);
  const job = startExport({ from: '2026-11-01', to: '2026-11-12' });
  assert.equal(job.status, 'running');
  assert.throws(() => startExport({ from: '2026-11-01', to: '2026-11-12' }), /уже выполняется/);
  await job.promise;

  assert.equal(job.status, 'done');
  assert.equal(job.count, 3);
  assert.deepEqual(job.errors, [{ project: 'Лицей', error: 'PlanRadar 503' }]);
  assert.equal(job.progress.done, 3);
  assert.equal(job.filename, 'PlanRadar_замечания_2026-11-01_2026-11-12.xlsx');
  assert.ok(!calls.some((c) => /projects\/lic\/users/.test(c)), 'справочники — только по объектам с замечаниями');

  const ws = await readSheet(job.buffer);
  assert.deepEqual(ws.getRow(1).values.slice(1), ['Объект', '№', 'Название', 'Статус', 'Автор', 'Исполнитель', 'Слой', 'Срок', 'Создано', 'Закрыто',
    'Фото до, шт.', 'Фото после, шт.', 'Фото до', 'Фото после']);
  assert.equal(ws.rowCount, 4);
  // порядок — по дате создания: №7 (02.11, дом 63), №1 (03.11, КОС), №5 (05.11, дом 63)
  const first = ws.getRow(2).values;
  assert.equal(first[1], 'Жилой дом поз.63');
  assert.equal(first[2], 7);
  assert.equal(first[4], 'В работе');
  assert.equal(first[5], 'Иван Петров');
  assert.equal(first[6], 'sub@x.kz');
  assert.equal(first[7], 'Блок А, 3 этаж');
  assert.equal(first[9].toISOString().slice(0, 10), '2026-11-02');
  assert.equal(ws.getRow(3).values[2], 1);
  assert.equal(ws.getRow(4).values[2], 5);
  assert.equal(ws.getRow(4).values[10].toISOString().slice(0, 10), '2026-11-07');
  const errors = await readSheet(job.buffer, 'Ошибки');
  assert.deepEqual(errors.getRow(2).values.slice(1), ['Лицей', 'PlanRadar 503']);
});

test('постраничная выгрузка: вторая страница запрашивается, если первая полная', async () => {
  mock.restoreAll();
  const page1 = Array.from({ length: 500 }, (_, i) => ticket(i + 1, '2026-01-01T05:00:00.000Z'));
  const calls = mockApi([
    [/projects\/p63\/tickets\?page=1/, () => ok(page1)],
    [/projects\/p63\/tickets\?page=2/, () => ok([ticket(501, '2026-11-05T05:00:00.000Z')])],
  ]);
  const job = startExport({ from: '2026-11-01', to: '2026-11-12', projectIds: ['p63'] });
  await job.promise;
  assert.equal(job.count, 1);
  assert.ok(calls.some((c) => /tickets\?page=2/.test(c)));
  assert.ok(!calls.some((c) => /projects\/(lic|kos)\//.test(c)), 'выбран один объект');
});

test('PlanRadar не ответил ни по одному объекту — ошибка, а не пустой файл', async () => {
  mock.restoreAll();
  mockApi([[/tickets/, () => fail(500)]]);
  const job = startExport({ from: '2026-11-01', to: '2026-11-12' });
  await job.promise;
  assert.equal(job.status, 'error');
  assert.match(job.error, /не ответил/);
});

test('429: ждём и повторяем запрос', async () => {
  mock.restoreAll();
  let n = 0;
  mockApi([[/projects\/p63\/tickets/, () => (++n === 1 ? fail(429) : ok([ticket(9, '2026-11-05T05:00:00.000Z')]))]]);
  const job = startExport({ from: '2026-11-01', to: '2026-11-12', projectIds: ['p63'] });
  await job.promise;
  assert.equal(job.status, 'done');
  assert.equal(job.count, 1);
  assert.equal(n, 2);
});

test('проверка дат, объектов и ключа', () => {
  assert.throws(() => startExport({ from: '12.11.2026', to: '2026-11-12' }), /формате/);
  assert.throws(() => startExport({ from: '2026-11-12', to: '2026-11-01' }), /позже/);
  assert.throws(() => startExport({ from: '2026-11-01', to: '2026-11-12', projectIds: ['нет такого'] }), /Не найдено объектов/);
  const key = process.env.PLANRADAR_API_KEY;
  delete process.env.PLANRADAR_API_KEY;
  assert.throws(() => startExport({ from: '2026-11-01', to: '2026-11-12' }), /PLANRADAR_API_KEY/);
  process.env.PLANRADAR_API_KEY = key;
});

// Минимальный JPEG с заголовком SOF0: высота 60, ширина 120 — хватает, чтобы прочитать размер.
const tinyJpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const FIELD_AFTER = 'tf797eb4c4bcf526aa';
// фото вложения: field — id поля формы (у фото «после»), by — кто загрузил, at — когда
const image = (n, { field = null, by = 'author1', at = '2026-11-05T05:05:00.000Z' } = {}) => ({
  type: 'defectradar-issue-images',
  id: `img${n}`,
  attributes: { 'image-url-thumb-300px': `https://s3.test/img${n}.jpg`, 'image-url': `https://s3.test/full${n}.jpg`, 'field-id': field, 'created-by': by, 'created-at': at },
});
const imageResponse = (bytes) => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

test('размер картинки читается по заголовку (JPEG, PNG), чужие форматы не встраиваются', () => {
  assert.deepEqual(imageInfo(tinyJpeg(120, 60)), { extension: 'jpeg', width: 120, height: 60 });
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png);
  png.writeUInt32BE(300, 16);
  png.writeUInt32BE(200, 20);
  assert.deepEqual(imageInfo(png), { extension: 'png', width: 300, height: 200 });
  assert.equal(imageInfo(Buffer.from('RIFFxxxxWEBPVP8 ')), null);
});

test('фото «до» и «после»: по полю формы, а без поля — по автору и времени', () => {
  const t = { attributes: { 'author-id': 'author1', 'created-at': '2026-11-05T05:00:00.000Z' } };
  const names = new Map([[FIELD_AFTER, 'Фотоподтверждение устранения замечания'], ['tfBefore', 'Фото нарушения']]);
  // при создании замечания автором, без поля — «до» (в том числе загруженное ДО сохранения замечания)
  assert.equal(classifyPhoto(image(1), t, names), 'before');
  assert.equal(classifyPhoto(image(2, { at: '2026-11-05T04:20:00.000Z' }), t, names), 'before');
  // поле «Фотоподтверждение устранения замечания» — «после», кем и когда бы ни загрузили
  assert.equal(classifyPhoto(image(3, { field: FIELD_AFTER, by: 'fixer', at: '2026-11-20T05:00:00.000Z' }), t, names), 'after');
  assert.equal(classifyPhoto(image(4, { field: FIELD_AFTER }), t, names), 'after');
  // другое поле с названием про нарушение — «до»; неизвестное поле — «после»
  assert.equal(classifyPhoto(image(5, { field: 'tfBefore' }), t, names), 'before');
  assert.equal(classifyPhoto(image(6, { field: 'tfUnknown' }), t, names), 'after');
  // без поля: исполнитель (не автор) приложил позже чем через час — «после»; сразу — «до»
  assert.equal(classifyPhoto(image(7, { by: 'fixer', at: '2026-11-07T05:00:00.000Z' }), t, names), 'after');
  assert.equal(classifyPhoto(image(8, { by: 'fixer', at: '2026-11-05T05:10:00.000Z' }), t, names), 'before');
  // автор дозагрузил своё фото на следующий день — это всё равно «до»
  assert.equal(classifyPhoto(image(9, { by: 'author1', at: '2026-11-06T05:00:00.000Z' }), t, names), 'before');
});

test('фото: «до» и «после» раздельно, встраиваются в свои столбцы, размеры вдвое крупнее', async () => {
  mock.restoreAll();
  const withUuid = (n, created) => {
    const tk = ticket(n, created);
    return { ...tk, attributes: { ...tk.attributes, uuid: `uuid-${n}`, 'author-id': 'author1' } };
  };
  const calls = mockApi([
    [/projects\/p63\/tickets\?/, () => ({ ok: true, status: 200, json: async () => ({
      data: [withUuid(1, '2026-11-05T05:00:00.000Z'), withUuid(2, '2026-11-06T05:00:00.000Z')],
      included: [{ type: 'ticket-types', id: 'tt', attributes: { 'typed-fields': { [FIELD_AFTER]: { name: 'Фотоподтверждение устранения замечания' } } } }],
    }) })],
    // замечание 1: 2 фото «до», 6 «после» (встраиваются первые четыре), не скачается img3; замечание 2: нет фото
    [/tickets\/uuid-1\/attachments/, () => ({ ok: true, status: 200, json: async () => ({
      data: [],
      included: [image(1), image(2)]
        .concat([3, 4, 5, 6, 7, 8].map((n) => image(n, { field: FIELD_AFTER, by: 'fixer', at: `2026-11-1${n - 3}T05:00:00.000Z` })))
        .concat([{ type: 'videos', id: 'v1', attributes: {} }]),
    }) })],
    [/tickets\/uuid-2\/attachments/, () => ({ ok: true, status: 200, json: async () => ({ data: [], included: [] }) })],
    [/s3\.test\/img3\.jpg/, () => ({ ok: false, status: 403 })], // одно фото «после» не скачалось
    [/s3\.test\/img/, () => imageResponse(tinyJpeg(300, 200))],
  ]);
  const job = startExport({ from: '2026-11-01', to: '2026-11-12', projectIds: ['p63'] });
  await job.promise;

  assert.equal(job.status, 'done');
  assert.equal(job.photoFailures, 1);
  assert.ok(!calls.some((c) => /full\d/.test(c)), 'берутся миниатюры, не оригиналы');
  assert.equal(calls.filter((c) => /s3\.test/.test(c)).length, 6, 'скачиваются 2 фото «до» и первые 4 «после»');
  const ws = await readSheet(job.buffer);
  const row = ws.getRow(2).values;
  assert.equal(row[11], 2, 'фото до — всего');
  assert.equal(row[12], 6, 'фото после — всего (видео не считается)');
  assert.equal(ws.getRow(3).values[11], undefined);
  assert.equal(ws.getRow(2).height, 347, 'строка с фото вмещает две плитки по высоте');
  assert.equal(ws.getColumn(13).width, 87, 'столбец под фото вмещает две плитки по ширине');

  const imgs = ws.getImages().map((i) => ({ col: Math.floor(i.range.tl.col), ext: i.range.ext }));
  assert.deepEqual(imgs.map((i) => i.col), [12, 12, 13, 13, 13], 'до — 2 фото в столбце «Фото до», после — 3 в «Фото после» (img3 не скачалась)');
  // 300×200 вписывается в 330×244 без растягивания: остаётся натуральный размер
  assert.deepEqual(imgs[0].ext, { width: 300, height: 200 });
});

test('без фото: запросов вложений нет, столбцов фото нет', async () => {
  mock.restoreAll();
  const calls = mockApi([[/projects\/p63\/tickets\?/, () => ok([ticket(1, '2026-11-05T05:00:00.000Z')])]]);
  const job = startExport({ from: '2026-11-01', to: '2026-11-12', projectIds: ['p63'], withPhotos: false });
  await job.promise;
  assert.ok(!calls.some((c) => /attachments/.test(c)));
  const ws = await readSheet(job.buffer);
  assert.equal(ws.getRow(1).values.length - 1, 10);
  assert.equal(ws.getImages().length, 0);
});

test('несколько отмеченных объектов: опрашиваются только они', async () => {
  mock.restoreAll();
  const calls = mockApi([
    [/projects\/p63\/tickets/, () => ok([ticket(1, '2026-11-05T05:00:00.000Z')])],
    [/projects\/kos\/tickets/, () => ok([ticket(2, '2026-11-06T05:00:00.000Z')])],
  ]);
  const job = startExport({ from: '2026-11-01', to: '2026-11-12', projectIds: ['p63', 'kos'] });
  assert.equal(job.progress.total, 2);
  await job.promise;
  assert.equal(job.count, 2);
  assert.ok(!calls.some((c) => /projects\/lic\//.test(c)), 'неотмеченный объект не запрашивается');
});
