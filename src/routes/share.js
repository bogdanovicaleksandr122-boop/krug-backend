const express = require('express');
const prisma = require('../lib/prisma');
const { telegramAuth } = require('../middleware/telegramAuth');
const { shareLimiter } = require('../middleware/rateLimiters');
const { getShareCard } = require('../lib/shareCard');
const { publicBaseUrl, buildPhotoResult } = require('../lib/shareMessage');
const { asyncRoute } = require('../lib/asyncRoute');

const router = express.Router();

async function findPublished(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const specialist = await prisma.specialist.findUnique({
    where: { id },
    include: { category: true, subcategory: true, city: true },
  });
  return specialist && specialist.status === 'published' ? specialist : null;
}

// Картинка-карточка анкеты. Её забирает Telegram, когда показывает сообщение.
router.get('/specialists/:id/share-card.jpg', asyncRoute(async (req, res, next) => {
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
}));

// Готовит сообщение "картинка + кнопка" для отправки через Telegram.shareMessage.
// Telegram возвращает номер заготовки, приложение по нему открывает выбор чата.
router.post('/specialists/:id/share-prepare', shareLimiter, telegramAuth, asyncRoute(async (req, res, next) => {
  try {
    const specialist = await findPublished(req.params.id);
    if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });

    // Рисуем картинку заранее: так сразу видно, если что-то не так (тогда
    // приложение поделится по-старому, ссылкой), и Telegram получит её мгновенно.
    await getShareCard(specialist);

    const tgRes = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/savePreparedInlineMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: req.telegramUser.id,
        result: buildPhotoResult(specialist, publicBaseUrl(req), `spec_${specialist.id}_${Date.now()}`),
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
}));

module.exports = router;
