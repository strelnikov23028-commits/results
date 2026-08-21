/**
 * Рисует images/logo.png — 130×100. Размер жёсткий: amoCRM отклоняет архив с
 * сообщением «Logo file for logo must have resolution 130x100px» (проверено
 * 20.08.2026 при загрузке через «Создать интеграцию»).
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

const W = 130;
const H = 100;
const HERE = dirname(fileURLToPath(import.meta.url));

// Фирменные цвета neoved: красный круг, внутри белый пузырь чата.
const RED = [238, 0, 0];
const WHITE = [255, 255, 255];

const R = 46;                 // круг вписан по высоте с небольшим полем
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

    const color = inBubble(x, y) ? WHITE : RED;
    px[i] = color[0];
    px[i + 1] = color[1];
    px[i + 2] = color[2];
    px[i + 3] = Math.round(255 * alpha);
  }
}

/** Скруглённый прямоугольник с хвостиком — узнаваемый значок сообщения. */
function inBubble(x, y) {
  const left = CX - 25, right = CX + 25, top = CY - 18, bottom = CY + 10, radius = 10;
  const inBody = x >= left && x <= right && y >= top && y <= bottom
    && cornerOk(x, y, left, right, top, bottom, radius);
  // Хвостик: треугольник под левой частью пузыря.
  const inTail = y > bottom && y <= bottom + 11 && x >= CX - 16 && x <= CX - 16 + (bottom + 11 - y) * 1.5;
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

// ── сборка PNG ──
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;   // фильтр строки: none
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;    // бит на канал
ihdr[9] = 6;    // RGBA
ihdr[10] = 0;   // сжатие
ihdr[11] = 0;   // фильтрация
ihdr[12] = 0;   // без интерлейса

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

await mkdir(join(HERE, 'images'), { recursive: true });
await writeFile(join(HERE, 'images', 'logo.png'), png);
console.log(`images/logo.png — ${W}×${H}, ${png.length} байт`);

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
