/**
 * neoved-chat-worker — виджет обратной связи на сайте ↔ amoCRM.
 *
 * Как это работает:
 *   Посетитель заполняет форму (имя, почта, телефон, ник Telegram) и пишет
 *   вопрос → воркер ищет контакт в amoCRM по почте, потом по телефону, потом
 *   по нику → если у контакта есть открытая сделка, двигает её на «Новую
 *   заявку» и вешает тег, иначе заводит новую сделку с контактом. Текст падает
 *   примечанием в ленту сделки.
 *
 *   Менеджер отвечает прямо в карточке — обычным примечанием. amoCRM шлёт
 *   вебхук `note_lead`, воркер узнаёт сделку по сохранённой связке
 *   lead → sid и кладёт текст в очередь сессии. Виджет забирает её опросом
 *   /api/poll и показывает ответ в чате.
 *
 * Почему связка через KV, а не Chats API:
 *   Двусторонний чат amoCRM (amojo) требует канала, зарегистрированного через
 *   партнёрский аккаунт в amoMarket, — у обычной интеграции его нет. Примечания
 *   доступны любому долгосрочному токену и работают в обе стороны: этим же
 *   способом уже живёт соседний tg-amo-worker.
 *
 * Секреты (задаются при деплое):
 *   AMO_SUBDOMAIN — поддомен аккаунта amoCRM без .amocrm.ru
 *   AMO_TOKEN     — долгосрочный токен интеграции amoCRM
 *   HOOK_SECRET   — произвольная строка: часть URL вебхука и адреса /debug
 * Переменные — см. DEFAULTS ниже.
 * KV binding: S (сессии, очередь ответов, отладочный лог).
 *
 * Текст виджета лежит рядом в widget.js и заливается текстовым модулем.
 */

import WIDGET from './widget.js';

const DEFAULTS = {
  // Воронка «Продажи клиентам» и её этап «Новая заявка» — куда падают
  // сделки от новых клиентов (проверено по /api/v4/leads/pipelines 19.08.2026).
  PIPELINE_ID: '9018718',
  STATUS_ID: '72669522',
  // На этот этап двигаем уже существующую сделку. Ищется внутри её собственной
  // воронки — между воронками сделка не переезжает.
  NEW_STATUS_NAME: 'Новая заявка',
  TAG_NAME: 'site_chat',
  // Начало названия сделки: «site chat — Иван Петров».
  LEAD_NAME_PREFIX: 'site chat',

  // Поля контакта в этом аккаунте.
  EMAIL_FIELD: '629257',   // EMAIL, multitext
  PHONE_FIELD: '629255',   // PHONE, multitext
  TG_FIELD: '996481',      // «Telegram username», text — куда пишем ник новому контакту
  // По этим полям ищем ник у существующего контакта: 977339 и 996481
  // «Telegram username», 997749 «Telegram логин», 999219 «Telegram».
  TG_LOOKUP: '977339,996481,997749,999219',

  // Пусто — виджет можно ставить на любой домен. Иначе список origin через запятую.
  ALLOW_ORIGINS: '',

  // Пусто — клиенту уходит ЛЮБОЕ обычное примечание, написанное человеком
  // (свои примечания воркер узнаёт и обратно не шлёт). Если поставить сюда,
  // например, «+», уходить будут только примечания, начатые с этого знака.
  REPLY_PREFIX: '',
  // Пометки, которыми соседние интеграции начинают исходящие сообщения, —
  // в чате клиенту они не нужны.
  STRIP_PREFIXES: 'Ответ:',

  // Антиспам: сколько заявок принимаем с одного адреса в час и сколько
  // сообщений — в рамках одной сессии.
  START_LIMIT: '5',
  MSG_LIMIT: '60',
};

// note_type обычного примечания в вебхуке приходит числом.
const COMMON_NOTE_TYPE = '4';

// Успех и отказ — эти ID одинаковы во всех воронках amoCRM.
const CLOSED_STATUS_IDS = new Set([142, 143]);

const SESSION_TTL = 60 * 60 * 24 * 30;   // месяц: столько живёт переписка
const MAX_QUEUE = 100;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = { ...DEFAULTS, ...pick(env, Object.keys(DEFAULTS)) };
    const secret = env.HOOK_SECRET || '';
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, cfg) });
    }

    if (url.pathname === '/widget.js') {
      return new Response(WIDGET, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'neoved-chat-worker' }, origin, cfg);
    }

    // Последние решения воркера — что прилетело и что с этим стало.
    if (secret && url.pathname === `/debug/${secret}`) {
      const entries = await readLog(env);
      return json({ ok: true, count: entries.length, log: entries }, origin, cfg);
    }

    // Вебхук amoCRM: примечание в сделке → ответ клиенту в виджет.
    // amoCRM ретраит хук, если не ответить быстро, — разбор уходит в фон.
    if (secret && request.method === 'POST' && url.pathname === `/amo/${secret}`) {
      const raw = await request.text();
      ctx.waitUntil(
        handleAmoHook(raw, env, cfg).catch(async (e) => {
          console.error('handleAmoHook failed', e);
          await writeLog(env, { verdict: 'ошибка amo-хука', error: String(e).slice(0, 400) });
        }),
      );
      return json({ ok: true }, origin, cfg);
    }

    if (url.pathname.startsWith('/api/')) {
      if (!originAllowed(origin, cfg)) {
        return json({ ok: false, error: 'origin не разрешён' }, origin, cfg, 403);
      }
      try {
        if (url.pathname === '/api/start' && request.method === 'POST') {
          return json(await apiStart(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/send' && request.method === 'POST') {
          return json(await apiSend(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/poll' && request.method === 'GET') {
          return json(await apiPoll(url, env), origin, cfg);
        }
      } catch (e) {
        const bad = e instanceof HttpError;
        if (!bad) {
          console.error('api failed', e);
          await writeLog(env, { verdict: 'ошибка api', path: url.pathname, error: String(e).slice(0, 400) });
        }
        return json({ ok: false, error: bad ? e.message : 'Внутренняя ошибка, попробуйте ещё раз' },
          origin, cfg, bad ? e.status : 500);
      }
      return json({ ok: false, error: 'не найдено' }, origin, cfg, 404);
    }

    return new Response('neoved-chat-worker', { status: 200 });
  },
};

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ─────────────────────────── приём заявки ───────────────────────────

async function apiStart(request, env, cfg) {
  const body = await readJson(request);
  const person = {
    name: str(body.name, 128),
    email: str(body.email, 128).toLowerCase(),
    phone: str(body.phone, 32),
    tg: nickOf(str(body.tg, 64)),
    page: str(body.page, 300),
  };
  const text = str(body.message, 4000);

  // Ник Telegram бывает только из латиницы, цифр и подчёркивания. Всё прочее
  // (кириллица, пробелы, эмодзи) — опечатка, и в карточку её пускать незачем:
  // искать по такому нику всё равно бессмысленно.
  if (!/^[a-z0-9_]{4,32}$/.test(person.tg)) person.tg = '';

  if (person.name.length < 2) throw new HttpError('Укажите имя');
  if (!/^[^\s@]+@[^\s@]+\.[a-zа-я]{2,}$/i.test(person.email)) throw new HttpError('Проверьте адрес почты');
  if (digits(person.phone).length < 10) throw new HttpError('Проверьте номер телефона');
  if (text.length < 5) throw new HttpError('Опишите вопрос хотя бы парой слов');

  await rateLimit(env, `start:${clientIp(request)}`, Number(cfg.START_LIMIT) || 5,
    'Слишком много заявок с этого адреса. Напишите на sales@neoved.io');

  const { leadId, contactId, verdict } = await syncToAmo(person, text, env, cfg);

  const sid = crypto.randomUUID();
  await env.S.put(`sid:${sid}`, JSON.stringify({
    leadId, contactId, name: person.name, at: Date.now(),
  }), { expirationTtl: SESSION_TTL });

  await writeLog(env, { verdict, lead_id: leadId, contact_id: contactId, name: person.name, sid });
  return { ok: true, sid, lead_id: leadId };
}

async function apiSend(request, env, cfg) {
  const body = await readJson(request);
  const sid = str(body.sid, 64);
  const text = str(body.text, 4000);
  if (!text) throw new HttpError('Пустое сообщение');

  const session = await getSession(env, sid);
  await rateLimit(env, `msg:${sid}`, Number(cfg.MSG_LIMIT) || 60, 'Слишком много сообщений подряд');

  await addNote(session.leadId, text, env);
  await writeLog(env, { verdict: `сообщение клиента → сделка ${session.leadId}`, lead_id: session.leadId, text: text.slice(0, 200) });
  return { ok: true };
}

async function apiPoll(url, env) {
  const sid = str(url.searchParams.get('sid'), 64);
  const after = Number(url.searchParams.get('after')) || 0;
  const session = await getSession(env, sid);   // чужой/протухший sid — 404

  // Очередь висит на сделке, а не на сессии: человек мог заполнить форму
  // заново (новый sid), и ответ менеджера, положенный по старому ключу, до
  // него бы не доехал. Из общей ленты берём только то, что написано после
  // начала этой сессии, — старую переписку показывать незачем.
  const messages = await readQueue(env, session.leadId, after, Number(session.at) || 0);
  return { ok: true, messages };
}

async function getSession(env, sid) {
  if (!sid) throw new HttpError('Нет идентификатора сессии');
  const raw = await env.S.get(`sid:${sid}`);
  if (!raw) throw new HttpError('Сессия устарела — обновите страницу и напишите снова', 404);
  return JSON.parse(raw);
}

// ─────────────────────────── amoCRM ───────────────────────────

async function syncToAmo(person, text, env, cfg) {
  const found = await findContact(person, env, cfg);
  const summary = firstNote(person, text);

  if (!found) {
    const created = await createLeadWithContact(person, env, cfg);
    await addNote(created.leadId, summary, env);
    return { ...created, verdict: 'создана сделка с новым контактом' };
  }

  const contact = found.contact;
  await fillEmptyFields(contact, person, env, cfg);

  const lead = await findOpenLead(contact, env);
  if (!lead) {
    const leadId = await createLead(person, contact.id, env, cfg);
    await addNote(leadId, summary, env);
    return {
      leadId, contactId: contact.id,
      verdict: `контакт найден по ${found.by}, открытых сделок не было — создана новая`,
    };
  }

  const statusId = await resolveNewStatus(lead.pipeline_id, env, cfg);
  // tags_to_add дописывает тег, не затирая уже висящие на сделке.
  const patch = { tags_to_add: [{ name: cfg.TAG_NAME }] };
  if (statusId && lead.status_id !== statusId) {
    patch.status_id = statusId;
    patch.pipeline_id = lead.pipeline_id;
  }
  await amo(`/api/v4/leads/${lead.id}`, env, { method: 'PATCH', body: patch });
  await addNote(lead.id, summary, env);

  return {
    leadId: lead.id, contactId: contact.id,
    verdict: statusId
      ? `контакт найден по ${found.by}, сделка ${lead.id} → «${cfg.NEW_STATUS_NAME}» + тег`
      : `контакт найден по ${found.by}, сделка ${lead.id}: этап «${cfg.NEW_STATUS_NAME}» в воронке не найден, поставлен только тег`,
  };
}

/**
 * Почта → телефон → ник Telegram, первое совпадение выигрывает.
 *
 * Ищем через ?query=, а не через filter[custom_fields_values][...]: этот
 * аккаунт фильтр по дополнительным полям не принимает — проверено на соседнем
 * tg-amo-worker, обе формы записи отдают 400 «Invalid filter for current
 * account». query ищет подстроку по всем заполненным полям, поэтому совпадение
 * обязательно перепроверяется по нужному полю.
 *
 * Телефон ищем цифрами: «+7 (926) 571-72-19» amoCRM не находит, а
 * «79265717219» и «9265717219» — находят один и тот же контакт
 * (проверено на аккаунте 19.08.2026).
 */
async function findContact(person, env, cfg) {
  if (person.email) {
    const hit = (await queryContacts(person.email, env))
      .find((c) => fieldValues(c, cfg.EMAIL_FIELD).some((v) => v.toLowerCase() === person.email));
    if (hit) return { contact: hit, by: 'почте' };
  }

  const tail = digits(person.phone).slice(-10);
  if (tail.length === 10) {
    const hit = (await queryContacts(tail, env))
      .find((c) => fieldValues(c, cfg.PHONE_FIELD).some((v) => digits(v).endsWith(tail)));
    if (hit) return { contact: hit, by: 'телефону' };
  }

  if (person.tg.length >= 3) {
    const lookup = list(cfg.TG_LOOKUP);
    const hit = (await queryContacts(person.tg, env))
      .find((c) => lookup.some((id) => fieldValues(c, id).some((v) => nickOf(v) === person.tg)));
    if (hit) return { contact: hit, by: 'нику Telegram' };
  }

  return null;
}

async function queryContacts(value, env) {
  const q = String(value || '').trim();
  if (q.length < 3) return [];
  const res = await amo(`/api/v4/contacts?limit=50&with=leads&query=${encodeURIComponent(q)}`, env);
  return res?._embedded?.contacts || [];      // ничего не нашлось → 204 → null
}

/** Значения одного поля контакта, пустые отброшены. */
function fieldValues(contact, fieldId) {
  const f = (contact.custom_fields_values || []).find((x) => String(x.field_id) === String(fieldId));
  return (f?.values || []).map((v) => String(v.value ?? '').trim()).filter(Boolean);
}

/**
 * Дописываем в карточку то, чего в ней ещё нет: клиент мог прийти год назад
 * только с почтой, а сегодня оставил телефон и ник. Заполненные поля не
 * трогаем — PATCH заменяет значения поля целиком, и чужой номер затёрся бы.
 */
async function fillEmptyFields(contact, person, env, cfg) {
  const add = [];
  if (person.email && !fieldValues(contact, cfg.EMAIL_FIELD).length) {
    add.push(multitext(cfg.EMAIL_FIELD, person.email));
  }
  if (person.phone && !fieldValues(contact, cfg.PHONE_FIELD).length) {
    add.push(multitext(cfg.PHONE_FIELD, person.phone));
  }
  if (person.tg && !list(cfg.TG_LOOKUP).some((id) => fieldValues(contact, id).length)) {
    add.push(field(cfg.TG_FIELD, `@${person.tg}`));
  }
  if (!add.length) return;
  await amo(`/api/v4/contacts/${contact.id}`, env, {
    method: 'PATCH',
    body: { custom_fields_values: add },
  });
}

/** Последняя сделка контакта, которая ещё не в «Успешно»/«Отказ». */
async function findOpenLead(contact, env) {
  const ids = (contact._embedded?.leads || []).map((l) => l.id).filter(Boolean);
  if (!ids.length) return null;

  const query = ids.slice(-50).map((id) => `filter[id][]=${id}`).join('&');
  const res = await amo(`/api/v4/leads?limit=50&${query}`, env);
  const leads = res?._embedded?.leads || [];

  const open = leads.filter((l) => !CLOSED_STATUS_IDS.has(Number(l.status_id)));
  if (!open.length) return null;
  open.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
  return open[open.length - 1];
}

/**
 * ID этапа «Новая заявка» внутри той же воронки, где лежит сделка, — чтобы
 * не перетаскивать её между воронками. Карта воронок кешируется на 10 минут.
 */
let pipelinesCache = { at: 0, map: null };
async function resolveNewStatus(pipelineId, env, cfg) {
  if (!pipelineId) return null;
  const fresh = Date.now() - pipelinesCache.at < 600_000;
  if (!fresh || !pipelinesCache.map) {
    const res = await amo('/api/v4/leads/pipelines', env);
    const map = {};
    for (const p of res?._embedded?.pipelines || []) {
      map[p.id] = {};
      for (const s of p._embedded?.statuses || []) map[p.id][norm(s.name)] = s.id;
    }
    pipelinesCache = { at: Date.now(), map };
  }
  return pipelinesCache.map?.[pipelineId]?.[norm(cfg.NEW_STATUS_NAME)] || null;
}

async function createLeadWithContact(person, env, cfg) {
  const fields = [multitext(cfg.EMAIL_FIELD, person.email), multitext(cfg.PHONE_FIELD, person.phone)];
  if (person.tg) fields.push(field(cfg.TG_FIELD, `@${person.tg}`));

  const body = [{
    name: leadName(person, cfg),
    pipeline_id: Number(cfg.PIPELINE_ID),
    status_id: Number(cfg.STATUS_ID),
    tags_to_add: [{ name: cfg.TAG_NAME }],
    _embedded: {
      contacts: [{ name: person.name, custom_fields_values: fields }],
    },
  }];
  // complex прогоняет контакт через контроль дублей и возвращает id сделки
  // и id контакта прямо в объекте ответа: [{ id, contact_id, company_id, … }].
  const res = await amo('/api/v4/leads/complex', env, { method: 'POST', body });
  return { leadId: res?.[0]?.id, contactId: res?.[0]?.contact_id || null };
}

async function createLead(person, contactId, env, cfg) {
  const body = [{
    name: leadName(person, cfg),
    pipeline_id: Number(cfg.PIPELINE_ID),
    status_id: Number(cfg.STATUS_ID),
    tags_to_add: [{ name: cfg.TAG_NAME }],
    _embedded: { contacts: [{ id: contactId }] },
  }];
  const res = await amo('/api/v4/leads', env, { method: 'POST', body });
  return res?._embedded?.leads?.[0]?.id;
}

/**
 * Пишет примечание и запоминает его id: на каждое примечание amoCRM пришлёт
 * вебхук, и без этой метки воркер вернул бы клиенту его же сообщение —
 * переписка зациклилась бы.
 */
async function addNote(leadId, text, env) {
  if (!leadId) return null;
  const res = await amo(`/api/v4/leads/${leadId}/notes`, env, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text } }],
  });
  const noteId = res?._embedded?.notes?.[0]?.id;
  if (noteId) await env.S.put(`note:${noteId}`, '1', { expirationTtl: 86400 });
  return noteId;
}

/** Первое примечание: контакты рядом с вопросом, чтобы менеджер видел всё сразу. */
function firstNote(person, text) {
  const lines = [
    'Заявка с сайта (виджет)',
    `Имя: ${person.name}`,
    `Почта: ${person.email}`,
    `Телефон: ${person.phone}`,
  ];
  if (person.tg) lines.push(`Telegram: @${person.tg}`);
  if (person.page) lines.push(`Страница: ${person.page}`);
  lines.push('', 'Сообщение:', text);
  return lines.join('\n');
}

function leadName(person, cfg) {
  return `${cfg.LEAD_NAME_PREFIX} — ${person.name}`;
}

// ─────────────────── ответ клиенту: amoCRM → виджет ───────────────────

/**
 * Вебхук amoCRM о добавлении примечания (событие note_lead).
 *
 * Формат в документации не описан; ключи сняты с живого хука 17.08.2026 —
 * `leads[note][0][note][…]` с полями id, element_id, element_type, note_type
 * (числом: 4 — обычное), text. То же самое разбирают соседние
 * tg-amo-worker и amo-phone-worker.
 */
async function handleAmoHook(raw, env, cfg) {
  const params = new URLSearchParams(raw);
  const root = parseNested(params);

  const notes = [];
  for (const bucket of [root.leads?.note, root.notes?.add, root.note?.add]) {
    for (const item of values(bucket)) {
      const note = item?.note || item;
      if (note && typeof note === 'object') notes.push(note);
    }
  }
  if (!notes.length) {
    return writeLog(env, { verdict: 'скип: в хуке amo нет примечаний', keys: [...params.keys()].slice(0, 30) });
  }
  for (const note of notes) await onAmoNote(note, env, cfg);
}

async function onAmoNote(note, env, cfg) {
  const noteId = String(note.id ?? '');
  const leadId = String(note.element_id ?? '');
  const type = String(note.note_type ?? '');

  // Звонки, системные сообщения и прочее в чат не показываем.
  if (type !== COMMON_NOTE_TYPE) return;

  // Кто написал. Примечания, созданные по API (наши собственные и чужих
  // интеграций), приходят с created_by = 0; у реплики живого менеджера тут
  // стоит его id. Это и есть защита от эха: KV-метка своего примечания
  // ненадёжна — вебхук успевает прийти раньше, чем запись разойдётся по
  // регионам, и сообщение клиента возвращалось ему же ответом.
  if (!Number(note.created_by ?? 0)) return;

  // Подстраховка на случай, если однажды у примечания появится ненулевой автор:
  // свои примечания воркер помечает в KV сразу после создания.
  if (noteId && await env.S.get(`note:${noteId}`)) {
    return writeLog(env, { verdict: 'скип: примечание создано воркером', note_id: noteId });
  }

  // Обслуживается ли эта сделка виджетом — спрашиваем у самой amoCRM, а не у
  // KV: свежезаписанный признак расходится по регионам до минуты, и вебхук об
  // ответе менеджера успевал прийти раньше. Тег на сделке виден сразу.
  if (!await taggedByWidget(leadId, env, cfg)) return;

  let text = String(note.text ?? '').trim();
  if (cfg.REPLY_PREFIX) {
    if (!text.startsWith(cfg.REPLY_PREFIX)) {
      return writeLog(env, { verdict: `скип: примечание без префикса «${cfg.REPLY_PREFIX}»`, note_id: noteId });
    }
    text = text.slice(cfg.REPLY_PREFIX.length).trim();
  }
  // Пометки соседних интеграций («Ответ: …» от tg-amo-worker) клиенту не нужны.
  for (const p of list(cfg.STRIP_PREFIXES)) {
    if (p && text.startsWith(p)) { text = text.slice(p.length).trim(); break; }
  }
  if (!text) return;

  // Каждый ответ — отдельный ключ, а не элемент общего списка: два примечания
  // подряд иначе могли бы прочитать одну и ту же версию списка и затереть друг
  // друга. Ключи сортируются как строки, поэтому id примечания дополняется
  // нулями — так list отдаёт их в хронологическом порядке.
  await env.S.put(msgKey(leadId, noteId), text, {
    expirationTtl: SESSION_TTL,
    metadata: { at: Date.now() },
  });

  await writeLog(env, {
    verdict: `ответ менеджера → виджет (сделка ${leadId})`,
    lead_id: leadId, note_id: noteId, user_id: note.created_by, text: text.slice(0, 200),
  });
}

const msgKey = (leadId, noteId) => `m:${leadId}:${String(noteId).padStart(14, '0')}`;

/** Тег виджета на сделке — признак того, что клиент ждёт ответа в чате. */
async function taggedByWidget(leadId, env, cfg) {
  const lead = await amo(`/api/v4/leads/${leadId}`, env);
  const tags = (lead?._embedded?.tags || []).map((t) => norm(t.name));
  return tags.includes(norm(cfg.TAG_NAME));
}

/**
 * Ответы менеджера по сделке: новее `after` (id примечания) и не старше начала
 * сессии. Значения читаются только у подходящих ключей — на обычном опросе,
 * когда нового нет, обходимся одним list.
 */
async function readQueue(env, leadId, after, since) {
  const listed = await env.S.list({ prefix: `m:${leadId}:`, limit: MAX_QUEUE });
  const fresh = listed.keys
    .map((k) => ({ key: k.name, id: Number(k.name.split(':').pop()), at: Number(k.metadata?.at) || 0 }))
    .filter((k) => k.id > after && k.at >= since);

  const out = [];
  for (const k of fresh) {
    const text = await env.S.get(k.key);
    if (text) out.push({ id: k.id, text, at: k.at });
  }
  return out;
}

/** leads[note][0][note][text]=… → { leads: { note: { 0: { note: { text } } } } } */
function parseNested(params) {
  const root = {};
  for (const [key, value] of params.entries()) {
    const path = key.replace(/\]/g, '').split('[');
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
      node = node[k];
    }
    node[path[path.length - 1]] = value;
  }
  return root;
}

const values = (obj) => (obj && typeof obj === 'object' ? Object.values(obj) : []);

// ─────────────────────────── утилиты ───────────────────────────

const field = (id, value) => ({ field_id: Number(id), values: [{ value: String(value) }] });
const multitext = (id, value) => ({ field_id: Number(id), values: [{ value: String(value), enum_code: 'WORK' }] });

async function amo(path, env, opts = {}) {
  const res = await fetch(`https://${env.AMO_SUBDOMAIN}.amocrm.ru${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${env.AMO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;             // «ничего не нашлось»
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`amo ${opts.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Грубый счётчик на час: KV не атомарен, при одновременных запросах пара
 * попыток проскочит сверх лимита. Для отсечения спама этого достаточно.
 */
async function rateLimit(env, key, limit, message) {
  const bucket = `rate:${key}:${Math.floor(Date.now() / 3_600_000)}`;
  const used = Number(await env.S.get(bucket)) || 0;
  if (used >= limit) throw new HttpError(message, 429);
  await env.S.put(bucket, String(used + 1), { expirationTtl: 7200 });
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError('Ожидался JSON'); }
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function originAllowed(origin, cfg) {
  const allowed = list(cfg.ALLOW_ORIGINS);
  return !allowed.length || !origin || allowed.includes(origin);
}

function corsHeaders(origin, cfg) {
  const allowed = list(cfg.ALLOW_ORIGINS);
  return {
    'Access-Control-Allow-Origin': !allowed.length ? (origin || '*') : (allowed.includes(origin) ? origin : allowed[0]),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** «https://t.me/ivanov», «@ivanov», «ivanov» → «ivanov» */
const nickOf = (v) => String(v || '').trim().toLowerCase()
  .replace(/^https?:\/\/(t\.me|telegram\.me)\//, '')
  .replace(/^@/, '')
  .replace(/\/+$/, '');

const digits = (v) => String(v || '').replace(/\D/g, '');
const norm = (s) => String(s || '').trim().toLowerCase();
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

function json(obj, origin, cfg, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin, cfg) },
  });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  return out;
}

// Кольцевой лог последних решений — единственный способ понять,
// что именно прилетело от amoCRM.
async function readLog(env) {
  try { return JSON.parse((await env.S.get('log')) || '[]'); } catch { return []; }
}

async function writeLog(env, entry) {
  const entries = await readLog(env);
  entries.unshift({ at: new Date().toISOString(), ...entry });
  await env.S.put('log', JSON.stringify(entries.slice(0, 50)));
}
