/**
 * Рисует cover.png — 400×272, картинку интеграции для формы «Создать
 * интеграцию» в amoCRM. Тот же значок, что и у логотипа виджета, только
 * крупнее и на светлой подложке.
 *
 * Запуск: node make-cover.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 400;
const H = 272;
const HERE = dirname(fileURLToPath(import.meta.url));

const BG = [245, 245, 247];      // светлая подложка, как на neoved.io
const RED = [238, 0, 0];
const WHITE = [255, 255, 255];

const R = 84;                    // радиус красного круга
const CX = W / 2;
const CY = H / 2;

const px = Buffer.alloc(W * H * 4);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const dist = Math.hypot(x - CX, y - CY);
    const inCircle = clamp((R - dist) * 1.4 + 0.5);

    let color = BG;
    if (inCircle > 0) color = inBubble(x, y) ? WHITE : RED;

    // Круг с мягким краем: подмешиваем фон по краю, чтобы не было «лесенки».
    const mix = color === BG ? 0 : inCircle;
    px[i] = Math.round(BG[0] * (1 - mix) + color[0] * mix);
    px[i + 1] = Math.round(BG[1] * (1 - mix) + color[1] * mix);
    px[i + 2] = Math.round(BG[2] * (1 - mix) + color[2] * mix);
    px[i + 3] = 255;
  }
}

/** Скруглённый прямоугольник с хвостиком — значок сообщения. */
function inBubble(x, y) {
  const left = CX - 46, right = CX + 46, top = CY - 32, bottom = CY + 18, radius = 18;
  const inBody = x >= left && x <= right && y >= top && y <= bottom
    && cornerOk(x, y, left, right, top, bottom, radius);
  const inTail = y > bottom && y <= bottom + 20 && x >= CX - 30 && x <= CX - 30 + (bottom + 20 - y) * 1.5;
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
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

await mkdir(join(HERE, 'images'), { recursive: true });
await writeFile(join(HERE, 'images', 'cover.png'), png);
console.log(`images/cover.png — ${W}×${H}, ${(png.length / 1024).toFixed(1)} КБ`);

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
