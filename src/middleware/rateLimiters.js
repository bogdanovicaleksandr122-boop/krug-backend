const rateLimit = require('express-rate-limit');

// Общий лимит на все запросы к API — базовая защита от простого заваливания
// запросами с одного адреса (не спасёт от крупной распределённой атаки,
// но останавливает подавляющее большинство простых скриптов и ботов).
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 120, // 120 запросов в минуту с одного IP — с запасом для обычного использования
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже' },
});

// Жёсткий лимит на вход в админку — защита от подбора пароля
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 5, // 5 попыток за 15 минут с одного IP
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // успешные входы не расходуют лимит
  message: { error: 'Слишком много попыток входа, попробуйте позже' },
});

// Лимит на создание новых анкет через публичную форму — против спам-заливки
const createSpecialistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 10, // максимум 10 новых анкет в час с одного IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много заявок подряд, попробуйте позже' },
});

// Лимит на запросы к оплате — против накрутки инвойсов
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов на оплату, попробуйте позже' },
});

// Лимит на обращения в поддержку — против спам-заливки чата поддержки
const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 5, // максимум 5 обращений в час с одного IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много обращений подряд, попробуйте позже' },
});

// Лимит на подготовку карточек "поделиться" — каждая такая заявка рисует картинку
// и обращается к Telegram, поэтому не даём дёргать её бесконечно.
const shareLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже' },
});

// Лимит на сбор статистики (открытия приложения, просмотры, нажатия на контакты) —
// обычному пользователю столько не нужно даже при очень активном листании.
const trackLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже' },
});

module.exports = { trackLimiter, generalLimiter, adminLoginLimiter, createSpecialistLimiter, paymentLimiter, supportLimiter, shareLimiter };
