// Общая обвязка тестов ПТО: временная БД, заглушка расценок, сервер на свободном порту.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Должен вызываться до первого require модулей ПТО: db.js читает PTO_DATA_DIR при загрузке.
function setupPtoEnv() {
  process.env.PTO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pto-test-'));
}

// Расценки из «свода»: три кандидата, как отдал бы Qdrant.
const RATE_BOOK = {
  prep: { id: 101, score: 0.62, tier: 'Расценки утверждённые в ТОО VK development group', tierTitle: 'утверждённые в VK', name: 'Устройство бетонной подготовки', unit: 'м³', price: 14268, priceNoVat: 12300, object: 'Все объекты', unitMatch: true },
  concrete: { id: 102, score: 0.58, tier: 'Расценки из ЕНиР для фирм', tierTitle: 'ЕНиР для фирм', name: 'Бетонирование открытых площадок', unit: 'м³', price: 15772, priceNoVat: 13597, object: null, unitMatch: true },
};

function stubRates() {
  const calls = { suggest: [], get: [] };
  return {
    calls,
    async suggest(query, unit) {
      calls.suggest.push([query, unit]);
      if (/бетонной подготовки/.test(query)) return { best: RATE_BOOK.prep, candidates: [RATE_BOOK.prep] };
      if (/Бетонирование монолитных/.test(query)) return { best: RATE_BOOK.concrete, candidates: [RATE_BOOK.concrete] };
      return { best: null, candidates: [] };
    },
    async get(id) {
      calls.get.push(id);
      return Object.values(RATE_BOOK).find((r) => r.id === Number(id)) || null;
    },
    async search(q) { return Object.values(RATE_BOOK).map((r) => ({ ...r, query: q })); },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const call = async (method, url, body, { raw, headers } = {}) => {
        const res = await fetch(base + url, {
          method,
          headers: { ...(raw ? {} : body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
      };
      resolve({ server, call });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { tries = 60, delay = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(delay);
  }
  throw new Error('дождались не того');
}

module.exports = { setupPtoEnv, stubRates, listen, until, RATE_BOOK };
