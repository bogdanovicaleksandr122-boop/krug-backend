// Общий поиск анкет — один и тот же и в приложении (строка поиска), и в поиске
// через "@krugspace_bot запрос" в любом чате. Ищет по имени, специализации,
// описанию, списку услуг, названиям категорий, подкатегорий и городов,
// понимает разные окончания слов ("бухгалтера", "Варне").
const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');
const { cityWhere } = require('./specialistData');

// Порядок результатов: буст → PRO → чаще рекомендуемые → подтверждённые → новые
const SEARCH_ORDER = [
  { boosted: 'desc' },
  { pro: 'desc' },
  { recommendations: { _count: 'desc' } },
  { verified: 'desc' },
  { id: 'desc' },
];

// Грубое "отрезание окончаний", чтобы "бухгалтера", "Варне", "Софии" находили
// "бухгалтер", "Варна", "София". Для поиска по справочнику этого достаточно.
function stem(word) {
  if (word.length >= 6) return word.slice(0, -2);
  if (word.length === 5) return word.slice(0, -1);
  return word;
}

function searchWords(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 5)
    .map(stem);
}

// Услуги хранятся списком (JSON) — ищем по его тексту прямым запросом к базе.
// В словах остаются только буквы, цифры и дефис, поэтому подстановка безопасна.
async function idsByServices(word) {
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT id FROM "Specialist"
    WHERE status = 'published' AND services::text ILIKE ${'%' + word + '%'}
    LIMIT 500`);
  return rows.map((r) => r.id);
}

async function wordFilter(word) {
  const has = { contains: word, mode: 'insensitive' };
  const [serviceIds, subcategories] = await Promise.all([
    idsByServices(word),
    prisma.subcategory.findMany({ where: { label: has }, select: { id: true } }),
  ]);
  const subIds = subcategories.map((s) => s.id);
  const or = [
    { name: has },
    { role: has },
    { about: has },
    { category: { is: { label: has } } },
    { city: { is: { label: has } } },
  ];
  if (serviceIds.length) or.push({ id: { in: serviceIds } });
  if (subIds.length) {
    or.push({ subcategoryId: { in: subIds } });
    // Дополнительные подкатегории PRO-анкет
    or.push({ pro: true, extraSubcategories: { hasSome: subIds } });
  }
  return { OR: or };
}

// query — текст поиска; cityId — если задан, только этот город (плюс анкеты,
// работающие онлайн по стране). select/include — какие поля вернуть.
async function searchSpecialists({ query, cityId = null, skip = 0, take = 50, select, include }) {
  const words = searchWords(query);
  if (!words.length) return [];
  const conditions = await Promise.all(words.map(wordFilter));
  if (cityId) conditions.push(await cityWhere(cityId));
  return prisma.specialist.findMany({
    where: { status: 'published', AND: conditions },
    orderBy: SEARCH_ORDER,
    skip,
    take,
    ...(select ? { select } : {}),
    ...(include ? { include } : {}),
  });
}

module.exports = { searchSpecialists, searchWords, SEARCH_ORDER };
