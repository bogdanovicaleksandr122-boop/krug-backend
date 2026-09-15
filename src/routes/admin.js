const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// Вход в админку. Для простоты старта — один логин/пароль из переменных окружения
// (не из базы). Когда появится несколько модераторов, легко переключить на таблицу Admin + bcrypt.
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = jwt.sign({ username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

router.use(adminAuth); // всё, что ниже, требует токен

// Заявки, ожидающие проверки
router.get('/pending', async (req, res) => {
  const pending = await prisma.specialist.findMany({
    where: { status: 'pending' },
    include: { category: true, subcategory: true, city: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json(pending);
});

router.post('/specialists/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.update({
    where: { id },
    data: { status: 'published' },
  });
  await prisma.moderationLog.create({
    data: { specialistId: id, action: 'approve' },
  });
  res.json(specialist);
});

router.post('/specialists/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = req.body;
  const specialist = await prisma.specialist.update({
    where: { id },
    data: { status: 'rejected', rejectionReason: reason || 'Без указания причины' },
  });
  await prisma.moderationLog.create({
    data: { specialistId: id, action: 'reject', reason },
  });
  res.json(specialist);
});

// Массовая загрузка через CSV: заглушка на будущее.
// Ожидаемые колонки — те же поля, что в форме добавления специалиста.
router.post('/specialists/bulk-csv', async (req, res) => {
  res.status(501).json({ error: 'Массовая загрузка ещё не реализована' });
});

module.exports = router;
