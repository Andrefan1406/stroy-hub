// Один PDF по заявке на бурение: форма + все вложения, все листы А4 книжные,
// альбомные вложения поворачиваются; доступ — только после принятия в работу.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drpdf-'));
process.env.CONCRETE_DATA_DIR = dir;
process.env.RIDES_DATA_DIR = path.join(dir, 'rides');

const fbPath = require.resolve('firebase-admin/auth');
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { getAuth: () => ({ verifyIdToken: async (t) => ({ email: t }) }) } };

const { PDFDocument } = require('pdf-lib');
const { initSchema } = require('../../db');
const rides = require('../../rides/db');
initSchema();
rides.initSchema();
const svc = require('../service');
svc.seedDefaults();

function addUser(email, role, o = {}) {
  rides.getWriteDb().prepare('INSERT INTO users (email, name, phone, position, company_id, role, full_site_access) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(email, o.name || 'Тест', '', o.position || '', o.companyId || null, role);
}
addUser('chief@x.kz', 'chief_engineer', { name: 'Титаренко Владимир', position: 'Главный инженер' });
addUser('prom@x.kz', 'prom_alyans', { name: 'Исполнитель' });
addUser('dir@x.kz', 'prom_director', { name: 'Директор', position: 'Директор' });
addUser('author@x.kz', 'staff', { name: 'Кузнецов Андрей', position: 'Прораб' });

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/drilling', require('../router').router);
const server = app.listen(0);
after(() => server.close());
const url = (p) => `http://127.0.0.1:${server.address().port}/api/drilling${p}`;
const auth = (email) => ({ authorization: `Bearer ${email}` });

// Настоящий PNG нужного размера (серый, без сжатия фильтров) — чтобы pdf-lib его принял.
function png(w, h) {
  const crc = (buf) => { let c; let r = 0xffffffff; for (const b of buf) { c = (r ^ b) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; r = (r >>> 8) ^ c; } return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 128);
  for (let y = 0; y < h; y += 1) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function pdfFile(sizes) {
  const d = await PDFDocument.create();
  sizes.forEach(([w, h]) => d.addPage([w, h]));
  return Buffer.from(await d.save());
}
const upload = (id, name, body) => fetch(url(`/requests/${id}/attachments?name=${encodeURIComponent(name)}`), {
  method: 'POST', headers: { ...auth('author@x.kz'), 'content-type': 'application/octet-stream' }, body,
});
const drill = { object: 'Брик таун 2', position: 'пятно I', workType: 'drill', material: 'кирпич', diameterMm: '100', quantity: '12', reason: '' };

test('PDF: форма + вложения, все листы А4 книжные, альбомные вложения поворачиваются', async () => {
  const id = svc.createRequest('author@x.kz', [drill], { dueDate: '2099-01-31' });
  assert.equal((await upload(id, 'портрет.png', png(40, 80))).status, 201);
  assert.equal((await upload(id, 'альбом.png', png(80, 40))).status, 201);
  assert.equal((await upload(id, 'чертёж.pdf', await pdfFile([[842, 595], [595, 842], [300, 300]]))).status, 201);

  const get = (email) => fetch(url(`/requests/${id}/pdf`), { headers: auth(email) });
  assert.equal((await get('author@x.kz')).status, 409, 'до согласования и принятия файл не отдаётся');

  svc.respond(id, 'chief@x.kz', 'accept'); svc.respond(id, 'dir@x.kz', 'accept');
  assert.equal((await get('author@x.kz')).status, 409, 'пока исполнитель не принял — нельзя');
  svc.respond(id, 'prom@x.kz', 'accept');

  for (const email of ['author@x.kz', 'chief@x.kz', 'prom@x.kz']) {
    const res = await get(email);
    assert.equal(res.status, 200, email + ' ' + (res.status === 200 ? '' : await res.text()));
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  }
  const res = await get('author@x.kz');
  const doc = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
  const pages = doc.getPages();
  assert.equal(pages.length, 1 + 2 + 3, 'форма + 2 картинки + 3 страницы PDF');
  for (const p of pages) {
    const { width, height } = p.getSize();
    assert.ok(Math.abs(width - 595.28) < 0.1 && Math.abs(height - 841.89) < 0.1, `лист А4 книжный, а не ${width}x${height}`);
  }
});

test('PDF: чужой не получает; битое вложение не ломает документ', async () => {
  const id = svc.createRequest('author@x.kz', [drill], { dueDate: '2099-01-31' });
  await upload(id, 'битый.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 1)]));
  svc.respond(id, 'chief@x.kz', 'accept'); svc.respond(id, 'dir@x.kz', 'accept');
  svc.respond(id, 'prom@x.kz', 'accept');
  assert.equal((await fetch(url(`/requests/${id}/pdf`), { headers: auth('nobody@x.kz') })).status, 403);
  const res = await fetch(url(`/requests/${id}/pdf`), { headers: auth('author@x.kz') });
  assert.equal(res.status, 200);
  assert.equal((await PDFDocument.load(Buffer.from(await res.arrayBuffer()))).getPageCount(), 2, 'форма + лист-заглушка');
});

test('PDF: вводная фраза зависит от состава работ', () => {
  const { introSubject } = require('../pdf');
  const cut = { workType: 'cut' };
  assert.equal(introSubject([drill]), 'технологическому бурению');
  assert.equal(introSubject([cut]), 'резке');
  assert.equal(introSubject([drill, cut]), 'технологическому бурению и резке');
});
