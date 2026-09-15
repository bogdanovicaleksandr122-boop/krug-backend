// Telegram не даёт мини-приложению получить file_id напрямую из выбранного файла —
// это делается только через отправку фото сообщением через Bot API. Поэтому загрузка
// работает так: получаем от пользователя байты картинки → пересылаем их в Telegram как
// сообщение с фото → Telegram возвращает file_id → сохраняем его в базе. Чтобы показать
// фото обратно в приложении, отдельная функция ниже проксирует файл по этому file_id
// (напрямую отдавать ссылку Telegram нельзя — она содержит токен бота).

async function uploadPhotoToTelegram(buffer, mimeType, chatId) {
  if (!chatId) {
    throw new Error('нет получателя для загрузки фото в Telegram');
  }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([buffer], { type: mimeType || 'image/jpeg' }), 'photo.jpg');

  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || 'Telegram отклонил фото');
  }
  const sizes = data.result.photo;
  return sizes[sizes.length - 1].file_id; // последний элемент — самый большой размер
}

async function streamTelegramFile(fileId, res) {
  const infoRes = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const info = await infoRes.json();
  if (!info.ok) {
    res.status(404).json({ error: 'Файл не найден в Telegram' });
    return;
  }
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${info.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    res.status(502).json({ error: 'Не удалось получить файл из Telegram' });
    return;
  }
  res.set('Content-Type', fileRes.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  res.send(buffer);
}

module.exports = { uploadPhotoToTelegram, streamTelegramFile };
