const jwt = require('jsonwebtoken');

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
    next();
  } catch {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
}

module.exports = adminAuth;
