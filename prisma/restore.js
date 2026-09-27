// Восстановление базы из файла бэкапа (krug-backup-ГГГГ-ММ-ДД.json.gz, который
// сервер каждый день присылает в Telegram).
//
// Запуск (с DATABASE_URL нужной базы):
//   node prisma/restore.js путь/к/krug-backup-2026-09-27.json.gz
//
// По умолчанию восстанавливает только в ПУСТУЮ базу (без анкет и пользователей) —
// чтобы случайно не смешать старые данные с новыми. Схема таблиц должна быть уже
// создана: сначала `npx prisma db push`, потом этот скрипт.
// Флаг --wipe сначала полностью очищает все таблицы — только если точно нужно
// заменить текущие данные копией.
require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const { Prisma } = require('@prisma/client');
const prisma = require('../src/lib/prisma');
const { modelsInDependencyOrder, BACKUP_FORMAT_VERSION } = require('../src/lib/backup');

const CHUNK = 1000;

// Пустое необязательное JSON-поле Prisma не принимает как обычный null —
// нужно явно сказать "пусто в базе".
function prepareRow(row, jsonFields) {
  const out = { ...row };
  for (const f of jsonFields) if (out[f] === null) out[f] = Prisma.DbNull;
  return out;
}

async function main() {
  const file = process.argv.find((a) => a.endsWith('.json.gz') || a.endsWith('.json'));
  const wipe = process.argv.includes('--wipe');
  if (!file) {
    console.error('Укажите файл бэкапа: node prisma/restore.js krug-backup-ГГГГ-ММ-ДД.json.gz [--wipe]');
    process.exit(1);
  }
  const raw = fs.readFileSync(file);
  const backup = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
  if (backup.format !== 'krug-backup' || backup.version > BACKUP_FORMAT_VERSION) {
    throw new Error('Это не файл бэкапа КРУГ или он от более новой версии');
  }
  console.log(`Бэкап от ${backup.createdAt}`);

  const models = modelsInDependencyOrder();
  const [specialists, users] = await Promise.all([prisma.specialist.count(), prisma.telegramUser.count()]);
  if ((specialists || users) && !wipe) {
    throw new Error(`База не пустая (анкет: ${specialists}, пользователей: ${users}). Чтобы заменить данные копией, добавьте --wipe`);
  }

  await prisma.$transaction(async (tx) => {
    if (wipe) {
      // Очищаем в обратном порядке — сначала то, что ссылается на другие таблицы
      for (const model of [...models].reverse()) {
        await tx[delegateName(model.name)].deleteMany({});
      }
    }
    for (const model of models) {
      const rows = backup.tables[model.name] || [];
      const jsonFields = model.fields.filter((f) => f.type === 'Json' && !f.isRequired).map((f) => f.name);
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx[delegateName(model.name)].createMany({ data: rows.slice(i, i + CHUNK).map((r) => prepareRow(r, jsonFields)) });
      }
      // Счётчик автоматических номеров продолжаем с максимального восстановленного,
      // иначе следующая новая запись попыталась бы занять уже существующий номер.
      const idField = model.fields.find((f) => f.isId);
      if (idField && idField.type === 'Int' && idField.hasDefaultValue && rows.length) {
        await tx.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${model.name}"', '${idField.name}'), (SELECT MAX("${idField.name}") FROM "${model.name}"))`,
        );
      }
      console.log(`${model.name}: ${rows.length}`);
    }
  }, { timeout: 10 * 60 * 1000 });

  console.log('Готово: база восстановлена из бэкапа.');
}

function delegateName(modelName) {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

main()
  .catch((e) => {
    console.error('Восстановление не удалось:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
