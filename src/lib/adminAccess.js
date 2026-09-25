// Вход в админку через Telegram-аккаунт владельца (кнопка "Войти через Telegram"
// на странице админки — официальный виджет Telegram Login).
const crypto = require('crypto');
const { sendTelegramMessage } = require('./telegramSend');

// Кому разрешён вход: Telegram ID через запятую в переменной ADMIN_TELEGRAM_IDS.
// Пока переменная пустая, вход через Telegram выключен и работает старый вход
// по логину/паролю (чтобы обновление не закрыло владельцу доступ в админку).
// Как только переменная задана — вход по паролю отключается совсем.
function adminTelegramIds() {
  return new Set(
    (process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  );
}

function telegramLoginEnabled() {
  return adminTelegramIds().size > 0;
}

// Данные от виджета считаем свежими не дольше суток (так советует Telegram).
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

// Один и тот же ответ виджета нельзя использовать для входа дважды: иначе
// перехваченные данные (например, из истории браузера) позволили бы войти
// повторно. Помним использованные подписи до конца их срока годности.
const usedHashes = new Map();
function rememberHash(hash, authDate) {
  const nowSec = Date.now() / 1000;
  for (const [h, expires] of usedHashes) if (expires < nowSec) usedHashes.delete(h);
  usedHashes.set(hash, authDate + MAX_AUTH_AGE_SECONDS);
}

// Проверка подписи виджета Telegram Login — алгоритм из документации Telegram:
// ключ = SHA256(токен бота), подпись = HMAC-SHA256 от отсортированных полей.
// Подделать ответ без токена бота невозможно. Возвращает пользователя или null.
function verifyLoginWidget(data, botToken) {
  if (!data || typeof data !== 'object' || !botToken) return null;
  const { hash } = data;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;

  const fields = Object.entries(data).filter(([key]) => key !== 'hash');
  // Виджет присылает только простые значения (строки и числа)
  if (fields.some(([, v]) => typeof v !== 'string' && typeof v !== 'number')) return null;

  const dataCheckString = fields
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const received = Buffer.from(hash, 'hex');
  if (computed.length !== received.length || !crypto.timingSafeEqual(computed, received)) return null;

  const authDate = Number(data.auth_date);
  const nowSec = Date.now() / 1000;
  if (!authDate || nowSec - authDate > MAX_AUTH_AGE_SECONDS || authDate - nowSec > 5 * 60) return null;
  if (usedHashes.has(hash)) return null;
  rememberHash(hash, authDate);

  return {
    id: String(data.id),
    username: data.username ? String(data.username) : null,
    firstName: data.first_name ? String(data.first_name) : null,
    lastName: data.last_name ? String(data.last_name) : null,
  };
}

// Сообщение владельцу в бота о каждом входе в админку — если зашёл кто-то
// чужой, это сразу будет видно.
function notifyAdminsAboutLogin(user, req) {
  const who = user.username ? `@${user.username}` : [user.firstName, user.lastName].filter(Boolean).join(' ') || `id ${user.id}`;
  const time = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Sofia' });
  const device = String(req.headers['user-agent'] || 'неизвестно').slice(0, 150);
  const text = [
    '🔐 Вход в админку КРУГ',
    `Кто: ${who}`,
    `Когда: ${time} (время Болгарии)`,
    `IP: ${req.ip}`,
    `Устройство: ${device}`,
    '',
    'Если это были не вы — уберите лишний ID из ADMIN_TELEGRAM_IDS в Railway и смените JWT_SECRET (все входы сбросятся).',
  ].join('\n');
  for (const id of adminTelegramIds()) {
    sendTelegramMessage(id, text).catch((e) => console.error('Не удалось отправить уведомление о входе в админку', e));
  }
}

module.exports = { adminTelegramIds, telegramLoginEnabled, verifyLoginWidget, notifyAdminsAboutLogin };
