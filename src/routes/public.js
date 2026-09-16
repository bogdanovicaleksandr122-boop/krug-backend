const express = require('express');
const prisma = require('../lib/prisma');
const { createSpecialistLimiter } = require('../middleware/rateLimiters');
const { streamTelegramFile } = require('../lib/telegramFiles');
const { telegramAuth } = require('../middleware/telegramAuth');
const { toPublicId } = require('../lib/publicId');

const router = express.Router();

// Добавляет публичный номер анкеты (см. lib/publicId.js) в объект перед отправкой клиенту.
function withPublicId(specialist) {
  return { ...specialist, publicId: toPublicId(specialist.id) };
}

// Список всех категорий с подкатегориями — для верхней ленты категорий
router.get('/categories', async (req, res) => {
  const categories = await prisma.category.findMany({
    orderBy: { sortOrder: 'asc' },
    include: { subcategories: { orderBy: { sortOrder: 'asc' } } },
  });
  res.json(categories);
});

// Список городов
router.get('/cities', async (req, res) => {
  const cities = await prisma.city.findMany({ orderBy: { sortOrder: 'asc' } });
  res.json(cities);
});

// Публичный список специалистов — только опубликованные, с фильтрами
router.get('/specialists', async (req, res) => {
  const { subcategoryId, categoryId, cityId, search } = req.query;

  const where = {
    status: 'published',
    ...(subcategoryId && { subcategoryId }),
    ...(categoryId && { categoryId }),
    ...(cityId && { cityId }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { role: { contains: search, mode: 'insensitive' } },
        { about: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  const specialists = await prisma.specialist.findMany({ where });

  // Честная сортировка: boosted (перемешаны случайно) → pro → остальные
  const boosted = specialists.filter((s) => s.boosted);
  const pro = specialists.filter((s) => !s.boosted && s.pro);
  const rest = specialists.filter((s) => !s.boosted && !s.pro);
  for (let i = boosted.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [boosted[i], boosted[j]] = [boosted[j], boosted[i]];
  }

  res.json([...boosted, ...pro, ...rest].map(withPublicId));
});

// Карточка одного специалиста
router.get('/specialists/:id', async (req, res) => {
  const specialist = await prisma.specialist.findUnique({
    where: { id: Number(req.params.id) },
    include: { category: true, subcategory: true, city: true },
  });
  if (!specialist || specialist.status !== 'published') {
    return res.status(404).json({ error: 'Анкета не найдена' });
  }
  res.json(withPublicId(specialist));
});

// Новая заявка от пользователя (мастер добавления из прототипа) — уходит на модерацию.
// createSpecialistLimiter не даёт заваливать каталог спамом: не больше 10 заявок в час с одного адреса.
// telegramAuth теперь обязателен: раньше telegramUserId принимался прямо из тела запроса
// (клиент мог прислать любое значение или вообще ничего — на практике фронт его никогда
// не отправлял, поэтому у анкет никогда не было известно, кто их подал). Теперь id
// заявителя всегда берётся из проверенной подписи initData, подделать нельзя.
router.post('/specialists', createSpecialistLimiter, telegramAuth, async (req, res) => {
  const {
    name, langs, role, about, services,
    contactsTelegram, contactsInstagram, contactsPhone, contactsWebsite,
    locationAddress, cityId, categoryId, subcategoryId,
  } = req.body;

  if (!name || !role || !categoryId || !subcategoryId) {
    return res.status(400).json({ error: 'Не хватает обязательных полей' });
  }

  const specialist = await prisma.specialist.create({
    data: {
      name, langs, role, about, services,
      contactsTelegram, contactsInstagram, contactsPhone, contactsWebsite,
      locationAddress, cityId, categoryId, subcategoryId,
      telegramUserId: String(req.telegramUser.id),
      status: 'pending',
    },
  });

  res.status(201).json(withPublicId(specialist));
});

// Фото специалиста — проксируем через себя (напрямую отдавать ссылку Telegram нельзя,
// в ней зашит токен бота). Отдаём только для уже опубликованных анкет.
router.get('/specialists/:id/photo', async (req, res) => {
  const specialist = await prisma.specialist.findUnique({ where: { id: Number(req.params.id) } });
  if (!specialist || !specialist.photoFileId || specialist.status !== 'published') {
    return res.status(404).json({ error: 'Фото не найдено' });
  }
  // Фронт грузит эти фото с другого домена (github.io) через <img> — по умолчанию
  // helmet ставит Cross-Origin-Resource-Policy: same-origin на все ответы, и без
  // этой точечной поправки браузер молча блокирует именно междоменную загрузку фото.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  await streamTelegramFile(specialist.photoFileId, res);
});

module.exports = router;
