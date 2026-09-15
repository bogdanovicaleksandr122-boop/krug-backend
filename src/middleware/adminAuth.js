const jwt = require('jsonwebtoken');

// Защищает роуты админки: без правильного токена (полученного через /api/admin/login) доступа нет.
function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Нужен токен авторизации' });
  }
  const token = header.slice('Bearer '.length);
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
}

module.exports = adminAuth;
