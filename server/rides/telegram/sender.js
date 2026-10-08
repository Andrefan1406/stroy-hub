// Очередь исходящих сообщений бота. Лимиты Telegram — около 30 сообщений в
// секунду на бота и 1 в секунду в один чат; рассылка заявки всем водителям
// на линии идёт подряд, поэтому отправка последовательная с небольшой
// паузой, а на 429 очередь ждёт, сколько сказал Telegram, и повторяет.
//
// Ошибки Telegram никогда не уходят в вызывающий код (основная операция с
// заявкой уже выполнена): заблокировавший бота водитель помечается и больше
// не получает рассылку, остальное — в лог, результат null.
const { markChatBlocked } = require('./store');

const MIN_GAP_MS = 40;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSender(api, getDb, { minGapMs = MIN_GAP_MS } = {}) {
  let tail = Promise.resolve();

  async function attempt(method, params, chatId) {
    for (let i = 0; ; i++) {
      try {
        return await api.call(method, params);
      } catch (err) {
        if (err.retryAfter && i < MAX_RETRIES) {
          await sleep(err.retryAfter * 1000);
          continue;
        }
        if (err.isBlocked && chatId) {
          markChatBlocked(getDb(), chatId);
        } else if (!err.isHarmlessEdit) {
          console.error(`[telegram] ${method} не выполнен:`, err.message);
        }
        return null;
      }
    }
  }

  function enqueue(method, params) {
    const chatId = params.chat_id;
    const run = tail.then(async () => {
      const result = await attempt(method, params, chatId);
      if (minGapMs) await sleep(minGapMs);
      return result;
    });
    tail = run.catch(() => null);
    return run;
  }

  return {
    send: (chatId, text, replyMarkup) =>
      enqueue('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    edit: (chatId, messageId, text, replyMarkup) =>
      enqueue('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup || { inline_keyboard: [] },
      }),
    // Прочие методы (команды чата, кнопка меню) — через ту же очередь.
    call: (method, params) => enqueue(method, params),
    // Ответ на нажатие кнопки — мимо очереди: Telegram ждёт его быстро,
    // иначе у водителя «крутятся часики» на кнопке.
    answer: (callbackQueryId, text, showAlert = false) =>
      attempt('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '', show_alert: showAlert }),
    // Для тестов и плавной остановки: дождаться, пока очередь опустеет.
    idle: () => tail,
  };
}

module.exports = { createSender };
