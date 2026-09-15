// Публичный номер анкеты — это просто внутренний autoincrement id со сдвигом,
// чтобы анкеты не показывали пользователям "анкета №1, №2, №3..." (слишком заметно,
// что каталог маленький), а выглядели как у больших сервисов — "№100000000042".
// Отдельного счётчика в базе не заводим: Postgres и так никогда не переиспользует
// id удалённых строк (autoincrement всегда только растёт), а значит это условие
// ("номер не освобождается после удаления") выполняется само собой бесплатно.
const OFFSET = 100000000000;

function toPublicId(id) {
  return String(OFFSET + Number(id));
}

// Обратное преобразование для поиска в админке по номеру анкеты.
// Возвращает internal id (число) или null, если строка не похожа на публичный номер.
function fromPublicId(value) {
  const n = Number(String(value).trim());
  if (!Number.isInteger(n)) return null;
  const id = n - OFFSET;
  return id > 0 ? id : null;
}

module.exports = { toPublicId, fromPublicId };
