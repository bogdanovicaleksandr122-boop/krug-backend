const express = require('express');
const prisma = require('../lib/prisma');
const { telegramAuth } = require('../middleware/telegramAuth');
const { shareLimiter } = require('../middleware/rateLimiters');
const { getShareCard, CARD_WIDTH, CARD_HEIGHT } = require('../lib/shareCard');

const router = express.Router();

const BOT_USERNAME = process.env.BOT_USERNAME || 'krugspace_bot';
const MINI_APP_NAME = process.env.MINI_APP_NAME || 'app';

async function findPublished(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const specialist = await prisma.specialist.findUnique({
    where: { id },
    include: { category: true, subcategory: true, city: true },
  });
  return specialist && specialist.status === 'published' ? specialist : null;
}

// Публичный адрес этого сервера — Telegram сам скачивает по нему картинку.
// Railway сам сообщает свой домен в RAILWAY_PUBLIC_DOMAIN.
function publicBaseUrl(req) {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `${req.protocol}://${req.get('host')}`;
}

// Картинка-карточка анкеты. Её забирает Telegram, когда показывает сообщение.
router.get('/specialists/:id/share-card.jpg', async (req, res, next) => {
  try {
    const specialist = await findPublished(req.params.id);
    if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });
    const jpeg = await getShareCard(specialist);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(jpeg);
  } catch (err) {
    next(err);
  }
});

// Готовит сообщение "картинка + кнопка" для отправки через Telegram.shareMessage.
// Telegram возвращает номер заготовки, приложение по нему открывает выбор чата.
router.post('/specialists/:id/share-prepare', shareLimiter, telegramAuth, async (req, res, next) => {
  try {
    const specialist = await findPublished(req.params.id);
    if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });

    // Рисуем картинку заранее: так сразу видно, если что-то не так (тогда
    // приложение поделится по-старому, ссылкой), и Telegram получит её мгновенно.
    await getShareCard(specialist);

    const version = new Date(specialist.updatedAt).getTime();
    const photoUrl = `${publicBaseUrl(req)}/api/specialists/${specialist.id}/share-card.jpg?v=${version}`;
    const deepLink = `https://t.me/${BOT_USERNAME}/${MINI_APP_NAME}?startapp=spec_${specialist.id}`;
    const cityText = specialist.city ? specialist.city.label : '';
    const caption = [`${specialist.name} — ${specialist.role}`, cityText ? `📍 ${cityText}` : '']
      .filter(Boolean)
      .join('\n')
      .slice(0, 1000);

    const tgRes = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/savePreparedInlineMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: req.telegramUser.id,
        result: {
          type: 'photo',
          id: `spec_${specialist.id}_${Date.now()}`,
          photo_url: photoUrl,
          thumbnail_url: photoUrl,
          photo_width: CARD_WIDTH,
          photo_height: CARD_HEIGHT,
          caption,
          reply_markup: { inline_keyboard: [[{ text: 'Открыть анкету', url: deepLink }]] },
        },
        allow_user_chats: true,
        allow_bot_chats: true,
        allow_group_chats: true,
        allow_channel_chats: true,
      }),
    });
    const data = await tgRes.json();
    if (!data.ok) {
      console.error('savePreparedInlineMessage отклонён:', data.description);
      return res.status(502).json({ error: 'Telegram не принял сообщение' });
    }
    res.json({ id: data.result.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
