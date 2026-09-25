// Готовит картинку-карточку анкеты (JPEG) для сообщения "поделиться".
// Само рисование — в shareCardDraw.js; здесь шрифты, фото из Telegram и кэш.
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { drawShareCard, W, H, FONT_DISPLAY, FONT_BODY, FONT_BODY_BOLD } = require('./shareCardDraw');
const { downloadTelegramFile } = require('./telegramFiles');
const { toPublicId } = require('./publicId');

const COUNTRY_LABELS_RU = { Bulgaria: 'Болгария', Poland: 'Польша' };

// Те же шрифты, что в самом приложении (Unbounded для заголовков, Manrope для текста).
// На сервере Railway нет шрифтов с кириллицей, поэтому при первом запуске скачиваем
// их из Google Fonts и держим в памяти. Без User-Agent браузера Google отдаёт
// обычные .ttf-файлы — именно такие умеет подключать библиотека рисования.
const FONTS = [
  { alias: FONT_DISPLAY, family: 'Unbounded', weight: 700 },
  { alias: FONT_BODY, family: 'Manrope', weight: 500 },
  { alias: FONT_BODY_BOLD, family: 'Manrope', weight: 700 },
];

async function downloadFont({ family, weight }) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`;
  const cssRes = await fetch(cssUrl, { headers: { 'User-Agent': 'krug-backend' } });
  if (!cssRes.ok) throw new Error(`Google Fonts CSS ${family}: ${cssRes.status}`);
  const css = await cssRes.text();
  const match = css.match(/url\((https:[^)]+)\)\s*format\(['"](?:truetype|opentype)['"]\)/);
  if (!match) throw new Error(`Не найден ttf для шрифта ${family}`);
  const fontRes = await fetch(match[1]);
  if (!fontRes.ok) throw new Error(`Скачивание шрифта ${family}: ${fontRes.status}`);
  return Buffer.from(await fontRes.arrayBuffer());
}

let fontsPromise = null;
function ensureFonts() {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      for (const font of FONTS) {
        const buffer = await downloadFont(font);
        if (!GlobalFonts.register(buffer, font.alias)) {
          throw new Error(`Не удалось подключить шрифт ${font.family}`);
        }
      }
    })().catch((err) => {
      fontsPromise = null; // при следующем запросе попробуем снова
      throw err;
    });
  }
  return fontsPromise;
}

function cardData(specialist) {
  const city = specialist.city
    ? [specialist.city.label, COUNTRY_LABELS_RU[specialist.city.country] || specialist.city.country].filter(Boolean).join(', ')
    : '';
  return {
    name: specialist.name,
    role: specialist.role,
    city,
    chip: (specialist.subcategory && specialist.subcategory.label) || (specialist.category && specialist.category.label) || '',
    verified: specialist.verified,
    pro: specialist.pro,
    publicId: toPublicId(specialist.id),
    botLink: `t.me/${process.env.BOT_USERNAME || 'krugspace_bot'}`,
  };
}

async function render(specialist) {
  await ensureFonts();
  let photo = null;
  if (specialist.photoFileId) {
    try {
      const buffer = await downloadTelegramFile(specialist.photoFileId);
      if (buffer) photo = await loadImage(buffer);
    } catch (err) {
      // Без фото карточка всё равно получится — просто с инициалами.
      console.error('Карточка: не удалось загрузить фото', err.message);
    }
  }
  const canvas = createCanvas(W, H);
  drawShareCard(canvas.getContext('2d'), cardData(specialist), photo);
  return canvas.encode('jpeg', 90);
}

// Кэш готовых картинок: ключ включает время последнего изменения анкеты, так что
// после правки анкеты картинка сама перерисуется. Храним не больше 200 штук.
const cache = new Map();
const CACHE_LIMIT = 200;

function getShareCard(specialist) {
  const key = `${specialist.id}:${new Date(specialist.updatedAt).getTime()}`;
  if (cache.has(key)) return cache.get(key);
  const promise = render(specialist).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, promise);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return promise;
}

module.exports = { getShareCard, ensureFonts, CARD_WIDTH: W, CARD_HEIGHT: H };
