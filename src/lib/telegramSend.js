// Простая обёртка над Bot API sendMessage — переиспользуется и для уведомлений
// о статусе анкеты, и для рассылки всем пользователям (см. routes/admin.js).
async function sendTelegramMessage(chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return response.json();
}

module.exports = { sendTelegramMessage };
