const express = require('express');
const prisma = require('../lib/prisma');
const { telegramAuth } = require('../middleware/telegramAuth');
const { uploadPhotoToTelegram } = require('../lib/telegramFiles');
const { supportLimiter } = require('../middleware/rateLimiters');
const { specialistStats } = require('../lib/analytics');
const { asyncRoute } = require('../lib/asyncRoute');
const { sendTelegramMessage } = require('../lib/telegramSend');
const { toPublicId } = require('../lib/publicId');
const {
  PUBLIC_SELECT, toPublic, cleanListingInput, hasAnyContact, telegramHandle,
} = require('../lib/specialistData');
const { cancelProSubscription } = require('../lib/subscriptions');

// Сколько длится бесплатный пробный буст (один раз на анкету)
const TRIAL_BOOST_DAYS = 3;

const router = express.Router();
router.use(telegramAuth); // все роуты в этом файле требуют подтверждённой личности из Telegram

function ensureOwnership(specialist, telegramUser) {
  return !!specialist && specialist.telegramUserId === String(telegramUser.id);
}

// Управлять анкетой (редактировать, удалять, менять фото) может только тот, кто
// подтвердил, что это его анкета. Человек, который просто добавил в каталог чужую
// анкету, видит её у себя в кабинете, но менять её не может.
function ensureVerifiedOwner(specialist, telegramUser) {
  return ensureOwnership(specialist, telegramUser) && specialist.verified;
}

// Подтверждение владения анкетой ("это я")
router.post('/specialists/:id/claim', asyncRoute(async (req, res) => {
  const specialist = await prisma.specialist.findUnique({ where: { id: Number(req.params.id) } });
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });

  // Сравниваем без учёта больших букв и формы записи: "@Name", "name",
  // "t.me/name" в анкете — это всё тот же аккаунт.
  const myUsername = req.telegramUser.username ? req.telegramUser.username.toLowerCase() : null;
  const matchesTelegram = !!myUsername && telegramHandle(specialist.contactsTelegram) === myUsername;

  if (matchesTelegram) {
    const updated = await prisma.specialist.update({
      where: { id: specialist.id },
      data: { telegramUserId: String(req.telegramUser.id), verified: true },
    });
    return res.json({ verified: true, specialist: ownView(updated) });
  }

  // Username не совпал — сообщаем, что нужна ручная проверка модератором
  // (пользователь по инструкции размещает временный код в био Instagram/на сайте)
  res.json({
    verified: false,
    message: 'Автоматическое подтверждение не сработало. Разместите код подтверждения в био Instagram или на сайте — модератор проверит вручную.',
  });
}));

// Ручная проверка владения — для анкет без Telegram в контактах (или если Telegram
// в анкете не совпал). Человек размещает код в Instagram/на сайте, а мы пересылаем
// заявку владельцу приложения: он сверяет код и назначает владельца в админке.
router.post('/specialists/:id/claim-request', supportLimiter, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const code = String((req.body && req.body.code) || '');
  if (!/^KRUG-\d{4}$/.test(code) || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Некорректная заявка' });
  }
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });
  const chatId = process.env.SUPPORT_CHAT_ID || process.env.TELEGRAM_FILE_RELAY_CHAT_ID;
  if (!chatId) {
    return res.status(500).json({ error: 'Проверка временно недоступна — не задан адрес получателя на сервере' });
  }
  const u = req.telegramUser;
  const where = [
    specialist.contactsInstagram && `Instagram: ${specialist.contactsInstagram}`,
    specialist.contactsWebsite && `Сайт: ${specialist.contactsWebsite}`,
    specialist.contactsTelegram && `Telegram в анкете: ${specialist.contactsTelegram}`,
  ].filter(Boolean);
  const text = [
    '🪪 Заявка на подтверждение анкеты',
    `Анкета: «${specialist.name}» — № ${toPublicId(specialist.id)}`,
    `От: ${u.username ? '@' + u.username : 'без username'} (${[u.first_name, u.last_name].filter(Boolean).join(' ') || 'без имени'})`,
    `Telegram ID заявителя: ${u.id}`,
    `Код: ${code}`,
    '',
    'Где проверить код:',
    ...(where.length ? where : ['— контактов для проверки в анкете нет']),
    '',
    specialist.verified
      ? '⚠️ У анкеты уже есть подтверждённый владелец — будьте внимательны.'
      : 'Если код на месте — откройте анкету в админке и впишите Telegram ID заявителя в поле «Telegram ID владельца».',
  ].join('\n');
  const result = await sendTelegramMessage(chatId, text);
  if (!result.ok) return res.status(502).json({ error: 'Не удалось отправить заявку, попробуйте позже' });
  res.status(201).json({ ok: true });
}));

// Как анкета выглядит для её владельца в кабинете: всё, что видно всем, плюс
// статус проверки, правки на проверке и доступность пробного буста.
function ownView(s) {
  const pending = s.pendingChanges && typeof s.pendingChanges === 'object' ? s.pendingChanges : null;
  return {
    ...toPublic({ ...s, _count: s._count }),
    status: s.status,
    rejectionReason: s.rejectionReason,
    editRejectionReason: s.editRejectionReason,
    pendingChanges: pending,
    hasPendingChanges: !!pending,
    extraSubcategories: s.extraSubcategories || [],
    proExpiresAt: s.proExpiresAt,
    proRecurring: s.proRecurring,
    boostedUntil: s.boostedUntil,
    trialBoostAvailable: !!s.verified && !s.trialBoostUsedAt,
  };
}

// «Мои анкеты»
router.get('/specialists', asyncRoute(async (req, res) => {
  const specialists = await prisma.specialist.findMany({
    where: { telegramUserId: String(req.telegramUser.id) },
    include: { _count: { select: { recommendations: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(specialists.map(ownView));
}));

// Статистика своей анкеты — только для подтверждённого владельца. Показываем
// лишь количество (просмотры, нажатия на контакты), кто именно смотрел — не видно.
router.get('/specialists/:id/stats', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = Number.isInteger(id) && id > 0 ? await prisma.specialist.findUnique({ where: { id } }) : null;
  if (!ensureVerifiedOwner(specialist, req.telegramUser)) {
    return res.status(403).json({ error: 'Статистика доступна только подтверждённому владельцу анкеты' });
  }
  const stats = await specialistStats(specialist.id, 30);
  // Полная статистика (контакты, откуда смотрят, избранное) — для анкет с активным
  // PRO или бустом. Остальным отдаём только просмотры: лишнее даже не уходит с сервера.
  if (specialist.pro || specialist.boosted) return res.json({ ...stats, limited: false });
  res.json({
    limited: true,
    periodDays: stats.periodDays,
    views: stats.views,
    uniqueViewers: stats.uniqueViewers,
    daily: stats.daily.map((d) => ({ date: d.date, views: d.views })),
  });
}));

// Владелец редактирует свою анкету.
// - Опубликованная анкета: правки складываются в pendingChanges и уходят на проверку,
//   а в каталоге до проверки остаётся прежняя версия (раньше анкета пропадала).
// - Ещё не опубликованная (на проверке или отклонена): правим саму анкету — она
//   и так целиком проходит проверку; отклонённая снова уходит на проверку.
// Так правки в pendingChanges всегда относятся к уже одобренной анкете, и отказ
// в правке просто оставляет анкету как была.
function editData(specialist, changes) {
  if (specialist.status === 'published' || specialist.pendingChanges) {
    return {
      pendingChanges: { ...(specialist.pendingChanges || {}), ...changes },
      status: specialist.status === 'rejected' ? 'pending' : specialist.status,
    };
  }
  return { ...changes, status: 'pending', rejectionReason: null };
}

router.put('/specialists/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = Number.isInteger(id) && id > 0 ? await prisma.specialist.findUnique({ where: { id } }) : null;
  if (!ensureVerifiedOwner(specialist, req.telegramUser)) {
    return res.status(403).json({ error: 'Редактировать может только подтверждённый владелец анкеты' });
  }
  let changes;
  try {
    changes = await cleanListingInput(req.body, { partial: true });
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ error: e.message });
    throw e;
  }
  if ('extraSubcategories' in changes) {
    if (!specialist.pro) {
      return res.status(403).json({ error: 'Дополнительные подкатегории доступны с PRO' });
    }
    changes.extraSubcategories = changes.extraSubcategories.filter((sid) => sid !== specialist.subcategoryId);
  }
  // Ничего не поменялось по сравнению с тем, что уже есть (или уже ждёт проверки) — не отправляем
  const current = { ...specialist, ...(specialist.pendingChanges || {}) };
  Object.keys(changes).forEach((key) => {
    if (JSON.stringify(current[key] ?? null) === JSON.stringify(changes[key] ?? null)) delete changes[key];
  });
  if (!Object.keys(changes).length) {
    return res.status(400).json({ error: 'Нет изменений для сохранения' });
  }
  if (!hasAnyContact({ ...current, ...changes })) {
    return res.status(400).json({ error: 'Укажите хотя бы один способ связи' });
  }
  const updated = await prisma.specialist.update({
    where: { id },
    data: editData(specialist, changes),
    include: { _count: { select: { recommendations: true } } },
  });
  res.json({ ok: true, specialist: ownView(updated) });
}));

// Владелец удаляет свою анкету — сразу, без подтверждения модератором
router.delete('/specialists/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!ensureVerifiedOwner(specialist, req.telegramUser)) {
    return res.status(403).json({ error: 'Удалить может только подтверждённый владелец анкеты' });
  }
  // Подписка PRO на удалённую анкету не должна продолжать списывать звёзды
  if (specialist.proRecurring) await cancelProSubscription(specialist.id);
  await prisma.specialist.delete({ where: { id } });
  res.status(204).end();
}));

// Владелец загружает фото. Тоже уходит на проверку вместе с остальными правками —
// сама загрузка в Telegram происходит сразу, но анкета покажет новое фото публично
// только после одобрения администратором.
router.post('/specialists/:id/photo', express.raw({ type: 'image/*', limit: '8mb' }), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!ensureVerifiedOwner(specialist, req.telegramUser)) {
    return res.status(403).json({ error: 'Загружать фото может только подтверждённый владелец анкеты' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'Файл не получен' });
  }
  // Фото прогоняется через Telegram только для того, чтобы получить file_id — но
  // отправлять его нужно в служебный чат владельца приложения (TELEGRAM_FILE_RELAY_CHAT_ID),
  // а НЕ обратно в чат пользователя, который его загрузил. Раньше было наоборот: бот
  // отправлял фото прямо в личный чат с самим загрузившим — а значит, загрузив
  // неприемлемый контент, пользователь мог пожаловаться в Telegram на «сообщение от
  // бота» в своём же чате и добиться блокировки всего бота. Теперь до одобрения
  // фото видит только сам владелец приложения в закрытом служебном чате.
  const chatId = process.env.TELEGRAM_FILE_RELAY_CHAT_ID;
  if (!chatId) {
    return res.status(500).json({ error: 'Загрузка фото временно недоступна — не задана переменная TELEGRAM_FILE_RELAY_CHAT_ID на сервере' });
  }
  try {
    const fileId = await uploadPhotoToTelegram(req.body, req.headers['content-type'], chatId);
    const updated = await prisma.specialist.update({
      where: { id },
      data: editData(specialist, { photoFileId: fileId }),
      include: { _count: { select: { recommendations: true } } },
    });
    res.json({ ok: true, specialist: ownView(updated) });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось загрузить фото в Telegram: ' + e.message });
  }
}));

// Фото при подаче новой анкеты. Можно только тому, кто её подал, пока она ещё
// ждёт первой проверки (и не позже суток после подачи). Публично фото появится
// вместе с анкетой — после одобрения модератором.
router.post('/specialists/:id/submission-photo', express.raw({ type: 'image/*', limit: '8mb' }), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = Number.isInteger(id) && id > 0 ? await prisma.specialist.findUnique({ where: { id } }) : null;
  const fresh = specialist && Date.now() - specialist.createdAt.getTime() < 24 * 60 * 60 * 1000;
  if (!ensureOwnership(specialist, req.telegramUser) || specialist.status !== 'pending' || !fresh) {
    return res.status(403).json({ error: 'Фото можно добавить только к своей новой анкете до проверки' });
  }
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Файл не получен' });
  // Фото прогоняется только через служебный чат владельца приложения (см. объяснение выше)
  const chatId = process.env.TELEGRAM_FILE_RELAY_CHAT_ID;
  if (!chatId) {
    return res.status(500).json({ error: 'Загрузка фото временно недоступна — не задана переменная TELEGRAM_FILE_RELAY_CHAT_ID на сервере' });
  }
  try {
    const fileId = await uploadPhotoToTelegram(req.body, req.headers['content-type'], chatId);
    await prisma.specialist.update({ where: { id }, data: { photoFileId: fileId } });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось загрузить фото в Telegram: ' + e.message });
  }
}));

// Бесплатный пробный буст на несколько дней — один раз на анкету, только
// подтверждённому владельцу опубликованной анкеты без активного буста.
router.post('/specialists/:id/trial-boost', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = Number.isInteger(id) && id > 0 ? await prisma.specialist.findUnique({ where: { id } }) : null;
  if (!ensureVerifiedOwner(specialist, req.telegramUser)) {
    return res.status(403).json({ error: 'Доступно только подтверждённому владельцу анкеты' });
  }
  if (specialist.status !== 'published') return res.status(400).json({ error: 'Анкета ещё не опубликована' });
  if (specialist.boosted) return res.status(400).json({ error: 'Буст уже активен' });
  const until = new Date(Date.now() + TRIAL_BOOST_DAYS * 24 * 60 * 60 * 1000);
  // Условие trialBoostUsedAt = null прямо в запросе: два быстрых нажатия не дадут два буста
  const result = await prisma.specialist.updateMany({
    where: { id, trialBoostUsedAt: null },
    data: { boosted: true, boostedUntil: until, trialBoostUsedAt: new Date(), boostReminderFor: null },
  });
  if (!result.count) return res.status(400).json({ error: 'Пробный буст для этой анкеты уже был' });
  res.json({ ok: true, boostedUntil: until, days: TRIAL_BOOST_DAYS });
}));

// «Рекомендую»: один голос от одного аккаунта за анкету. Свою анкету рекомендовать нельзя.
router.post('/specialists/:id/recommend', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const userId = String(req.telegramUser.id);
  const specialist = Number.isInteger(id) && id > 0
    ? await prisma.specialist.findFirst({ where: { id, status: 'published' }, select: { id: true, telegramUserId: true, verified: true } })
    : null;
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });
  if (specialist.verified && specialist.telegramUserId === userId) {
    return res.status(400).json({ error: 'Свою анкету рекомендовать нельзя' });
  }
  await prisma.recommendation.upsert({
    where: { telegramUserId_specialistId: { telegramUserId: userId, specialistId: id } },
    update: {},
    create: { telegramUserId: userId, specialistId: id },
  });
  res.json({ ok: true, count: await prisma.recommendation.count({ where: { specialistId: id } }) });
}));

router.delete('/specialists/:id/recommend', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Анкета не найдена' });
  await prisma.recommendation.deleteMany({ where: { telegramUserId: String(req.telegramUser.id), specialistId: id } });
  res.json({ ok: true, count: await prisma.recommendation.count({ where: { specialistId: id } }) });
}));

// Какие анкеты этот пользователь уже рекомендовал (только номера)
router.get('/recommendations', asyncRoute(async (req, res) => {
  const rows = await prisma.recommendation.findMany({
    where: { telegramUserId: String(req.telegramUser.id) },
    select: { specialistId: true },
  });
  res.json(rows.map((r) => r.specialistId));
}));

// Пользователь прочитал уведомление об отклонённой правке — прячем его из кабинета.
// Саму анкету не трогаем (она уже опубликована как была).
router.post('/specialists/:id/dismiss-edit-rejection', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!ensureOwnership(specialist, req.telegramUser)) {
    return res.status(403).json({ error: 'Доступно только подтверждённому владельцу анкеты' });
  }
  const updated = await prisma.specialist.update({
    where: { id },
    data: { editRejectionReason: null, editRejectedAt: null },
  });
  res.json({ ok: true, specialist: updated });
}));

// Избранное. Добавить можно только опубликованную анкету, а в списке избранного
// показываются только опубликованные и только их публичные поля (раньше через
// избранное можно было прочитать анкету на проверке целиком).
router.post('/specialists/:id/favorite', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const exists = Number.isInteger(id) && id > 0
    ? await prisma.specialist.findFirst({ where: { id, status: 'published' }, select: { id: true } })
    : null;
  if (!exists) return res.status(404).json({ error: 'Анкета не найдена' });
  const userId = String(req.telegramUser.id);
  await prisma.favorite.upsert({
    where: { telegramUserId_specialistId: { telegramUserId: userId, specialistId: id } },
    update: {},
    create: { telegramUserId: userId, specialistId: id },
  });
  res.status(204).end();
}));

router.delete('/specialists/:id/favorite', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(204).end();
  await prisma.favorite.deleteMany({
    where: { telegramUserId: String(req.telegramUser.id), specialistId: id },
  });
  res.status(204).end();
}));

router.get('/favorites', asyncRoute(async (req, res) => {
  const favorites = await prisma.favorite.findMany({
    where: { telegramUserId: String(req.telegramUser.id), specialist: { status: 'published' } },
    include: { specialist: { select: PUBLIC_SELECT } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(favorites.map((f) => toPublic(f.specialist)));
}));

// Обращение в поддержку из раздела "Поддержка". Пересылаем сообщение владельцу
// приложения в Telegram — отдельного интерфейса для тикетов пока нет, а личный
// чат владельца (тот же SUPPORT_CHAT_ID / TELEGRAM_FILE_RELAY_CHAT_ID, что уже
// используется для загрузки фото без владельца) для старта вполне достаточен.
router.post('/support', supportLimiter, asyncRoute(async (req, res) => {
  const { topic, message } = req.body;
  if (!topic || !message || !String(message).trim()) {
    return res.status(400).json({ error: 'Нужны тема и текст обращения' });
  }
  const chatId = process.env.SUPPORT_CHAT_ID || process.env.TELEGRAM_FILE_RELAY_CHAT_ID;
  if (!chatId) {
    return res.status(500).json({ error: 'Поддержка временно недоступна — не задан адрес получателя на сервере' });
  }
  const u = req.telegramUser;
  const from = u.username ? `@${u.username}` : `id ${u.id}`;
  const text = [
    '🆘 Обращение в поддержку КРУГ',
    `Тема: ${topic}`,
    `От: ${from} (${[u.first_name, u.last_name].filter(Boolean).join(' ') || 'без имени'})`,
    '',
    String(message).trim(),
    '',
    'Чтобы ответить — ответьте на это сообщение реплаем, ответ придёт пользователю в бот.',
  ].join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.description || 'Telegram отклонил сообщение');

    // Запоминаем, какое сообщение в служебном чате отвечает какому пользователю —
    // без этого при реплае админа бэкенд не знает, кому пересылать ответ.
    await prisma.supportMessage.create({
      data: {
        relayChatId: String(chatId),
        relayMessageId: data.result.message_id,
        telegramUserId: String(u.id),
      },
    });

    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось отправить обращение: ' + e.message });
  }
}));

module.exports = router;
