// Статистика и рекламные ссылки для админки. Подключается внутри routes/admin.js
// уже после проверки токена админа — сюда без входа в админку не попасть.
const express = require('express');
const { asyncRoute } = require('../lib/asyncRoute');
const prisma = require('../lib/prisma');
const { slugify } = require('../lib/slugify');
const { toPublicId, fromPublicId } = require('../lib/publicId');
const { appLink } = require('../lib/shareMessage');
const {
  clampDays, specialistStats, appAnalytics, referralSummaries, referralDetails,
} = require('../lib/analytics');

const router = express.Router();

// id из адреса: не число — значит такой записи точно нет (без этой проверки
// запрос к базе с "не числом" падал бы с внутренней ошибкой вместо 404).
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* ================= Общая статистика ================= */

router.get('/analytics', asyncRoute(async (req, res) => {
  res.json(await appAnalytics(clampDays(req.query.days)));
}));

// Статистика одной анкеты — то же, что видит владелец, плюс можно выбрать период
router.get('/specialists/:id/stats', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const specialist = id && await prisma.specialist.findUnique({ where: { id }, select: { id: true } });
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });
  res.json(await specialistStats(id, clampDays(req.query.days)));
}));

/* ================= Рекламные ссылки ================= */

// Код попадает в саму ссылку: t.me/бот/app?startapp=r_<код>. Telegram разрешает
// в этом параметре только латиницу, цифры, "_" и "-".
const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/;

function cleanText(value, max) {
  if (value === undefined) return undefined;
  const s = value == null ? '' : String(value).trim().slice(0, max);
  return s || null;
}

function cleanCost(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error('Стоимость должна быть числом не меньше нуля');
    err.isValidation = true;
    throw err;
  }
  return n;
}

// Анкету, на которую ведёт ссылка, админ указывает её публичным номером (100000000042)
async function cleanTarget(value) {
  if (value === undefined) return undefined;
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return null;
  const id = fromPublicId(raw);
  const specialist = id && await prisma.specialist.findUnique({ where: { id }, select: { id: true } });
  if (!specialist) {
    const err = new Error(`Анкета № ${raw} не найдена`);
    err.isValidation = true;
    throw err;
  }
  return specialist.id;
}

async function withLinkInfo(links) {
  const summaries = await referralSummaries();
  const targetIds = links.map((l) => l.targetSpecialistId).filter(Boolean);
  const targets = targetIds.length
    ? await prisma.specialist.findMany({ where: { id: { in: targetIds } }, select: { id: true, name: true } })
    : [];
  const targetById = new Map(targets.map((t) => [t.id, t]));
  return links.map((l) => {
    const stats = summaries.get(l.id) || {};
    const target = l.targetSpecialistId ? targetById.get(l.targetSpecialistId) : null;
    return {
      ...l,
      url: appLink(`r_${l.code}`),
      target: target ? { id: target.id, publicId: toPublicId(target.id), name: target.name } : null,
      stats,
      // Сколько стоил один новый пользователь — главный показатель выгодности рекламы
      costPerUser: l.cost != null && stats.newUsers ? Math.round((l.cost / stats.newUsers) * 100) / 100 : null,
    };
  });
}

router.get('/referrals', asyncRoute(async (req, res) => {
  const links = await prisma.referralLink.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(await withLinkInfo(links));
}));

router.get('/referrals/:id', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const link = id && await prisma.referralLink.findUnique({ where: { id } });
  if (!link) return res.status(404).json({ error: 'Ссылка не найдена' });
  const [withInfo] = await withLinkInfo([link]);
  res.json({ ...withInfo, details: await referralDetails(link.id, clampDays(req.query.days)) });
}));

router.post('/referrals', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name, 100);
  if (!name) return res.status(400).json({ error: 'Укажите название ссылки' });
  try {
    let code = cleanText(body.code, 40);
    if (code) {
      if (!CODE_RE.test(code)) {
        return res.status(400).json({ error: 'Код: от 2 до 40 символов — латиница, цифры, «_» или «-»' });
      }
      if (await prisma.referralLink.findUnique({ where: { code } })) {
        return res.status(400).json({ error: `Код «${code}» уже занят` });
      }
    } else {
      // Код не задан — делаем из названия, добавляя номер, если такой уже есть
      const base = slugify(name).slice(0, 36);
      code = base;
      let n = 2;
      while (await prisma.referralLink.findUnique({ where: { code } })) {
        code = `${base}-${n}`;
        n += 1;
      }
    }
    const link = await prisma.referralLink.create({
      data: {
        code,
        name,
        channel: cleanText(body.channel, 200),
        cost: cleanCost(body.cost),
        currency: cleanText(body.currency, 10),
        note: cleanText(body.note, 1000),
        targetSpecialistId: await cleanTarget(body.targetPublicId),
      },
    });
    const [withInfo] = await withLinkInfo([link]);
    res.status(201).json(withInfo);
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ error: e.message });
    throw e;
  }
}));

// Код ссылки не меняем: она уже может быть опубликована в рекламе
router.put('/referrals/:id', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Ссылка не найдена' });
  const body = req.body || {};
  try {
    const data = {
      name: cleanText(body.name, 100),
      channel: cleanText(body.channel, 200),
      cost: cleanCost(body.cost),
      currency: cleanText(body.currency, 10),
      note: cleanText(body.note, 1000),
      targetSpecialistId: await cleanTarget(body.targetPublicId),
      archived: body.archived === undefined ? undefined : !!body.archived,
    };
    if (data.name === null) return res.status(400).json({ error: 'Название не может быть пустым' });
    const link = await prisma.referralLink.update({ where: { id }, data });
    const [withInfo] = await withLinkInfo([link]);
    res.json(withInfo);
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ error: e.message });
    if (e.code === 'P2025') return res.status(404).json({ error: 'Ссылка не найдена' });
    throw e;
  }
}));

// Удаление: пришедшие по ссылке пользователи останутся, но будут считаться
// "источник неизвестен". Поэтому в админке по умолчанию предлагаем архив.
router.delete('/referrals/:id', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Ссылка не найдена' });
  try {
    await prisma.referralLink.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Ссылка не найдена' });
    throw e;
  }
}));

module.exports = router;
