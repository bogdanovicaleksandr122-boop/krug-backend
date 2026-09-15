// Заполняет базу теми же категориями/городами/демо-специалистами, что были в прототипе.
// Запуск: npm run seed

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CITIES = [
  { id: 'sofia', label: 'София', isDefault: true, sortOrder: 0 },
  { id: 'plovdiv', label: 'Пловдив', sortOrder: 1 },
  { id: 'varna', label: 'Варна', sortOrder: 2 },
  { id: 'burgas', label: 'Бургас', sortOrder: 3 },
  { id: 'ruse', label: 'Русе', sortOrder: 4 },
  { id: 'stara-zagora', label: 'Стара Загора', sortOrder: 5 },
  { id: 'pleven', label: 'Плевен', sortOrder: 6 },
  { id: 'sliven', label: 'Сливен', sortOrder: 7 },
  { id: 'dobrich', label: 'Добрич', sortOrder: 8 },
  { id: 'shumen', label: 'Шумен', sortOrder: 9 },
];

const CATEGORIES = [
  { id: 'beauty', label: 'Красота и уход', icon: 'sparkle', subcats: [
    { id: 'salons', label: 'Салоны красоты' }, { id: 'nails', label: 'Маникюр/педикюр' }, { id: 'hair', label: 'Парикмахер/Барбер' },
    { id: 'cosmetology', label: 'Косметология' }, { id: 'brows', label: 'Брови/Ресницы/Макияж' }, { id: 'massage', label: 'Массаж' }, { id: 'tattoo', label: 'Тату' },
  ]},
  { id: 'repair', label: 'Бытовые услуги и ремонт', icon: 'gear', subcats: [
    { id: 'plumber', label: 'Сантехник' }, { id: 'electrician', label: 'Электрик' }, { id: 'cleaning', label: 'Уборка' },
    { id: 'renovation', label: 'Ремонт квартир' }, { id: 'furniture', label: 'Сборка мебели' }, { id: 'appliances', label: 'Ремонт техники' },
  ]},
  { id: 'legal', label: 'Юридические услуги', icon: 'doc', subcats: [
    { id: 'immigration', label: 'Иммиграционные вопросы' }, { id: 'labor', label: 'Трудовое право' },
    { id: 'business-reg', label: 'Открытие бизнеса' }, { id: 'realestate-law', label: 'Сделки с недвижимостью' }, { id: 'family', label: 'Семейное право' },
  ]},
  { id: 'education', label: 'Курсы и школы', icon: 'cap', subcats: [
    { id: 'language', label: 'Языковые курсы' }, { id: 'driving', label: 'Автошкола' }, { id: 'tutors', label: 'Репетиторы' }, { id: 'online', label: 'Онлайн-курсы' },
  ]},
  { id: 'food', label: 'Еда, доставка', icon: 'cup', subcats: [
    { id: 'delivery', label: 'Доставка еды' }, { id: 'catering', label: 'Кейтеринг' }, { id: 'homemade', label: 'Домашняя выпечка' }, { id: 'restaurants', label: 'Рестораны «своих»' },
  ]},
  { id: 'auto', label: 'Авто и обслуживание', icon: 'car', subcats: [
    { id: 'mechanic', label: 'Автомеханик' }, { id: 'carwash', label: 'Автомойка' }, { id: 'tires', label: 'Шиномонтаж' }, { id: 'rental', label: 'Прокат авто' },
  ]},
  { id: 'moving', label: 'Аренда и переезд', icon: 'box', subcats: [
    { id: 'rent', label: 'Аренда жилья' }, { id: 'movers', label: 'Помощь с переездом' }, { id: 'cargo', label: 'Грузоперевозки' }, { id: 'storage', label: 'Хранение вещей' },
  ]},
  { id: 'events', label: 'События и сообщества', icon: 'users', subcats: [
    { id: 'organizers', label: 'Организация мероприятий' }, { id: 'communities', label: 'Локальные сообщества' }, { id: 'photo', label: 'Фото/видеосъёмка' },
  ]},
  { id: 'sport', label: 'Спорт и фитнес', icon: 'dumbbell', subcats: [
    { id: 'gyms', label: 'Тренажёрные залы' }, { id: 'personal', label: 'Персональные тренировки' }, { id: 'yoga', label: 'Йога' }, { id: 'dance', label: 'Танцы' },
  ]},
  { id: 'kids', label: 'Для детей', icon: 'smiley', subcats: [
    { id: 'nanny', label: 'Няни' }, { id: 'kindergarten', label: 'Сады и кружки' }, { id: 'parties', label: 'Детские праздники' },
  ]},
  { id: 'pets', label: 'Для животных', icon: 'paw', subcats: [
    { id: 'vet', label: 'Ветеринары' }, { id: 'grooming', label: 'Груминг' }, { id: 'sitting', label: 'Передержка/выгул' },
  ]},
  { id: 'business', label: 'Для бизнеса', icon: 'building', subcats: [
    { id: 'accounting', label: 'Бухгалтерия' }, { id: 'marketing', label: 'Маркетинг' }, { id: 'it', label: 'IT-услуги' }, { id: 'translation', label: 'Перевод документов' },
  ]},
  { id: 'jobs', label: 'Работа', icon: 'briefcase', subcats: [
    { id: 'vacancies', label: 'Поиск вакансий' }, { id: 'resume', label: 'Резюме и собеседования' }, { id: 'employment', label: 'Помощь с трудоустройством' },
  ]},
  { id: 'gifts', label: 'Праздники и подарки', icon: 'gift', subcats: [
    { id: 'flowers', label: 'Цветы и подарки' }, { id: 'confectioners', label: 'Кондитеры' }, { id: 'decor', label: 'Праздничное оформление' },
  ]},
];

// Демо-специалисты из прототипа (для проверки, что всё работает после переезда на базу данных)
const DEMO_SPECIALISTS = [
  { id: 101, categoryId: 'beauty', subcategoryId: 'nails', name: 'Марта Й.', langs: ['RU', 'UA'], role: 'Маникюр/педикюр',
    about: 'Мастер маникюра и педикюра, работаю на дому и в студии. Аппаратный и классический маникюр, покрытие гель-лак.',
    services: ['Классический маникюр', 'Аппаратный педикюр', 'Покрытие гель-лаком'],
    contactsTelegram: '@marta_nails', contactsInstagram: '@marta.nails.sofia', contactsPhone: '+359 88 123 4567',
    locationAddress: 'ул. Витоша 25, София' },
  { id: 102, categoryId: 'beauty', subcategoryId: 'hair', name: 'Виктор С.', langs: ['RU'], role: 'Парикмахер/Барбер',
    about: 'Барбер с 6-летним опытом, стрижки и укладки для мужчин и женщин, говорю по-русски.',
    services: ['Стрижка', 'Укладка', 'Оформление бороды'],
    contactsTelegram: '@viktor_barber', contactsPhone: '+359 87 234 5678',
    locationAddress: 'бул. Витоша 89, София' },
  { id: 103, categoryId: 'beauty', subcategoryId: 'massage', name: 'Ольга Т.', langs: ['RU', 'UA'], role: 'Массаж',
    about: 'Классический и лечебный массаж, выезд на дом по Софии.',
    services: ['Классический массаж', 'Спортивный массаж', 'Выезд на дом'],
    contactsInstagram: '@olga.massage.sofia' },
  { id: 104, categoryId: 'repair', subcategoryId: 'plumber', name: 'Николай Р.', langs: ['RU'], role: 'Сантехник',
    about: 'Ремонт и установка сантехники, устранение протечек, вызов в день обращения.',
    services: ['Устранение протечек', 'Установка сантехники', 'Аварийный вызов'],
    contactsPhone: '+359 89 345 6789', locationAddress: 'работает по всей Софии' },
  { id: 105, categoryId: 'legal', subcategoryId: 'immigration', name: 'Анна К.', langs: ['RU', 'UA'], role: 'Иммиграционные вопросы',
    about: 'Помогаю с видом на жительство, продлением документов и переводом бумаг для Болгарии.',
    services: ['Консультация по ВНЖ', 'Перевод документов', 'Продление документов'],
    contactsTelegram: '@anna_legal', contactsWebsite: 'anna-legal.bg', contactsPhone: '+359 88 456 7890',
    locationAddress: 'ул. Раковски 55, София' },
  { id: 106, categoryId: 'education', subcategoryId: 'language', name: 'Школа «Диалог»', langs: ['RU', 'UA'], role: 'Курсы болгарского языка',
    about: 'Групповые и индивидуальные курсы болгарского языка для всех уровней, утренние и вечерние группы.',
    services: ['Группы для начинающих', 'Индивидуальные занятия', 'Подготовка к экзамену'],
    contactsTelegram: '@dialog_school', contactsInstagram: '@dialog.sofia', contactsWebsite: 'dialog-school.bg',
    verified: true, locationAddress: 'ул. Граф Игнатиев 12, София' },
  { id: 107, categoryId: 'auto', subcategoryId: 'mechanic', name: 'Игорь П.', langs: ['RU', 'UA'], role: 'Автомеханик',
    about: 'Диагностика и ремонт двигателя, честная оценка стоимости до начала работ.',
    services: ['Компьютерная диагностика', 'Ремонт двигателя', 'Замена масла'],
    contactsTelegram: '@igor_auto', contactsPhone: '+359 87 567 8901',
    verified: true, locationAddress: 'ж.к. Люлин, София' },
  { id: 108, categoryId: 'kids', subcategoryId: 'nanny', name: 'Мария Д.', langs: ['RU'], role: 'Няня',
    about: 'Няня с педагогическим образованием, опыт работы с детьми от 1 года, говорю по-русски и по-болгарски.',
    services: ['Присмотр за ребёнком', 'Прогулки и развивающие игры', 'Помощь с домашними заданиями'],
    contactsTelegram: '@maria_nanny', contactsPhone: '+359 88 678 9012' },
  { id: 109, categoryId: 'pets', subcategoryId: 'vet', name: 'Клиника «ВетДруг»', langs: ['RU', 'UA'], role: 'Ветеринар',
    about: 'Ветеринарная клиника, приём и выезд на дом, говорим по-русски и по-украински.',
    services: ['Приём в клинике', 'Вызов на дом', 'Вакцинация'],
    contactsTelegram: '@vetdrug_sofia', contactsPhone: '+359 89 789 0123', contactsWebsite: 'vetdrug.bg',
    locationAddress: 'бул. Цариградско шосе 101, София' },
];

async function main() {
  for (const city of CITIES) {
    await prisma.city.upsert({ where: { id: city.id }, update: city, create: city });
  }

  for (const cat of CATEGORIES) {
    const { subcats, ...catData } = cat;
    await prisma.category.upsert({ where: { id: cat.id }, update: catData, create: catData });
    for (const sub of subcats) {
      await prisma.subcategory.upsert({
        where: { id: sub.id },
        update: { ...sub, categoryId: cat.id },
        create: { ...sub, categoryId: cat.id },
      });
    }
  }

  for (const s of DEMO_SPECIALISTS) {
    await prisma.specialist.upsert({
      where: { id: s.id },
      update: { ...s, cityId: 'sofia', status: 'published' },
      create: { ...s, cityId: 'sofia', status: 'published' },
    });
  }

  console.log('Готово: категории, города и демо-специалисты загружены.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
