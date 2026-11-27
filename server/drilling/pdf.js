// Один PDF-файл по заявке на бурение: «Наряд задание» (адресат, таблица работ, подписи, путь
// согласования внизу первого листа) и следом все вложения — фото и страницы PDF. Все листы —
// А4 книжные: альбомное фото или страница поворачивается на 90° по часовой и заполняет лист.
// Шрифт PT Serif (лицензия OFL, server/drilling/fonts) — с кириллицей, по виду близок к Times.
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { UNITS, positionLabel } = require('./validation');

const MM = 72 / 25.4;
const PAGE_W = 210 * MM;
const PAGE_H = 297 * MM;
const MARGIN_X = 15 * MM;
const MARGIN_Y = 20 * MM;
const BODY_W = PAGE_W - 2 * MARGIN_X;
const TZ = 'Asia/Almaty';

const fontBytes = {};
const readFont = (name) => { if (!fontBytes[name]) fontBytes[name] = fs.readFileSync(path.join(__dirname, 'fonts', name)); return fontBytes[name]; };

function parts(iso) {
  const f = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
}
const fmtDate = (iso) => { const p = parts(iso); return `${p.day}.${p.month}.${p.year}`; };
const fmtStamp = (iso) => { const p = parts(iso); return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`; };
const fmtNum = (n) => String(n).replace('.', ',');

// Ориентация фото из EXIF (JPEG): на сколько градусов по часовой повернуть, чтобы фото стояло прямо.
function jpegTurn(buf) {
  try {
    let i = 2;
    while (i + 4 < buf.length) {
      if (buf[i] !== 0xff) return 0;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.slice(i + 4, i + 10).toString('latin1') === 'Exif\0\0') {
        const t = i + 10;
        const le = buf.slice(t, t + 2).toString('latin1') === 'II';
        const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k += 1) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return { 3: 180, 6: 90, 8: 270 }[u16(e + 8)] || 0;
        }
        return 0;
      }
      if (marker === 0xda) return 0; // дальше пошли данные картинки
      i += 2 + len;
    }
  } catch {
    /* нет или битый EXIF — считаем, что фото стоит прямо */
  }
  return 0;
}

// Нарисовать прямоугольник w×h (картинку или страницу), повернув на turn° по часовой,
// по центру листа с вписыванием в область листа без обрезки.
function drawFitted(page, w, h, turn, drawAt) {
  const rot = ((turn % 360) + 360) % 360;
  const sideways = rot % 180 !== 0;
  const vw = sideways ? h : w;
  const vh = sideways ? w : h;
  const scale = Math.min((PAGE_W - 2 * MARGIN_X) / vw, (PAGE_H - 2 * MARGIN_Y) / vh);
  const a = (-rot * Math.PI) / 180; // по часовой = отрицательный угол
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, PAGE_W / 2, PAGE_H / 2), concatTransformationMatrix(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0));
  drawAt(-(w * scale) / 2, -(h * scale) / 2, w * scale, h * scale);
  page.pushOperators(popGraphicsState());
}

// Альбомное — ещё на 90° по часовой, чтобы заполнить книжный лист.
const extraTurn = (w, h, base) => ((base % 180 === 0 ? w > h : h > w) ? 90 : 0);

async function addImage(doc, att, buf) {
  const isPng = att.mime === 'image/png';
  const img = await (isPng ? doc.embedPng(buf) : doc.embedJpg(buf));
  const base = isPng ? 0 : jpegTurn(buf);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const turn = base + extraTurn(img.width, img.height, base);
  drawFitted(page, img.width, img.height, turn, (x, y, w, h) => page.drawImage(img, { x, y, width: w, height: h }));
}

async function addPdfPages(doc, buf) {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const pages = src.getPages();
  for (const srcPage of pages) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    if (!srcPage.node.Contents()) continue; // пустая страница без содержимого — остаётся чистый лист
    const emb = await doc.embedPage(srcPage);
    const base = ((srcPage.getRotation().angle % 360) + 360) % 360; // собственный поворот страницы в файле
    const turn = base + extraTurn(emb.width, emb.height, base);
    drawFitted(page, emb.width, emb.height, turn, (x, y, w, h) => page.drawPage(emb, { x, y, width: w, height: h }));
  }
}

// ---------- форма «Наряд задание» ----------

function wrap(font, text, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxW) { line = next; continue; }
      if (line) out.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > maxW) { // слово длиннее ячейки — режем по буквам
        let k = line.length - 1;
        while (k > 1 && font.widthOfTextAtSize(line.slice(0, k), size) > maxW) k -= 1;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

// «…прошу выполнить работы по …»: по составу строк заявки.
function introSubject(items) {
  const hasDrill = items.some((i) => i.workType === 'drill');
  const hasCut = items.some((i) => i.workType === 'cut');
  if (hasDrill && hasCut) return 'технологическому бурению и резке';
  return hasCut ? 'резке' : 'технологическому бурению';
}

function drawForm(doc, fonts, data) {
  const { regular, bold } = fonts;
  const black = rgb(0, 0, 0);
  const grey = rgb(0.33, 0.33, 0.33);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN_Y;

  const text = (t, { x = MARGIN_X, size = 12, font = regular, color = black, align = 'left', width = BODY_W } = {}) => {
    const w = font.widthOfTextAtSize(t, size);
    const px = align === 'right' ? x + width - w : align === 'center' ? x + (width - w) / 2 : x;
    page.drawText(t, { x: px, y: y - size, size, font, color });
  };
  const line = (t, opts = {}) => { text(t, opts); y -= (opts.size || 12) * 1.35; };

  const addressee = data.company?.addressee || 'Директору';
  for (const l of wrap(regular, addressee, 12, BODY_W * 0.6)) line(l, { align: 'right' });
  line('В работу', { align: 'right', font: bold });
  line(fmtDate(data.acceptedAt || data.createdAt), { align: 'right' });
  y -= 12;
  line('Наряд задание', { align: 'center', size: 14, font: bold });
  line(`№ ${data.id} от ${fmtDate(data.createdAt)}`, { align: 'center' });
  if (data.dueDate) line(`Срок исполнения: до ${data.dueDate.split('-').reverse().join('.')}`, { align: 'center', font: bold });
  y -= 10;
  const subject = introSubject(data.items);
  for (const l of wrap(regular, `В связи с производственной необходимостью прошу Вас выполнить работы по ${subject}:`, 12, BODY_W)) line(l);
  y -= 6;

  // таблица работ
  const cols = [22, 108, 66, 64, 64, 52];
  cols.push(BODY_W - cols.reduce((a, b) => a + b, 0));
  const head = ['№', 'Объект, позиция', 'Вид работ', 'Размер', 'Материал', 'Кол-во', 'Причина / комментарий'];
  const SIZE = 10.5;
  const PAD = 3;
  const leading = SIZE * 1.25;
  const drawRow = (cells, isHead) => {
    const lines = cells.map((c, i) => wrap(isHead ? bold : regular, c, SIZE, cols[i] - 2 * PAD));
    const h = Math.max(...lines.map((l) => l.length)) * leading + 2 * PAD;
    if (y - h < MARGIN_Y + 90 && !isHead) { // не помещается — продолжение на новом листе
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN_Y;
      drawRow(head, true);
    }
    let x = MARGIN_X;
    cells.forEach((_, i) => {
      page.drawRectangle({ x, y: y - h, width: cols[i], height: h, borderColor: black, borderWidth: 0.7 });
      const center = isHead || i === 0 || i === 5;
      lines[i].forEach((l, k) => {
        const f = isHead ? bold : regular;
        const w = f.widthOfTextAtSize(l, SIZE);
        const tx = center ? x + (cols[i] - w) / 2 : x + PAD;
        page.drawText(l, { x: tx, y: y - PAD - SIZE - k * leading + 2, size: SIZE, font: f, color: black });
      });
      x += cols[i];
    });
    y -= h;
  };
  drawRow(head, true);
  data.items.forEach((it, i) => drawRow([
    String(i + 1),
    `${it.object}\n${positionLabel(it.position)}`,
    it.workType === 'drill' ? 'Бурение' : 'Резка',
    it.workType === 'drill' ? `Ø ${it.diameterMm} мм` : `толщина ${fmtNum(it.thicknessCm)} см`,
    it.material,
    `${fmtNum(it.quantity)} ${UNITS[it.workType]}`,
    it.reason || '—',
  ], false));

  // подписи
  y -= 30;
  const half = BODY_W / 2;
  const sign = (x, title, lines) => {
    let sy = y;
    page.drawText(title, { x, y: sy - 12, size: 12, font: bold, color: black });
    for (const l of lines) { sy -= 16; page.drawText(l, { x, y: sy - 12, size: 12, font: regular, color: black }); }
  };
  sign(MARGIN_X, 'Составил:', [data.initiator.position, data.initiator.fullName]);
  sign(MARGIN_X + half + 10, 'Согласовано:', [data.approver.position, data.approver.fullName]);

  // колонтитул: путь согласования внизу первого листа
  const stamps = [`Создана: ${fmtStamp(data.roundStartedAt)}`, ...data.stamps.map((s) => `${s.company} — ${s.label} ${fmtStamp(s.at)}`)];
  const first = doc.getPage(0);
  const top = MARGIN_Y + stamps.length * 11.5 + 6;
  first.drawLine({ start: { x: MARGIN_X, y: top }, end: { x: PAGE_W - MARGIN_X, y: top }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
  stamps.forEach((s, i) => first.drawText(s, { x: MARGIN_X, y: top - 11 - i * 11.5, size: 9, font: regular, color: grey }));
}

function noteWebp(doc, fonts, name) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText(`Файл «${name}» не вставлен: формат не поддерживается в общем PDF.`, { x: MARGIN_X, y: PAGE_H / 2, size: 11, font: fonts.regular, color: rgb(0.6, 0, 0), maxWidth: BODY_W });
  page.drawText('Откройте его в заявке на сайте.', { x: MARGIN_X, y: PAGE_H / 2 - 18, size: 11, font: fonts.regular });
}

// data — svc.getDocData(id); files — [{ name, mime, buffer }] в порядке прикрепления.
async function buildPdf(data, files = []) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Наряд задание № ${data.id}`);
  doc.setCreator('stroy-hub');
  const fonts = {
    regular: await doc.embedFont(readFont('PT_Serif-Regular.ttf'), { subset: true }),
    bold: await doc.embedFont(readFont('PT_Serif-Bold.ttf'), { subset: true }),
  };
  drawForm(doc, fonts, data);
  for (const f of files) {
    try {
      if (f.mime === 'application/pdf') await addPdfPages(doc, f.buffer);
      else if (f.mime === 'image/jpeg' || f.mime === 'image/png') await addImage(doc, f, f.buffer);
      else noteWebp(doc, fonts, f.name);
    } catch {
      noteWebp(doc, fonts, f.name); // битый файл не должен ронять весь документ
    }
  }
  return Buffer.from(await doc.save());
}

module.exports = { buildPdf, introSubject };
