const jwt = require('jsonwebtoken');
const { adminTelegramIds, telegramLoginEnabled } = require('../lib/adminAccess');

// Защищает роуты админки: без правильного токена (полученного через /api/admin/login) доступа нет.
function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Нужен токен авторизации' });
  }
  const token = header.slice('Bearer '.length);
  try {
    // algorithms указан явно и намеренно: без этого jwt.verify по умолчанию доверяет
    // алгоритму, указанному в самом токене, а не только тому, каким токен реально
    // подписывается при логине (HS256). Явное ограничение — стандартная защита от
    // атак с подменой алгоритма подписи (см. OWASP JWT security cheat sheet).
    req.admin = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
  // Когда включён вход через Telegram, пропускаем только входы тех аккаунтов,
  // которые прямо сейчас есть в ADMIN_TELEGRAM_IDS. Поэтому: старые входы по паролю
  // перестают работать сразу после включения, а убранный из списка аккаунт теряет
  // доступ мгновенно, не дожидаясь, пока истечёт его вход.
  if (telegramLoginEnabled() && !adminTelegramIds().has(String(req.admin.tgId || ''))) {
    return res.status(401).json({ error: 'Нет доступа — войдите через Telegram заново' });
  }
  next();
}

module.exports = adminAuth;
