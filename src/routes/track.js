// Сбор статистики из мини-приложения: открытия приложения (в том числе по рекламным
// ссылкам) и действия с анкетами (просмотр, нажатие на контакт, "поделиться").
// Всё — только от настоящих пользователей Telegram (проверенная подпись initData),
// чтобы цифры нельзя было накрутить простым скриптом без аккаунта.
const express = require('express');
const { asyncRoute } = require('../lib/asyncRoute');
const prisma = require('../lib/prisma');
const { telegramAuth } = require('../middleware/telegramAuth');
const { trackLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

const EVENT_TYPES = ['view', 'contact', 'share'];
const CONTACT_TYPES = ['telegram', 'phone', 'instagram', 'website', 'map'];
const VIEW_SOURCES = ['catalog', 'search', 'favorites', 'share', 'ref', 'cabinet', 'other'];

// Повторное действие того же человека с той же анкетой в течение этого времени
// не считается ещё раз — иначе один человек, листающий туда-сюда, давал бы десятки
// "просмотров", и владелец анкеты видел бы завышенные цифры.
const REPEAT_WINDOW_MS = {
  view: 30 * 60 * 1000,
  contact: 30 * 60 * 1000,
  share: 10 * 60 * 1000,
};

// Может ли пользователь Telegram ещё считаться "только что пришедшим": запрос
// "приложение открыто" обычно первый, но на всякий случай даём запас, если
// какой-то другой запрос успел создать запись о пользователе чуть раньше.
const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

// Приложение сообщает, что его открыли. Откуда пришёл человек, берём из
// подписанного Telegram параметра запуска (startapp=...), а не из тела запроса.
router.post('/track/open', trackLimiter, telegramAuth, asyncRoute(async (req, res) => {
  const userId = String(req.telegramUser.id);
  const startParam = req.telegramStartParam || '';
  const platform = /^[a-z_]{1,20}$/.test(String(req.body?.platform || '')) ? req.body.platform : null;

  let source = 'direct';
  let referralLink = null;
  let specialistId = null;

  if (startParam.startsWith('r_')) {
    referralLink = await prisma.referralLink.findUnique({ where: { code: startParam.slice(2) } });
    if (referralLink) source = 'ref';
  } else if (startParam.startsWith('spec_')) {
    const id = Number(startParam.slice(5));
    if (Number.isInteger(id) && id > 0) {
      source = 'share';
      specialistId = id;
    }
  }

  // Запоминаем, откуда человек пришёл впервые. Условие firstSource = null делает это
  // ровно один раз: повторные открытия (даже по другой рекламе) источник не меняют.
  const attributed = await prisma.telegramUser.updateMany({
    where: { id: userId, firstSource: null, firstSeenAt: { gte: new Date(Date.now() - NEW_USER_WINDOW_MS) } },
    data: { firstSource: source, referralLinkId: referralLink ? referralLink.id : null },
  });
  const isNewUser = req.isNewTelegramUser || attributed.count > 0;

  try {
    await prisma.appOpen.create({
      data: {
        telegramUserId: userId,
        source,
        referralLinkId: referralLink ? referralLink.id : null,
        specialistId,
        isNewUser,
        platform,
        authDate: req.telegramAuthDate,
      },
    });
  } catch (e) {
    // P2002 — этот запуск уже записан (страницу перезагрузили) — это не ошибка.
    if (e.code !== 'P2002') throw e;
  }

  // Рекламная ссылка может вести сразу на конкретную анкету
  let openSpecialistId = null;
  if (referralLink && referralLink.targetSpecialistId) {
    const target = await prisma.specialist.findUnique({
      where: { id: referralLink.targetSpecialistId },
      select: { id: true, status: true },
    });
    if (target && target.status === 'published') openSpecialistId = target.id;
  }

  res.json({ ok: true, openSpecialistId });
}));

// Действие с анкетой: просмотр, нажатие на контакт, "поделиться".
router.post('/track/event', trackLimiter, telegramAuth, asyncRoute(async (req, res) => {
  const { type } = req.body || {};
  const specialistId = Number(req.body?.specialistId);
  if (!EVENT_TYPES.includes(type) || !Number.isInteger(specialistId) || specialistId <= 0) {
    return res.status(400).json({ error: 'Некорректное событие' });
  }
  const detail = type === 'contact' ? req.body.detail : null;
  if (type === 'contact' && !CONTACT_TYPES.includes(detail)) {
    return res.status(400).json({ error: 'Некорректный тип контакта' });
  }
  const source = type === 'view' && VIEW_SOURCES.includes(req.body.source) ? req.body.source : null;

  const userId = String(req.telegramUser.id);
  const specialist = await prisma.specialist.findUnique({
    where: { id: specialistId },
    select: { status: true, telegramUserId: true },
  });
  // Считаем только опубликованные анкеты и не считаем, когда владелец смотрит сам себя
  if (!specialist || specialist.status !== 'published' || specialist.telegramUserId === userId) {
    return res.json({ ok: true, counted: false });
  }

  const recent = await prisma.specialistEvent.findFirst({
    where: {
      specialistId,
      telegramUserId: userId,
      type,
      ...(detail && { detail }),
      createdAt: { gte: new Date(Date.now() - REPEAT_WINDOW_MS[type]) },
    },
    select: { id: true },
  });
  if (recent) return res.json({ ok: true, counted: false });

  await prisma.specialistEvent.create({
    data: { specialistId, telegramUserId: userId, type, detail, source },
  });
  res.json({ ok: true, counted: true });
}));

module.exports = router;
