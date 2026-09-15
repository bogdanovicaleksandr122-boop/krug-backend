const express = require('express');
const prisma = require('../lib/prisma');
const { telegramAuth } = require('../middleware/telegramAuth');

const router = express.Router();
router.use(telegramAuth); // все роуты в этом файле требуют подтверждённой личности из Telegram

// Подтверждение владения анкетой ("это я")
router.post('/specialists/:id/claim', async (req, res) => {
  const specialist = await prisma.specialist.findUnique({ where: { id: Number(req.params.id) } });
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });

  const myUsername = req.telegramUser.username ? `@${req.telegramUser.username}` : null;
  const matchesTelegram = myUsername && specialist.contactsTelegram === myUsername;

  if (matchesTelegram) {
    const updated = await prisma.specialist.update({
      where: { id: specialist.id },
      data: { telegramUserId: String(req.telegramUser.id), verified: true },
    });
    return res.json({ verified: true, specialist: updated });
  }

  // Username не совпал — сообщаем, что нужна ручная проверка модератором
  // (пользователь по инструкции размещает временный код в био Instagram/на сайте)
  res.json({
    verified: false,
    message: 'Автоматическое подтверждение не сработало. Разместите код подтверждения в био Instagram или на сайте — модератор проверит вручную.',
  });
});

// «Мои анкеты»
router.get('/specialists', async (req, res) => {
  const specialists = await prisma.specialist.findMany({
    where: { telegramUserId: String(req.telegramUser.id) },
  });
  res.json(specialists);
});

// Избранное
router.post('/specialists/:id/favorite', async (req, res) => {
  await prisma.favorite.upsert({
    where: {
      telegramUserId_specialistId: {
        telegramUserId: String(req.telegramUser.id),
        specialistId: Number(req.params.id),
      },
    },
    update: {},
    create: {
      telegramUserId: String(req.telegramUser.id),
      specialistId: Number(req.params.id),
    },
  });
  res.status(204).end();
});

router.delete('/specialists/:id/favorite', async (req, res) => {
  await prisma.favorite.deleteMany({
    where: {
      telegramUserId: String(req.telegramUser.id),
      specialistId: Number(req.params.id),
    },
  });
  res.status(204).end();
});

router.get('/favorites', async (req, res) => {
  const favorites = await prisma.favorite.findMany({
    where: { telegramUserId: String(req.telegramUser.id) },
    include: { specialist: true },
  });
  res.json(favorites.map((f) => f.specialist));
});

module.exports = router;
