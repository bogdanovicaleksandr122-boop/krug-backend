const { PrismaClient } = require('@prisma/client');

// Один общий "клиент" для общения с базой данных на всё приложение.
const prisma = new PrismaClient();

module.exports = prisma;
