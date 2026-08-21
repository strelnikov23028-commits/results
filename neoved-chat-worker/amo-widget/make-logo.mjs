/**
 * Рисует логотипы виджета: images/logo.png (130×100) и images/logo_small.png
 * (108×108). Размеры amoCRM сообщает по одному при загрузке архива, в
 * документации их нет — собраны на аккаунте 20.08.2026:
 *
 *   logo.png       — 130×100 («Logo file for logo must have resolution 130x100px»)
 *   logo_main.png  — 400×272 (рисует make-cover.mjs)
 *   logo_small.png — 108×108, обязателен для widget_small
 *
 * Никаких зависимостей: PNG собирается вручную из IHDR/IDAT/IEND, сжатие
 * берётся из встроенного zlib.
 *
 * Запуск: node make-logo.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Фирменные цвета neoved: красный круг, внутри белый пузырь чата.
const RED = [238, 0, 0];
const WHITE = [255, 255, 255];

// Таблица для контрольных сумм PNG-чанков. Объявлена здесь, а не рядом с
// crc32: файл рисуется сразу при загрузке модуля, и объявление ниже по тексту
// до неё бы не дожило.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

await mkdir(join(HERE, 'images'), { recursive: true });
await draw(130, 100, 'logo.png');
await draw(108, 108, 'logo_small.png');

async function draw(W, H, file) {
  const R = Math.min(W, H) / 2 - 4;
  const CX = (W - 1) / 2;
  const CY = (H - 1) / 2;
  const px = Buffer.alloc(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dist = Math.hypot(x - CX, y - CY);

      // Круг с мягким краем — иначе на светлом фоне видна «лесенка».
      const alpha = clamp((R - dist) * 1.4 + 0.5);
      if (alpha <= 0) continue;

      const color = inBubble(x, y, CX, CY, R) ? WHITE : RED;
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = Math.round(255 * alpha);
    }
  }

  const png = encode(px, W, H);
  await writeFile(join(HERE, 'images', file), png);
  console.log(`images/${file} — ${W}×${H}, ${png.length} байт`);
}

/** Скруглённый прямоугольник с хвостиком — узнаваемый значок сообщения. */
function inBubble(x, y, CX, CY, R) {
  const w = R * 0.56, h = R * 0.32;
  const left = CX - w, right = CX + w, top = CY - h - R * 0.08, bottom = CY + h - R * 0.08;
  const radius = R * 0.22;

  const inBody = x >= left && x <= right && y >= top && y <= bottom
    && cornerOk(x, y, left, right, top, bottom, radius);
  // Хвостик: треугольник под левой частью пузыря.
  const tailTop = bottom;
  const tailHeight = R * 0.26;
  const inTail = y > tailTop && y <= tailTop + tailHeight
    && x >= CX - w * 0.6 && x <= CX - w * 0.6 + (tailTop + tailHeight - y) * 1.5;
  return inBody || inTail;
}

function cornerOk(x, y, left, right, top, bottom, r) {
  const cx = x < left + r ? left + r : (x > right - r ? right - r : x);
  const cy = y < top + r ? top + r : (y > bottom - r ? bottom - r : y);
  return Math.hypot(x - cx, y - cy) <= r;
}

function clamp(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// ─────────────────────────── сборка PNG ───────────────────────────

function encode(px, W, H) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;   // фильтр строки: none
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;    // бит на канал
  ihdr[9] = 6;    // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
