// Файлы к заявке на бурение (чертежи, фото): допустимые типы, лимиты, безопасное имя.
// Тип определяется по первым байтам файла, а не по расширению и заявленному типу —
// переименованный исполняемый файл не пройдёт.
const MAX_FILE_BYTES = 15 * 1024 * 1024; // один файл (фото с телефона страница сжимает до отправки)
const MAX_FILES_PER_REQUEST = 15;

// -> { mime, ext } или null
function detectFileType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

// Имя файла для показа и скачивания: без пути и управляющих символов, не длиннее 120 знаков.
function safeFileName(name, fallbackExt = '') {
  let n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  if (!n) n = `файл${fallbackExt}`;
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 8 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

module.exports = { MAX_FILE_BYTES, MAX_FILES_PER_REQUEST, detectFileType, safeFileName };
