const express = require('express');
const jwt = require('jsonwebtoken');
const { parse } = require('csv-parse/sync');
const prisma = require('../lib/prisma');
const adminAuth = require('../middleware/adminAuth');
const { adminLoginLimiter } = require('../middleware/rateLimiters');
const { uploadPhotoToTelegram, streamTelegramFile } = require('../lib/telegramFiles');
const { toPublicId, fromPublicId } = require('../lib/publicId');

const router = express.Router();

// Подмешивает в анкету данные о том, кто её подал (юзернейм/имя из TelegramUser —
// эта таблица и так пополняется автоматически при каждом заходе в приложение), плюс
// публичный номер анкеты. TelegramUser и Specialist не связаны через Prisma-релацию
// (это просто совпадающие строковые id), поэтому собираем вручную одним доп. запросом
// на весь список сразу, а не по одному на анкету.
async function attachSubmitters(specialists) {
  const ids = [...new Set(specialists.map((s) => s.telegramUserId).filter(Boolean))];
  const users = ids.length
    ? await prisma.telegramUser.findMany({ where: { id: { in: ids } } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return specialists.map((s) => ({
    ...s,
    publicId: toPublicId(s.id),
    submitter: s.telegramUserId
      ? (byId.get(s.telegramUserId) || { id: s.telegramUserId, username: null, firstName: null, lastName: null })
      : null,
  }));
}

// Вход в админку. Для простоты старта — один логин/пароль из переменных окружения
// (не из базы). Когда появится несколько модераторов, легко переключить на таблицу Admin + bcrypt.
// adminLoginLimiter не даёт перебирать пароль: не больше 5 попыток за 15 минут с одного адреса.
router.post('/login', adminLoginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = jwt.sign({ username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

router.use(adminAuth); // всё, что ниже, требует токен

/* ================= Заявки на проверке (очередь модерации) ================= */

router.get('/pending', async (req, res) => {
  const pending = await prisma.specialist.findMany({
    where: { status: 'pending' },
    include: { category: true, subcategory: true, city: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json(await attachSubmitters(pending));
});

router.post('/specialists/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });

  // Если это была правка уже опубликованной анкеты (pendingChanges) — применяем
  // накопленные изменения к живым полям. Если это новая заявка — просто публикуем.
  const data = specialist.pendingChanges
    ? { ...specialist.pendingChanges, status: 'published', pendingChanges: null }
    : { status: 'published' };

  const updated = await prisma.specialist.update({ where: { id }, data });
  await prisma.moderationLog.create({ data: { specialistId: id, action: 'approve' } });
  res.json(updated);
});

router.post('/specialists/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  const { reason } = req.body;
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });

  // Отклонение правки уже опубликованной анкеты — отбрасываем предложенные
  // изменения и возвращаем анкету как было, без статуса "отклонено", но
  // сохраняем причину отдельно (editRejectionReason), чтобы владелец анкеты
  // увидел её в кабинете — раньше причина никуда не сохранялась и терялась.
  const data = specialist.pendingChanges
    ? {
        pendingChanges: null,
        status: 'published',
        editRejectionReason: reason || 'Без указания причины',
        editRejectedAt: new Date(),
      }
    : { status: 'rejected', rejectionReason: reason || 'Без указания причины' };

  const updated = await prisma.specialist.update({ where: { id }, data });
  await prisma.moderationLog.create({ data: { specialistId: id, action: 'reject', reason } });
  res.json(updated);
});

/* ================= Полное управление анкетами ================= */

// Список всех анкет (любой статус) — с фильтрами по статусу и текстовому поиску.
// Поиск теперь охватывает не только имя/специализацию, но и номер анкеты
// (100000000042) и данные того, кто анкету подал — Telegram ID или username.
router.get('/specialists', async (req, res) => {
  const { status, search } = req.query;
  const where = {};
  if (status) where.status = status;

  if (search) {
    const term = search.trim();
    const or = [
      { name: { contains: term, mode: 'insensitive' } },
      { role: { contains: term, mode: 'insensitive' } },
    ];

    const idFromPublic = fromPublicId(term);
    if (idFromPublic) or.push({ id: idFromPublic });

    const usernameQuery = term.replace(/^@/, '');
    const matchingUsers = await prisma.telegramUser.findMany({
      where: { OR: [{ id: term }, { username: { contains: usernameQuery, mode: 'insensitive' } }] },
      select: { id: true },
    });
    if (matchingUsers.length) {
      or.push({ telegramUserId: { in: matchingUsers.map((u) => u.id) } });
    }

    where.OR = or;
  }

  const specialists = await prisma.specialist.findMany({
    where,
    include: { category: true, subcategory: true, city: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(await attachSubmitters(specialists));
});

router.get('/specialists/:id', async (req, res) => {
  const specialist = await prisma.specialist.findUnique({
    where: { id: Number(req.params.id) },
    include: { category: true, subcategory: true, city: true },
  });
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });
  const [withSubmitter] = await attachSubmitters([specialist]);
  res.json(withSubmitter);
});

const EDITABLE_FIELDS = [
  'name', 'role', 'about', 'langs', 'services',
  'contactsTelegram', 'contactsInstagram', 'contactsPhone', 'contactsWebsite',
  'locationAddress', 'cityId', 'categoryId', 'subcategoryId', 'status', 'rejectionReason',
  'verified', 'pro', 'proExpiresAt', 'boosted', 'boostedUntil',
];

function pickEditableFields(body) {
  const data = {};
  EDITABLE_FIELDS.forEach((key) => {
    if (key in body) data[key] = body[key];
  });
  if (data.proExpiresAt) data.proExpiresAt = new Date(data.proExpiresAt);
  if (data.boostedUntil) data.boostedUntil = new Date(data.boostedUntil);
  return data;
}

// Ручное создание анкеты админом — в отличие от публичной формы, здесь можно сразу
// указать статус published и вручную выставить verified/pro/boosted без оплаты.
router.post('/specialists', async (req, res) => {
  const data = pickEditableFields(req.body);
  if (!data.name || !data.role || !data.categoryId || !data.subcategoryId) {
    return res.status(400).json({ error: 'Не хватает обязательных полей (имя, специализация, категория, подкатегория)' });
  }
  try {
    const specialist = await prisma.specialist.create({ data: { status: 'published', ...data } });
    res.status(201).json(specialist);
  } catch (e) {
    res.status(400).json({ error: 'Не удалось создать анкету: ' + e.message });
  }
});

// Полное ручное редактирование анкеты — админ может менять любое поле,
// включая verified/pro/boosted без прохождения оплаты пользователем
router.put('/specialists/:id', async (req, res) => {
  const id = Number(req.params.id);
  const data = pickEditableFields(req.body);
  data.pendingChanges = null; // ручное редактирование админом отменяет любые несогласованные правки владельца
  try {
    const specialist = await prisma.specialist.update({ where: { id }, data });
    await prisma.moderationLog.create({ data: { specialistId: id, action: 'admin-edit' } });
    res.json(specialist);
  } catch (e) {
    res.status(400).json({ error: 'Не удалось сохранить: ' + e.message });
  }
});

router.delete('/specialists/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.specialist.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: 'Не удалось удалить анкету' });
  }
});

// Загрузка фото админом — применяется сразу, без очереди модерации (в отличие от
// фото, которое загружает сам владелец через /api/me/...). Получателем в Telegram,
// через которого фото прогоняется, чтобы получить file_id, ВСЕГДА выступает
// служебный чат TELEGRAM_FILE_RELAY_CHAT_ID (личный чат владельца приложения с ботом),
// а не чат владельца анкеты. Раньше, если анкета уже была привязана к владельцу,
// фото отправлялось прямо в его личный чат с ботом — это открывало уязвимость:
// пользователь мог загрузить недопустимый контент и затем пожаловаться в Telegram
// на сообщение «от бота» в СВОЁМ ЖЕ чате, что грозило блокировкой всего бота.
// Теперь бот никогда не отправляет загруженное фото обратно в чат того, кто его
// прислал, — только в закрытый служебный чат, который контролирует сам владелец приложения.
router.post('/specialists/:id/photo', express.raw({ type: 'image/*', limit: '8mb' }), async (req, res) => {
  const id = Number(req.params.id);
  const specialist = await prisma.specialist.findUnique({ where: { id } });
  if (!specialist) return res.status(404).json({ error: 'Анкета не найдена' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Файл не получен' });

  const chatId = process.env.TELEGRAM_FILE_RELAY_CHAT_ID;
  if (!chatId) {
    return res.status(400).json({
      error: 'Нет служебного получателя для загрузки фото — задайте переменную TELEGRAM_FILE_RELAY_CHAT_ID в Railway (ваш личный Telegram id)',
    });
  }
  try {
    const fileId = await uploadPhotoToTelegram(req.body, req.headers['content-type'], chatId);
    const updated = await prisma.specialist.update({ where: { id }, data: { photoFileId: fileId } });
    res.json({ ok: true, specialist: updated });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось загрузить фото: ' + e.message });
  }
});

// Превью фото, которое ещё не одобрено (лежит в pendingChanges) — только для админки,
// публично оно не отдаётся, пока анкету не одобрят.
router.get('/specialists/:id/pending-photo', async (req, res) => {
  const specialist = await prisma.specialist.findUnique({ where: { id: Number(req.params.id) } });
  const fileId = specialist && specialist.pendingChanges && specialist.pendingChanges.photoFileId;
  if (!fileId) return res.status(404).json({ error: 'Нет фото на проверке' });
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  await streamTelegramFile(fileId, res);
});

/* ================= Категории / города (редактирование) ================= */
// Списки для чтения отдаются публичными /api/categories и /api/cities — здесь только запись.

router.put('/categories/:id', async (req, res) => {
  const { label, icon, sortOrder } = req.body;
  const data = {};
  if (label !== undefined) data.label = label;
  if (icon !== undefined) data.icon = icon;
  if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);
  try {
    const category = await prisma.category.update({ where: { id: req.params.id }, data });
    res.json(category);
  } catch (e) {
    res.status(400).json({ error: 'Не удалось сохранить категорию' });
  }
});

router.put('/subcategories/:id', async (req, res) => {
  const { label, sortOrder } = req.body;
  const data = {};
  if (label !== undefined) data.label = label;
  if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);
  try {
    const subcategory = await prisma.subcategory.update({ where: { id: req.params.id }, data });
    res.json(subcategory);
  } catch (e) {
    res.status(400).json({ error: 'Не удалось сохранить подкатегорию' });
  }
});

// Создание города вручную (без CSV) — например, чтобы завести новую страну
// с несколькими городами ещё до того, как в ней появятся первые анкеты.
router.post('/cities', async (req, res) => {
  const { label, country, sortOrder, isDefault } = req.body;
  if (!label || !country) {
    return res.status(400).json({ error: 'Нужны название города и страна' });
  }
  try {
    const base = slugify(label); // slugify объявлена ниже в этом же файле (function-декларации поднимаются наверх)
    let id = base;
    let n = 2;
    while (await prisma.city.findUnique({ where: { id } })) {
      id = `${base}-${n}`;
      n += 1;
    }
    const city = await prisma.city.create({
      data: { id, label, country, sortOrder: Number(sortOrder) || 0, isDefault: !!isDefault },
    });
    res.status(201).json(city);
  } catch (e) {
    res.status(400).json({ error: 'Не удалось создать город: ' + e.message });
  }
});

router.put('/cities/:id', async (req, res) => {
  const { label, country, sortOrder, isDefault } = req.body;
  const data = {};
  if (label !== undefined) data.label = label;
  if (country !== undefined) data.country = country;
  if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);
  if (isDefault !== undefined) data.isDefault = !!isDefault;
  try {
    const city = await prisma.city.update({ where: { id: req.params.id }, data });
    res.json(city);
  } catch (e) {
    res.status(400).json({ error: 'Не удалось сохранить город' });
  }
});

/* ================= Массовая загрузка через CSV ================= */

const VALID_ICONS = ['home', 'sparkle', 'gear', 'doc', 'cap', 'cup', 'car', 'box', 'users', 'dumbbell', 'smiley', 'paw', 'building', 'briefcase', 'gift', 'heart'];

// Простая транслитерация кириллицы — только чтобы получить читаемый технический id,
// на отображение в приложении не влияет (там используется label).
const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: '', ю: 'yu', я: 'ya',
};
function slugify(text) {
  const lower = String(text || '').toLowerCase();
  let out = '';
  for (const ch of lower) out += CYRILLIC_MAP[ch] !== undefined ? CYRILLIC_MAP[ch] : ch;
  out = out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'item';
}
function truthy(v) {
  return ['да', 'yes', 'true', '1', 'y', 'д'].includes(String(v || '').trim().toLowerCase());
}

// Принимает сырой текст CSV (не JSON!) — так проще загружать файл с телефона/компьютера
// без лишней библиотеки для отправки файлов. Если указанные страна/город/категория/
// подкатегория ещё не существуют — создаёт их на лету.
router.post('/specialists/bulk-csv', express.text({ type: '*/*', limit: '5mb' }), async (req, res) => {
  let rows;
  try {
    rows = parse(req.body, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (e) {
    return res.status(400).json({ error: 'Не удалось прочитать CSV: ' + e.message });
  }
  if (!rows.length) {
    return res.status(400).json({ error: 'Файл пустой или без строк с данными' });
  }

  const [existingCities, existingCategories, existingSubcategories] = await Promise.all([
    prisma.city.findMany(),
    prisma.category.findMany(),
    prisma.subcategory.findMany(),
  ]);

  const cityMap = new Map(existingCities.map((c) => [`${c.label.toLowerCase()}|${c.country.toLowerCase()}`, c]));
  const categoryMap = new Map(existingCategories.map((c) => [c.label.toLowerCase(), c]));
  const subcategoryMap = new Map(existingSubcategories.map((s) => [`${s.categoryId}|${s.label.toLowerCase()}`, s]));
  const usedIds = new Set([
    ...existingCities.map((c) => c.id),
    ...existingCategories.map((c) => c.id),
    ...existingSubcategories.map((s) => s.id),
  ]);

  function uniqueId(base) {
    let id = slugify(base);
    let n = 2;
    while (usedIds.has(id)) {
      id = `${slugify(base)}-${n}`;
      n += 1;
    }
    usedIds.add(id);
    return id;
  }

  const createdCities = [];
  const createdCategories = [];
  const createdSubcategories = [];
  const createdSpecialistIds = [];
  const errors = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const lineNo = i + 2; // +1 за заголовок, +1 за индексацию с единицы
    try {
      const countryName = (row.country || '').trim();
      const cityName = (row.city || '').trim();
      const categoryName = (row.category || '').trim();
      const subcategoryName = (row.subcategory || '').trim();
      const name = (row.name || '').trim();

      if (!cityName || !categoryName || !subcategoryName || !name) {
        errors.push(`Строка ${lineNo}: не хватает city/category/subcategory/name`);
        continue;
      }

      const cityKey = `${cityName.toLowerCase()}|${(countryName || 'Bulgaria').toLowerCase()}`;
      let city = cityMap.get(cityKey);
      if (!city) {
        city = await prisma.city.create({
          data: {
            id: uniqueId(cityName),
            label: cityName,
            country: countryName || 'Bulgaria',
            sortOrder: existingCities.length + createdCities.length,
          },
        });
        cityMap.set(cityKey, city);
        createdCities.push(city);
      }

      const catKey = categoryName.toLowerCase();
      let category = categoryMap.get(catKey);
      if (!category) {
        const iconRaw = (row.category_icon || '').trim().toLowerCase();
        const icon = VALID_ICONS.includes(iconRaw) ? iconRaw : 'briefcase';
        category = await prisma.category.create({
          data: {
            id: uniqueId(categoryName),
            label: categoryName,
            icon,
            sortOrder: existingCategories.length + createdCategories.length,
          },
        });
        categoryMap.set(catKey, category);
        createdCategories.push(category);
      }

      const subKey = `${category.id}|${subcategoryName.toLowerCase()}`;
      let subcategory = subcategoryMap.get(subKey);
      if (!subcategory) {
        subcategory = await prisma.subcategory.create({
          data: {
            id: uniqueId(`${category.id}-${subcategoryName}`),
            categoryId: category.id,
            label: subcategoryName,
            sortOrder: 0,
          },
        });
        subcategoryMap.set(subKey, subcategory);
        createdSubcategories.push(subcategory);
      }

      const langs = (row.langs || '').split('|').map((s) => s.trim()).filter(Boolean);
      const services = (row.services || '').split('|').map((s) => s.trim()).filter(Boolean);
      const statusRaw = (row.status || 'published').trim().toLowerCase();
      const status = ['pending', 'published', 'rejected'].includes(statusRaw) ? statusRaw : 'published';

      const specialist = await prisma.specialist.create({
        data: {
          name,
          role: (row.role || '').trim() || subcategory.label,
          about: (row.about || '').trim(),
          langs,
          services,
          contactsTelegram: (row.contactsTelegram || '').trim() || null,
          contactsInstagram: (row.contactsInstagram || '').trim() || null,
          contactsPhone: (row.contactsPhone || '').trim() || null,
          contactsWebsite: (row.contactsWebsite || '').trim() || null,
          locationAddress: (row.locationAddress || '').trim() || null,
          cityId: city.id,
          categoryId: category.id,
          subcategoryId: subcategory.id,
          status,
          verified: truthy(row.verified),
          pro: truthy(row.pro),
          boosted: truthy(row.boosted),
        },
      });
      createdSpecialistIds.push(specialist.id);
    } catch (e) {
      errors.push(`Строка ${lineNo}: ${e.message}`);
    }
  }

  res.json({
    createdSpecialists: createdSpecialistIds.length,
    createdCities: createdCities.map((c) => c.label),
    createdCategories: createdCategories.map((c) => c.label),
    createdSubcategories: createdSubcategories.map((s) => s.label),
    errors,
  });
});

/* ================= Статистика ================= */

router.get('/stats', async (req, res) => {
  const now = new Date();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers, activeUsers24h, activeUsers7d,
    totalSpecialists, pendingCount, publishedCount, rejectedCount,
    totalCategories, totalCities, totalFavorites,
    proCount, boostedCount, newSpecialists7d,
    paymentsAgg, categoryCounts, cityCounts,
  ] = await Promise.all([
    prisma.telegramUser.count(),
    prisma.telegramUser.count({ where: { lastSeenAt: { gte: dayAgo } } }),
    prisma.telegramUser.count({ where: { lastSeenAt: { gte: weekAgo } } }),
    prisma.specialist.count(),
    prisma.specialist.count({ where: { status: 'pending' } }),
    prisma.specialist.count({ where: { status: 'published' } }),
    prisma.specialist.count({ where: { status: 'rejected' } }),
    prisma.category.count(),
    prisma.city.count(),
    prisma.favorite.count(),
    prisma.specialist.count({ where: { pro: true } }),
    prisma.specialist.count({ where: { boosted: true } }),
    prisma.specialist.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.payment.groupBy({ by: ['type'], _sum: { starsAmount: true }, _count: true }),
    // Раньше здесь стояло orderBy: { _count: 'desc' } — Prisma требует для сортировки
    // по агрегату указывать конкретное поле внутри _count (см. документацию по groupBy),
    // без этого запрос падал с ошибкой валидации ещё до похода в базу — и так как это
    // было в одном Promise.all со всей остальной статистикой, падал весь /stats разом.
    prisma.specialist.groupBy({ by: ['categoryId'], _count: { categoryId: true }, orderBy: { _count: { categoryId: 'desc' } }, take: 5 }),
    prisma.specialist.groupBy({ by: ['cityId'], _count: { cityId: true }, orderBy: { _count: { cityId: 'desc' } }, take: 5 }),
  ]);

  const categories = await prisma.category.findMany({ where: { id: { in: categoryCounts.map((c) => c.categoryId) } } });
  const cities = await prisma.city.findMany({ where: { id: { in: cityCounts.map((c) => c.cityId).filter(Boolean) } } });

  res.json({
    users: { total: totalUsers, active24h: activeUsers24h, active7d: activeUsers7d },
    specialists: {
      total: totalSpecialists, pending: pendingCount, published: publishedCount, rejected: rejectedCount,
      pro: proCount, boosted: boostedCount, newLast7d: newSpecialists7d,
    },
    catalog: { categories: totalCategories, cities: totalCities },
    favorites: totalFavorites,
    payments: paymentsAgg.map((p) => ({ type: p.type, count: p._count, starsTotal: p._sum.starsAmount || 0 })),
    topCategories: categoryCounts.map((c) => ({
      label: (categories.find((cat) => cat.id === c.categoryId) || {}).label || c.categoryId,
      count: c._count.categoryId,
    })),
    topCities: cityCounts.map((c) => ({
      label: (cities.find((city) => city.id === c.cityId) || {}).label || c.cityId || 'Без города',
      count: c._count.cityId,
    })),
  });
});

router.get('/users', async (req, res) => {
  const users = await prisma.telegramUser.findMany({ orderBy: { lastSeenAt: 'desc' } });
  res.json(users);
});

module.exports = router;
