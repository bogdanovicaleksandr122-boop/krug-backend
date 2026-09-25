// Общие расчёты статистики: для админки (routes/adminAnalytics.js) и для владельца
// анкеты в личном кабинете (routes/me.js). Здесь только чтение из базы.
const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');

// Дни и часы считаем по времени Болгарии (Польша на час раньше) — иначе "сегодня"
// начиналось бы в 2-3 часа ночи по местному времени. Это наша константа, не ввод
// пользователя, поэтому её можно вставлять прямо в текст запроса.
const TZ = 'Europe/Sofia';
const DAY_MS = 24 * 60 * 60 * 1000;

// Ограничиваем период, который можно запросить, чтобы тяжёлые запросы нельзя было
// раздуть до бесконечности.
function clampDays(value, fallback = 30) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 365);
}

function daysAgo(days) {
  return new Date(Date.now() - days * DAY_MS);
}

// Дата в базе хранится "по UTC без пояса". Чтобы сравнение не зависело от настроек
// часового пояса самой базы, передаём время текстом с явным UTC и приводим к тому же виду.
function ts(date) {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

// Выражение "местное время" для столбца с датой.
function local(column = '"createdAt"') {
  return Prisma.raw(`((${column} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`);
}

// Дата "ГГГГ-ММ-ДД" по местному времени.
function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Список дат за последние N дней (включая сегодня), от старых к новым —
// чтобы на графике были и дни без единого события (с нулём), а не пропуски.
function lastDays(days) {
  const today = new Date(`${dayKey(new Date())}T00:00:00Z`);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(today.getTime() - i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

// Условие "событие попало в последние N дней по местному календарю". Первое
// условие по голой дате нужно, чтобы база могла использовать индекс.
function inLastDays(days, column = '"createdAt"') {
  return Prisma.sql`${Prisma.raw(column)} >= ${ts(daysAgo(days + 1))}
    AND ${local(column)}::date > (now() AT TIME ZONE ${Prisma.raw(`'${TZ}'`)})::date - ${days}::int`;
}

// Счётчик по дням: { 'ГГГГ-ММ-ДД': число }.
// table и column — наши константы; where — готовый кусок Prisma.sql.
async function countByDay(table, days, { where = Prisma.sql`TRUE`, distinct = null, column = '"createdAt"' } = {}) {
  const count = distinct ? Prisma.raw(`COUNT(DISTINCT ${distinct})`) : Prisma.raw('COUNT(*)');
  const rows = await prisma.$queryRaw`
    SELECT to_char(${local(column)}, 'YYYY-MM-DD') AS day, ${count}::int AS n
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE ${inLastDays(days, column)} AND ${where}
    GROUP BY 1`;
  return Object.fromEntries(rows.map((r) => [r.day, r.n]));
}

// Склеивает несколько счётчиков по дням в один ряд для графика:
// [{ date, views: 3, contacts: 1 }, ...]
function mergeSeries(days, series) {
  return lastDays(days).map((date) => {
    const row = { date };
    for (const [name, map] of Object.entries(series)) row[name] = map[date] || 0;
    return row;
  });
}

function percent(part, whole) {
  return whole ? Math.min(100, Math.round((part / whole) * 1000) / 10) : 0;
}

function toCountMap(rows, key) {
  return Object.fromEntries(rows.map((r) => [r[key] || 'unknown', r._count._all]));
}

/* ================= Статистика одной анкеты ================= */

// Видна и админу, и подтверждённому владельцу анкеты. Кто именно смотрел —
// не отдаём никому, только количество.
async function specialistStats(specialistId, periodDays = 30) {
  const days = clampDays(periodDays);
  const since = daysAgo(days);
  const weekAgo = daysAgo(7);
  const base = { specialistId };
  const idSql = Prisma.sql`"specialistId" = ${specialistId}`;

  const [
    viewsTotal, views7d, viewsPeriod,
    uniqueRows,
    contactsTotal, contactsPeriod,
    sharesTotal, sharesPeriod,
    favorites, sources,
    dailyViews, dailyContacts,
  ] = await Promise.all([
    prisma.specialistEvent.count({ where: { ...base, type: 'view' } }),
    prisma.specialistEvent.count({ where: { ...base, type: 'view', createdAt: { gte: weekAgo } } }),
    prisma.specialistEvent.count({ where: { ...base, type: 'view', createdAt: { gte: since } } }),
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT "telegramUserId") FILTER (WHERE type = 'view')::int AS total,
             COUNT(DISTINCT "telegramUserId") FILTER (WHERE type = 'view' AND "createdAt" >= ${ts(since)})::int AS period,
             COUNT(DISTINCT "telegramUserId") FILTER (WHERE type = 'contact' AND "createdAt" >= ${ts(since)})::int AS contacters
      FROM "SpecialistEvent" WHERE ${idSql}`,
    prisma.specialistEvent.count({ where: { ...base, type: 'contact' } }),
    prisma.specialistEvent.groupBy({ by: ['detail'], where: { ...base, type: 'contact', createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.specialistEvent.count({ where: { ...base, type: 'share' } }),
    prisma.specialistEvent.count({ where: { ...base, type: 'share', createdAt: { gte: since } } }),
    prisma.favorite.count({ where: base }),
    prisma.specialistEvent.groupBy({ by: ['source'], where: { ...base, type: 'view', createdAt: { gte: since } }, _count: { _all: true } }),
    countByDay('SpecialistEvent', days, { where: Prisma.sql`${idSql} AND type = 'view'` }),
    countByDay('SpecialistEvent', days, { where: Prisma.sql`${idSql} AND type = 'contact'` }),
  ]);

  const contactsByType = toCountMap(contactsPeriod, 'detail');
  const contactsInPeriod = Object.values(contactsByType).reduce((a, b) => a + b, 0);

  return {
    periodDays: days,
    views: { total: viewsTotal, last7d: views7d, period: viewsPeriod },
    uniqueViewers: { total: uniqueRows[0].total, period: uniqueRows[0].period },
    contacts: { total: contactsTotal, period: contactsInPeriod, byType: contactsByType },
    shares: { total: sharesTotal, period: sharesPeriod },
    favorites,
    // Какая доля посмотревших людей нажала хоть на один контакт — главный показатель
    // "работает ли анкета". Считаем по людям, а не по нажатиям: один человек мог
    // нажать и телефон, и Telegram, и это не должно давать больше 100%.
    contactRate: percent(uniqueRows[0].contacters, uniqueRows[0].period),
    sources: toCountMap(sources, 'source'),
    daily: mergeSeries(days, { views: dailyViews, contacts: dailyContacts }),
  };
}

/* ================= Общая статистика приложения (админка) ================= */

async function appAnalytics(periodDays = 30) {
  const days = clampDays(periodDays);
  const since = daysAgo(days);
  const weekAgo = daysAgo(7);
  const dayAgo = daysAgo(1);
  const period = inLastDays(days);

  const [
    usersTotal, newUsers, sourcesRows,
    activeRows,
    opens, views, contacts, shares,
    funnelRows,
    dailyNew, dailyActive, dailyOpens, dailyViews, dailyContacts,
    hourRows, weekdayRows,
    topSpecialistRows,
    topSearches, zeroSearches, topSubcategoryRows,
    platformRows, languageRows,
    retentionRows,
    paymentsRows, newSpecialists,
  ] = await Promise.all([
    prisma.telegramUser.count(),
    prisma.telegramUser.count({ where: { firstSeenAt: { gte: since } } }),
    prisma.telegramUser.groupBy({ by: ['firstSource'], where: { firstSeenAt: { gte: since } }, _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT "telegramUserId") FILTER (WHERE "createdAt" >= ${ts(dayAgo)})::int AS d1,
             COUNT(DISTINCT "telegramUserId") FILTER (WHERE "createdAt" >= ${ts(weekAgo)})::int AS d7,
             COUNT(DISTINCT "telegramUserId")::int AS period
      FROM "AppOpen" WHERE "createdAt" >= ${ts(since)}`,
    prisma.appOpen.count({ where: { createdAt: { gte: since } } }),
    prisma.specialistEvent.count({ where: { type: 'view', createdAt: { gte: since } } }),
    prisma.specialistEvent.count({ where: { type: 'contact', createdAt: { gte: since } } }),
    prisma.specialistEvent.count({ where: { type: 'share', createdAt: { gte: since } } }),
    // Воронка: сколько разных людей открыли приложение → посмотрели хоть одну
    // анкету → нажали хоть на один контакт.
    prisma.$queryRaw`
      SELECT
        (SELECT COUNT(DISTINCT "telegramUserId") FROM "AppOpen" WHERE "createdAt" >= ${ts(since)})::int AS opened,
        (SELECT COUNT(DISTINCT "telegramUserId") FROM "SpecialistEvent" WHERE type = 'view' AND "createdAt" >= ${ts(since)})::int AS viewed,
        (SELECT COUNT(DISTINCT "telegramUserId") FROM "SpecialistEvent" WHERE type = 'contact' AND "createdAt" >= ${ts(since)})::int AS contacted`,
    countByDay('TelegramUser', days, { column: '"firstSeenAt"' }),
    countByDay('AppOpen', days, { distinct: '"telegramUserId"' }),
    countByDay('AppOpen', days),
    countByDay('SpecialistEvent', days, { where: Prisma.sql`type = 'view'` }),
    countByDay('SpecialistEvent', days, { where: Prisma.sql`type = 'contact'` }),
    // Когда люди заходят — помогает выбрать время для рекламного поста.
    prisma.$queryRaw`
      SELECT EXTRACT(HOUR FROM ${local()})::int AS hour, COUNT(*)::int AS n
      FROM "AppOpen" WHERE ${period} GROUP BY 1`,
    prisma.$queryRaw`
      SELECT EXTRACT(ISODOW FROM ${local()})::int AS dow, COUNT(*)::int AS n
      FROM "AppOpen" WHERE ${period} GROUP BY 1`,
    prisma.$queryRaw`
      SELECT "specialistId" AS id,
             COUNT(*) FILTER (WHERE type = 'view')::int AS views,
             COUNT(DISTINCT "telegramUserId") FILTER (WHERE type = 'view')::int AS viewers,
             COUNT(*) FILTER (WHERE type = 'contact')::int AS contacts,
             COUNT(DISTINCT "telegramUserId") FILTER (WHERE type = 'contact')::int AS contacters,
             COUNT(*) FILTER (WHERE type = 'share')::int AS shares
      FROM "SpecialistEvent" WHERE "createdAt" >= ${ts(since)}
      GROUP BY 1 ORDER BY views DESC, contacts DESC LIMIT 30`,
    prisma.$queryRaw`
      SELECT lower(trim(query)) AS query, COUNT(*)::int AS n,
             COUNT(DISTINCT "telegramUserId")::int AS users,
             ROUND(AVG("resultsCount"))::int AS results
      FROM "SearchLog" WHERE kind = 'text' AND "createdAt" >= ${ts(since)}
      GROUP BY 1 ORDER BY n DESC LIMIT 30`,
    prisma.$queryRaw`
      SELECT lower(trim(query)) AS query, COUNT(*)::int AS n,
             COUNT(DISTINCT "telegramUserId")::int AS users
      FROM "SearchLog" WHERE kind = 'text' AND "resultsCount" = 0 AND "createdAt" >= ${ts(since)}
      GROUP BY 1 ORDER BY n DESC LIMIT 30`,
    prisma.$queryRaw`
      SELECT "subcategoryId" AS id, COUNT(*)::int AS n,
             COUNT(DISTINCT "telegramUserId")::int AS users,
             COUNT(*) FILTER (WHERE "resultsCount" = 0)::int AS empty
      FROM "SearchLog" WHERE kind = 'subcategory' AND "createdAt" >= ${ts(since)}
      GROUP BY 1 ORDER BY n DESC LIMIT 30`,
    prisma.$queryRaw`
      SELECT COALESCE(platform, 'unknown') AS platform, COUNT(DISTINCT "telegramUserId")::int AS users
      FROM "AppOpen" WHERE "createdAt" >= ${ts(since)} GROUP BY 1 ORDER BY users DESC`,
    prisma.telegramUser.groupBy({ by: ['languageCode'], _count: { _all: true } }),
    // Удержание: из тех, кто впервые пришёл в этот период (и не прямо сегодня),
    // сколько вернулись хотя бы на следующий день.
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE "lastSeenAt" >= "firstSeenAt" + interval '1 day')::int AS returned
      FROM "TelegramUser"
      WHERE "firstSeenAt" >= ${ts(since)} AND "firstSeenAt" < ${ts(dayAgo)}`,
    prisma.payment.groupBy({ by: ['type'], where: { createdAt: { gte: since } }, _sum: { starsAmount: true }, _count: { _all: true } }),
    prisma.specialist.count({ where: { createdAt: { gte: since } } }),
  ]);

  // Подписываем анкеты и подкатегории человеческими названиями
  const [specialists, subcategories] = await Promise.all([
    prisma.specialist.findMany({
      where: { id: { in: topSpecialistRows.map((r) => r.id) } },
      select: { id: true, name: true, role: true, pro: true, boosted: true, verified: true, city: { select: { label: true } } },
    }),
    prisma.subcategory.findMany({
      where: { id: { in: topSubcategoryRows.map((r) => r.id).filter(Boolean) } },
      select: { id: true, label: true, category: { select: { label: true } } },
    }),
  ]);
  const specById = new Map(specialists.map((s) => [s.id, s]));
  const subById = new Map(subcategories.map((s) => [s.id, s]));

  const hours = Array.from({ length: 24 }, (_, h) => (hourRows.find((r) => r.hour === h) || { n: 0 }).n);
  const weekdays = Array.from({ length: 7 }, (_, i) => (weekdayRows.find((r) => r.dow === i + 1) || { n: 0 }).n);

  return {
    periodDays: days,
    users: {
      total: usersTotal,
      newInPeriod: newUsers,
      active24h: activeRows[0].d1,
      active7d: activeRows[0].d7,
      activeInPeriod: activeRows[0].period,
      newBySource: toCountMap(sourcesRows, 'firstSource'),
      retention: retentionRows[0],
    },
    totals: { opens, views, contacts, shares, newSpecialists },
    funnel: funnelRows[0],
    daily: mergeSeries(days, {
      newUsers: dailyNew, activeUsers: dailyActive, opens: dailyOpens, views: dailyViews, contacts: dailyContacts,
    }),
    hours,
    weekdays,
    topSpecialists: topSpecialistRows.map((r) => {
      const s = specById.get(r.id) || {};
      return {
        ...r,
        name: s.name || `Анкета #${r.id}`,
        role: s.role || '',
        city: s.city ? s.city.label : '',
        pro: !!s.pro,
        boosted: !!s.boosted,
        verified: !!s.verified,
        contactRate: percent(r.contacters, r.viewers),
      };
    }),
    topSearches,
    zeroSearches,
    topSubcategories: topSubcategoryRows.map((r) => {
      const s = subById.get(r.id);
      return { ...r, label: s ? `${s.category.label} → ${s.label}` : r.id || '—' };
    }),
    platforms: platformRows,
    languages: languageRows
      .map((r) => ({ language: r.languageCode || 'unknown', users: r._count._all }))
      .sort((a, b) => b.users - a.users),
    payments: paymentsRows.map((p) => ({ type: p.type, count: p._count._all, stars: p._sum.starsAmount || 0 })),
  };
}

/* ================= Рекламные ссылки ================= */

// Сводка по всем ссылкам сразу: сколько раз нажали, сколько новых людей пришло,
// сколько из них вернулись и что делали дальше.
async function referralSummaries() {
  const weekAgo = daysAgo(7);
  const rows = await prisma.$queryRaw`
    SELECT l.id,
      (SELECT COUNT(*) FROM "AppOpen" o WHERE o."referralLinkId" = l.id)::int AS opens,
      (SELECT COUNT(DISTINCT o."telegramUserId") FROM "AppOpen" o WHERE o."referralLinkId" = l.id)::int AS openers,
      (SELECT COUNT(*) FROM "TelegramUser" u WHERE u."referralLinkId" = l.id)::int AS "newUsers",
      (SELECT COUNT(*) FROM "TelegramUser" u WHERE u."referralLinkId" = l.id
         AND u."lastSeenAt" >= u."firstSeenAt" + interval '1 day')::int AS returned,
      (SELECT COUNT(*) FROM "TelegramUser" u WHERE u."referralLinkId" = l.id
         AND u."lastSeenAt" >= ${ts(weekAgo)})::int AS "active7d",
      (SELECT COUNT(DISTINCT e."telegramUserId") FROM "SpecialistEvent" e
         JOIN "TelegramUser" u ON u.id = e."telegramUserId"
         WHERE u."referralLinkId" = l.id AND e.type = 'view')::int AS viewers,
      (SELECT COUNT(DISTINCT e."telegramUserId") FROM "SpecialistEvent" e
         JOIN "TelegramUser" u ON u.id = e."telegramUserId"
         WHERE u."referralLinkId" = l.id AND e.type = 'contact')::int AS contacted,
      (SELECT COUNT(*) FROM "Specialist" s
         JOIN "TelegramUser" u ON u.id = s."telegramUserId"
         WHERE u."referralLinkId" = l.id)::int AS specialists,
      (SELECT COALESCE(SUM(p."starsAmount"), 0) FROM "Payment" p
         JOIN "Specialist" s ON s.id = p."specialistId"
         JOIN "TelegramUser" u ON u.id = s."telegramUserId"
         WHERE u."referralLinkId" = l.id)::int AS stars
    FROM "ReferralLink" l`;
  return new Map(rows.map((r) => [r.id, r]));
}

// Подробности по одной ссылке: график по дням, устройства, кто пришёл.
async function referralDetails(linkId, periodDays = 30) {
  const days = clampDays(periodDays);
  const idSql = Prisma.sql`"referralLinkId" = ${linkId}`;
  const [dailyOpens, dailyNew, platforms, users, topViewed] = await Promise.all([
    countByDay('AppOpen', days, { where: idSql }),
    countByDay('TelegramUser', days, { where: idSql, column: '"firstSeenAt"' }),
    prisma.$queryRaw`
      SELECT COALESCE(platform, 'unknown') AS platform, COUNT(DISTINCT "telegramUserId")::int AS users
      FROM "AppOpen" WHERE ${idSql} GROUP BY 1 ORDER BY users DESC`,
    prisma.telegramUser.findMany({
      where: { referralLinkId: linkId },
      orderBy: { firstSeenAt: 'desc' },
      take: 200,
      select: { id: true, username: true, firstName: true, lastName: true, languageCode: true, firstSeenAt: true, lastSeenAt: true },
    }),
    prisma.$queryRaw`
      SELECT e."specialistId" AS id, s.name, COUNT(*)::int AS views
      FROM "SpecialistEvent" e
      JOIN "TelegramUser" u ON u.id = e."telegramUserId"
      JOIN "Specialist" s ON s.id = e."specialistId"
      WHERE u."referralLinkId" = ${linkId} AND e.type = 'view'
      GROUP BY 1, 2 ORDER BY views DESC LIMIT 10`,
  ]);
  return {
    periodDays: days,
    daily: mergeSeries(days, { opens: dailyOpens, newUsers: dailyNew }),
    platforms,
    users,
    topViewed,
  };
}

module.exports = {
  TZ, clampDays, daysAgo, specialistStats, appAnalytics, referralSummaries, referralDetails,
};
