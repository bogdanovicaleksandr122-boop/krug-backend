// Общая сборка сообщения "карточка анкеты + кнопка Открыть анкету".
// Используется и кнопкой "поделиться" в приложении (routes/share.js), и поиском
// через строку @krugspace_bot в любом чате (lib/inlineSearch.js) — поэтому
// в обоих случаях в чат уходит одинаковое сообщение.
const { CARD_WIDTH, CARD_HEIGHT } = require('./shareCard');

const BOT_USERNAME = process.env.BOT_USERNAME || 'krugspace_bot';
const MINI_APP_NAME = process.env.MINI_APP_NAME || 'app';

// Публичный адрес этого сервера — Telegram сам скачивает по нему картинку.
// Railway сам сообщает свой домен в RAILWAY_PUBLIC_DOMAIN.
function publicBaseUrl(req) {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `${req.protocol}://${req.get('host')}`;
}

function appLink(startParam) {
  const base = `https://t.me/${BOT_USERNAME}/${MINI_APP_NAME}`;
  return startParam ? `${base}?startapp=${startParam}` : base;
}

// specialist должен быть загружен вместе с city (include: { city: true }).
function buildPhotoResult(specialist, baseUrl, resultId) {
  const version = new Date(specialist.updatedAt).getTime();
  const photoUrl = `${baseUrl}/api/specialists/${specialist.id}/share-card.jpg?v=${version}`;
  const cityText = specialist.city ? specialist.city.label : '';
  const caption = [`${specialist.name} — ${specialist.role}`, cityText ? `📍 ${cityText}` : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000);
  return {
    type: 'photo',
    id: resultId,
    photo_url: photoUrl,
    thumbnail_url: photoUrl,
    photo_width: CARD_WIDTH,
    photo_height: CARD_HEIGHT,
    title: specialist.name,
    description: specialist.role,
    caption,
    reply_markup: { inline_keyboard: [[{ text: 'Открыть анкету', url: appLink(`spec_${specialist.id}`) }]] },
  };
}

module.exports = { publicBaseUrl, appLink, buildPhotoResult, BOT_USERNAME };
