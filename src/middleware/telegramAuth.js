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

// Достаёт пользователя из initData, если она пришла и прошла проверку. Иначе null.
function readTelegramUser(initData) {
  if (!initData || !verifyInitData(initData, process.env.BOT_TOKEN)) return null;
  try {
    return JSON.parse(new URLSearchParams(initData).get('user'));
  } catch {
    return null;
  }
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
  // Параметр из ссылки запуска (startapp=...) и время запуска — оба внутри подписи
  // Telegram, поэтому им можно доверять (в отличие от того, что прислано в теле запроса).
  req.telegramStartParam = params.get('start_param') || null;
  req.telegramAuthDate = Number(params.get('auth_date')) || null;
  req.isNewTelegramUser = false;

  // Обновляем запись о пользователе — используется только для статистики в админке,
  // на саму проверку прав это никак не влияет. Если запись не сохранилась —
  // не блокируем запрос из-за этого, только пишем в лог.
  // Чтобы понять, новый ли это пользователь (нужно для подсчёта новичков по рекламным
  // ссылкам), при создании записи ставим "первый визит" ровно на текущий момент:
  // если после сохранения он совпал с этим моментом — запись только что появилась.
  const now = new Date();
  const profile = {
    username: user.username || null,
    firstName: user.first_name || null,
    lastName: user.last_name || null,
    languageCode: user.language_code || null,
    lastIp: req.ip,
  };
  try {
    const saved = await prisma.telegramUser.upsert({
      where: { id: String(user.id) },
      update: { ...profile, lastSeenAt: now },
      create: { id: String(user.id), ...profile, firstSeenAt: now, lastSeenAt: now },
    });
    req.isNewTelegramUser = saved.firstSeenAt.getTime() === now.getTime();
  } catch (e) {
    console.error('Не удалось обновить статистику пользователя', e);
  }

  next();
}

// Для публичных роутов: если запрос пришёл из Telegram с правильной подписью —
// запоминаем пользователя (req.telegramUser), если нет — просто пропускаем дальше.
// В базу ничего не пишет.
function optionalTelegramUser(req, res, next) {
  req.telegramUser = readTelegramUser(req.headers['x-telegram-init-data']);
  next();
}

module.exports = { verifyInitData, telegramAuth, optionalTelegramUser };
