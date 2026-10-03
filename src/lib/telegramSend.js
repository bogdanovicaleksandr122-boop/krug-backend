// Простая обёртка над Bot API sendMessage — переиспользуется и для уведомлений
// о статусе анкеты, и для рассылки всем пользователям (см. routes/admin.js).
// extra — дополнительные поля сообщения, например кнопки (reply_markup).
async function sendTelegramMessage(chatId, text, extra) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(extra || {}) }),
  });
  return response.json();
}

// Любой другой метод Bot API (createInvoiceLink, refundStarPayment и т.п.)
async function callTelegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

// Кнопка под сообщением, открывающая мини-приложение по ссылке
function openAppButton(text, url) {
  return { reply_markup: { inline_keyboard: [[{ text, url }]] } };
}

module.exports = { sendTelegramMessage, callTelegram, openAppButton };
