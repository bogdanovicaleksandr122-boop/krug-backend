// Express 4 не ловит ошибки внутри async-обработчиков: без этой обёртки любая
// ошибка базы превращалась бы в "необработанную ошибку", на которой Node.js
// останавливает весь сервер. Обёртка передаёт ошибку в общий обработчик в
// server.js — пользователь получает ответ "Внутренняя ошибка сервера", сервер живёт.
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { asyncRoute };
