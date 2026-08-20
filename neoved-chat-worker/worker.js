/**
 * neoved-chat-worker — виджет обратной связи на сайте ↔ amoCRM.
 *
 * Как это работает:
 *   Посетитель заполняет короткую форму (имя, рабочая почта, по желанию ИНН)
 *   и пишет вопрос → воркер ищет контакт по почте, при необходимости заводит
 *   компанию по ИНН и создаёт сделку в воронке «Чат на сайте». Текст падает
 *   примечанием в ленту сделки.
 *
 *   Менеджер отвечает прямо в карточке — обычным примечанием. amoCRM шлёт
 *   вебхук `note_lead`, воркер складывает текст в очередь сделки, виджет
 *   забирает её опросом /api/poll и показывает в чате.
 *
 *   По ходу разговора виджет досылает то, что человек не указал сразу:
 *   /api/inn — ИНН (создаётся компания), /api/phone — телефон.
 *
 * Почему примечания, а не Chats API:
 *   Двусторонний чат amoCRM (amojo) требует канала, зарегистрированного через
 *   партнёрский аккаунт в amoMarket, — у обычной интеграции его нет. Примечания
 *   доступны любому долгосрочному токену и работают в обе стороны: этим же
 *   способом живёт соседний tg-amo-worker.
 *
 * Секреты (задаются при деплое):
 *   AMO_SUBDOMAIN — поддомен аккаунта amoCRM без .amocrm.ru
 *   AMO_TOKEN     — долгосрочный токен интеграции amoCRM
 *   HOOK_SECRET   — произвольная строка: часть URL вебхука и адреса /debug
 *   CAPTCHA_KEY   — серверный ключ Яндекс SmartCaptcha (пусто — проверка выключена)
 * Переменные — см. DEFAULTS ниже.
 * KV binding: S (сессии, очередь ответов, отладочный лог).
 *
 * Текст виджета лежит рядом в widget.js и заливается текстовым модулем.
 */

import WIDGET from './widget.js';

const DEFAULTS = {
  // Воронка «Чат на сайте» и её этап «Первичный контакт».
  PIPELINE_ID: '11212054',
  STATUS_ID: '87966922',
  // На этот этап возвращаем сделку, если человек написал повторно.
  NEW_STATUS_NAME: 'Первичный контакт',
  TAG_NAME: 'site_chat',
  // Название сделки: «site chat: Иван | uslugi/ved».
  LEAD_NAME_PREFIX: 'site chat',
  // Домен сайта — из адреса страницы вырезается всё до него, остаток идёт
  // в название сделки.
  SITE_HOST: 'neoved.io',

  // Поля контакта и компании в этом аккаунте.
  EMAIL_FIELD: '629257',        // EMAIL, multitext — пишем с enum WORK («Email раб.»)
  PHONE_FIELD: '629255',        // PHONE, multitext — enum WORK («Раб. тел.»)
  COMPANY_INN_FIELD: '630037',  // «ИНН» у компании, numeric
  LEAD_URL_FIELD: '980989',     // «Источник» у сделки, url — полный адрес страницы

  // Пусто — виджет можно ставить на любой домен. Иначе список origin через запятую.
  ALLOW_ORIGINS: '',

  // Пусто — клиенту уходит ЛЮБОЕ обычное примечание, написанное человеком
  // (примечания интеграций отсеиваются по created_by). Если поставить сюда,
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
      return json({ ok: true, service: 'neoved-chat-worker', captcha: Boolean(env.CAPTCHA_KEY) }, origin, cfg);
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
        if (url.pathname === '/api/inn' && request.method === 'POST') {
          return json(await apiInn(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/phone' && request.method === 'POST') {
          return json(await apiPhone(request, env, cfg), origin, cfg);
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
    inn: digits(str(body.inn, 20)),
    ads: Boolean(body.ads),                 // согласие на рекламные сообщения
    page: str(body.page, 300),
  };
  const text = str(body.message, 4000);

  if (person.name.length < 2) throw new HttpError('Укажите имя');
  if (!/^[^\s@]+@[^\s@]+\.[a-zа-я]{2,}$/i.test(person.email)) throw new HttpError('Проверьте адрес почты');
  if (person.inn && !isInn(person.inn)) throw new HttpError('ИНН — 10 цифр у компании или 12 у ИП');
  if (!body.consent) throw new HttpError('Без согласия на обработку персональных данных начать чат нельзя');
  if (text.length < 2) throw new HttpError('Напишите сообщение');

  await checkCaptcha(str(body.captcha, 4000), request, env);
  await rateLimit(env, `start:${clientIp(request)}`, Number(cfg.START_LIMIT) || 5,
    'Слишком много обращений с этого адреса. Напишите на sales@neoved.io');

  const result = await syncToAmo(person, text, env, cfg);

  const sid = crypto.randomUUID();
  await env.S.put(`sid:${sid}`, JSON.stringify({
    leadId: result.leadId,
    contactId: result.contactId,
    companyId: result.companyId,
    name: person.name,
    email: person.email,
    at: Date.now(),
  }), { expirationTtl: SESSION_TTL });

  await writeLog(env, {
    verdict: result.verdict, lead_id: result.leadId, contact_id: result.contactId,
    company_id: result.companyId, name: person.name, sid,
  });
  return { ok: true, sid, lead_id: result.leadId, has_inn: Boolean(person.inn) };
}

async function apiSend(request, env, cfg) {
  const body = await readJson(request);
  const sid = str(body.sid, 64);
  const text = str(body.text, 4000);
  if (!text) throw new HttpError('Пустое сообщение');

  const session = await getSession(env, sid);
  await rateLimit(env, `msg:${sid}`, Number(cfg.MSG_LIMIT) || 60, 'Слишком много сообщений подряд');

  await addNote(session.leadId, text, env);
  await writeLog(env, {
    verdict: `сообщение клиента → сделка ${session.leadId}`,
    lead_id: session.leadId, text: text.slice(0, 200),
  });
  return { ok: true };
}

/** ИНН, названный уже в разговоре: заводим компанию и подшиваем её к сделке. */
async function apiInn(request, env, cfg) {
  const body = await readJson(request);
  const sid = str(body.sid, 64);
  const inn = digits(str(body.inn, 20));
  if (!isInn(inn)) throw new HttpError('ИНН — 10 цифр у компании или 12 у ИП');

  const session = await getSession(env, sid);
  const company = await ensureCompany({ inn, email: session.email }, env, cfg);
  await linkCompany(company.id, session, env);
  await addNote(session.leadId, `Клиент указал ИНН: ${inn}`, env);

  session.companyId = company.id;
  await env.S.put(`sid:${sid}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });

  await writeLog(env, {
    verdict: `ИНН из чата → компания ${company.id} (сделка ${session.leadId})`,
    lead_id: session.leadId, company_id: company.id, inn,
  });
  return { ok: true };
}

/** Телефон, оставленный по ходу разговора: пишем контакту и компании. */
async function apiPhone(request, env, cfg) {
  const body = await readJson(request);
  const sid = str(body.sid, 64);
  const phone = str(body.phone, 32);
  if (digits(phone).length !== 11 || !/^[78]/.test(digits(phone))) {
    throw new HttpError('Нужен российский номер: +7 999 123-45-67');
  }

  const session = await getSession(env, sid);
  const pretty = formatRuPhone(phone);

  if (session.contactId) await addPhone('contacts', session.contactId, pretty, env, cfg);
  if (session.companyId) await addPhone('companies', session.companyId, pretty, env, cfg);
  await addNote(session.leadId, `Клиент оставил телефон: ${pretty}`, env);

  await writeLog(env, {
    verdict: `телефон из чата → контакт ${session.contactId} (сделка ${session.leadId})`,
    lead_id: session.leadId, contact_id: session.contactId, phone: pretty,
  });
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
  const contact = await findContact(person, env, cfg);
  const company = person.inn ? await ensureCompany(person, env, cfg) : null;
  const summary = firstNote(person, text);

  // Контакта в базе нет — сделка, контакт и компания одним запросом.
  if (!contact) {
    const created = await createLeadWithContact(person, company, env, cfg);
    await addNote(created.leadId, summary, env);
    return { ...created, companyId: company?.id || null, verdict: 'создана сделка с новым контактом' };
  }

  await fillEmptyFields(contact, person, env, cfg);

  // Повторное обращение: если сделка в воронке чата ещё живая, продолжаем в
  // ней, а не плодим новую. Сделки других воронок не трогаем — у них своя жизнь.
  const lead = await findOpenChatLead(contact, env, cfg);
  if (!lead) {
    const leadId = await createLead(person, contact.id, company, env, cfg);
    await addNote(leadId, summary, env);
    return {
      leadId, contactId: contact.id, companyId: company?.id || null,
      verdict: 'контакт был, открытой сделки в воронке чата не было — создана новая',
    };
  }

  const statusId = await resolveStatus(lead.pipeline_id, env, cfg);
  const patch = { tags_to_add: [{ name: cfg.TAG_NAME }] };
  if (statusId && lead.status_id !== statusId) {
    patch.status_id = statusId;
    patch.pipeline_id = lead.pipeline_id;
  }
  if (person.page) patch.custom_fields_values = [field(cfg.LEAD_URL_FIELD, person.page)];
  if (company) patch._embedded = { companies: [{ id: company.id }] };
  await amo(`/api/v4/leads/${lead.id}`, env, { method: 'PATCH', body: patch });
  await addNote(lead.id, summary, env);

  return {
    leadId: lead.id, contactId: contact.id, companyId: company?.id || null,
    verdict: `сделка ${lead.id} → «${cfg.NEW_STATUS_NAME}» + тег`,
  };
}

/**
 * Контакт ищем по рабочей почте — единственное, что человек оставляет на входе.
 *
 * Ищем через ?query=, а не через filter[custom_fields_values][...]: этот
 * аккаунт фильтр по дополнительным полям не принимает — проверено на соседнем
 * tg-amo-worker, обе формы записи отдают 400 «Invalid filter for current
 * account». query ищет подстроку по всем заполненным полям, поэтому совпадение
 * обязательно перепроверяется по нужному полю.
 */
async function findContact(person, env, cfg) {
  if (!person.email) return null;
  const found = await query('contacts', person.email, env, 'with=leads');
  return found.find((c) => fieldValues(c, cfg.EMAIL_FIELD).some((v) => v.toLowerCase() === person.email)) || null;
}

/** Компания по ИНН: нашли — берём, нет — заводим с названием по ИНН. */
async function ensureCompany(person, env, cfg) {
  const found = await query('companies', person.inn, env);
  const hit = found.find((c) => fieldValues(c, cfg.COMPANY_INN_FIELD).some((v) => digits(v) === person.inn));
  if (hit) {
    if (person.email && !fieldValues(hit, cfg.EMAIL_FIELD).length) {
      await amo(`/api/v4/companies/${hit.id}`, env, {
        method: 'PATCH',
        body: { custom_fields_values: [multitext(cfg.EMAIL_FIELD, person.email)] },
      });
    }
    return hit;
  }

  // Названия компании виджет не спрашивает, поэтому в имя идёт ИНН —
  // менеджер переименует карточку, когда узнает организацию.
  const fields = [field(cfg.COMPANY_INN_FIELD, person.inn)];
  if (person.email) fields.push(multitext(cfg.EMAIL_FIELD, person.email));
  const res = await amo('/api/v4/companies', env, {
    method: 'POST',
    body: [{ name: person.inn, custom_fields_values: fields }],
  });
  return res?._embedded?.companies?.[0];
}

/** Компанию видно и в сделке, и в карточке контакта. */
async function linkCompany(companyId, session, env) {
  if (!companyId) return;
  await amo(`/api/v4/leads/${session.leadId}`, env, {
    method: 'PATCH',
    body: { _embedded: { companies: [{ id: companyId }] } },
  });
  if (session.contactId) {
    await amo(`/api/v4/contacts/${session.contactId}`, env, {
      method: 'PATCH',
      body: { _embedded: { companies: [{ id: companyId }] } },
    });
  }
}

/** Дописывает телефон, не затирая уже записанные номера. */
async function addPhone(entity, id, phone, env, cfg) {
  const card = await amo(`/api/v4/${entity}/${id}`, env);
  const existing = fieldValues(card, cfg.PHONE_FIELD);
  if (existing.some((v) => digits(v).slice(-10) === digits(phone).slice(-10))) return;

  const values = existing.map((v) => ({ value: v })).concat([{ value: phone, enum_code: 'WORK' }]);
  await amo(`/api/v4/${entity}/${id}`, env, {
    method: 'PATCH',
    body: { custom_fields_values: [{ field_id: Number(cfg.PHONE_FIELD), values }] },
  });
}

async function query(entity, value, env, extra = '') {
  const q = String(value || '').trim();
  if (q.length < 3) return [];
  const res = await amo(`/api/v4/${entity}?limit=50&${extra ? extra + '&' : ''}query=${encodeURIComponent(q)}`, env);
  return res?._embedded?.[entity] || [];      // ничего не нашлось → 204 → null
}

/** Значения одного поля карточки, пустые отброшены. */
function fieldValues(card, fieldId) {
  const f = (card?.custom_fields_values || []).find((x) => String(x.field_id) === String(fieldId));
  return (f?.values || []).map((v) => String(v.value ?? '').trim()).filter(Boolean);
}

/**
 * Дописываем в карточку то, чего в ней ещё нет: клиент мог прийти год назад
 * без почты. Заполненные поля не трогаем — PATCH заменяет значения поля
 * целиком, и чужой адрес затёрся бы.
 */
async function fillEmptyFields(contact, person, env, cfg) {
  if (!person.email || fieldValues(contact, cfg.EMAIL_FIELD).length) return;
  await amo(`/api/v4/contacts/${contact.id}`, env, {
    method: 'PATCH',
    body: { custom_fields_values: [multitext(cfg.EMAIL_FIELD, person.email)] },
  });
}

/** Последняя незакрытая сделка контакта в воронке чата. */
async function findOpenChatLead(contact, env, cfg) {
  const ids = (contact._embedded?.leads || []).map((l) => l.id).filter(Boolean);
  if (!ids.length) return null;

  const q = ids.slice(-50).map((id) => `filter[id][]=${id}`).join('&');
  const res = await amo(`/api/v4/leads?limit=50&${q}`, env);
  const open = (res?._embedded?.leads || [])
    .filter((l) => String(l.pipeline_id) === String(cfg.PIPELINE_ID))
    .filter((l) => !CLOSED_STATUS_IDS.has(Number(l.status_id)));

  if (!open.length) return null;
  open.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
  return open[open.length - 1];
}

/**
 * ID нужного этапа внутри той же воронки, где лежит сделка. Карта воронок
 * кешируется на 10 минут.
 */
let pipelinesCache = { at: 0, map: null };
async function resolveStatus(pipelineId, env, cfg) {
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

async function createLeadWithContact(person, company, env, cfg) {
  const body = [{
    ...leadBody(person, company, cfg),
    _embedded: {
      contacts: [{
        name: person.name,
        custom_fields_values: [multitext(cfg.EMAIL_FIELD, person.email)],
      }],
      ...(company ? { companies: [{ id: company.id }] } : {}),
    },
  }];
  // complex прогоняет контакт через контроль дублей и возвращает id сделки
  // и id контакта прямо в объекте ответа: [{ id, contact_id, company_id, … }].
  const res = await amo('/api/v4/leads/complex', env, { method: 'POST', body });
  return { leadId: res?.[0]?.id, contactId: res?.[0]?.contact_id || null };
}

async function createLead(person, contactId, company, env, cfg) {
  const body = [{
    ...leadBody(person, company, cfg),
    _embedded: {
      contacts: [{ id: contactId }],
      ...(company ? { companies: [{ id: company.id }] } : {}),
    },
  }];
  const res = await amo('/api/v4/leads', env, { method: 'POST', body });
  return res?._embedded?.leads?.[0]?.id;
}

function leadBody(person, company, cfg) {
  const body = {
    name: leadName(person, cfg),
    pipeline_id: Number(cfg.PIPELINE_ID),
    status_id: Number(cfg.STATUS_ID),
    tags_to_add: [{ name: cfg.TAG_NAME }],
  };
  if (person.page) body.custom_fields_values = [field(cfg.LEAD_URL_FIELD, person.page)];
  return body;
}

/**
 * Пишет примечание и запоминает его id: на каждое примечание amoCRM пришлёт
 * вебхук, и метка помогает не принять собственную запись за ответ менеджера.
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
    'Чат на сайте (виджет)',
    `Имя: ${person.name}`,
    `Рабочая почта: ${person.email}`,
  ];
  if (person.inn) lines.push(`ИНН: ${person.inn}`);
  lines.push(`Согласие на рекламные сообщения: ${person.ads ? 'да' : 'нет'}`);
  if (person.page) lines.push(`Страница: ${person.page}`);
  lines.push('', 'Сообщение:', text);
  return lines.join('\n');
}

/** «site chat: Иван | uslugi/ved» — по названию видно, с какой страницы пришли. */
function leadName(person, cfg) {
  return `${cfg.LEAD_NAME_PREFIX}: ${person.name} | ${pagePath(person.page, cfg)}`;
}

/** Из «https://neoved.io/uslugi/ved?x=1» получается «uslugi/ved». */
function pagePath(page, cfg) {
  if (!page) return '—';
  try {
    const path = new URL(page).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return path || '/';
  } catch {
    const cut = String(page).split(cfg.SITE_HOST).pop() || '';
    return cut.replace(/^\/+/, '').replace(/[?#].*$/, '') || '/';
  }
}

// ─────────────────── ответ клиенту: amoCRM → виджет ───────────────────

/**
 * Вебхук amoCRM о добавлении примечания (событие note_lead).
 *
 * Формат в документации не описан; ключи сняты с живого хука 17.08.2026 —
 * `leads[note][0][note][…]` с полями id, element_id, element_type, note_type
 * (числом: 4 — обычное), text, created_by. То же самое разбирают соседние
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

// ─────────────────────────── защита от спама ───────────────────────────

/**
 * Яндекс SmartCaptcha. Пока серверный ключ не задан, проверка выключена и
 * работают только лимиты по IP: виджет тоже рисует капчу лишь при наличии
 * клиентского ключа.
 * https://yandex.cloud/ru/docs/smartcaptcha/concepts/validation
 */
async function checkCaptcha(token, request, env) {
  if (!env.CAPTCHA_KEY) return;
  if (!token) throw new HttpError('Подтвердите, что вы не робот');

  const params = new URLSearchParams({
    secret: env.CAPTCHA_KEY,
    token,
    ip: clientIp(request),
  });
  const res = await fetch(`https://smartcaptcha.yandexcloud.net/validate?${params}`, { method: 'POST' });
  if (!res.ok) {
    // Сервис капчи недоступен — пропускаем: лучше принять заявку, чем потерять.
    console.error('smartcaptcha validate failed', res.status);
    return;
  }
  const data = await res.json();
  if (data.status !== 'ok') throw new HttpError('Проверка «я не робот» не пройдена, попробуйте ещё раз');
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

/** 10 цифр у организации, 12 у ИП — длиннее или короче не бывает. */
const isInn = (v) => /^(\d{10}|\d{12})$/.test(String(v || ''));

/** «79991234567» → «+7 999 123-45-67» */
function formatRuPhone(value) {
  const d = digits(value).replace(/^8/, '7');
  if (d.length !== 11) return String(value);
  return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

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
