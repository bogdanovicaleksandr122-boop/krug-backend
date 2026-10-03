const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { createSpecialistLimiter } = require('../middleware/rateLimiters');
const { streamTelegramFile } = require('../lib/telegramFiles');
const { telegramAuth, optionalTelegramUser } = require('../middleware/telegramAuth');
const { getPrices } = require('../lib/prices');
const { asyncRoute } = require('../lib/asyncRoute');
const { searchSpecialists } = require('../lib/search');
const {
  PUBLIC_SELECT, toPublic, sortForDisplay, cleanListingInput, hasAnyContact,
  cityWhere, subcategoryWhere, telegramHandle, instagramHandle, phoneKey, websiteHost,
} = require('../lib/specialistData');

const router = express.Router();

// Больше этого одним списком не отдаём — защита от слишком тяжёлых ответов
const LIST_LIMIT = 300;

// Список всех категорий с подкатегориями — для верхней ленты категорий.
// Меняется только когда админ вручную правит структуру каталога (очень редко),
// поэтому можно спокойно кэшировать на 10 минут — заметно меньше трафика на
// каждое открытие приложения без риска долго показывать устаревший список.
router.get('/categories', asyncRoute(async (req, res) => {
  const categories = await prisma.category.findMany({
    orderBy: { sortOrder: 'asc' },
    include: { subcategories: { orderBy: { sortOrder: 'asc' } } },
  });
  res.set('Cache-Control', 'public, max-age=600');
  res.json(categories);
}));

// Список городов — та же логика, что и у категорий.
router.get('/cities', asyncRoute(async (req, res) => {
  const cities = await prisma.city.findMany({ orderBy: { sortOrder: 'asc' } });
  res.set('Cache-Control', 'public, max-age=600');
  res.json(cities);
}));

// Текущие цены PRO/буста — публичный роут, чтобы приложение показывало актуальные
// цифры на кнопках оплаты (сами цены редактируются в админке, см. lib/prices.js).
router.get('/prices', asyncRoute(async (req, res) => {
  res.json(await getPrices());
}));

// Публичный список специалистов — только опубликованные и только публичные поля.
// Варианты: ?ids=1,2,3 (конкретные анкеты, например "вы недавно смотрели"),
// ?search=текст (поиск, можно с cityId), ?subcategoryId=...&cityId=... (раздел каталога).
router.get('/specialists', optionalTelegramUser, asyncRoute(async (req, res) => {
  const { subcategoryId, categoryId, cityId } = req.query;
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';

  if (typeof req.query.ids === 'string') {
    const ids = req.query.ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30);
    const found = ids.length
      ? await prisma.specialist.findMany({ where: { id: { in: ids }, status: 'published' }, select: PUBLIC_SELECT })
      : [];
    const byId = new Map(found.map((s) => [s.id, s]));
    return res.json(ids.map((id) => byId.get(id)).filter(Boolean).map(toPublic));
  }

  let specialists;
  if (search) {
    specialists = await searchSpecialists({ query: search, cityId, take: LIST_LIMIT, select: PUBLIC_SELECT });
  } else {
    const and = [];
    if (subcategoryId) and.push(subcategoryWhere(subcategoryId));
    if (categoryId) and.push({ categoryId: String(categoryId) });
    if (cityId) and.push(await cityWhere(cityId));
    specialists = await prisma.specialist.findMany({
      where: { status: 'published', AND: and },
      select: PUBLIC_SELECT,
      take: LIST_LIMIT,
    });
  }

  res.json(sortForDisplay(specialists).map(toPublic));

  // Статистика для админки: что ищут и какие разделы открывают. Пишем только для
  // настоящих пользователей Telegram и уже после ответа — поиск от этого не медленнее.
  if (req.telegramUser && (search || subcategoryId)) {
    prisma.searchLog.create({
      data: {
        telegramUserId: String(req.telegramUser.id),
        kind: search ? 'text' : 'subcategory',
        query: search || null,
        subcategoryId: subcategoryId ? String(subcategoryId) : null,
        cityId: cityId ? String(cityId) : null,
        resultsCount: specialists.length,
      },
    }).catch((e) => console.error('Не удалось записать статистику поиска', e));
  }
}));

// Подборки для главного экрана: "Новые в вашем городе" и "Популярное" (больше всего
// просмотров за последние 30 дней). Только публичные поля, одинаково для всех.
router.get('/home', asyncRoute(async (req, res) => {
  const location = req.query.cityId ? await cityWhere(req.query.cityId) : {};
  const fresh = await prisma.specialist.findMany({
    where: { status: 'published', ...location },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: PUBLIC_SELECT,
  });
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const top = await prisma.specialistEvent.groupBy({
    by: ['specialistId'],
    where: { type: 'view', createdAt: { gte: since }, specialist: { is: { status: 'published', ...location } } },
    _count: { specialistId: true },
    orderBy: { _count: { specialistId: 'desc' } },
    take: 10,
  });
  const popularRows = top.length
    ? await prisma.specialist.findMany({ where: { id: { in: top.map((t) => t.specialistId) } }, select: PUBLIC_SELECT })
    : [];
  const byId = new Map(popularRows.map((s) => [s.id, s]));
  const popular = top.map((t) => byId.get(t.specialistId)).filter(Boolean);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ fresh: fresh.map(toPublic), popular: popular.map(toPublic) });
}));

// Проверка повторов перед подачей анкеты: есть ли уже в каталоге опубликованная
// анкета с таким же Telegram, Instagram, телефоном или сайтом.
router.post('/specialists/check-duplicates', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const tg = telegramHandle(b.contactsTelegram);
  const ig = instagramHandle(b.contactsInstagram);
  const phone = phoneKey(b.contactsPhone);
  const site = websiteHost(b.contactsWebsite);

  const or = [];
  if (tg) or.push({ contactsTelegram: { contains: tg, mode: 'insensitive' } });
  if (ig) or.push({ contactsInstagram: { contains: ig, mode: 'insensitive' } });
  if (site) or.push({ contactsWebsite: { contains: site, mode: 'insensitive' } });
  if (phone) {
    const rows = await prisma.$queryRaw(Prisma.sql`
      SELECT id FROM "Specialist"
      WHERE status = 'published' AND "contactsPhone" IS NOT NULL
        AND right(regexp_replace("contactsPhone", '\\D', '', 'g'), 9) = ${phone}
      LIMIT 20`);
    if (rows.length) or.push({ id: { in: rows.map((r) => r.id) } });
  }
  if (!or.length) return res.json([]);

  const candidates = await prisma.specialist.findMany({
    where: { status: 'published', OR: or },
    select: PUBLIC_SELECT,
    take: 30,
  });
  // "contains" нашёл похожие — оставляем только точные совпадения
  const matches = candidates.filter((s) => (tg && telegramHandle(s.contactsTelegram) === tg)
    || (ig && instagramHandle(s.contactsInstagram) === ig)
    || (phone && phoneKey(s.contactsPhone) === phone)
    || (site && websiteHost(s.contactsWebsite) === site));
  res.json(matches.slice(0, 5).map(toPublic));
}));

// Карточка одного специалиста
router.get('/specialists/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = Number.isInteger(id) && id > 0
    ? await prisma.specialist.findFirst({ where: { id, status: 'published' }, select: PUBLIC_SELECT })
    : null;
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });
  res.json(toPublic(specialist));
}));

// Новая заявка от пользователя (мастер добавления в приложении) — уходит на модерацию.
// createSpecialistLimiter не даёт заваливать каталог спамом: не больше 10 заявок в час
// от одного человека. id заявителя берётся из проверенной подписи Telegram.
router.post('/specialists', createSpecialistLimiter, telegramAuth, asyncRoute(async (req, res) => {
  let data;
  try {
    data = await cleanListingInput(req.body);
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ error: e.message });
    throw e;
  }
  if (!hasAnyContact(data)) return res.status(400).json({ error: 'Укажите хотя бы один способ связи' });
  delete data.extraSubcategories; // дополнительные подкатегории — только для PRO, через правку

  const specialist = await prisma.specialist.create({
    data: { ...data, telegramUserId: String(req.telegramUser.id), status: 'pending' },
    select: PUBLIC_SELECT,
  });
  res.status(201).json(toPublic(specialist));
}));

// Фото специалиста — проксируем через себя (напрямую отдавать ссылку Telegram нельзя,
// в ней зашит токен бота). Отдаём только для уже опубликованных анкет.
router.get('/specialists/:id/photo', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = Number.isInteger(id) && id > 0 ? await prisma.specialist.findUnique({ where: { id } }) : null;
  if (!specialist || !specialist.photoFileId || specialist.status !== 'published') {
    return res.status(404).json({ error: 'Фото не найдено' });
  }
  // Фронт грузит эти фото с другого домена (github.io) через <img> — по умолчанию
  // helmet ставит Cross-Origin-Resource-Policy: same-origin на все ответы, и без
  // этой точечной поправки браузер молча блокирует именно междоменную загрузку фото.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  await streamTelegramFile(specialist.photoFileId, res);
}));

module.exports = router;
