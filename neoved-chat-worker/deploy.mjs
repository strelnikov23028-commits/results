/**
 * Деплой neoved-chat-worker в Cloudflare Workers + подписка вебхука в amoCRM.
 *
 * Почему Node, а не curl, как у соседних воркеров: на этой машине curl.exe не
 * договаривается по TLS с api.cloudflare.com (ошибка 35, HTTP 000), а
 * встроенный в Node fetch ходит туда нормально. Заодно не нужен внешний
 * multipart — FormData и Blob есть в стандартной библиотеке Node 18+.
 *
 * Запуск:
 *   CF_API_TOKEN=... node deploy.mjs        (bash)
 *   $env:CF_API_TOKEN='...'; node deploy.mjs   (PowerShell)
 * Токену нужны права: Workers Scripts:Edit и Workers KV Storage:Edit.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, '.env');
const CF = 'https://api.cloudflare.com/client/v4';

const token = process.env.CF_API_TOKEN;
if (!token) fail("Задай CF_API_TOKEN: $env:CF_API_TOKEN='...'");

const raw = await readFile(ENV_PATH, 'utf8');
const cfg = Object.fromEntries(
  raw.split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);

const name = cfg.WORKER_NAME;
const account = cfg.CF_ACCOUNT;
const auth = { Authorization: `Bearer ${token}` };

// ─────────────────── KV ───────────────────
// Хранит сессии виджета, очередь ответов менеджера и отладочный лог.
if (!cfg.KV_ID) {
  console.log('Создаю KV namespace…');
  const res = await cfApi(`/accounts/${account}/storage/kv/namespaces`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${name}-state` }),
  });
  cfg.KV_ID = res.result.id;
  await writeFile(ENV_PATH, raw.replace(/^KV_ID=.*$/m, `KV_ID=${cfg.KV_ID}`), 'utf8');
  console.log(`  KV_ID=${cfg.KV_ID} (записан в .env)`);
}

// ─────────────────── заливка ───────────────────
const SECRETS = ['AMO_SUBDOMAIN', 'AMO_TOKEN', 'HOOK_SECRET'];
// Ключ капчи необязателен: пока его нет, проверка «я не робот» выключена.
const OPTIONAL_SECRETS = ['CAPTCHA_KEY'];
const PLAIN = ['PIPELINE_ID', 'STATUS_ID', 'NEW_STATUS_NAME', 'TAG_NAME', 'LEAD_NAME_PREFIX',
  'SITE_HOST', 'EMAIL_FIELD', 'PHONE_FIELD', 'COMPANY_INN_FIELD', 'LEAD_URL_FIELD',
  'ALLOW_ORIGINS', 'REPLY_PREFIX', 'STRIP_PREFIXES', 'START_LIMIT', 'MSG_LIMIT'];

const bindings = [];
for (const key of SECRETS) {
  if (!cfg[key]) fail(`В .env не заполнен ${key}`);
  bindings.push({ type: 'secret_text', name: key, text: cfg[key] });
}
for (const key of OPTIONAL_SECRETS) {
  if (cfg[key]) bindings.push({ type: 'secret_text', name: key, text: cfg[key] });
}
for (const key of PLAIN) {
  if (cfg[key] !== undefined) bindings.push({ type: 'plain_text', name: key, text: cfg[key] });
}
bindings.push({ type: 'kv_namespace', name: 'S', namespace_id: cfg.KV_ID });

const form = new FormData();
form.set('metadata', new Blob([JSON.stringify({
  main_module: 'worker.js',
  compatibility_date: '2024-11-01',
  bindings,
})], { type: 'application/json' }), 'metadata.json');

form.set('worker.js', new Blob([await readFile(join(HERE, 'worker.js'))],
  { type: 'application/javascript+module' }), 'worker.js');
// Текстовым модулем: worker.js импортирует его как строку и отдаёт по /widget.js.
form.set('widget.js', new Blob([await readFile(join(HERE, 'widget.js'))],
  { type: 'text/plain' }), 'widget.js');

console.log(`Заливаю воркер ${name}…`);
await cfApi(`/accounts/${account}/workers/scripts/${name}`, {
  method: 'PUT', headers: auth, body: form,
});
console.log('  залито');

// Без workers.dev-поддомена воркер недоступен снаружи.
await cfApi(`/accounts/${account}/workers/scripts/${name}/subdomain`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: true }),
});

const base = `https://${name}.${cfg.CF_SUBDOMAIN}.workers.dev`;
const hook = `${base}/amo/${cfg.HOOK_SECRET}`;

// ─────────────────── вебхук amoCRM ───────────────────
// Вопреки документации («вебхук с тем же адресом будет обновлён»), этот
// аккаунт на повторный POST того же destination отвечает 400 «Invalid URL».
// Поэтому сначала смотрим список и подписываемся, только если нашего там нет.
console.log('Проверяю вебхук в amoCRM…');
const events = (cfg.WEBHOOK_EVENTS || 'note_lead').split(',').map((s) => s.trim()).filter(Boolean);
const amoAuth = { Authorization: `Bearer ${cfg.AMO_TOKEN}`, 'Content-Type': 'application/json' };
const amoBase = `https://${cfg.AMO_SUBDOMAIN}.amocrm.ru/api/v4/webhooks`;

const listRes = await fetch(amoBase, { headers: amoAuth });
const existing = listRes.ok
  ? ((await listRes.json())._embedded?.webhooks || []).find((w) => w.destination === hook)
  : null;

if (existing) {
  console.log(`  уже подписан: ${Object.values(existing.settings || {}).join(', ')}`);
} else {
  const hookRes = await fetch(amoBase, {
    method: 'POST', headers: amoAuth,
    body: JSON.stringify({ destination: hook, settings: events }),
  });
  if (!hookRes.ok) fail(`amoCRM ответил ${hookRes.status}: ${(await hookRes.text()).slice(0, 300)}`);
  const body = await hookRes.json();
  const saved = body._embedded?.webhooks?.[0] || body;
  console.log(`  подписан: ${Object.values(saved.settings || {}).join(', ')}`);
}

// ─────────────────── проверка ───────────────────
// Не критично: с этой машины TLS до workers.dev иногда рвётся на ровном месте,
// хотя воркер уже залит и снаружи отвечает.
await new Promise((r) => setTimeout(r, 2000));
try {
  const health = await (await fetch(`${base}/health`)).json();
  console.log(`  health: ok=${health.ok} service=${health.service}`);
} catch (e) {
  console.log(`  health: не дозвонился (${e.cause?.code || e.message}) — проверь вручную`);
}

console.log(`
Готово.
  виджет: ${base}/widget.js
  вебхук: ${hook}
  лог:    ${base}/debug/${cfg.HOOK_SECRET}

Вставка на сайт (Tilda → блок T123 в футере):
  <script src="${base}/widget.js" defer></script>`);

async function cfApi(path, opts) {
  const res = await retry(() => fetch(CF + path, opts));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const errors = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    fail(`Cloudflare ${res.status} ${path}\n  ${errors || JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

/**
 * Связь с api.cloudflare.com с этой машины рвётся на ровном месте — то TLS,
 * то таймаут коннекта. Сетевой сбой не повод считать деплой неудачным.
 */
async function retry(call, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (i >= attempts) throw e;
      console.log(`  сеть подвела (${e.cause?.code || e.message}), попытка ${i + 1} из ${attempts}…`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
