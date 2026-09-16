const crypto = require('crypto');
const prisma = require('../lib/prisma');

// Сколько времени доверяем initData после её выдачи Telegram. Сама подпись (hash)
// никогда не истекает сама по себе — без этой проверки один раз перехваченная
// (например, случайно попавшая в лог, реферер или скриншот) строка initData
// оставалась бы валидной вечно и позволяла бы выдавать себя за пользователя
// сколь угодно долго. Telegram обновляет initData при каждом открытии мини-приложения,
// поэтому окно в 24 часа — стандартная практика, а не искусственное ограничение.
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

// Проверяет, что initData действительно прислана Telegram и не подделана.
// Алгоритм — стандартный, описан в документации Telegram WebApp.
function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // timingSafeEqual вместо === — сравнение строкой уязвимо к атаке по времени
  // отклика (чем раньше не совпал символ, тем быстрее ответ). Для HMAC такую атаку
  // трудно провести практически, но это ничего не стоящая, стандартная защита.
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_SECONDS) return false;

  return true;
}

// Middleware для роутов, которые должны знать, кто именно пишет из Telegram.
async function telegramAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) {
    return res.status(401).json({ error: 'Нет данных Telegram (x-telegram-init-data)' });
  }
  if (!verifyInitData(initData, process.env.BOT_TOKEN)) {
    return res.status(401).json({ error: 'Данные Telegram не прошли проверку' });
  }

  const params = new URLSearchParams(initData);
  let user;
  try {
    user = JSON.parse(params.get('user'));
  } catch {
    return res.status(400).json({ error: 'Не удалось прочитать пользователя из initData' });
  }
  req.telegramUser = user;

  // Обновляем запись о пользователе — используется только для статистики в админке,
  // на саму проверку прав это никак не влияет. Если запись не сохранилась —
  // не блокируем запрос из-за этого, только пишем в лог.
  try {
    await prisma.telegramUser.upsert({
      where: { id: String(user.id) },
      update: {
        username: user.username || null,
        firstName: user.first_name || null,
        lastName: user.last_name || null,
        languageCode: user.language_code || null,
        lastIp: req.ip,
        lastSeenAt: new Date(),
      },
      create: {
        id: String(user.id),
        username: user.username || null,
        firstName: user.first_name || null,
        lastName: user.last_name || null,
        languageCode: user.language_code || null,
        lastIp: req.ip,
      },
    });
  } catch (e) {
    console.error('Не удалось обновить статистику пользователя', e);
  }

  next();
}

module.exports = { verifyInitData, telegramAuth };
