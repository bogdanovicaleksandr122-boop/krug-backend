// Простая транслитерация кириллицы — только чтобы получить читаемый технический id
// (города, категории, коды рекламных ссылок); на отображение в приложении не влияет.
const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: '', ю: 'yu', я: 'ya',
};

function slugify(text) {
  const lower = String(text || '').toLowerCase();
  let out = '';
  for (const ch of lower) out += CYRILLIC_MAP[ch] !== undefined ? CYRILLIC_MAP[ch] : ch;
  out = out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'item';
}

module.exports = { slugify };
