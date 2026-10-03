// Всё, что касается данных анкеты в одном месте:
// - какие поля можно отдавать всем (публично) — без служебных и личных данных;
// - проверка и приведение к единому виду того, что присылают пользователи;
// - разбор контактов (Telegram, Instagram, телефон, сайт) для сравнения.
const prisma = require('./prisma');
const { toPublicId } = require('./publicId');

// Поля, которые видит любой посетитель. Сюда НЕ входят: Telegram ID того, кто подал
// анкету, правки на проверке, причины отказа, служебные даты напоминаний и т.п.
const PUBLIC_SELECT = {
  id: true,
  name: true,
  role: true,
  about: true,
  services: true,
  contactsTelegram: true,
  contactsInstagram: true,
  contactsPhone: true,
  contactsWebsite: true,
  locationAddress: true,
  cityId: true,
  categoryId: true,
  subcategoryId: true,
  verified: true,
  pro: true,
  boosted: true,
  worksOnline: true,
  photoFileId: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { recommendations: true } },
};

// Превращает строку из базы (выбранную через PUBLIC_SELECT) в то, что уходит клиенту.
// Номер файла фото в Telegram наружу не отдаём — только признак "фото есть".
function toPublic(s) {
  const { photoFileId, _count, ...rest } = s;
  return {
    ...rest,
    services: Array.isArray(s.services) ? s.services : [],
    hasPhoto: !!photoFileId,
    recommendCount: _count ? _count.recommendations : 0,
    publicId: toPublicId(s.id),
  };
}

// Порядок в списках: буст (вперемешку, чтобы все забустившие получали показы
// поровну) → PRO → остальные: чаще рекомендуемые выше, затем подтверждённые, затем новые.
function sortForDisplay(list) {
  const boosted = list.filter((s) => s.boosted);
  const pro = list.filter((s) => !s.boosted && s.pro);
  const rest = list.filter((s) => !s.boosted && !s.pro);
  for (let i = boosted.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [boosted[i], boosted[j]] = [boosted[j], boosted[i]];
  }
  const recs = (s) => (s._count ? s._count.recommendations : s.recommendCount || 0);
  const byRest = (a, b) => (recs(b) - recs(a))
    || (Number(b.verified) - Number(a.verified))
    || (new Date(b.createdAt) - new Date(a.createdAt));
  return [...boosted, ...pro.sort(byRest), ...rest.sort(byRest)];
}

/* ---------- контакты: приведение к единому виду ---------- */

// "@Name", "name", "t.me/name", "https://t.me/name" → "name" (маленькими буквами).
// Если это не похоже на username Telegram — null.
function stripTelegram(value) {
  return String(value || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
}
function telegramHandle(value) {
  const s = stripTelegram(value);
  return /^[A-Za-z0-9_]{4,32}$/.test(s) ? s.toLowerCase() : null;
}

// "@name", "instagram.com/name/", "https://www.instagram.com/name?igsh=..." → "name"
function instagramHandle(value) {
  if (!value) return null;
  const s = String(value).trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(s) ? s.toLowerCase() : null;
}

// Последние 9 цифр номера — так "+359 88 123 4567" и "0881234567" совпадут
function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-9) : null;
}

// "https://www.Example.bg/page" → "example.bg"
function websiteHost(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

/* ---------- проверка данных анкеты ---------- */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.isValidation = true;
  }
}

const LIMITS = { name: 100, about: 1500, service: 100, services: 20, address: 200, phone: 30, website: 200, extraSubcategories: 30 };

function optionalText(value, max, label) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${label}: неверный формат`);
  const s = value.trim();
  if (!s) return null;
  if (s.length > max) throw new ValidationError(`${label}: слишком длинно (максимум ${max} символов)`);
  return s;
}

// Проверяет поля анкеты из запроса и приводит их к единому виду.
// partial = true — для правки: проверяются только присланные поля.
// Возвращает объект только с теми полями, что были в запросе.
async function cleanListingInput(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};

  if (!partial || 'name' in b) {
    const name = optionalText(b.name, LIMITS.name, 'Имя');
    if (!name) throw new ValidationError('Укажите имя или название');
    out.name = name;
  }
  if ('about' in b) out.about = optionalText(b.about, LIMITS.about, 'Описание') || '';
  else if (!partial) out.about = '';

  if ('services' in b) {
    if (!Array.isArray(b.services)) throw new ValidationError('Услуги: неверный формат');
    const services = b.services
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean);
    if (services.length > LIMITS.services) throw new ValidationError(`Можно указать не больше ${LIMITS.services} услуг`);
    if (services.some((s) => s.length > LIMITS.service)) throw new ValidationError(`Название услуги — не длиннее ${LIMITS.service} символов`);
    out.services = services;
  } else if (!partial) {
    out.services = [];
  }

  if ('contactsTelegram' in b) {
    const raw = optionalText(b.contactsTelegram, 100, 'Telegram');
    if (raw) {
      if (!telegramHandle(raw)) throw new ValidationError('Telegram: укажите username, например @name');
      // Сохраняем в виде "@name" — с большими буквами, как написал человек
      out.contactsTelegram = '@' + stripTelegram(raw);
    } else {
      out.contactsTelegram = null;
    }
  }
  if ('contactsInstagram' in b) {
    const raw = optionalText(b.contactsInstagram, 200, 'Instagram');
    if (raw) {
      const handle = instagramHandle(raw);
      if (!handle) throw new ValidationError('Instagram: укажите имя профиля, например @name');
      out.contactsInstagram = '@' + handle;
    } else {
      out.contactsInstagram = null;
    }
  }
  if ('contactsPhone' in b) {
    const raw = optionalText(b.contactsPhone, LIMITS.phone, 'Телефон');
    if (raw) {
      const digits = raw.replace(/\D/g, '');
      if (!/^[\d\s()+\-.]+$/.test(raw) || digits.length < 6 || digits.length > 15) {
        throw new ValidationError('Телефон: проверьте номер, например +359 88 123 4567');
      }
    }
    out.contactsPhone = raw;
  }
  if ('contactsWebsite' in b) {
    const raw = optionalText(b.contactsWebsite, LIMITS.website, 'Сайт');
    if (raw && (!websiteHost(raw) || /\s/.test(raw))) throw new ValidationError('Сайт: проверьте адрес, например example.bg');
    out.contactsWebsite = raw;
  }
  if ('locationAddress' in b) out.locationAddress = optionalText(b.locationAddress, LIMITS.address, 'Адрес');
  if ('worksOnline' in b) out.worksOnline = b.worksOnline === true;

  if (!partial || 'cityId' in b) {
    if (typeof b.cityId !== 'string' || !b.cityId) throw new ValidationError('Выберите город');
    const city = await prisma.city.findUnique({ where: { id: b.cityId } });
    if (!city) throw new ValidationError('Такого города нет в каталоге');
    out.cityId = city.id;
  }

  if (!partial) {
    if (typeof b.categoryId !== 'string' || typeof b.subcategoryId !== 'string') {
      throw new ValidationError('Выберите категорию и подкатегорию');
    }
    const sub = await prisma.subcategory.findUnique({ where: { id: b.subcategoryId } });
    if (!sub || sub.categoryId !== b.categoryId) throw new ValidationError('Такой подкатегории нет в каталоге');
    out.categoryId = sub.categoryId;
    out.subcategoryId = sub.id;
    out.role = sub.label;
  }

  if ('extraSubcategories' in b) {
    if (!Array.isArray(b.extraSubcategories)) throw new ValidationError('Дополнительные подкатегории: неверный формат');
    const ids = [...new Set(b.extraSubcategories.filter((x) => typeof x === 'string'))];
    if (ids.length > LIMITS.extraSubcategories) throw new ValidationError(`Можно выбрать не больше ${LIMITS.extraSubcategories} дополнительных подкатегорий`);
    const found = ids.length ? await prisma.subcategory.findMany({ where: { id: { in: ids } }, select: { id: true } }) : [];
    if (found.length !== ids.length) throw new ValidationError('Такой подкатегории нет в каталоге');
    out.extraSubcategories = ids;
  }

  return out;
}

function hasAnyContact(s) {
  return !!(s.contactsTelegram || s.contactsInstagram || s.contactsPhone || s.contactsWebsite);
}

// Условие "анкета видна в этом городе": её город — или она работает онлайн / по всей
// стране, и её город в той же стране.
async function cityWhere(cityId) {
  if (!cityId) return {};
  const city = await prisma.city.findUnique({ where: { id: String(cityId) } });
  if (!city) return { cityId: String(cityId) };
  return { OR: [{ cityId: city.id }, { worksOnline: true, city: { is: { country: city.country } } }] };
}

// Условие "анкета в этой подкатегории": основная подкатегория — или дополнительная
// (дополнительные действуют только пока у анкеты активен PRO).
function subcategoryWhere(subcategoryId) {
  const id = String(subcategoryId);
  return { OR: [{ subcategoryId: id }, { pro: true, extraSubcategories: { has: id } }] };
}

module.exports = {
  PUBLIC_SELECT,
  toPublic,
  sortForDisplay,
  telegramHandle,
  instagramHandle,
  phoneKey,
  websiteHost,
  ValidationError,
  cleanListingInput,
  hasAnyContact,
  cityWhere,
  subcategoryWhere,
};
