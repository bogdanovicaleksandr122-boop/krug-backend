// Рисует картинку-карточку анкеты для сообщения "поделиться" (как чек в @send).
// Здесь только рисование на стандартном Canvas 2D — без загрузки шрифтов, фото и
// сохранения файла (это в shareCard.js). Благодаря этому тот же код можно
// проверить в обычном браузере и быть уверенным, что сервер нарисует так же.

const W = 1200;
const H = 630;
const PAD = 64;

const FONT_DISPLAY = 'KrugDisplay'; // Unbounded 700 — как заголовки в приложении
const FONT_BODY = 'KrugBody'; // Manrope 500
const FONT_BODY_BOLD = 'KrugBodyBold'; // Manrope 700

const COLORS = {
  bg: '#0B0B0B',
  white: '#FFFFFF',
  soft: '#BDBDBD',
  muted: '#8A8A8A',
  photoBg: '#262626',
};

// Шрифты не содержат эмодзи и некоторых символов — вместо них на картинке
// получились бы пустые квадратики. Убираем их и лишние пробелы.
function cleanText(value) {
  return String(value || '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u200D\uFE0E\uFE0F\u20E3]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function initials(name) {
  const letters = cleanText(name)
    .split(' ')
    .map((w) => (w.match(/\p{L}/u) || [''])[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');
  return (letters || 'К').toUpperCase();
}

// Разбивает текст на строки по ширине. Если строк больше maxLines — последнюю
// обрезает с многоточием. Слишком длинное слово без пробелов режется по буквам.
function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = cleanText(text).split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  let overflow = false;

  const pushWord = (word) => {
    const candidate = current ? current + ' ' + word : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      return;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
      return;
    }
    let piece = '';
    for (const ch of word) {
      if (ctx.measureText(piece + ch).width > maxWidth && piece) {
        lines.push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    current = piece;
  };

  for (const word of words) {
    pushWord(word);
    if (lines.length > maxLines) break;
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    overflow = true;
    lines.length = maxLines;
  }
  if (overflow) {
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1).trimEnd();
    // Обрезаем по целому слову, если так теряем не слишком много строки.
    const space = last.lastIndexOf(' ');
    if (space > last.length * 0.6) last = last.slice(0, space);
    lines[maxLines - 1] = last.replace(/[\s,.;:—-]+$/, '') + '…';
  }
  return { lines, overflow };
}

function fitSingleLine(ctx, text, maxWidth) {
  return wrapLines(ctx, text, maxWidth, 1).lines[0] || '';
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function drawBackground(ctx) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  // Концентрические круги — фирменный мотив "КРУГ", едва заметный фон.
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i += 1) {
    ctx.strokeStyle = `rgba(255,255,255,${0.07 - i * 0.008})`;
    ctx.beginPath();
    ctx.arc(W - 40, 40, 150 + i * 90, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawHeader(ctx, data) {
  const cy = 100;
  const logoR = 42;
  const logoX = PAD + logoR;

  ctx.fillStyle = COLORS.white;
  ctx.beginPath();
  ctx.arc(logoX, cy, logoR, 0, Math.PI * 2);
  ctx.fill();

  let logoSize = 20;
  ctx.font = `${logoSize}px ${FONT_DISPLAY}`;
  while (ctx.measureText('КРУГ').width > logoR * 1.6 && logoSize > 12) {
    logoSize -= 1;
    ctx.font = `${logoSize}px ${FONT_DISPLAY}`;
  }
  ctx.fillStyle = COLORS.bg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('КРУГ', logoX, cy + 1);

  const taglineX = PAD + logoR * 2 + 22;
  ctx.textAlign = 'left';
  ctx.font = `22px ${FONT_BODY}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('Справочник услуг своих за границей', taglineX, cy);
  const taglineEnd = taglineX + ctx.measureText('Справочник услуг своих за границей').width;

  if (data.city) {
    ctx.font = `24px ${FONT_BODY_BOLD}`;
    const pillPadX = 24;
    const maxTextW = W - PAD - (taglineEnd + 32) - pillPadX * 2;
    const text = fitSingleLine(ctx, data.city, Math.max(120, maxTextW));
    const pillW = ctx.measureText(text).width + pillPadX * 2;
    const pillH = 52;
    const pillX = W - PAD - pillW;
    ctx.fillStyle = COLORS.bg;
    roundRectPath(ctx, pillX, cy - pillH / 2, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = COLORS.white;
    ctx.fillText(text, pillX + pillPadX, cy + 1);
  }
}

function drawPhoto(ctx, data, photo, cx, cy, r) {
  ctx.fillStyle = COLORS.white;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (photo && photo.width && photo.height) {
    const scale = Math.max((r * 2) / photo.width, (r * 2) / photo.height);
    const w = photo.width * scale;
    const h = photo.height * scale;
    ctx.drawImage(photo, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = COLORS.photoBg;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = COLORS.white;
    ctx.font = `80px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(data.name), cx, cy + 4);
  }
  ctx.restore();

  if (data.verified) {
    const bx = cx + r * 0.72;
    const by = cy + r * 0.72;
    const br = 28;
    ctx.fillStyle = COLORS.bg;
    ctx.beginPath();
    ctx.arc(bx, by, br + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.white;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.bg;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(bx - 12, by + 1);
    ctx.lineTo(bx - 3, by + 10);
    ctx.lineTo(bx + 13, by - 9);
    ctx.stroke();
  }
}

function measureChip(ctx, text) {
  ctx.font = `22px ${FONT_BODY_BOLD}`;
  return ctx.measureText(text).width + 44;
}

function drawChip(ctx, text, x, y, filled) {
  const h = 46;
  ctx.font = `22px ${FONT_BODY_BOLD}`;
  const w = ctx.measureText(text).width + 44;
  roundRectPath(ctx, x, y, w, h, h / 2);
  if (filled) {
    ctx.fillStyle = COLORS.white;
    ctx.fill();
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.fillStyle = filled ? COLORS.bg : COLORS.white;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 22, y + h / 2 + 1);
  return w;
}

function drawMain(ctx, data) {
  const centerY = 342;
  const x = 440;
  const maxW = W - PAD - x;

  // Имя: подбираем самый крупный размер, при котором оно влезает в 2 строки.
  let nameSize = 60;
  let name;
  for (const size of [60, 54, 48, 44, 40]) {
    ctx.font = `${size}px ${FONT_DISPLAY}`;
    nameSize = size;
    name = wrapLines(ctx, data.name, maxW, 2);
    if (!name.overflow) break;
  }
  const nameLH = Math.round(nameSize * 1.2);

  ctx.font = `30px ${FONT_BODY}`;
  const role = data.role ? wrapLines(ctx, data.role, maxW, 2) : { lines: [] };
  const roleLH = 40;

  const chips = [];
  if (data.chip) chips.push({ text: data.chip, filled: true });
  if (data.pro) chips.push({ text: 'PRO', filled: false });
  const chipsH = chips.length ? 46 : 0;

  const gapRole = role.lines.length ? 18 : 0;
  const gapChips = chips.length ? 30 : 0;
  const blockH = name.lines.length * nameLH + gapRole + role.lines.length * roleLH + gapChips + chipsH;
  let y = Math.max(170, centerY - blockH / 2);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLORS.white;
  ctx.font = `${nameSize}px ${FONT_DISPLAY}`;
  for (const line of name.lines) {
    ctx.fillText(line, x, y);
    y += nameLH;
  }

  y += gapRole;
  ctx.fillStyle = COLORS.soft;
  ctx.font = `30px ${FONT_BODY}`;
  for (const line of role.lines) {
    ctx.fillText(line, x, y);
    y += roleLH;
  }

  y += gapChips;
  let cx = x;
  for (const chip of chips) {
    let text = chip.text;
    const room = x + maxW - cx;
    if (measureChip(ctx, text) > room) {
      ctx.font = `22px ${FONT_BODY_BOLD}`;
      text = fitSingleLine(ctx, text, Math.max(40, room - 44));
    }
    if (room < 90) break;
    cx += drawChip(ctx, text, cx, y, chip.filled) + 12;
  }
}

function drawFooter(ctx, data) {
  const lineY = 540;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, lineY);
  ctx.lineTo(W - PAD, lineY);
  ctx.stroke();

  const y = 586;
  ctx.textBaseline = 'middle';
  ctx.font = `22px ${FONT_BODY}`;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'left';
  if (data.publicId) ctx.fillText(`Анкета № ${data.publicId}`, PAD, y);

  ctx.font = `22px ${FONT_BODY_BOLD}`;
  ctx.fillStyle = COLORS.white;
  ctx.textAlign = 'right';
  if (data.botLink) ctx.fillText(data.botLink, W - PAD, y);
  ctx.textAlign = 'left';
}

// data: { name, role, city, chip, verified, pro, publicId, botLink }
// photo: загруженная картинка (или null — тогда рисуем инициалы)
function drawShareCard(ctx, data, photo) {
  drawBackground(ctx);
  drawHeader(ctx, data);
  drawPhoto(ctx, data, photo, PAD + 150, 342, 142);
  drawMain(ctx, data);
  drawFooter(ctx, data);
}

module.exports = { drawShareCard, cleanText, W, H, FONT_DISPLAY, FONT_BODY, FONT_BODY_BOLD };
