const prisma = require('./prisma');

// Цены по умолчанию — используются, пока админ ни разу не сохранил свои значения
// через админку (после первой миграции таблица AppSetting пустая).
const DEFAULT_PRICES = {
  pro_price: 500,
  boost_price_7: 200,
  boost_price_30: 600,
};
const PRICE_KEYS = Object.keys(DEFAULT_PRICES);

async function getPrices() {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: PRICE_KEYS } } });
  const saved = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    pro_price: saved.pro_price || DEFAULT_PRICES.pro_price,
    boost_price_7: saved.boost_price_7 || DEFAULT_PRICES.boost_price_7,
    boost_price_30: saved.boost_price_30 || DEFAULT_PRICES.boost_price_30,
  };
}

// newPrices — объект с любым подмножеством ключей из PRICE_KEYS, значения — положительные числа.
async function setPrices(newPrices) {
  const entries = PRICE_KEYS
    .filter((key) => key in newPrices)
    .map((key) => [key, Math.max(1, Math.round(Number(newPrices[key])))]);
  await prisma.$transaction(
    entries.map(([key, value]) => prisma.appSetting.upsert({
      where: { key },
      update: { value: String(value) },
      create: { key, value: String(value) },
    })),
  );
}

module.exports = { getPrices, setPrices, DEFAULT_PRICES };
