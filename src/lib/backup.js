// Резервная копия всей базы. Раз в сутки сервер сам выгружает все таблицы в один
// сжатый файл и отправляет его владельцу в Telegram (служебный чат) — копия лежит
// отдельно от Railway, и даже если с базой там что-то случится, данные останутся.
// Восстановление из такого файла — скрипт prisma/restore.js.
const zlib = require('zlib');
const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');

const BACKUP_FORMAT_VERSION = 1;
const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
const LAST_BACKUP_KEY = 'backup_last_at';
const LAST_ERROR_KEY = 'backup_last_error';
// Больше этого Telegram не принимает файлы от ботов
const TELEGRAM_FILE_LIMIT = 49 * 1024 * 1024;

// Куда отправлять копию: отдельный чат BACKUP_CHAT_ID, если задан, иначе тот же
// служебный чат владельца, куда уже уходят фото на проверку.
function backupChatId() {
  return process.env.BACKUP_CHAT_ID || process.env.TELEGRAM_FILE_RELAY_CHAT_ID || null;
}

// Все таблицы берём из описания схемы, а не списком вручную — так новая таблица
// попадёт в бэкап сама. Порядок: сначала те, на которые ссылаются другие
// (категории раньше анкет), — в таком же порядке их потом и восстанавливаем.
function modelsInDependencyOrder() {
  const models = Prisma.dmmf.datamodel.models;
  const deps = new Map(models.map((m) => [
    m.name,
    m.fields.filter((f) => f.relationFromFields && f.relationFromFields.length).map((f) => f.type),
  ]));
  const ordered = [];
  const visit = (name, stack = new Set()) => {
    if (ordered.includes(name) || stack.has(name)) return;
    stack.add(name);
    for (const dep of deps.get(name) || []) visit(dep, stack);
    ordered.push(name);
  };
  models.forEach((m) => visit(m.name));
  return ordered.map((name) => models.find((m) => m.name === name));
}

// Имя модели → свойство клиента Prisma (Specialist → prisma.specialist)
function delegateFor(modelName) {
  return prisma[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
}

async function createBackupData() {
  const tables = {};
  for (const model of modelsInDependencyOrder()) {
    const idField = model.fields.find((f) => f.isId);
    tables[model.name] = await delegateFor(model.name).findMany(idField ? { orderBy: { [idField.name]: 'asc' } } : {});
  }
  return { format: 'krug-backup', version: BACKUP_FORMAT_VERSION, createdAt: new Date().toISOString(), tables };
}

async function createBackupFile() {
  const data = await createBackupData();
  const buffer = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  const date = data.createdAt.slice(0, 10);
  return { data, buffer, fileName: `krug-backup-${date}.json.gz` };
}

async function setSetting(key, value) {
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

async function backupStatus() {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: [LAST_BACKUP_KEY, LAST_ERROR_KEY] } } });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    lastBackupAt: byKey[LAST_BACKUP_KEY] || null,
    lastError: byKey[LAST_ERROR_KEY] || null,
    chatConfigured: !!backupChatId(),
  };
}

function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

// Делает копию и отправляет её в Telegram. Возвращает краткую сводку.
async function sendBackupToTelegram(reason = 'автоматический') {
  const chatId = backupChatId();
  try {
    if (!chatId) throw new Error('не задан чат для бэкапов (BACKUP_CHAT_ID или TELEGRAM_FILE_RELAY_CHAT_ID)');
    const { data, buffer, fileName } = await createBackupFile();
    if (buffer.length > TELEGRAM_FILE_LIMIT) {
      throw new Error(`файл бэкапа ${formatSize(buffer.length)} — больше лимита Telegram 50 МБ`);
    }
    const counts = {
      specialists: data.tables.Specialist.length,
      users: data.tables.TelegramUser.length,
    };
    const caption = [
      `💾 Бэкап базы КРУГ (${reason})`,
      `Анкет: ${counts.specialists}, пользователей: ${counts.users}, размер: ${formatSize(buffer.length)}`,
      '',
      'Храните эти файлы и никому не пересылайте: внутри личные данные пользователей.',
    ].join('\n');

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('document', new Blob([buffer], { type: 'application/gzip' }), fileName);
    const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
    const result = await response.json().catch(() => null);
    if (!result) throw new Error(`Telegram недоступен (ответ сервера ${response.status})`);
    if (!result.ok) throw new Error(result.description || 'Telegram не принял файл');

    await setSetting(LAST_BACKUP_KEY, data.createdAt);
    await setSetting(LAST_ERROR_KEY, '');
    return { ok: true, fileName, size: buffer.length, ...counts };
  } catch (e) {
    await setSetting(LAST_ERROR_KEY, `${new Date().toISOString()} ${e.message}`.slice(0, 500)).catch(() => {});
    throw e;
  }
}

// Раз в час проверяем, не пора ли делать очередную копию. Время последней копии
// хранится в базе, поэтому частые перезапуски сервера (каждое обновление) не
// приводят ни к пропуску, ни к лишним копиям.
async function runScheduledBackupIfDue() {
  const { lastBackupAt } = await backupStatus();
  if (lastBackupAt && Date.now() - new Date(lastBackupAt).getTime() < BACKUP_EVERY_MS) return;
  const summary = await sendBackupToTelegram('ежедневный');
  console.log(`Бэкап базы отправлен в Telegram: ${summary.fileName}, ${formatSize(summary.size)}`);
}

function startBackupSchedule() {
  const tick = () => runScheduledBackupIfDue().catch((e) => console.error('Бэкап базы не удался:', e.message));
  // Первая проверка через минуту после запуска — не мешаем серверу стартовать
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 60 * 60 * 1000);
}

module.exports = {
  BACKUP_FORMAT_VERSION, modelsInDependencyOrder, delegateFor, createBackupData, createBackupFile,
  sendBackupToTelegram, backupStatus, startBackupSchedule,
};
