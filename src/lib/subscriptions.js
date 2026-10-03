// Подписка PRO через звёзды Telegram: Telegram сам списывает оплату каждые 30 дней.
// Здесь — отмена подписки, когда она больше не нужна (например, анкету удалили),
// чтобы с человека не продолжали списываться звёзды.
const prisma = require('./prisma');
const { callTelegram } = require('./telegramSend');

async function cancelProSubscription(specialistId) {
  try {
    // Подписка определяется первым платежом (не продлением)
    const first = await prisma.payment.findFirst({
      where: { specialistId, type: 'pro', isSubscription: true, isRenewal: false },
      orderBy: { createdAt: 'desc' },
    });
    if (!first || !first.telegramUserId || !first.telegramPaymentChargeId) return false;
    return await cancelByCharge(first.telegramUserId, first.telegramPaymentChargeId);
  } catch (e) {
    console.error('Не удалось отменить подписку PRO', e);
    return false;
  }
}

async function cancelByCharge(telegramUserId, chargeId) {
  const res = await callTelegram('editUserStarSubscription', {
    user_id: Number(telegramUserId),
    telegram_payment_charge_id: chargeId,
    is_canceled: true,
  });
  if (!res.ok) console.error('editUserStarSubscription отклонён:', res.description);
  return !!res.ok;
}

module.exports = { cancelProSubscription, cancelByCharge };
