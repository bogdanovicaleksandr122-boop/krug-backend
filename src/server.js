require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const prisma = require('./lib/prisma');
const { generalLimiter, imageLimiter } = require('./middleware/rateLimiters');

const publicRoutes = require('./routes/public');
const meRoutes = require('./routes/me');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payments');
const shareRoutes = require('./routes/share');
const trackRoutes = require('./routes/track');
const { ensureFonts } = require('./lib/shareCard');
const { ensureInlineUpdates } = require('./lib/inlineSearch');
const { startBackupSchedule } = require('./lib/backup');
const { startNotificationSchedule } = require('./lib/notifications');
const { Prisma } = require('@prisma/client');

const app = express();

// Railway ставит своё прокси перед приложением. Без этой строки все запросы
// будут выглядеть так, будто идут с одного и того же адреса (адреса прокси),
// и лимит запросов ниже перестанет иметь смысл.
app.set('trust proxy', 1);

// Базовые защитные заголовки (не даём браузеру угадывать тип контента,
// запрещаем встраивать сайт в чужие фреймы и т.п.) — стандартная практика.
// CORP оставляем в дефолтном "same-origin" здесь — ослабляем его точечно только
// на двух роутах с фото (в public.js и admin.js), а не для всего API: там это
// действительно нужно (фронт на github.io грузит фото с другого домена), а
// остальным ответам чужой источник для встраивания не нужен.
app.use(helmet());

// Ограничиваем, каким сайтам разрешено обращаться к API напрямую из браузера.
// Впишите в Railway переменную окружения ALLOWED_ORIGINS, например:
//   ALLOWED_ORIGINS=https://ваш-логин.github.io
// Можно перечислить несколько адресов через запятую.
// Пока переменная не задана, API временно принимает запросы с любого сайта —
// чтобы ничего не сломать прямо сейчас, но это стоит поправить.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn('ALLOWED_ORIGINS не задан — API принимает запросы с любого сайта. Задайте переменную в Railway.');
}
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : undefined));

// Ограничиваем размер тела запроса — защита от заваливания сервера огромными запросами
app.use(express.json({ limit: '200kb' }));

// Общий лимит запросов на весь API
app.use('/api', generalLimiter);
app.use('/api', imageLimiter);

app.use('/api', publicRoutes);
app.use('/api/me', meRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', paymentRoutes);
app.use('/api', shareRoutes);
app.use('/api', trackRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// Раз в час снимаем истёкшие PRO/Буст статусы, чтобы они не висели вечно
// PRO-подписку Telegram продлевает сам, но уведомление об оплате может прийти чуть
// позже срока — поэтому подписке даём сутки запаса, чтобы PRO не мигал.
async function expireStatuses() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await prisma.specialist.updateMany({ where: { pro: true, proRecurring: false, proExpiresAt: { lt: now } }, data: { pro: false } });
  await prisma.specialist.updateMany({ where: { pro: true, proRecurring: true, proExpiresAt: { lt: dayAgo } }, data: { pro: false, proRecurring: false } });
  await prisma.specialist.updateMany({ where: { boosted: true, boostedUntil: { lt: now } }, data: { boosted: false } });
}
// Если база на секунду недоступна — просто пишем в лог и пробуем через час,
// а не роняем весь сервер.
setInterval(() => {
  expireStatuses().catch((e) => console.error('Не удалось снять истёкшие PRO/Буст статусы', e));
}, 60 * 60 * 1000);

// Раньше правка опубликованной анкеты прятала её из каталога до проверки. Теперь
// анкета на время проверки правки остаётся в каталоге — возвращаем в каталог те,
// что были спрятаны по-старому (уже одобрялись раньше и ждут проверки правки).
async function restoreHiddenEdits() {
  const result = await prisma.specialist.updateMany({
    where: {
      status: 'pending',
      NOT: { pendingChanges: { equals: Prisma.AnyNull } },
      moderationLogs: { some: { action: { in: ['approve', 'admin-edit'] } } },
    },
    data: { status: 'published' },
  });
  if (result.count) console.log(`Возвращено в каталог анкет с правками на проверке: ${result.count}`);
}

// Подробные записи статистики (открытия, просмотры, поиски) храним 13 месяцев —
// этого хватает, чтобы сравнивать год к году, а база не растёт бесконечно.
// Сводные цифры (сколько пользователей, откуда пришли) от этого не меняются.
const STATS_KEEP_DAYS = 400;
async function cleanupOldStats() {
  const before = new Date(Date.now() - STATS_KEEP_DAYS * 24 * 60 * 60 * 1000);
  await prisma.appOpen.deleteMany({ where: { createdAt: { lt: before } } });
  await prisma.specialistEvent.deleteMany({ where: { createdAt: { lt: before } } });
  await prisma.searchLog.deleteMany({ where: { createdAt: { lt: before } } });
}
setInterval(() => {
  cleanupOldStats().catch((e) => console.error('Не удалось очистить старую статистику', e));
}, 24 * 60 * 60 * 1000);

// Всё, что не подошло ни под один роут
app.use((req, res) => res.status(404).json({ error: 'Не найдено' }));

// Общий обработчик ошибок — не даём деталям внутренней ошибки (например, текст SQL-запроса)
// утечь наружу в ответе; полный текст ошибки всё равно попадает в логи Railway.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`КРУГ backend запущен на порту ${port}`);
  // Заранее скачиваем шрифты для карточек "поделиться", чтобы первый пользователь
  // не ждал. Если не вышло — не страшно, попробуем снова при первом запросе.
  ensureFonts()
    .then(() => console.log('Шрифты для карточек загружены'))
    .catch((err) => console.error('Шрифты для карточек не загрузились:', err.message));
  ensureInlineUpdates().catch((err) => console.error('Не удалось проверить вебхук:', err.message));
  // Ежедневная копия базы владельцу в Telegram (см. lib/backup.js)
  startBackupSchedule();
  // Напоминания о конце PRO/буста и недельные сводки специалистам
  startNotificationSchedule();
  restoreHiddenEdits().catch((e) => console.error('Не удалось вернуть анкеты с правками в каталог', e));
});
