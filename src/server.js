require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');

const publicRoutes = require('./routes/public');
const meRoutes = require('./routes/me');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payments');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', publicRoutes);
app.use('/api/me', meRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', paymentRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// Раз в час снимаем истёкшие PRO/Буст статусы, чтобы они не висели вечно
setInterval(async () => {
  const now = new Date();
  await prisma.specialist.updateMany({ where: { pro: true, proExpiresAt: { lt: now } }, data: { pro: false } });
  await prisma.specialist.updateMany({ where: { boosted: true, boostedUntil: { lt: now } }, data: { boosted: false } });
}, 60 * 60 * 1000);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`КРУГ backend запущен на порту ${port}`));
