const express = require('express');
const prisma = require('../lib/prisma');
const { telegramAuth } = require('../middleware/telegramAuth');
const { uploadPhotoToTelegram } = require('../lib/telegramFiles');
const { supportLimiter } = require('../middleware/rateLimiters');
const { specialistStats } = require('../lib/analytics');
const { asyncRoute } = require('../lib/asyncRoute');

const router = express.Router();
router.use(telegramAuth); // все роуты в этом файле требуют подтверждённой личности из Telegram

function ensureOwnership(specialist, telegramUser) {
  return !!specialist && specialist.telegramUserId === String(telegramUser.id);
}

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

// Статистика своей анкеты — только для подтверждённого владельца. Показываем
// лишь количество (просмотры, нажатия на контакты), кто именно смотрел — не видно.
router.get('/specialists/:id/stats', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const specialist = Number.isInteger(id) && id > 0 ? await prisma.specialist.findUnique({ where: { id } }) : null;
  if (!ensureOwnership(specialist, req.telegramUser) || !specialist.verified) {
    return res.status(403).json({ error: 'Статистика доступна только подтверждённому владельцу анкеты' });
  }
  res.json(await specialistStats(specialist.id, 30));
}));

const OWNER_EDITABLE_FIELDS = [
  'name', 'langs', 'about', 'services',
  'contactsTelegram', 'contactsInstagram', 'contactsPhone', 'contactsWebsite',
  'locationAddress', 'cityId',
];

// Владелец редактирует свою анкету. Правки не применяются сразу — они складываются
// в pendingChanges и уходят на проверку модератору (статус анкеты становится pending,
// поэтому на время проверки она пропадает из общего каталога). Живые данные не трогаем,
// чтобы при отклонении правок можно было просто откатиться к тому, что было.
router.put('/specialists/:id', async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!ensureOwnership(specialist, req.telegramUser)) {
    return res.status(403).json({ error: 'Редактировать может только подтверждённый владелец анкеты' });
  }
  const changes = {};
  OWNER_EDITABLE_FIELDS.forEach((key) => {
    if (key in req.body) changes[key] = req.body[key];
  });
  if (!Object.keys(changes).length) {
    return res.status(400).json({ error: 'Нет изменений для сохранения' });
  }
  const pendingChanges = { ...(specialist.pendingChanges || {}), ...changes };
  const updated = await prisma.specialist.update({
    where: { id },
    data: { pendingChanges, status: 'pending' },
  });
  res.json({ ok: true, specialist: updated });
});

// Владелец удаляет свою анкету — сразу, без подтверждения модератором
router.delete('/specialists/:id', async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!ensureOwnership(specialist, req.telegramUser)) {
    return res.status(403).json({ error: 'Удалить может только подтверждённый владелец анкеты' });
  }
  await prisma.specialist.delete({ where: { id } });
  res.status(204).end();
});

// Владелец загружает фото. Тоже уходит на проверку вместе с остальными правками —
// сама загрузка в Telegram происходит сразу, но анкета покажет новое фото публично
// только после одобрения администратором.
router.post('/specialists/:id/photo', express.raw({ type: 'image/*', limit: '8mb' }), async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!ensureOwnership(specialist, req.telegramUser)) {
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
    const pendingChanges = { ...(specialist.pendingChanges || {}), photoFileId: fileId };
    const updated = await prisma.specialist.update({
      where: { id },
      data: { pendingChanges, status: 'pending' },
    });
    res.json({ ok: true, specialist: updated });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось загрузить фото в Telegram: ' + e.message });
  }
});

// Пользователь прочитал уведомление об отклонённой правке — прячем его из кабинета.
// Саму анкету не трогаем (она уже опубликована как была).
router.post('/specialists/:id/dismiss-edit-rejection', async (req, res) => {
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

// Обращение в поддержку из раздела "Поддержка". Пересылаем сообщение владельцу
// приложения в Telegram — отдельного интерфейса для тикетов пока нет, а личный
// чат владельца (тот же SUPPORT_CHAT_ID / TELEGRAM_FILE_RELAY_CHAT_ID, что уже
// используется для загрузки фото без владельца) для старта вполне достаточен.
router.post('/support', supportLimiter, async (req, res) => {
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
});

module.exports = router;
