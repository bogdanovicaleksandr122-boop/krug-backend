// Сообщения специалистам от бота:
// - за 3 дня до конца PRO или буста — напоминание с кнопкой "Продлить";
// - раз в неделю (по понедельникам) — сколько людей посмотрели анкету.
// Сообщения уходят только днём по времени Софии, чтобы никого не будить.
const prisma = require('./prisma');
const { sendTelegramMessage, openAppButton } = require('./telegramSend');
const { appLink } = require('./shareMessage');

const TZ = 'Europe/Sofia';
const DAY_MS = 24 * 60 * 60 * 1000;
const REMIND_BEFORE_MS = 3 * DAY_MS;
const DIGEST_KEY = 'weekly_digest_last_week';
// Telegram ограничивает поток сообщений от бота — небольшая пауза между отправками
const SEND_PAUSE_MS = 60;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sofiaParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

function isDaytime() {
  const { hour } = sofiaParts();
  return hour >= 10 && hour < 20;
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long' });
}

// 1 просмотр, 2 просмотра, 5 просмотров
function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

async function remindExpiring() {
  const now = new Date();
  const soon = new Date(now.getTime() + REMIND_BEFORE_MS);
  const owned = { verified: true, status: 'published', telegramUserId: { not: null } };

  // PRO-подписка продлевается сама — напоминаем только о разовом PRO
  const pro = await prisma.specialist.findMany({
    where: { ...owned, pro: true, proRecurring: false, proExpiresAt: { gt: now, lte: soon } },
  });
  for (const s of pro) {
    if (s.proReminderFor && s.proReminderFor.getTime() === s.proExpiresAt.getTime()) continue;
    const res = await sendTelegramMessage(
      s.telegramUserId,
      `⏳ PRO для анкеты «${s.name}» закончится ${formatDate(s.proExpiresAt)}. После этого анкета опустится ниже в списке, а полная статистика закроется.`,
      openAppButton('Продлить PRO', appLink(`cab_${s.id}_pro`)),
    ).catch(() => null);
    if (res && res.ok) {
      await prisma.specialist.update({ where: { id: s.id }, data: { proReminderFor: s.proExpiresAt } });
    }
    await pause(SEND_PAUSE_MS);
  }

  const boosts = await prisma.specialist.findMany({
    where: { ...owned, boosted: true, boostedUntil: { gt: now, lte: soon } },
  });
  for (const s of boosts) {
    if (s.boostReminderFor && s.boostReminderFor.getTime() === s.boostedUntil.getTime()) continue;
    const res = await sendTelegramMessage(
      s.telegramUserId,
      `⏳ Буст анкеты «${s.name}» закончится ${formatDate(s.boostedUntil)}. Продлите, чтобы анкета оставалась в начале списка.`,
      openAppButton('Продлить буст', appLink(`cab_${s.id}_boost`)),
    ).catch(() => null);
    if (res && res.ok) {
      await prisma.specialist.update({ where: { id: s.id }, data: { boostReminderFor: s.boostedUntil } });
    }
    await pause(SEND_PAUSE_MS);
  }
}

// Номер недели вида "2026-W40" — чтобы отправить сводку ровно один раз в неделю
function weekKey(date = new Date()) {
  const { date: ymd } = sofiaParts(date);
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // понедельник = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // четверг этой недели
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d - firstThursday) / (7 * DAY_MS));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function sendWeeklyDigest() {
  const { weekday } = sofiaParts();
  if (weekday !== 'Mon') return;
  const key = weekKey();
  const last = await prisma.appSetting.findUnique({ where: { key: DIGEST_KEY } });
  if (last && last.value === key) return;
  // Сначала отмечаем неделю — даже если сервер перезапустится посреди рассылки,
  // сводка не уйдёт людям второй раз
  await prisma.appSetting.upsert({ where: { key: DIGEST_KEY }, update: { value: key }, create: { key: DIGEST_KEY, value: key } });

  const since = new Date(Date.now() - 7 * DAY_MS);
  const specialists = await prisma.specialist.findMany({
    where: { verified: true, status: 'published', telegramUserId: { not: null } },
    select: { id: true, name: true, pro: true, boosted: true, telegramUserId: true },
  });
  if (!specialists.length) return;
  const counts = await prisma.specialistEvent.groupBy({
    by: ['specialistId', 'type'],
    where: { specialistId: { in: specialists.map((s) => s.id) }, createdAt: { gte: since }, type: { in: ['view', 'contact'] } },
    _count: { _all: true },
  });
  const stat = (id, type) => (counts.find((c) => c.specialistId === id && c.type === type) || { _count: { _all: 0 } })._count._all;

  // Одно сообщение на владельца, даже если у него несколько анкет
  const byOwner = new Map();
  specialists.forEach((s) => {
    const views = stat(s.id, 'view');
    if (!views) return;
    if (!byOwner.has(s.telegramUserId)) byOwner.set(s.telegramUserId, []);
    byOwner.get(s.telegramUserId).push({ ...s, views, contacts: stat(s.id, 'contact') });
  });

  for (const [ownerId, list] of byOwner) {
    // Число нажатий на контакты — только при активном PRO или бусте (как и в статистике в приложении)
    const lines = list.map((s) => {
      const views = `${s.views} ${plural(s.views, 'просмотр', 'просмотра', 'просмотров')}`;
      const full = s.pro || s.boosted;
      return `«${s.name}»: ${views}${full ? `, ${s.contacts} ${plural(s.contacts, 'нажатие', 'нажатия', 'нажатий')} на контакты` : ''}`;
    });
    const anyLimited = list.some((s) => !s.pro && !s.boosted);
    const text = [
      list.length > 1 ? '📊 Ваши анкеты за неделю' : '📊 Ваша анкета за неделю',
      '',
      ...lines,
      ...(anyLimited ? ['', 'Сколько людей нажали на ваши контакты — в полной статистике с PRO или бустом.'] : []),
    ].join('\n');
    await sendTelegramMessage(ownerId, text, openAppButton('Открыть статистику', appLink(`cab_${list[0].id}_stats`)))
      .catch((e) => console.error('Не удалось отправить недельную сводку', e));
    await pause(SEND_PAUSE_MS);
  }
}

let running = false;
async function runNotifications() {
  if (running || !isDaytime()) return;
  running = true;
  try {
    await remindExpiring();
    await sendWeeklyDigest();
  } finally {
    running = false;
  }
}

// Проверяем раз в час; сами сообщения уходят только днём
function startNotificationSchedule() {
  const tick = () => runNotifications().catch((e) => console.error('Ошибка при отправке напоминаний', e));
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 60 * 60 * 1000);
}

module.exports = { startNotificationSchedule, runNotifications, remindExpiring, sendWeeklyDigest, weekKey, plural };
