const crypto = require('crypto');

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

  return computedHash === hash;
}

// Middleware для роутов, которые должны знать, кто именно пишет из Telegram.
function telegramAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) {
    return res.status(401).json({ error: 'Нет данных Telegram (x-telegram-init-data)' });
  }
  if (!verifyInitData(initData, process.env.BOT_TOKEN)) {
    return res.status(401).json({ error: 'Данные Telegram не прошли проверку' });
  }

  const params = new URLSearchParams(initData);
  try {
    req.telegramUser = JSON.parse(params.get('user'));
  } catch {
    return res.status(400).json({ error: 'Не удалось прочитать пользователя из initData' });
  }
  next();
}

module.exports = { verifyInitData, telegramAuth };
