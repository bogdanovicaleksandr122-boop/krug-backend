// Поиск анкет прямо из строки ввода любого чата: "@krugspace_bot бухгалтер Варна".
// Telegram присылает такой запрос нам (inline_query), мы отвечаем списком
// карточек. Пользователь нажимает на карточку — она уходит в чат с кнопкой
// "Открыть анкету" (то же сообщение, что и при "поделиться" в приложении).
const prisma = require('./prisma');
const { buildPhotoResult, appLink } = require('./shareMessage');
const { searchSpecialists, SEARCH_ORDER } = require('./search');

const PAGE_SIZE = 20;

async function callTelegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

// Тот же поиск, что и в приложении (см. lib/search.js)
function searchForInline(query, offset) {
  return searchSpecialists({ query, skip: offset, take: PAGE_SIZE, include: { city: true } });
}

// Пустой запрос (просто "@krugspace_bot"): сначала свои анкеты пользователя
// (удобно отправить свою визитку), потом избранное; если ничего нет — новые анкеты.
async function personalSpecialists(telegramUserId) {
  const own = await prisma.specialist.findMany({
    where: { status: 'published', telegramUserId },
    include: { city: true },
    orderBy: { id: 'desc' },
    take: PAGE_SIZE,
  });
  const favorites = await prisma.favorite.findMany({
    where: { telegramUserId, specialist: { status: 'published' } },
    include: { specialist: { include: { city: true } } },
    orderBy: { createdAt: 'desc' },
    take: PAGE_SIZE,
  });
  const seen = new Set(own.map((s) => s.id));
  const list = [...own, ...favorites.map((f) => f.specialist).filter((s) => !seen.has(s.id))].slice(0, PAGE_SIZE);
  if (list.length) return list;
  return prisma.specialist.findMany({
    where: { status: 'published' },
    include: { city: true },
    orderBy: SEARCH_ORDER,
    take: PAGE_SIZE,
  });
}

// Если ничего не нашлось — даём отправить в чат просьбу о помощи со ссылкой
// на каталог: в группе это тоже полезно (и приводит в КРУГ новых людей).
function notFoundResult(query) {
  return {
    type: 'article',
    id: 'not_found',
    title: `По запросу «${query}» пока никого нет`,
    description: 'Нажмите, чтобы спросить в чате и отправить ссылку на КРУГ',
    input_message_content: {
      message_text: `Ищу: ${query}. Кто-нибудь знает хорошего специалиста?\n\nА ещё можно посмотреть в КРУГ — справочнике услуг своих за границей 👇`,
    },
    reply_markup: { inline_keyboard: [[{ text: 'Открыть КРУГ', url: appLink() }]] },
  };
}

async function handleInlineQuery(inlineQuery, baseUrl) {
  const query = String(inlineQuery.query || '').trim().slice(0, 64);
  const offset = Math.max(0, Number(inlineQuery.offset) || 0);
  const userId = String(inlineQuery.from.id);

  let specialists;
  let nextOffset = '';
  if (!query) {
    specialists = offset ? [] : await personalSpecialists(userId);
  } else {
    specialists = await searchForInline(query, offset);
    if (specialists.length === PAGE_SIZE) nextOffset = String(offset + PAGE_SIZE);
  }

  let results = specialists.map((s) => buildPhotoResult(s, baseUrl, `s${s.id}`));
  if (!results.length && query && !offset) results = [notFoundResult(query)];

  const answer = await callTelegram('answerInlineQuery', {
    inline_query_id: inlineQuery.id,
    results,
    next_offset: nextOffset,
    // Пустой запрос показывает личные анкеты и избранное — их нельзя кэшировать
    // для всех; результаты поиска общие, их Telegram может кэшировать ненадолго.
    is_personal: !query,
    cache_time: query ? 60 : 10,
  });
  if (!answer.ok) console.error('answerInlineQuery отклонён:', answer.description);
}

// Telegram присылает боту только те типы событий, на которые он подписан.
// Если когда-то подписку ограничили (например, только платежами и сообщениями),
// поиск бы молча не работал — поэтому при запуске сервера проверяем и, если
// нужно, добавляем inline_query, не меняя остальных настроек.
async function ensureInlineUpdates() {
  const info = await callTelegram('getWebhookInfo', {});
  if (!info.ok || !info.result.url) return;
  const current = info.result.allowed_updates;
  if (!current || !current.length || current.includes('inline_query')) return; // по умолчанию и так приходят все
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) return;
  const res = await callTelegram('setWebhook', {
    url: info.result.url,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: [...current, 'inline_query'],
  });
  console.log(res.ok ? 'Вебхук: добавлена подписка на inline-поиск' : `Вебхук не обновился: ${res.description}`);
}

module.exports = { handleInlineQuery, ensureInlineUpdates };
