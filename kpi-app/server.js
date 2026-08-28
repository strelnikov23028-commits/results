/**
 * Запуск на обычном сервере (serv_raboch) вместо Cloudflare.
 *
 * Логика целиком берётся из src/worker.js — здесь только подложка:
 * SQLite вместо D1, node:http вместо fetch-обработчика, таймеры вместо cron.
 * Так один и тот же код метрик работает и на воркере, и на VPS.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import worker from './src/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kpi.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ── D1-совместимая обёртка над SQLite ────────────────────────────────────────
// Воркер обращается к базе как db.prepare(sql).bind(...).first()/all()/run().
// Повторяем этот интерфейс, чтобы не трогать основной код.

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args.map(normalize));
  }
  #stmt() {
    return this.db.prepare(this.sql);
  }
  async first() {
    const row = this.#stmt().get(...this.args);
    return row ?? null;
  }
  async all() {
    return { results: this.#stmt().all(...this.args), success: true };
  }
  async run() {
    const info = this.#stmt().run(...this.args);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}

/** SQLite не понимает undefined и булевы значения — приводим к своим типам. */
function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class D1Like {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    const results = [];
    const tx = this.db.transaction(() => {
      for (const s of statements) {
        results.push(this.db.prepare(s.sql).run(...s.args));
      }
    });
    tx();
    return results.map((r) => ({ success: true, meta: { changes: r.changes } }));
  }
}

// ── Статика ──────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const assets = {
  async fetch(request) {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // не выпускаем за пределы public
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) return new Response('Нельзя', { status: 403 });

    try {
      const body = fs.readFileSync(file);
      return new Response(body, {
        headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' },
      });
    } catch {
      // одностраничное приложение: любой неизвестный путь отдаёт índex
      try {
        return new Response(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), {
          headers: { 'content-type': MIME['.html'] },
        });
      } catch {
        return new Response('Не найдено', { status: 404 });
      }
    }
  },
};

// ── Окружение ────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');

// первый запуск: разворачиваем схему
const hasTables = sqlite
  .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='users'")
  .get().n;
if (!hasTables) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  sqlite.exec(schema);
  console.log('Схема развёрнута:', DB_PATH);
  const seedPath = path.join(__dirname, 'seed.sql');
  if (fs.existsSync(seedPath)) {
    sqlite.exec(fs.readFileSync(seedPath, 'utf8'));
    console.log('Стартовый состав загружен');
  }
}

const env = {
  DB: new D1Like(sqlite),
  ASSETS: assets,
  TG_TOKEN: process.env.TG_TOKEN,
  TG_SECRET: process.env.TG_SECRET,
  HOOK_SECRET: process.env.HOOK_SECRET,
  BOOTSTRAP_SECRET: process.env.BOOTSTRAP_SECRET,
  YOUGILE_KEY: process.env.YOUGILE_KEY,
};

// ── HTTP ─────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });

    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    // Причину показываем в ответе, а не прячем за «сбой на сервере»:
    // приложение внутреннее, и без текста ошибку не найти.
    console.error(`Сбой запроса ${req.method} ${req.url}:`, err);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KPI отдела слушает 127.0.0.1:${PORT}`);
});

// ── Планировщик вместо cron-триггеров Cloudflare ─────────────────────────────

const tick = (cron) =>
  worker.scheduled({ cron }, env).catch((e) => console.error('Плановая задача:', cron, e));

// каждые 15 минут — напоминания о висящих вопросах и синхронизация
setInterval(() => tick('*/15 * * * *'), 15 * 60 * 1000);

// ежедневно в 18:00 UTC — проверка последнего дня месяца и итоговая сводка
let digestSentOn = null;
setInterval(() => {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 18 && digestSentOn !== stamp) {
    digestSentOn = stamp;
    tick('0 18 * * *');
  }
}, 60 * 1000);

const stop = () => {
  console.log('Останавливаюсь');
  server.close(() => {
    sqlite.close();
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
