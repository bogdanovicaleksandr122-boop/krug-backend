const express = require('express');
const prisma = require('../lib/prisma');
const { telegramAuth } = require('../middleware/telegramAuth');
const { paymentLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// Цены — те же, что были в прототипе
const PRO_PRICE = 500; // Stars в месяц
const BOOST_PRICES = { 7: 200, 30: 600 }; // Stars за срок в днях

async function callTelegram(method, payload) {
  // В Node 18+ (у вас на Railway — Node 24) функция fetch встроена в сам Node.js,
  // отдельный пакет node-fetch не нужен и как раз он ломал запрос ошибкой
  // "fetch is not a function" — пакет node-fetch версии 3 нельзя подключать через require().
  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

// Покупка PRO — доступна только подтверждённому владельцу анкеты (verified)
router.post('/specialists/:id/purchase-pro', paymentLimiter, telegramAuth, async (req, res) => {
  const specialist = await prisma.specialist.findUnique({ where: { id: Number(req.params.id) } });
  if (!specialist || !specialist.verified || specialist.telegramUserId !== String(req.telegramUser.id)) {
    return res.status(403).json({ error: 'Купить PRO может только подтверждённый владелец анкеты' });
  }

  const invoice = await callTelegram('createInvoiceLink', {
    title: 'PRO-подписка КРУГ',
    description: `PRO-статус для анкеты «${specialist.name}» на 1 месяц`,
    payload: `pro:${specialist.id}`,
    currency: 'XTR',
    prices: [{ label: 'PRO, 1 месяц', amount: PRO_PRICE }],
  });

  res.json(invoice);
});

// Покупка Буста
router.post('/specialists/:id/purchase-boost', paymentLimiter, telegramAuth, async (req, res) => {
  const { days } = req.body; // 7 или 30
  const price = BOOST_PRICES[days];
  if (!price) return res.status(400).json({ error: 'Некорректный срок буста' });

  const specialist = await prisma.specialist.findUnique({ where: { id: Number(req.params.id) } });
  if (!specialist || !specialist.verified || specialist.telegramUserId !== String(req.telegramUser.id)) {
    return res.status(403).json({ error: 'Купить буст может только подтверждённый владелец анкеты' });
  }

  const invoice = await callTelegram('createInvoiceLink', {
    title: 'Буст анкеты КРУГ',
    description: `Буст анкеты «${specialist.name}» на ${days} дней`,
    payload: `boost:${specialist.id}:${days}`,
    currency: 'XTR',
    prices: [{ label: `Буст, ${days} дней`, amount: price }],
  });

  res.json(invoice);
});

// Webhook от Telegram: сюда придут все апдейты бота, нас интересует successful_payment.
// Проверяем секретный токен — без этого кто угодно мог бы дёрнуть этот адрес напрямую
// и притвориться, что оплата прошла, получив себе бесплатный PRO/буст.
// Секрет задаётся один раз при регистрации вебхука (см. инструкцию ниже) и
// должен совпадать с переменной TELEGRAM_WEBHOOK_SECRET в Railway.
router.post('/telegram/webhook', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  const message = req.body?.message;
  const payment = message?.successful_payment;

  if (payment) {
    const [type, specialistId, days] = payment.invoice_payload.split(':');
    const id = Number(specialistId);

    if (type === 'pro') {
      const proExpiresAt = new Date();
      proExpiresAt.setMonth(proExpiresAt.getMonth() + 1);
      await prisma.specialist.update({ where: { id }, data: { pro: true, proExpiresAt } });
      await prisma.payment.create({
        data: { specialistId: id, type: 'pro', starsAmount: payment.total_amount, telegramPaymentChargeId: payment.telegram_payment_charge_id },
      });
    }

    if (type === 'boost') {
      const boostedUntil = new Date();
      boostedUntil.setDate(boostedUntil.getDate() + Number(days));
      await prisma.specialist.update({ where: { id }, data: { boosted: true, boostedUntil } });
      await prisma.payment.create({
        data: { specialistId: id, type: 'boost', starsAmount: payment.total_amount, durationDays: Number(days), telegramPaymentChargeId: payment.telegram_payment_charge_id },
      });
    }
  } else if (message && message.reply_to_message && message.text) {
    // Ответ владельца приложения реплаем на пересланное обращение в поддержку
    // (см. /api/me/support) — находим, кому изначально принадлежало это
    // сообщение, и пересылаем текст ответа обратно этому пользователю в бот.
    try {
      const ticket = await prisma.supportMessage.findUnique({
        where: {
          relayChatId_relayMessageId: {
            relayChatId: String(message.chat.id),
            relayMessageId: message.reply_to_message.message_id,
          },
        },
      });
      if (ticket) {
        await callTelegram('sendMessage', {
          chat_id: ticket.telegramUserId,
          text: `💬 Ответ поддержки КРУГ:\n\n${message.text}`,
        });
      }
    } catch (e) {
      console.error('Не удалось переслать ответ поддержки пользователю', e);
    }
  }

  res.sendStatus(200);
});

module.exports = router;
