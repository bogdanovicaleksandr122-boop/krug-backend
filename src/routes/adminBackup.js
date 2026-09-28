// Бэкапы в админке: состояние ежедневной копии, кнопка "сделать копию сейчас"
// и выгрузка всех анкет в CSV. Подключается внутри admin.js после проверки входа.
const express = require('express');
const { asyncRoute } = require('../lib/asyncRoute');
const prisma = require('../lib/prisma');
const { sendBackupToTelegram, backupStatus } = require('../lib/backup');
const { toPublicId } = require('../lib/publicId');

const router = express.Router();

router.get('/backup/status', asyncRoute(async (req, res) => {
  res.json(await backupStatus());
}));

// Копия уходит в Telegram, а не скачивается в браузер: в ней личные данные
// пользователей, и хранить её лучше в закрытом чате владельца.
router.post('/backup/run', asyncRoute(async (req, res) => {
  try {
    const summary = await sendBackupToTelegram('вручную из админки');
    res.json(summary);
  } catch (e) {
    res.status(502).json({ error: 'Не удалось сделать бэкап: ' + e.message });
  }
}));

// Та же раскладка колонок, что понимает "Импорт CSV" — файл можно загрузить обратно.
// Фото, владелец анкеты и статистика в CSV не попадают (для этого есть полный бэкап).
const CSV_COLUMNS = [
  'country', 'city', 'category', 'subcategory', 'name', 'role', 'category_icon', 'about', 'services',
  'contactsTelegram', 'contactsInstagram', 'contactsPhone', 'contactsWebsite', 'locationAddress',
  'status', 'verified', 'pro', 'boosted', 'public_id',
];

function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Не даём Excel принять текст из анкеты за формулу (текст пишут пользователи,
  // формула в ячейке может выполнить что-то при открытии файла). Телефоны вида
  // "+359 88 ..." и ники "@name" не трогаем — они безопасны. При загрузке файла
  // обратно через "Импорт CSV" этот защитный апостроф снимается.
  const isSafe = /^[+\-][\d\s()\-+]*$/.test(s) || /^@[\w.]+$/.test(s);
  if (/^[=+\-@\t\r]/.test(s) && !isSafe) s = "'" + s;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function list(value) {
  return Array.isArray(value) ? value.join('|') : '';
}

router.get('/backup/specialists.csv', asyncRoute(async (req, res) => {
  const specialists = await prisma.specialist.findMany({
    include: { category: true, subcategory: true, city: true },
    orderBy: { id: 'asc' },
  });
  const yesNo = (v) => (v ? 'да' : 'нет');
  const rows = specialists.map((s) => [
    s.city ? s.city.country : '', s.city ? s.city.label : '', s.category.label, s.subcategory.label,
    s.name, s.role, s.category.icon, s.about, list(s.services),
    s.contactsTelegram, s.contactsInstagram, s.contactsPhone, s.contactsWebsite, s.locationAddress,
    s.status, yesNo(s.verified), yesNo(s.pro), yesNo(s.boosted), toPublicId(s.id),
  ].map(csvCell).join(','));
  const date = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="krug-specialists-${date}.csv"`);
  // BOM в начале — чтобы Excel правильно показал русские буквы
  res.send('﻿' + [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n');
}));

module.exports = router;
