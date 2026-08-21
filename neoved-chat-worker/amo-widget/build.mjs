/**
 * Собирает amo-widget.zip для загрузки в amoCRM.
 *
 * Почему не Compress-Archive: PowerShell 5.1 пишет в архив пути с обратными
 * слешами («i18n\ru.json»), а спецификация ZIP требует прямых — на серверах
 * amoCRM такой архив распакуется одним файлом со слешем в имени. Здесь ZIP
 * собирается вручную, поэтому имена гарантированно правильные.
 *
 * Запуск: node build.mjs
 */
import { deflateRawSync } from 'node:zlib';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(dirname(HERE), 'amo-widget.zip');

// Только то, что нужно самому виджету: генераторы картинок, этот сборщик и
// обложка интеграции (её загружают отдельно, прямо в форме) в архив не идут.
//
// Логотип раскладываем по всем путям, где его ищет amoCRM. Аккаунт по очереди
// потребовал images/logo.png в разрешении 130×100, а затем images/logo_main.png
// («Файл логотипа "images/logo_main.png" обязателен для виджета widget_main»).
// Лишние копии весят по 800 байт и ничему не мешают.
const FILES = [
  'manifest.json',
  'script.js',
  ...await dir('i18n'),
  'images/logo.png',
  { src: 'images/logo.png', name: 'images/logo_main.png' },
  { src: 'images/logo.png', name: 'logo.png' },
];

async function dir(name) {
  const entries = await readdir(join(HERE, name));
  return entries.map((file) => `${name}/${file}`);
}

// Фиксированные дата и время (01.01.2026 00:00) в формате MS-DOS — чтобы
// одинаковые исходники давали побайтово одинаковый архив.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const locals = [];
const central = [];
let offset = 0;

for (const item of FILES) {
  const name = typeof item === 'string' ? item : item.name;
  const data = await readFile(join(HERE, typeof item === 'string' ? item : item.src));
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // версия, необходимая для распаковки
  local.writeUInt16LE(0x0800, 6);      // имена в UTF-8
  local.writeUInt16LE(8, 8);           // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, packed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);          // версия создателя
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBuf.length, 28);
  entry.writeUInt32LE(0, 38);          // атрибуты
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBuf);

  offset += local.length + nameBuf.length + packed.length;
  console.log(`  ${name} — ${data.length} → ${packed.length} байт`);
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(FILES.length, 8);
end.writeUInt16LE(FILES.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...locals, centralBuf, end]);
await writeFile(OUT, zip);
console.log(`\nГотово: ${relative(process.cwd(), OUT) || OUT} — ${(zip.length / 1024).toFixed(1)} КБ`);
console.log('Загрузка: amoCRM → Настройки → Интеграции → Создать интеграцию → Загрузить виджет');

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
