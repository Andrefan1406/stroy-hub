// Минимальный клиент Telegram Bot API на встроенном fetch (Node 18+) —
// без сторонних библиотек: боту нужны несколько методов (sendMessage,
// editMessageText, answerCallbackQuery, setWebhook, getUpdates...).
const API_BASE = 'https://api.telegram.org';

class TelegramError extends Error {
  constructor(method, code, description, retryAfter) {
    super(`Telegram ${method}: ${code} ${description}`);
    this.code = code;
    this.description = description || '';
    this.retryAfter = retryAfter || null;
  }

  // Водитель заблокировал бота или удалил чат — писать ему бесполезно.
  get isBlocked() {
    return this.code === 403;
  }

  // Безвредные ответы на правку: текст не изменился / сообщение уже удалено.
  get isHarmlessEdit() {
    return this.code === 400 && /not modified|message to edit not found|message can't be edited/i.test(this.description);
  }
}

function createApi(token, fetchImpl = fetch) {
  async function call(method, params = {}) {
    const res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({ ok: false, error_code: res.status, description: 'не JSON-ответ' }));
    if (!data.ok) throw new TelegramError(method, data.error_code, data.description, data.parameters?.retry_after);
    return data.result;
  }
  return { call };
}

module.exports = { createApi, TelegramError };
