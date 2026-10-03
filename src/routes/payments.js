const express = require('express');
const prisma = require('../lib/prisma');
const { telegramAuth } = require('../middleware/telegramAuth');
const { paymentLimiter } = require('../middleware/rateLimiters');
const { getPrices } = require('../lib/prices');
const { handleInlineQuery } = require('../lib/inlineSearch');
const { publicBaseUrl, appLink } = require('../lib/shareMessage');
const { asyncRoute } = require('../lib/asyncRoute');
const { sendTelegramMessage, callTelegram, openAppButton } = require('../lib/telegramSend');
const { cancelByCharge } = require('../lib/subscriptions');

const router = express.Router();

// Подписка Telegram Stars всегда на 30 дней
const SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function isActive(until) {
  return !!until && new Date(until).getTime() > Date.now();
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('ru-RU', { timeZone: 'Europe/Sofia', day: 'numeric', month: 'long', year: 'numeric' });
}

async function findOwnedSpecialist(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!specialist || !specialist.verified || specialist.telegramUserId !== String(req.telegramUser.id)) return null;
  return specialist;
}

// Покупка PRO — доступна только подтверждённому владельцу анкеты (verified).
// PRO оформляется подпиской: Telegram сам продлевает его каждые 30 дней, пока
// владелец не отменит. Если Telegram не принял подписку — обычная разовая оплата на месяц.
// Если действует разовый PRO — разовое продление ещё на месяц.
router.post('/specialists/:id/purchase-pro', paymentLimiter, telegramAuth, asyncRoute(async (req, res) => {
  const specialist = await findOwnedSpecialist(req);
  if (!specialist) {
    return res.status(403).json({ error: 'Купить PRO может только подтверждённый владелец анкеты' });
  }
  if (specialist.pro && specialist.proRecurring && isActive(specialist.proExpiresAt)) {
    return res.status(409).json({ error: `PRO уже подключён и продлевается автоматически (следующее продление — ${formatDate(specialist.proExpiresAt)})` });
  }

  const prices = await getPrices();
  const base = {
    title: 'PRO-подписка КРУГ',
    payload: `pro:${specialist.id}`,
    currency: 'XTR',
    prices: [{ label: 'PRO, 1 месяц', amount: prices.pro_price }],
  };
  // Разовый PRO ещё действует — продлеваем ещё на месяц от конца срока (дни не сгорают).
  // Подписку можно будет оформить, когда этот срок закончится.
  if (specialist.pro && isActive(specialist.proExpiresAt)) {
    return res.json(await callTelegram('createInvoiceLink', {
      ...base,
      description: `Продление PRO для анкеты «${specialist.name}» ещё на 1 месяц (сейчас действует до ${formatDate(specialist.proExpiresAt)})`,
    }));
  }
  let invoice = await callTelegram('createInvoiceLink', {
    ...base,
    description: `PRO для анкеты «${specialist.name}». Продлевается каждый месяц, отменить можно в любой момент в Telegram.`,
    subscription_period: SUBSCRIPTION_PERIOD_SECONDS,
  });
  if (!invoice.ok) {
    console.error('Подписка PRO не создалась, предлагаем разовую оплату:', invoice.description);
    invoice = await callTelegram('createInvoiceLink', {
      ...base,
      description: `PRO-статус для анкеты «${specialist.name}» на 1 месяц`,
    });
  }
  res.json(invoice);
}));

// Покупка Буста
router.post('/specialists/:id/purchase-boost', paymentLimiter, telegramAuth, asyncRoute(async (req, res) => {
  const days = Number(req.body && req.body.days); // 7 или 30
  const prices = await getPrices();
  const priceByDays = { 7: prices.boost_price_7, 30: prices.boost_price_30 };
  const price = priceByDays[days];
  if (!price) return res.status(400).json({ error: 'Некорректный срок буста' });

  const specialist = await findOwnedSpecialist(req);
  if (!specialist) {
    return res.status(403).json({ error: 'Купить буст может только подтверждённый владелец анкеты' });
  }

  const invoice = await callTelegram('createInvoiceLink', {
    title: 'Буст анкеты КРУГ',
    description: specialist.boosted && isActive(specialist.boostedUntil)
      ? `Продление буста анкеты «${specialist.name}» ещё на ${days} дней`
      : `Буст анкеты «${specialist.name}» на ${days} дней`,
    payload: `boost:${specialist.id}:${days}`,
    currency: 'XTR',
    prices: [{ label: `Буст, ${days} дней`, amount: price }],
  });

  res.json(invoice);
}));

// Проверка перед списанием звёзд: анкета ещё существует, подтверждена и платит её владелец.
// Если анкету успели удалить — платёж не проходит, звёзды не списываются.
async function checkPreCheckout(query) {
  const [type, rawId] = String(query.invoice_payload || '').split(':');
  const id = Number(rawId);
  if (!['pro', 'boost'].includes(type) || !Number.isInteger(id) || id <= 0) return 'Некорректный платёж';
  const specialist = await prisma.specialist.findUnique({
    where: { id },
    select: { verified: true, telegramUserId: true },
  });
  if (!specialist || !specialist.verified || specialist.telegramUserId !== String(query.from.id)) {
    return 'Анкета недоступна для оплаты — откройте приложение заново';
  }
  return null;
}

// Сохраняет оплату и включает PRO/буст. Telegram иногда присылает одно и то же
// уведомление об оплате дважды — повтор с тем же номером платежа пропускаем.
async function handleSuccessfulPayment(message) {
  const payment = message.successful_payment;
  const chargeId = payment.telegram_payment_charge_id;
  const userId = String(message.from.id);

  if (chargeId && await prisma.payment.findFirst({ where: { telegramPaymentChargeId: chargeId }, select: { id: true } })) {
    return;
  }

  const [type, rawId, rawDays] = String(payment.invoice_payload || '').split(':');
  const id = Number(rawId);
  const specialist = Number.isInteger(id) && id > 0 ? await prisma.specialist.findUnique({ where: { id } }) : null;
  const isSubscription = !!payment.subscription_expiration_date;
  const isRenewal = !!payment.is_recurring && !payment.is_first_recurring;

  const paymentData = {
    specialistId: specialist ? specialist.id : null,
    specialistName: specialist ? specialist.name : null,
    telegramUserId: userId,
    type: type === 'boost' ? 'boost' : 'pro',
    starsAmount: payment.total_amount,
    durationDays: type === 'boost' ? Number(rawDays) || null : null,
    telegramPaymentChargeId: chargeId,
    isSubscription,
    isRenewal,
  };
  const notify = (text) => sendTelegramMessage(userId, text).catch((e) => console.error('Не удалось отправить сообщение об оплате', e));

  // Анкету удалили, пока шла оплата (или продлевается подписка удалённой анкеты) —
  // возвращаем звёзды и отменяем подписку, чтобы не списывать снова.
  if (!specialist) {
    await prisma.payment.create({ data: paymentData });
    let refunded = false;
    try {
      if (isSubscription) await cancelByCharge(userId, chargeId);
      const refund = await callTelegram('refundStarPayment', { user_id: Number(userId), telegram_payment_charge_id: chargeId });
      refunded = !!refund.ok;
      if (!refunded) console.error('Возврат звёзд не прошёл:', refund.description);
    } catch (e) {
      console.error('Возврат звёзд не прошёл', e);
    }
    await notify(refunded
      ? 'Анкета, за которую прошла оплата, больше не существует — звёзды возвращены.'
      : 'Анкета, за которую прошла оплата, больше не существует. Напишите в поддержку в приложении — вернём звёзды.');
    return;
  }

  let update;
  let text = null;
  if (type === 'pro') {
    // Срок не сгорает: продление считается от конца текущего PRO, если он ещё идёт
    const currentEnd = specialist.pro && isActive(specialist.proExpiresAt) ? new Date(specialist.proExpiresAt).getTime() : 0;
    let until;
    if (isSubscription) {
      until = new Date(Math.max(payment.subscription_expiration_date * 1000, currentEnd));
    } else {
      until = new Date(Math.max(Date.now(), currentEnd));
      until.setMonth(until.getMonth() + 1);
    }
    update = { pro: true, proExpiresAt: until, proRecurring: isSubscription, proReminderFor: null };
    if (!isRenewal) {
      text = isSubscription
        ? `✅ PRO для анкеты «${specialist.name}» подключён. Следующее продление — ${formatDate(until)}. Отменить подписку можно в любой момент в настройках Telegram (Мои звёзды).`
        : `✅ PRO для анкеты «${specialist.name}» действует до ${formatDate(until)}.`;
    }
  } else {
    const days = Number(rawDays) || 7;
    const from = specialist.boosted && isActive(specialist.boostedUntil) ? new Date(specialist.boostedUntil).getTime() : Date.now();
    const until = new Date(from + days * DAY_MS);
    update = { boosted: true, boostedUntil: until, boostReminderFor: null };
    text = `⚡ Буст анкеты «${specialist.name}» действует до ${formatDate(until)}.`;
  }

  // Платёж и включение PRO/буста — одним действием: либо оба сохранятся, либо ни одно
  // (тогда Telegram пришлёт оплату повторно, и мы попробуем снова)
  await prisma.$transaction([
    prisma.payment.create({ data: paymentData }),
    prisma.specialist.update({ where: { id }, data: update }),
  ]);
  if (text) await notify(text);
}

// Приветствие на /start: коротко о КРУГ и кнопка, открывающая приложение.
// Если человек пришёл по ссылке с параметром (t.me/бот?start=spec_123) —
// кнопка откроет приложение с тем же параметром.
async function sendWelcome(message) {
  const payload = String(message.text || '').split(/\s+/)[1] || '';
  const startParam = /^[A-Za-z0-9_-]{1,64}$/.test(payload) ? payload : '';
  await sendTelegramMessage(
    message.chat.id,
    'КРУГ — услуги для своих за границей.\n\nВрачи, юристы, мастера, репетиторы и другие специалисты, которые говорят на вашем языке. Выберите город и найдите нужного специалиста.',
    openAppButton('Открыть КРУГ', appLink(startParam)),
  );
}

// Webhook от Telegram: сюда приходят все апдейты бота.
// Проверяем секретный токен — без этого кто угодно мог бы дёрнуть этот адрес напрямую
// и притвориться, что оплата прошла, получив себе бесплатный PRO/буст.
// Секрет задаётся один раз при регистрации вебхука и должен совпадать с
// переменной TELEGRAM_WEBHOOK_SECRET в Railway.
router.post('/telegram/webhook', asyncRoute(async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  // Telegram перед списанием звёзд присылает pre_checkout_query и ждёт ответа в течение
  // 10 секунд — без ответа он сам отменяет платёж. Проверка — один быстрый запрос к базе;
  // если база не ответила, платёж не блокируем (проверим при зачислении).
  const preCheckoutQuery = req.body?.pre_checkout_query;
  if (preCheckoutQuery) {
    let problem = null;
    try {
      problem = await checkPreCheckout(preCheckoutQuery);
    } catch (e) {
      console.error('Не удалось проверить платёж перед списанием', e);
    }
    try {
      await callTelegram('answerPreCheckoutQuery', problem
        ? { pre_checkout_query_id: preCheckoutQuery.id, ok: false, error_message: problem }
        : { pre_checkout_query_id: preCheckoutQuery.id, ok: true });
    } catch (e) {
      console.error('Не удалось ответить на pre_checkout_query', e);
    }
    return res.sendStatus(200);
  }

  // Поиск через строку "@krugspace_bot ..." в любом чате (см. lib/inlineSearch.js).
  // Сразу отвечаем Telegram "получено", а сам поиск делаем следом — так вебхук
  // никогда не подвисает на медленном запросе.
  const inlineQuery = req.body?.inline_query;
  if (inlineQuery) {
    res.sendStatus(200);
    handleInlineQuery(inlineQuery, publicBaseUrl(req)).catch((e) => console.error('Inline-поиск: ошибка', e));
    return;
  }

  const message = req.body?.message;

  if (message?.successful_payment) {
    // Ошибку здесь не глотаем: ответ 500 заставит Telegram прислать оплату повторно,
    // а повтор безопасен (см. проверку номера платежа выше)
    await handleSuccessfulPayment(message);
  } else if (message && message.chat?.type === 'private' && /^\/start(\s|@|$)/.test(message.text || '')) {
    try {
      await sendWelcome(message);
    } catch (e) {
      console.error('Не удалось отправить приветствие', e);
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
        await sendTelegramMessage(ticket.telegramUserId, `💬 Ответ поддержки КРУГ:\n\n${message.text}`);
      }
    } catch (e) {
      console.error('Не удалось переслать ответ поддержки пользователю', e);
    }
  }

  res.sendStatus(200);
}));

module.exports = router;
