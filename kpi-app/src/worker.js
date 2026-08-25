/**
 * KPI отдела ассистентов — Cloudflare Worker + D1.
 *
 * Роли:
 *   assistant — видит только себя
 *   lead      — видит весь отдел, правит настройки, выдаёт ключи
 *   chief     — руководитель: принимает работу одним «да/нет», видит сводку
 *
 * Никаких субъективных оценок в базе нет. Хранятся только события с временем,
 * а все цифры выводятся из них на лету — поэтому любую можно развернуть
 * до списка задач, из которых она сложилась.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// ── утилиты ──────────────────────────────────────────────────────────────────

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const bad = (msg, status = 400) => json({ error: msg }, status);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
}

const nowIso = () => new Date().toISOString();

function currentPeriod(offsetHours = 3) {
  const d = new Date(Date.now() + offsetHours * 3600e3);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Разница в минутах между двумя ISO-отметками. */
function minutesBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
}

/** Человекочитаемая длительность: 95 → «1 ч 35 мин». */
function humanMinutes(m) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  return `${d} д ${h % 24} ч`;
}

// ── настройки ────────────────────────────────────────────────────────────────

async function loadSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const row of results) s[row.key] = row.value;
  return s;
}

const num = (s, key, fallback = 0) => {
  const v = parseFloat(s[key]);
  return Number.isFinite(v) ? v : fallback;
};

// ── аутентификация ───────────────────────────────────────────────────────────

async function authenticate(request, db) {
  const key =
    request.headers.get('x-access-key') ||
    new URL(request.url).searchParams.get('key');
  if (!key) return null;
  const hash = await sha256(key);
  const user = await db
    .prepare('SELECT id, name, role, grade, salary FROM users WHERE key_hash = ? AND active = 1')
    .bind(hash)
    .first();
  return user || null;
}

// ── расчёт метрик ────────────────────────────────────────────────────────────

/**
 * Оценка одной задачи. Ничего не спрашивает у человека:
 * три признака снимаются с событий, четвёртый — ответ руководителя
 * по инициативе (и только по ней).
 */
function scoreTask(task) {
  if (task.status === 'failed') {
    return { score: 0, flags: { inTime: false, noReturns: false, noChief: false }, reason: 'сорвана' };
  }

  // Время в блокере и ожидании не идёт против исполнителя: дедлайн
  // сдвигается на столько же, сколько задача простояла не по его вине.
  const effectiveDeadline = task.deadline
    ? new Date(new Date(task.deadline).getTime() + (task.paused_min || 0) * 60000)
    : null;

  const inTime = effectiveDeadline && task.done_at
    ? new Date(task.done_at) <= effectiveDeadline
    : !task.deadline; // без дедлайна признак не снимается — считается выполненным
  const noReturns = (task.returns || 0) === 0;
  const noChief = !task.chief_touched || task.disputed === 1;

  const hits = [inTime, noReturns, noChief].filter(Boolean).length;
  let score = [2, 4, 6, 8][hits];
  if (hits === 3 && task.is_initiative && task.initiative_useful === 1) score = 10;

  return { score, flags: { inTime, noReturns, noChief }, reason: null };
}

/** Эффективный размер задачи с поправкой на ночь и выходные. */
const taskWeight = (t) => (t.size || 1) * (t.night ? 1.5 : 1);

/**
 * Все четыре оценки человека за период.
 * Возвращает и сами цифры, и «из чего они сложились» — вторая часть
 * важнее первой: без неё цифру нельзя аргументировать.
 */
function computeMetrics({ tasks, replies, settings, grade }) {
  // отменённые задачи в расчёт не идут: их не делали, а сняли
  const closed = tasks.filter((t) => ['accepted', 'failed'].includes(t.status));

  // Месяц без единого закрытого дела и без единого ответа в чате — это не
  // «нет данных, начислим по умолчанию», а отсутствие работы. Иначе человек,
  // который весь месяц молчал, получал бы часть бонуса просто за тишину.
  const idle = closed.length === 0 && replies.length === 0 && tasks.length === 0;

  // Качество — средневзвешенная оценка задач
  let points = 0;
  let weight = 0;
  const scored = closed.map((t) => {
    const s = scoreTask(t);
    const w = taskWeight(t);
    points += s.score * w;
    weight += w;
    return { ...t, ...s, weight: w };
  });
  const quality = weight > 0 ? points / weight : 0;

  // Реакция в чате — балльная. Один пропуск стоит трёх быстрых ответов,
  // поэтому провал начала месяца отыгрывается, а не ставит крест.
  // Ответ в нерабочее время ценнее рабочего: отвечать было не обязательно.
  const chat = scoreChat(replies, settings);

  const withDeadline = closed.filter((t) => t.deadline);
  const inTimeCount = withDeadline.filter((t) => scoreTask(t).flags.inTime).length;
  const slaRate = withDeadline.length ? inTimeCount / withDeadline.length : 0;
  const slaScore = slaRate * 10;

  // 4 балла из 10 — реакция, 6 — попадание в срок
  const speed = Math.max(0, Math.min(10, 0.4 * chat.score + 0.6 * slaScore));

  // Автономность — доля задач без вовлечения руководителя, отнесённая к норме
  const normAut = num(settings, `norm_autonomy_${grade}`, 0.85);
  const soloCount = closed.filter((t) => scoreTask(t).flags.noChief).length;
  const soloRate = closed.length ? soloCount / closed.length : 0;
  const autonomy = Math.min(10, normAut > 0 ? (soloRate / normAut) * 10 : 0);

  // Проактивность — инициативы, которые пригодились
  const normPro = num(settings, 'norm_proactivity', 4);
  const initiatives = closed.filter((t) => t.is_initiative && t.initiative_useful === 1).length;
  const proactivity = Math.min(10, normPro > 0 ? (initiatives / normPro) * 10 : 0);

  return {
    // Пустой месяц не приносит денег: без задач и без ответов метрика
    // не «нет данных», а ноль. Иначе тишина оплачивалась бы наравне с работой.
    quality: idle ? 0 : round2(quality),
    speed: idle ? 0 : round2(speed),
    autonomy: idle ? 0 : round2(autonomy),
    proactivity: idle ? 0 : round2(proactivity),
    idle,
    breakdown: {
      idle: idle ? 'за период нет ни задач, ни ответов в чате — бонус не начисляется' : null,
      quality: {
        tasks: closed.length,
        weight: round2(weight),
        points: round2(points),
        formula: `${round2(points)} баллов ÷ ${round2(weight)} размеров`,
      },
      speed: {
        chatScore: chat.score,
        chatPoints: chat.points,
        requests: chat.reference,
        repliesFast: chat.fast,
        repliesSlow: chat.slow,
        offHoursAnswered: chat.off,
        misses: chat.miss,
        medianReply: chat.median,
        chatFormula: chat.formula,
        detail: chat.detail,
        withDeadline: withDeadline.length,
        inTime: inTimeCount,
        slaRate: pct(slaRate),
        slaScore: round2(slaScore),
        formula: `реакция ${chat.score} × 0.4 + срок ${round2(slaScore)} × 0.6`,
      },
      autonomy: {
        solo: soloCount,
        of: closed.length,
        rate: pct(soloRate),
        norm: pct(normAut),
        formula: `${pct(soloRate)} ÷ ${pct(normAut)} × 10`,
      },
      proactivity: {
        useful: initiatives,
        norm: normPro,
        proposed: closed.filter((t) => t.is_initiative).length,
        formula: `${initiatives} из нормы ${normPro}`,
      },
    },
    scored,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const pct = (n) => `${Math.round(n * 1000) / 10} %`;

/**
 * Реакция в чате в баллах.
 *
 * Один пропуск стоит ровно трёх быстрых ответов, поэтому провал в начале
 * месяца отыгрывается — до десятки дойти можно всегда. Выше десятки нельзя.
 * Ответ в нерабочее время ценнее рабочего: отвечать было не обязательно.
 *
 * Ориентир для нормировки — количество вопросов рабочего времени:
 * ответить быстро на все и есть «десятка».
 */
function scoreChat(replies, settings) {
  const target = num(settings, 'reply_target_min', 15);
  const urgentTarget = num(settings, 'urgent_target_min', 5);
  const ptFast = num(settings, 'pt_fast', 1);
  const ptSlow = num(settings, 'pt_slow', 0);
  const ptOff = num(settings, 'pt_offhours', 2);
  const ptMiss = num(settings, 'pt_miss', -3);

  // вопросы, помеченные как «отвечать было не нужно», из расчёта выпадают
  const counted = replies.filter((r) => !r.no_reply_needed);

  const detail = [];
  let points = 0;
  let fast = 0, slow = 0, off = 0, miss = 0;

  for (const r of counted) {
    const limit = (r.urgent ? urgentTarget : target) * 60;
    const answered = r.seconds !== null && r.seconds !== undefined;

    if (!answered) {
      if (isMiss(r, settings)) {
        miss += 1; points += ptMiss;
        detail.push({ ...r, kind: 'miss', delta: ptMiss, why: 'остался без ответа' });
      }
      continue;
    }
    if (r.in_hours === 0) {
      off += 1; points += ptOff;
      detail.push({ ...r, kind: 'offhours', delta: ptOff, why: 'ответил в нерабочее время' });
    } else if (r.seconds <= limit) {
      fast += 1; points += ptFast;
      detail.push({ ...r, kind: 'fast', delta: ptFast, why: `ответил за ${Math.round(r.seconds / 60)} мин` });
    } else {
      slow += 1; points += ptSlow;
      detail.push({ ...r, kind: 'slow', delta: ptSlow, why: `ответил за ${Math.round(r.seconds / 60)} мин, норма ${r.urgent ? urgentTarget : target}` });
    }
  }

  // Вопросов не было — отвечать было не на что, метрику не занижаем.
  // Но и не считаем это заслугой: если человек вообще ничего не делал,
  // это отсекается уровнем выше, в computeMetrics.
  const reference = counted.filter((r) => r.in_hours === 1).length;
  const score = reference === 0 ? 10 : Math.max(0, Math.min(10, (10 * points) / reference));

  return {
    score: round2(score),
    points: round2(points),
    reference,
    fast, slow, off, miss,
    median: medianSeconds(counted.filter((r) => r.seconds !== null && r.in_hours === 1)),
    unanswered: counted.filter((r) => r.seconds === null && !isMiss(r, settings)).length,
    detail,
    formula: reference === 0
      ? 'вопросов не было — метрика не снижается'
      : `${round2(points)} балла ÷ ${reference} вопросов × 10`,
  };
}

/**
 * Не всякое сообщение требует ответа. «Понял, спасибо» таймер не открывает.
 *
 * Правила намеренно простые и проверяемые глазами: вопросительный знак,
 * список коротких подтверждений и длина. Любую ошибку можно поправить
 * вручную — в приложении вопрос помечается как не требовавший ответа.
 */
function needsReply(msg, settings) {
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return false;                       // стикер, картинка, голосовое без подписи
  if (text.includes('?')) return true;           // прямой вопрос — всегда

  const lower = text.toLowerCase();
  const stops = (settings.no_reply_words || '')
    .split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

  // сообщение целиком состоит из подтверждения: «спасибо», «понял», «ок»
  const stripped = lower.replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => stops.includes(w))) return false;

  // короткая реплика без вопроса — это реакция, а не задача
  if (text.length < num(settings, 'min_request_len', 25)) return false;

  return true;
}

/**
 * Пропуск — это молчание, а не медленный ответ.
 *
 * В рабочее время: не ответили дольше miss_after_min.
 * Вне рабочего времени отвечать никто не обязан, но сообщение,
 * которое провисело всю ночь и утро, тоже становится пропуском:
 * увидеть его к началу дня — часть работы.
 */
function isMiss(reply, settings, now = Date.now()) {
  if (reply.replied_at || reply.seconds !== null) return false;
  const waited = (now - new Date(reply.asked_at)) / 60000;
  if (reply.in_hours === 1) return waited > num(settings, 'miss_after_min', 60);
  return waited > num(settings, 'miss_night_hours', 12) * 60;
}

function medianSeconds(replies) {
  const vals = replies.map((r) => r.seconds).filter((v) => v !== null).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
}

/** Деньги: сколько забрано из каждого кошелька. */
function computeMoney(metrics, settings, extra = {}) {
  const purses = {
    quality: num(settings, 'purse_quality', 17500),
    speed: num(settings, 'purse_speed', 12500),
    autonomy: num(settings, 'purse_autonomy', 10000),
    proactivity: num(settings, 'purse_proactivity', 10000),
  };
  const values = {
    quality: metrics.quality,
    speed: metrics.speed,
    autonomy: metrics.autonomy,
    proactivity: metrics.proactivity,
  };

  const threshold = num(settings, 'cut_threshold', 5);
  const cutFactor = num(settings, 'cut_factor', 0.85);
  const low = Object.values(values).some((v) => v < threshold);
  const cut = low ? cutFactor : 1;
  const mult = extra.chiefMultiplier ?? 1;

  const wallets = {};
  let bonus = 0;
  for (const k of Object.keys(purses)) {
    const got = purses[k] * (values[k] / 10) * mult * cut;
    wallets[k] = { pool: purses[k], score: values[k], got: Math.round(got) };
    bonus += got;
  }

  const pool = num(settings, 'bonus_pool', 50000);
  return {
    wallets,
    bonus: Math.round(bonus),
    kef: round2((bonus / mult / cut / pool) * 10),
    cutApplied: low,
    multiplier: mult,
  };
}

/** Комиссия с экономии по регрессивной шкале. */
function savingCommission(sum, settings) {
  if (!(sum > 0)) return 0;
  const r1 = num(settings, 'saving_rate_1', 0.3);
  const r2 = num(settings, 'saving_rate_2', 0.2);
  const r3 = num(settings, 'saving_rate_3', 0.1);
  let c = Math.min(sum, 50000) * r1;
  if (sum > 50000) c += Math.min(sum - 50000, 100000) * r2;
  if (sum > 150000) c += (sum - 150000) * r3;
  return Math.round(c);
}

// ── выборка данных ───────────────────────────────────────────────────────────

async function fetchUserData(db, userId, period, role = 'assistant') {
  const tasks = await db
    .prepare('SELECT * FROM tasks WHERE assignee_id = ? AND (period = ? OR period IS NULL) ORDER BY created_at DESC')
    .bind(userId, period)
    .all();

  // Ответы этого человека, плюс адресованные лично ему вопросы (в том числе
  // оставшиеся без ответа). Лиду вдобавок достаются «ничейные» пропуски:
  // если вопрос руководителя не подобрал никто, отвечает руководитель отдела.
  const replies = await db
    .prepare(
      `SELECT * FROM chat_replies
       WHERE period = ? AND (
         user_id = ?
         OR (mention_id = ? AND replied_at IS NULL)
         OR (? = 'lead' AND mention_id IS NULL AND replied_at IS NULL AND asked_role = 'chief')
       )`
    )
    .bind(period, userId, userId, role)
    .all();
  const awards = await db
    .prepare('SELECT * FROM awards WHERE user_id = ? AND period = ?')
    .bind(userId, period)
    .all();
  return { tasks: tasks.results, replies: replies.results, awards: awards.results };
}

/** Полная карточка человека: метрики, деньги, задачи с таймингами. */
async function buildProfile(db, user, period, settings) {
  const { tasks, replies, awards } = await fetchUserData(db, user.id, period, user.role);
  const metrics = computeMetrics({ tasks, replies, settings, grade: user.grade });
  const money = computeMoney(metrics, settings);

  const zaebSum = awards
    .filter((a) => a.kind === 'zaeb' && a.status !== 'rejected')
    .reduce((acc, a) => acc + a.amount, 0);
  const savingSum = awards
    .filter((a) => a.kind === 'saving' && a.status !== 'rejected')
    .reduce((acc, a) => acc + Math.max(0, (a.base_price || 0) - (a.final_price || 0)), 0);
  const savingPay = savingCommission(savingSum, settings);

  return {
    user: { id: user.id, name: user.name, role: user.role, grade: user.grade },
    period,
    metrics,
    money: {
      ...money,
      zaeb: zaebSum,
      savingSum,
      savingPay,
      salary: user.salary || 0,
      total: money.bonus + zaebSum + savingPay,
    },
    awards,
    tasks: metrics.scored.map(decorateTask),
    openTasks: tasks
      .filter((t) => !['accepted', 'failed', 'cancelled'].includes(t.status))
      .map(decorateTask),
  };
}

/** Проставляет ссылки на сообщения в расшифровке баллов. */
function withChatLinks(profile, settings) {
  const chatId = settings.tg_chat_id;
  const d = profile.metrics?.breakdown?.speed?.detail;
  if (!chatId || !d) return profile;
  const base = String(chatId).replace('-100', '');
  for (const item of d) {
    if (item.request_msg) item.link = `https://t.me/c/${base}/${item.request_msg}`;
  }
  return profile;
}

/** Тайминги задачи — то, ради чего лид сюда заходит. */
function decorateTask(t) {
  const toTake = minutesBetween(t.created_at, t.taken_at);
  const toDo = minutesBetween(t.taken_at, t.submitted_at || t.done_at);
  const total = minutesBetween(t.created_at, t.done_at);
  const overdue =
    t.deadline && t.done_at ? minutesBetween(t.deadline, t.done_at) : null;

  return {
    id: t.id,
    title: t.title,
    url: t.url,
    size: t.size,
    night: !!t.night,
    status: t.status,
    createdAt: t.created_at,
    takenAt: t.taken_at,
    submittedAt: t.submitted_at,
    doneAt: t.done_at,
    deadline: t.deadline,
    returns: t.returns,
    chiefTouched: !!t.chief_touched,
    disputed: !!t.disputed,
    isInitiative: !!t.is_initiative,
    initiativeUseful: t.initiative_useful,
    score: t.score ?? null,
    flags: t.flags ?? null,
    timing: {
      toTakeMin: toTake,
      toTakeHuman: humanMinutes(toTake),
      toDoMin: toDo,
      toDoHuman: humanMinutes(toDo),
      totalMin: total,
      totalHuman: humanMinutes(total),
      overdueMin: overdue && overdue > 0 ? overdue : null,
      overdueHuman: overdue && overdue > 0 ? humanMinutes(overdue) : null,
    },
  };
}

// ── маршруты ─────────────────────────────────────────────────────────────────

async function handleApi(request, env, url) {
  const db = env.DB;
  const path = url.pathname.replace(/^\/api/, '');
  const settings = await loadSettings(db);
  const period = url.searchParams.get('period') || currentPeriod(num(settings, 'tz_offset', 3));

  // вход по ключу
  if (path === '/login' && request.method === 'POST') {
    const { key } = await request.json().catch(() => ({}));
    if (!key) return bad('нужен ключ доступа');
    const hash = await sha256(key);
    const user = await db
      .prepare('SELECT id, name, role, grade FROM users WHERE key_hash = ? AND active = 1')
      .bind(hash)
      .first();
    if (!user) return bad('ключ не подошёл', 401);
    return json({ ok: true, user });
  }

  // первичная инициализация: создаёт руководителя отдела, пока в базе никого нет
  if (path === '/bootstrap' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!env.BOOTSTRAP_SECRET || b.secret !== env.BOOTSTRAP_SECRET) return bad('нет доступа', 403);
    const existing = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (existing.n > 0) return bad('пользователи уже есть, используйте админку', 409);

    const key = newKey();
    await db
      .prepare("INSERT INTO users (id, name, role, grade, key_hash) VALUES (?,?,'lead','A3',?)")
      .bind(crypto.randomUUID(), b.name || 'Руководитель отдела', await sha256(key))
      .run();
    return json({ ok: true, key });
  }

  // вебхук YouGile — принимается без ключа доступа, поэтому проверяется секрет
  if (path === '/hook/yougile' && request.method === 'POST') {
    return handleYougileHook(request, env, settings);
  }
  // готовый замер от внешнего бота
  if (path === '/hook/tg' && request.method === 'POST') {
    return handleTgHook(request, env, settings);
  }
  // сам Telegram: путь содержит секрет, поэтому ключ доступа не нужен
  if (path.startsWith('/tg/') && request.method === 'POST') {
    if (path.slice(4) !== (env.TG_SECRET || '')) return bad('нет доступа', 403);
    return handleTelegramUpdate(request, env, settings);
  }

  const me = await authenticate(request, db);
  if (!me) return bad('нужен ключ доступа', 401);

  // свой профиль — доступен всем ролям
  if (path === '/me') {
    const full = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    return json(withChatLinks(await buildProfile(db, full, period, settings), settings));
  }

  // сводка по отделу — только лид и руководитель
  if (path === '/team') {
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);
    const { results: people } = await db
      .prepare("SELECT * FROM users WHERE role = 'assistant' AND active = 1 ORDER BY name")
      .all();

    const profiles = [];
    for (const p of people) profiles.push(await buildProfile(db, p, period, settings));

    const avgKef = profiles.length
      ? round2(profiles.reduce((a, p) => a + p.money.kef, 0) / profiles.length)
      : 0;

    // метрики лида
    const allClosed = profiles.flatMap((p) => p.tasks);
    const acceptedFirstTry = allClosed.filter((t) => t.returns === 0).length;
    const filterRate = allClosed.length ? acceptedFirstTry / allClosed.length : 0;
    const solo = allClosed.filter((t) => !t.chiefTouched).length;
    const unloadRate = allClosed.length ? solo / allClosed.length : 0;

    const leadShareZaeb = num(settings, 'lead_share_zaeb', 0.17);
    const leadShareSaving = num(settings, 'lead_share_saving', 0.05);
    const teamZaeb = profiles.reduce((a, p) => a + p.money.zaeb, 0);
    const teamSaving = profiles.reduce((a, p) => a + p.money.savingSum, 0);

    const leadPools = {
      team: num(settings, 'lead_purse_team', 20000),
      filter: num(settings, 'lead_purse_filter', 15000),
      unload: num(settings, 'lead_purse_unload', 10000),
      growth: num(settings, 'lead_purse_growth', 5000),
    };
    const leadWallets = {
      team: Math.round(leadPools.team * (avgKef / 10)),
      filter: Math.round(leadPools.filter * Math.min(1, filterRate / 0.95)),
      unload: Math.round(leadPools.unload * unloadRate),
      growth: 0, // проставляется руководителем вручную
    };

    // Скорость лида: своя реакция на вопросы руководителя плюс скорость команды.
    // Одной командной метрики мало — молчать самому тоже нельзя.
    const meFull = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    const leadOwn = me.role === 'lead' ? await buildProfile(db, meFull, period, settings) : null;
    const teamSpeed = profiles.length
      ? round2(profiles.reduce((a, p) => a + p.metrics.speed, 0) / profiles.length)
      : 0;
    const wPersonal = num(settings, 'lead_speed_personal', 0.4);
    const wTeam = num(settings, 'lead_speed_team', 0.6);
    const leadSpeed = leadOwn
      ? round2(wPersonal * leadOwn.metrics.speed + wTeam * teamSpeed)
      : teamSpeed;

    return json({
      period,
      avgKef,
      people: profiles.map((p) => ({
        id: p.user.id,
        name: p.user.name,
        grade: p.user.grade,
        kef: p.money.kef,
        metrics: {
          quality: p.metrics.quality,
          speed: p.metrics.speed,
          autonomy: p.metrics.autonomy,
          proactivity: p.metrics.proactivity,
        },
        tasksClosed: p.tasks.length,
        tasksOpen: p.openTasks.length,
        medianReply: p.metrics.breakdown.speed.medianReply,
        bonus: p.money.bonus,
        total: p.money.total,
      })),
      lead: {
        avgKef,
        filterRate: pct(filterRate),
        unloadRate: pct(unloadRate),
        wallets: leadWallets,
        speed: {
          total: leadSpeed,
          personal: leadOwn ? leadOwn.metrics.speed : null,
          team: teamSpeed,
          weights: { personal: wPersonal, team: wTeam },
          formula: `своя ${leadOwn ? leadOwn.metrics.speed : '—'} × ${wPersonal} + команда ${teamSpeed} × ${wTeam}`,
          ownDetail: leadOwn ? leadOwn.metrics.breakdown.speed : null,
        },
        shareZaeb: Math.round(teamZaeb * leadShareZaeb),
        shareSaving: Math.round(teamSaving * leadShareSaving),
        bonus:
          leadWallets.team + leadWallets.filter + leadWallets.unload + leadWallets.growth,
      },
    });
  }

  // карточка конкретного человека — лид и руководитель
  if (path.startsWith('/person/')) {
    const id = path.split('/')[2];
    if (!['lead', 'chief'].includes(me.role) && me.id !== id) return bad('нет доступа', 403);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!user) return bad('не найден', 404);
    return json(withChatLinks(await buildProfile(db, user, period, settings), settings));
  }

  // очередь приёмки для руководителя
  if (path === '/inbox') {
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);
    const { results } = await db
      .prepare(
        `SELECT t.*, u.name AS assignee_name FROM tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.status = 'review' ORDER BY t.submitted_at`
      )
      .all();
    return json({ tasks: results.map((t) => ({ ...decorateTask(t), assignee: t.assignee_name })) });
  }

  // приёмка: «принято» или «вернуть» — единственное решение руководителя
  if (path.startsWith('/task/') && request.method === 'POST') {
    const [, , id, action] = path.split('/');
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);
    const body = await request.json().catch(() => ({}));

    if (action === 'accept') {
      await db
        .prepare(
          `UPDATE tasks SET status='accepted', done_at=?, period=?, updated_at=?
           WHERE id=?`
        )
        .bind(nowIso(), period, nowIso(), id)
        .run();
      await logEvent(db, { taskId: id, type: 'accepted', actor: me.name, source: 'manual' });
      return json({ ok: true });
    }
    if (action === 'return') {
      await db
        .prepare(
          `UPDATE tasks SET status='in_progress', returns = returns + 1, updated_at=?
           WHERE id=?`
        )
        .bind(nowIso(), id)
        .run();
      await logEvent(db, {
        taskId: id, type: 'returned', actor: me.name, note: body.note || null, source: 'manual',
      });
      return json({ ok: true });
    }
    if (action === 'initiative') {
      await db
        .prepare('UPDATE tasks SET initiative_useful = ?, updated_at = ? WHERE id = ?')
        .bind(body.useful ? 1 : 0, nowIso(), id)
        .run();
      await logEvent(db, {
        taskId: id, type: 'initiative_answer', actor: me.name,
        note: body.useful ? 'пригодилось' : 'не пригодилось', source: 'manual',
      });
      return json({ ok: true });
    }
    if (action === 'dispute') {
      // лид списывает вовлечение руководителя как «вопрос был по делу»
      if (me.role !== 'lead') return bad('только руководитель отдела', 403);
      await db
        .prepare('UPDATE tasks SET disputed = 1, dispute_note = ?, updated_at = ? WHERE id = ?')
        .bind(body.note || null, nowIso(), id)
        .run();
      await logEvent(db, {
        taskId: id, type: 'manual', actor: me.name,
        note: `списано вовлечение: ${body.note || 'без комментария'}`, source: 'manual',
      });
      return json({ ok: true });
    }
    if (action === 'size') {
      if (me.role === 'assistant') return bad('нет доступа', 403);
      await db
        .prepare('UPDATE tasks SET size = ?, night = ?, updated_at = ? WHERE id = ?')
        .bind(Math.min(3, Math.max(1, body.size | 0)), body.night ? 1 : 0, nowIso(), id)
        .run();
      return json({ ok: true });
    }
    return bad('неизвестное действие');
  }

  // события задачи — основа прозрачности: откуда взялась каждая цифра
  if (path.startsWith('/events/')) {
    const taskId = path.split('/')[2];
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
    if (!task) return bad('не найдена', 404);
    if (me.role === 'assistant' && task.assignee_id !== me.id) return bad('нет доступа', 403);
    const { results } = await db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY at')
      .bind(taskId)
      .all();
    return json({ task: decorateTask(task), events: results, score: scoreTask(task) });
  }

  // ── админка лида ───────────────────────────────────────────────────────────
  if (path.startsWith('/admin/')) {
    if (me.role !== 'lead') return bad('только руководитель отдела', 403);

    if (path === '/admin/users' && request.method === 'GET') {
      const { results } = await db
        .prepare('SELECT id, name, role, grade, salary, active, yougile_id, tg_user_id FROM users ORDER BY role, name')
        .all();
      return json({ users: results });
    }

    if (path === '/admin/users' && request.method === 'POST') {
      const b = await request.json();
      const id = b.id || crypto.randomUUID();
      const key = b.rotateKey || !b.id ? newKey() : null;
      const hash = key ? await sha256(key) : null;

      if (b.id) {
        await db
          .prepare(
            `UPDATE users SET name=?, role=?, grade=?, salary=?, yougile_id=?, tg_user_id=?, active=?
             ${hash ? ', key_hash=?' : ''} WHERE id=?`
          )
          .bind(...[
            b.name, b.role, b.grade, b.salary | 0, b.yougile_id || null, b.tg_user_id || null,
            b.active === false ? 0 : 1,
            ...(hash ? [hash] : []),
            b.id,
          ])
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO users (id, name, role, grade, salary, yougile_id, tg_user_id, key_hash)
             VALUES (?,?,?,?,?,?,?,?)`
          )
          .bind(id, b.name, b.role || 'assistant', b.grade || 'A2', b.salary | 0,
                b.yougile_id || null, b.tg_user_id || null, hash)
          .run();
      }
      // ключ показывается ровно один раз — в базе только его хэш
      return json({ ok: true, id, key });
    }

    if (path === '/admin/settings' && request.method === 'GET') return json({ settings });

    if (path === '/admin/settings' && request.method === 'POST') {
      const b = await request.json();
      const stmts = Object.entries(b).map(([k, v]) =>
        db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .bind(k, String(v))
      );
      if (stmts.length) await db.batch(stmts);
      return json({ ok: true });
    }

    if (path === '/admin/award' && request.method === 'POST') {
      const b = await request.json();
      const leadShare = b.kind === 'zaeb'
        ? Math.round((b.amount | 0) * num(settings, 'lead_share_zaeb', 0.17))
        : 0;
      await db
        .prepare(
          `INSERT INTO awards (user_id, kind, title, tier, amount, lead_amount, base_price, final_price, period, proof_url, confirm_due)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(b.user_id, b.kind, b.title, b.tier || null, b.amount | 0, leadShare,
              b.base_price | 0, b.final_price | 0, period, b.proof_url || null,
              b.kind === 'zaeb' ? new Date(Date.now() + 30 * 864e5).toISOString() : null)
        .run();
      return json({ ok: true });
    }

    if (path === '/admin/sync' && request.method === 'POST') {
      const report = await syncYougile(env, settings);
      return json(report);
    }
  }

  return bad('маршрут не найден', 404);
}

async function logEvent(db, { taskId, userId, type, actor, at, note, source }) {
  await db
    .prepare('INSERT INTO events (task_id, user_id, type, actor, at, note, source) VALUES (?,?,?,?,?,?,?)')
    .bind(taskId || null, userId || null, type, actor || null, at || nowIso(), note || null, source || 'yougile')
    .run();
}

// ── интеграция с YouGile ─────────────────────────────────────────────────────

/**
 * Вебхук YouGile. Задачи и их перемещения по колонкам — единственный
 * источник таймингов: когда взята в работу, когда ушла на проверку,
 * сколько раз возвращалась.
 */
async function handleYougileHook(request, env, settings) {
  const db = env.DB;
  const secret = env.HOOK_SECRET;
  if (secret && request.headers.get('x-hook-secret') !== secret) return bad('нет доступа', 403);

  const payload = await request.json().catch(() => null);
  if (!payload) return bad('пустое тело');

  const items = Array.isArray(payload) ? payload : [payload];
  for (const ev of items) {
    const task = ev.payload || ev.task || ev;
    const id = task.id || ev.id;
    if (!id) continue;
    await upsertTaskFromYougile(db, task, settings);
  }
  return json({ ok: true, received: items.length });
}

/**
 * Периодическая синхронизация: подстраховка, если вебхук что-то потерял.
 *
 * /task-list отдаёт задачи целиком, поэтому хватает одного обхода с пагинацией.
 * Ключ берётся из секретов; настройка в базе оставлена как запасной путь.
 */
async function syncYougile(env, settings, { limit = 1000 } = {}) {
  const db = env.DB;
  const key = env.YOUGILE_KEY || settings.yougile_key;
  if (!key) return { ok: false, error: 'не задан ключ YouGile' };

  const base = settings.yougile_base || 'https://yougile.com/api-v2';
  let offset = 0;
  let touched = 0;
  let guard = 0;

  while (guard++ < 50) {
    const res = await fetch(`${base}/task-list?limit=100&offset=${offset}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return { ok: false, error: `YouGile ответил ${res.status}`, synced: touched };

    const data = await res.json().catch(() => ({}));
    const list = data.content || [];
    for (const t of list) {
      await upsertTaskFromYougile(db, t, settings);
      touched += 1;
      if (touched >= limit) return { ok: true, synced: touched, truncated: true };
    }
    if (!data.paging?.next) break;
    offset += list.length || 100;
  }
  return { ok: true, synced: touched };
}

// ─────────────────────────────────────────────────────────────────────────────
// Поиск задачи по сообщению в чате
//
// Руководитель пишет «заказали ракетку?» и не указывает, кому. Бот должен сам
// понять, о какой задаче речь, и спросить с её исполнителя.
//
// Чтобы не перебирать все задачи на каждое сообщение, у каждой задачи есть
// поисковый индекс. Он считается один раз — когда задача появляется — и лежит
// в базе рядом с ней. Дальше сравнение это пересечение двух коротких списков.
// ─────────────────────────────────────────────────────────────────────────────

/** Служебные слова, которые совпадают у всех задач и только мешают. */
const STOP_WORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его','но','да','ты',
  'к','у','же','вы','за','бы','по','ее','мне','было','вот','от','меня','еще','нет','о','из','ему','теперь',
  'для','мы','тебя','их','чем','была','сам','чтоб','без','будто','чего','раз','тоже','себе','под','будет',
  'ж','тогда','кто','этот','того','потому','этого','какой','совсем','ним','здесь','этом','один','почти',
  'мой','тем','чтобы','нее','были','куда','зачем','всех','никогда','можно','при','наконец','два','об',
  'другой','хоть','после','над','больше','тот','через','эти','нас','про','всего','них','какая','много',
  'разве','三','эту','моя','впрочем','хорошо','свою','этой','перед','иногда','лучше','чуть','том','нельзя',
  'такой','им','более','всегда','конечно','всю','между','надо','нужно','сделать','сделай','пожалуйста',
  'есть','быть','этих','либо','или','также','такие','когда','где','уже','ещё','его','который','которая',
]);

/**
 * Слова сообщения или заголовка в сравнимом виде.
 *
 * Русские окончания режутся грубо — до основы в пять букв. «Ракетку», «ракетка»
 * и «ракетки» превращаются в «ракет» и совпадают между собой. Это заметно проще
 * настоящей морфологии и для коротких заголовков задач работает не хуже.
 */
function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w));
}

/**
 * Индекс задачи. Слова заголовка и описания хранятся раздельно: совпадение
 * в заголовке значит куда больше, чем случайное слово в теле описания.
 */
function taskKeywords(task) {
  const plain = String(task.description || '').replace(/<[^>]*>/g, ' ');
  const head = [...new Set(words(task.title))];
  // описание берём целиком: детали вроде фирмы или модели живут именно там,
  // и спрашивают в чате часто именно про них
  const body = [...new Set(words(plain))].filter((w) => !head.includes(w));
  return `${head.join(' ')}|${body.join(' ')}`;
}

const splitKeywords = (kw) => {
  const [head = '', body = ''] = String(kw || '').split('|');
  return { head: head.split(' ').filter(Boolean), body: body.split(' ').filter(Boolean) };
};

/**
 * Кандидаты на вопрос из чата.
 *
 * Редкое слово весит больше частого: «ракет» встречается в двух задачах и почти
 * наверняка указывает на нужную, а «заказ» есть в полусотне и не значит ничего.
 * Без этой поправки вопрос «заказали ракетку?» уводит на первую попавшуюся
 * задачу со словом «заказать» — проверено на реальных задачах.
 */
async function findTaskCandidates(db, text, { limit = 6 } = {}) {
  const asked = [...new Set(words(text))];
  if (!asked.length) return [];

  // только живые задачи: про закрытые и снятые не спрашивают
  const { results } = await db
    .prepare(
      `SELECT id, title, number, keywords, assignee_id, status, deadline
       FROM tasks
       WHERE status NOT IN ('accepted','cancelled','failed')
       ORDER BY updated_at DESC LIMIT 400`
    )
    .all();

  const parsed = results.map((t) => ({ t, ...splitKeywords(t.keywords) }));

  // в скольких задачах встречается каждое слово вопроса
  const df = new Map();
  for (const w of asked) {
    let n = 0;
    for (const p of parsed) if (p.head.includes(w) || p.body.includes(w)) n += 1;
    df.set(w, n);
  }

  const total = parsed.length || 1;
  const scored = [];
  for (const p of parsed) {
    let score = 0;
    let hits = 0;
    const matched = [];
    for (const w of asked) {
      const inHead = p.head.includes(w);
      const inBody = !inHead && p.body.includes(w);
      if (!inHead && !inBody) continue;
      // редкое слово — сильный сигнал, частое почти ничего не значит
      const idf = Math.log((total + 1) / (df.get(w) + 1)) + 0.1;
      score += idf * (inHead ? 2.5 : 1);
      hits += 1;
      matched.push(w);
    }
    if (hits) scored.push({ ...p.t, hits, score: round2(score), matched });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Уверенность в лидере: во сколько раз он оторвался от второго места.
 * Если оторвался заметно — нейросеть звать незачем.
 */
function candidateConfidence(list) {
  if (!list.length) return 0;
  if (list.length === 1) return list[0].score >= 1.5 ? 1 : 0.5;
  const [first, second] = list;
  if (!second.score) return 1;
  return first.score / second.score;
}

/**
 * Выбор задачи нейросетью — только когда список слов не дал явного лидера.
 *
 * Модель получает не все задачи, а короткий список кандидатов от предфильтра:
 * несколько строк вместо сотни. Поэтому даже на процессорном сервере ответ
 * приходит за секунды, а не за минуты.
 *
 * Ответ ждём строго одним числом — так его нельзя перепутать с рассуждением.
 */
async function pickTaskWithModel(candidates, question, settings) {
  const url = settings.llm_url || 'http://127.0.0.1:11434/api/generate';
  const model = settings.llm_model || 'qwen3:8b';
  const timeout = num(settings, 'llm_timeout_ms', 45000);
  if (!candidates.length) return null;

  const list = candidates
    .map((c, i) => `${i + 1}. ${c.title.replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n');

  const prompt =
    `Есть список задач:\n${list}\n\n` +
    `Руководитель спросил в чате: "${question}"\n\n` +
    `О какой задаче он спрашивает? Ответь только номером из списка. ` +
    `Если ни одна не подходит, ответь 0. Никаких пояснений, только цифра.`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        think: false,          // рассуждения вслух здесь только тратят время
        options: { temperature: 0, num_predict: 8 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const n = parseInt(String(data.response || '').replace(/[^0-9]/g, ''), 10);
    if (!n || n < 1 || n > candidates.length) return null;
    return candidates[n - 1];
  } catch {
    return null; // модель недоступна или думает слишком долго — работаем без неё
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Кому адресован вопрос: сначала слова, при равных кандидатах — модель.
 * Возвращает саму задачу и то, как она была выбрана: это попадает в отчёт,
 * чтобы любое решение бота можно было объяснить.
 */
async function detectTask(db, text, settings) {
  const candidates = await findTaskCandidates(db, text);
  if (!candidates.length) return { task: null, how: 'ничего не нашлось' };

  const confidence = candidateConfidence(candidates);
  const threshold = num(settings, 'llm_confidence', 1.35);

  if (confidence >= threshold) {
    return { task: candidates[0], how: `по словам, отрыв ×${round2(confidence)}`, candidates };
  }
  if (settings.llm_enabled === '0') {
    return { task: candidates[0], how: 'по словам, кандидаты равны', candidates };
  }

  const picked = await pickTaskWithModel(candidates, text, settings);
  return picked
    ? { task: picked, how: 'выбрала модель из равных кандидатов', candidates }
    : { task: candidates[0], how: 'по словам, модель не ответила', candidates };
}

/** Настройка со списком id колонок: «a,b,c» → Set. */
const colSet = (settings, key) =>
  new Set((settings[key] || '').split(',').map((s) => s.trim()).filter(Boolean));

/** В какой стадии находится задача, судя по её колонке. */
function stageOfColumn(columnId, settings) {
  if (!columnId) return null;
  if (colSet(settings, 'column_in_progress').has(columnId)) return 'in_progress';
  if (colSet(settings, 'column_review').has(columnId)) return 'review';
  if (colSet(settings, 'column_done').has(columnId)) return 'accepted';
  if (colSet(settings, 'column_paused').has(columnId)) return 'paused';
  if (colSet(settings, 'column_cancelled').has(columnId)) return 'cancelled';
  if (colSet(settings, 'column_backlog').has(columnId)) return 'open';
  return null;
}

async function upsertTaskFromYougile(db, t, settings) {
  const existing = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(t.id).first();
  const now = nowIso();

  const assignee = Array.isArray(t.assigned) ? t.assigned[0] : t.assigned || null;
  const user = assignee
    ? await db.prepare('SELECT id FROM users WHERE yougile_id = ?').bind(assignee).first()
    : null;

  const title = t.title || existing?.title || 'Без названия';
  const createdAt = existing?.created_at
    || (t.timestamp ? new Date(t.timestamp).toISOString() : now);
  const deadline = t.deadline?.deadline
    ? new Date(t.deadline.deadline).toISOString()
    : existing?.deadline || null;

  let status = existing?.status || 'open';
  let taken = existing?.taken_at || null;
  let submitted = existing?.submitted_at || null;
  let done = existing?.done_at || null;
  let returns = existing?.returns || 0;
  let pausedMin = existing?.paused_min || 0;
  let pausedSince = existing?.paused_since || null;

  const stage = stageOfColumn(t.columnId, settings);

  // выход из паузы — копим её длительность, чтобы вычесть из времени работы
  if (pausedSince && stage !== 'paused') {
    pausedMin += Math.max(0, Math.round((Date.now() - new Date(pausedSince)) / 60000));
    pausedSince = null;
  }

  if (stage === 'in_progress') {
    if (status === 'review') returns += 1; // вернулась с проверки — признак «без правок» гаснет
    status = 'in_progress';
    taken = taken || now;
  } else if (stage === 'review') {
    status = 'review';
    submitted = submitted || now;
  } else if (stage === 'accepted') {
    status = 'accepted';
    done = done || now;
  } else if (stage === 'paused') {
    status = 'paused';
    pausedSince = pausedSince || now;
  } else if (stage === 'cancelled') {
    status = 'cancelled';
  }

  // YouGile сам отмечает завершённость — это надёжнее, чем угадывать по колонке
  if (t.completed && status !== 'accepted' && status !== 'cancelled') {
    status = 'accepted';
    done = done || now;
  }
  if (t.archived || t.deleted) status = 'cancelled';

  const period = done ? done.slice(0, 7) : existing?.period || null;

  if (existing) {
    // индекс пересчитываем, только если поменялся заголовок — обычно он лежит нетронутым
    const keywords = existing.keywords && title === existing.title
      ? existing.keywords
      : taskKeywords({ ...t, title });

    await db
      .prepare(
        `UPDATE tasks SET title=?, number=?, board_id=?, keywords=?, assignee_id=?, deadline=?,
         status=?, taken_at=?, submitted_at=?, done_at=?, returns=?, paused_min=?, paused_since=?,
         period=?, updated_at=? WHERE id=?`
      )
      .bind(title, t.idTaskCommon || existing.number, t.boardId || existing.board_id, keywords,
            user?.id || existing.assignee_id, deadline, status, taken, submitted, done,
            returns, pausedMin, pausedSince, period, now, t.id)
      .run();
  } else {
    // задачу завёл сам исполнитель — это инициатива
    const isInitiative = assignee && t.createdBy && t.createdBy === assignee ? 1 : 0;
    await db
      .prepare(
        `INSERT INTO tasks (id, title, number, board_id, keywords, assignee_id, author_id,
         created_at, deadline, status, taken_at, submitted_at, done_at, returns, paused_min,
         paused_since, is_initiative, period)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(t.id, title, t.idTaskCommon || null, t.boardId || null, taskKeywords({ ...t, title }),
            user?.id || null, t.createdBy || null, createdAt, deadline, status, taken, submitted,
            done, returns, pausedMin, pausedSince, isInitiative, period)
      .run();
    await logEvent(db, { taskId: t.id, type: 'created', at: createdAt });
  }

  if (stage === 'in_progress' && !existing?.taken_at) await logEvent(db, { taskId: t.id, type: 'taken' });
  if (stage === 'review' && existing?.status !== 'review') await logEvent(db, { taskId: t.id, type: 'submitted' });
  if (stage === 'paused' && existing?.status !== 'paused') {
    await logEvent(db, { taskId: t.id, type: 'manual', note: 'ушла в ожидание или блокер' });
  }
}

// ── интеграция с телеграм-ботом ──────────────────────────────────────────────

/**
 * Бот в общем чате присылает сюда замеры: кто и через сколько ответил.
 * Сам замер живёт в боте — Worker только хранит и агрегирует.
 */
async function handleTgHook(request, env, settings) {
  const db = env.DB;
  const secret = env.HOOK_SECRET;
  if (secret && request.headers.get('x-hook-secret') !== secret) return bad('нет доступа', 403);

  const b = await request.json().catch(() => null);
  if (!b) return bad('пустое тело');

  const user = b.tg_user_id
    ? await db.prepare('SELECT id FROM users WHERE tg_user_id = ?').bind(String(b.tg_user_id)).first()
    : null;

  await db
    .prepare(
      `INSERT INTO chat_replies (user_id, chat_id, request_msg, reply_msg, asked_at, replied_at, seconds, in_hours, period)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .bind(user?.id || null, String(b.chat_id || ''), String(b.request_msg || ''),
          String(b.reply_msg || ''), b.asked_at, b.replied_at || null,
          b.seconds ?? null, b.in_hours === false ? 0 : 1,
          b.period || currentPeriod(num(settings, 'tz_offset', 3)))
    .run();

  return json({ ok: true });
}

/**
 * Обработка сообщений общего чата.
 *
 * Логика замера намеренно простая, иначе её нельзя объяснить команде:
 *   сообщение руководителя или лида  → открытый запрос
 *   первое сообщение ассистента после → ответ, разница и есть скорость
 *
 * Ответ через reply привязывается к конкретному запросу — это точный случай.
 * Без reply берётся последний открытый запрос в чате.
 * Сообщения вне рабочего окна помечаются и в оценку скорости не идут.
 */
async function handleTelegramUpdate(request, env, settings) {
  const db = env.DB;
  const update = await request.json().catch(() => null);

  // Реакция на сообщение — тоже ответ. Поставить смайлик под просьбой
  // означает «увидел, принял»; требовать сверх этого текст было бы придиркой.
  if (update?.message_reaction) return handleReaction(update.message_reaction, env, settings);

  const msg = update?.message || update?.edited_message;
  if (!msg || !msg.from || msg.from.is_bot) return json({ ok: true });

  // личка — панель управления составом
  if (msg.chat.type === 'private') return handleBotCommand(msg, env, settings);

  const wanted = settings.tg_chat_id;
  if (wanted && String(msg.chat.id) !== String(wanted)) return json({ ok: true });

  let user = await db
    .prepare('SELECT id, role, name FROM users WHERE tg_user_id = ? AND active = 1')
    .bind(String(msg.from.id))
    .first();

  // Привязка по нику: лид заранее прислал «@ник», а id становится известен
  // только когда человек напишет в чат — Telegram не отдаёт id по нику.
  if (!user && msg.from.username) {
    const pending = await db
      .prepare('SELECT id, role, name FROM users WHERE lower(tg_username) = ? AND tg_user_id IS NULL AND active = 1')
      .bind(msg.from.username.toLowerCase())
      .first();
    if (pending) {
      await db.prepare('UPDATE users SET tg_user_id = ? WHERE id = ?')
        .bind(String(msg.from.id), pending.id).run();
      user = pending;
    }
  }
  if (!user) return json({ ok: true, skipped: 'неизвестный отправитель' });

  const at = new Date(msg.date * 1000).toISOString();
  const tz = num(settings, 'tz_offset', 3);
  const period = currentPeriod(tz);
  const inHours = isWorkTime(msg.date * 1000, settings) ? 1 : 0;

  // отметка активности: по ней отличаем новый вопрос от продолжения разговора
  const prevState = await db
    .prepare('SELECT last_msg_at, last_from FROM chat_state WHERE chat_id = ?')
    .bind(String(msg.chat.id))
    .first();
  await db
    .prepare(
      `INSERT INTO chat_state (chat_id, last_msg_at, last_from) VALUES (?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET last_msg_at = excluded.last_msg_at,
       last_from = excluded.last_from`
    )
    .bind(String(msg.chat.id), at, user.id)
    .run();

  // запрос от руководителя или лида
  if (user.role === 'chief' || user.role === 'lead') {
    // «понял, спасибо» таймер не открывает
    if (!needsReply(msg, settings)) return json({ ok: true, skipped: 'ответ не требуется' });

    // Идёт живая переписка — это продолжение разговора, а не новый вопрос.
    // Иначе за одну беседу ассистент набрал бы десяток «быстрых ответов».
    const windowMin = num(settings, 'dialog_window_min', 20);
    const quiet = prevState?.last_msg_at
      ? (new Date(at) - new Date(prevState.last_msg_at)) / 60000
      : Infinity;
    if (quiet < windowMin) {
      return json({ ok: true, skipped: `продолжение разговора, тишины было ${Math.round(quiet)} мин` });
    }

    const text = (msg.text || msg.caption || '').toLowerCase();
    const words = (settings.urgent_words || '').split(',').map((w) => w.trim()).filter(Boolean);
    const urgent = words.some((w) => text.includes(w)) ? 1 : 0;

    // Кому адресовано. Явный тег — самый надёжный сигнал. Если тега нет,
    // ищем задачу по смыслу сообщения и спрашиваем с её исполнителя:
    // руководитель в YouGile не пишет и адресата не указывает.
    let mentionId = await resolveMention(db, msg);
    let matchedTask = null;
    let matchHow = null;

    if (!mentionId) {
      const found = await detectTask(db, msg.text || msg.caption || '', settings);
      matchHow = found.how;
      if (found.task?.assignee_id) {
        mentionId = found.task.assignee_id;
        matchedTask = found.task;
      }
    }

    // Лид всегда тегает, когда ставит задачу. Значит сообщение лида без тега,
    // когда висит вопрос руководителя, — это его собственный ответ, а не запрос.
    if (user.role === 'lead' && !mentionId) {
      const openForLead = await db
        .prepare(
          `SELECT * FROM chat_replies WHERE chat_id = ? AND replied_at IS NULL
           AND asked_role = 'chief' AND (mention_id IS NULL OR mention_id = ?)
           ORDER BY asked_at DESC LIMIT 1`
        )
        .bind(String(msg.chat.id), user.id)
        .first();

      if (openForLead) {
        const seconds = Math.max(0, Math.round((new Date(at) - new Date(openForLead.asked_at)) / 1000));
        await db
          .prepare('UPDATE chat_replies SET user_id = ?, reply_msg = ?, replied_at = ?, seconds = ? WHERE id = ?')
          .bind(user.id, String(msg.message_id), at, seconds, openForLead.id)
          .run();
        return json({ ok: true, tracked: 'reply', by: 'lead', seconds });
      }
    }

    await db
      .prepare(
        `INSERT INTO chat_replies (user_id, chat_id, request_msg, asked_by, asked_role, asked_at, in_hours, urgent, mention_id, period)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(String(msg.chat.id), String(msg.message_id), user.id, user.role, at, inHours, urgent, mentionId, period)
      .run();

    // Бот подсказывает в чат, кого ждут: сообщение руководителя без адресата
    // иначе висит, пока каждый думает, что спросили не у него.
    if (matchedTask && mentionId) {
      const who = await db
        .prepare('SELECT name, tg_username FROM users WHERE id = ?')
        .bind(mentionId)
        .first();
      if (who) {
        const nick = who.tg_username ? `@${who.tg_username}` : who.name;
        await sendTelegram(
          env,
          msg.chat.id,
          `${nick}, вопрос к вам — задача «${matchedTask.title.slice(0, 90)}»`,
          { reply_to: msg.message_id }
        );
        await logEvent(db, {
          taskId: matchedTask.id,
          userId: mentionId,
          type: 'manual',
          at,
          note: `бот связал вопрос с задачей: ${matchHow}`,
          source: 'telegram',
        });
      }
    }

    return json({ ok: true, tracked: 'request', urgent: !!urgent, task: matchedTask?.title, how: matchHow });
  }

  // ответ ассистента или лида: вопрос руководителя может быть адресован и лиду
  let open = null;
  if (msg.reply_to_message) {
    open = await db
      .prepare(
        `SELECT * FROM chat_replies WHERE chat_id = ? AND request_msg = ? AND replied_at IS NULL`
      )
      .bind(String(msg.chat.id), String(msg.reply_to_message.message_id))
      .first();
  }
  if (!open) {
    // сначала ищем запрос, адресованный лично этому человеку
    open = await db
      .prepare(
        `SELECT * FROM chat_replies WHERE chat_id = ? AND replied_at IS NULL AND mention_id = ?
         ORDER BY asked_at LIMIT 1`
      )
      .bind(String(msg.chat.id), user.id)
      .first();
  }
  if (!open) {
    // иначе закрываем последний общий запрос: засчитывается первому ответившему
    open = await db
      .prepare(
        `SELECT * FROM chat_replies WHERE chat_id = ? AND replied_at IS NULL
         AND (mention_id IS NULL OR mention_id = ?)
         ORDER BY asked_at DESC LIMIT 1`
      )
      .bind(String(msg.chat.id), user.id)
      .first();
  }
  if (!open) return json({ ok: true, skipped: 'нет открытого запроса' });

  const seconds = Math.max(0, Math.round((new Date(at) - new Date(open.asked_at)) / 1000));
  await db
    .prepare(
      `UPDATE chat_replies SET user_id = ?, reply_msg = ?, replied_at = ?, seconds = ? WHERE id = ?`
    )
    .bind(user.id, String(msg.message_id), at, seconds, open.id)
    .run();

  return json({ ok: true, tracked: 'reply', seconds });
}

/**
 * Реакция на сообщение засчитывается как ответ.
 *
 * Telegram присылает такие события отдельным типом и только если он явно
 * указан в allowed_updates при установке вебхука — по умолчанию их нет.
 * Учитывается лишь появление реакции: снятие смайлика ответ не отменяет.
 */
async function handleReaction(reaction, env, settings) {
  const db = env.DB;
  const from = reaction.user;
  if (!from || from.is_bot) return json({ ok: true });

  const added = (reaction.new_reaction || []).length > (reaction.old_reaction || []).length;
  if (!added) return json({ ok: true, skipped: 'реакцию сняли' });

  const user = await db
    .prepare('SELECT id, role FROM users WHERE tg_user_id = ? AND active = 1')
    .bind(String(from.id))
    .first();
  if (!user || user.role === 'chief') return json({ ok: true });

  // ищем открытый вопрос именно на это сообщение
  const open = await db
    .prepare(
      `SELECT * FROM chat_replies
       WHERE chat_id = ? AND request_msg = ? AND replied_at IS NULL
       AND (mention_id IS NULL OR mention_id = ?)
       LIMIT 1`
    )
    .bind(String(reaction.chat.id), String(reaction.message_id), user.id)
    .first();
  if (!open) return json({ ok: true, skipped: 'нет открытого вопроса на это сообщение' });

  const at = new Date((reaction.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const seconds = Math.max(0, Math.round((new Date(at) - new Date(open.asked_at)) / 1000));

  await db
    .prepare('UPDATE chat_replies SET user_id = ?, replied_at = ?, seconds = ? WHERE id = ?')
    .bind(user.id, at, seconds, open.id)
    .run();

  return json({ ok: true, tracked: 'reaction', seconds });
}

/**
 * Панель управления в личке бота.
 *
 * Telegram не отдаёт id пользователя по нику, поэтому человек заводится
 * по нику и «оживает», когда впервые напишет в общий чат. До этого момента
 * он числится ожидающим — это видно в /team.
 */
async function handleBotCommand(msg, env, settings) {
  const db = env.DB;
  const from = String(msg.from.id);
  const text = (msg.text || '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const reply = (t) => sendTelegram(env, from, t).then(() => json({ ok: true }));

  const me = await db
    .prepare('SELECT id, name, role FROM users WHERE tg_user_id = ? AND active = 1')
    .bind(from)
    .first();

  // первичная активация: назначает отправителя руководителем отдела
  if (cmd === '/init') {
    if (me) return reply(`Вы уже в системе: ${me.name}.`);
    const secret = rest.join(' ').trim();
    if (!env.BOOTSTRAP_SECRET || secret !== env.BOOTSTRAP_SECRET) {
      return reply('Неверный секрет. Формат: /init <секрет>');
    }
    const key = newKey();
    await db
      .prepare(
        `INSERT INTO users (id, name, role, grade, key_hash, tg_user_id, tg_username)
         VALUES (?,?,'lead','A3',?,?,?)`
      )
      .bind(crypto.randomUUID(), msg.from.first_name || 'Руководитель отдела',
            await sha256(key), from, (msg.from.username || '').toLowerCase() || null)
      .run();
    return reply(
      `Готово, вы руководитель отдела.\n\nКлюч для входа в приложение (показывается один раз):\n<code>${key}</code>\n\n` +
      `Дальше: /assist @ник Имя — добавить ассистента, /help — все команды.`
    );
  }

  if (!me) return reply('Вас нет в системе. Обратитесь к руководителю отдела.');
  if (me.role !== 'lead' && cmd !== '/help' && cmd !== '/me') {
    return reply('Эта команда доступна только руководителю отдела.');
  }

  if (cmd === '/help' || cmd === '/start') {
    return reply(
      '<b>Команды</b>\n' +
      '/assist @ник Имя — добавить ассистента\n' +
      '/chief @ник Имя — добавить руководителя\n' +
      '/team — состав отдела\n' +
      '/key @ник — выдать новый ключ в приложение\n' +
      '/off @ник — отключить человека\n' +
      '/chat — привязать этот чат как рабочий\n' +
      '/me — мои результаты за месяц'
    );
  }

  if (cmd === '/assist' || cmd === '/chief') {
    const nick = (rest[0] || '').replace('@', '').toLowerCase();
    const name = rest.slice(1).join(' ').trim();
    if (!nick || !name) return reply(`Формат: ${cmd} @ник Имя Фамилия`);

    const role = cmd === '/assist' ? 'assistant' : 'chief';
    const exists = await db.prepare('SELECT id FROM users WHERE lower(tg_username) = ?').bind(nick).first();
    if (exists) {
      await db.prepare('UPDATE users SET name = ?, role = ?, active = 1 WHERE id = ?')
        .bind(name, role, exists.id).run();
      return reply(`Обновил: ${name} — ${role === 'assistant' ? 'ассистент' : 'руководитель'}.`);
    }

    const key = newKey();
    await db
      .prepare(
        `INSERT INTO users (id, name, role, grade, key_hash, tg_username)
         VALUES (?,?,?,'A2',?,?)`
      )
      .bind(crypto.randomUUID(), name, role, await sha256(key), nick)
      .run();
    return reply(
      `Добавлен: <b>${name}</b> (@${nick}) — ${role === 'assistant' ? 'ассистент' : 'руководитель'}.\n\n` +
      `Ключ для входа в приложение:\n<code>${key}</code>\n\n` +
      `Замер начнётся, как только он напишет в рабочем чате: Telegram не отдаёт id по нику.`
    );
  }

  if (cmd === '/team') {
    const { results } = await db
      .prepare('SELECT name, role, grade, tg_username, tg_user_id, active FROM users ORDER BY role, name')
      .all();
    const label = { assistant: 'ассистент', lead: 'рук. отдела', chief: 'руководитель' };
    const lines = results.map((u) =>
      `${u.active ? '' : '⛔ '}<b>${u.name}</b> — ${label[u.role]}` +
      `${u.tg_username ? ` @${u.tg_username}` : ''}` +
      `${u.tg_user_id ? ' ✅' : ' ⏳ ждёт первого сообщения'}`
    );
    return reply(`<b>Состав отдела</b>\n\n${lines.join('\n') || 'пусто'}`);
  }

  if (cmd === '/key') {
    const nick = (rest[0] || '').replace('@', '').toLowerCase();
    const u = await db.prepare('SELECT id, name FROM users WHERE lower(tg_username) = ?').bind(nick).first();
    if (!u) return reply('Не нашёл такого ника. /team — список.');
    const key = newKey();
    await db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').bind(await sha256(key), u.id).run();
    return reply(`Новый ключ для ${u.name} (старый больше не работает):\n<code>${key}</code>`);
  }

  if (cmd === '/off') {
    const nick = (rest[0] || '').replace('@', '').toLowerCase();
    const u = await db.prepare('SELECT id, name FROM users WHERE lower(tg_username) = ?').bind(nick).first();
    if (!u) return reply('Не нашёл такого ника.');
    await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(u.id).run();
    return reply(`${u.name} отключён. История сохранена.`);
  }

  if (cmd === '/chat') {
    return reply('Перешлите сюда любое сообщение из рабочего чата или отправьте /chat <id>. ' +
      'Проще всего: напишите что-нибудь в рабочем чате — бот привяжет его сам, если он там единственный.');
  }

  if (cmd === '/me') {
    const period = currentPeriod(num(settings, 'tz_offset', 3));
    const full = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    const p = await buildProfile(db, full, period, settings);
    return reply(
      `<b>${p.user.name}</b>, ${period}\n\n` +
      `Кэф: <b>${p.money.kef}</b>\n` +
      `Качество ${p.metrics.quality} · Скорость ${p.metrics.speed}\n` +
      `Автономность ${p.metrics.autonomy} · Проактивность ${p.metrics.proactivity}\n\n` +
      `К выплате сверх оклада: <b>${p.money.total.toLocaleString('ru-RU')} ₽</b>`
    );
  }

  return reply('Не понял команду. /help — список.');
}

/**
 * Кому адресовано сообщение. Telegram даёт два вида упоминаний:
 * text_mention с готовым id (для тех, у кого нет ника) и обычный @ник.
 */
async function resolveMention(db, msg) {
  const entities = msg.entities || msg.caption_entities || [];
  const text = msg.text || msg.caption || '';

  for (const e of entities) {
    if (e.type === 'text_mention' && e.user?.id) {
      const u = await db.prepare('SELECT id FROM users WHERE tg_user_id = ?')
        .bind(String(e.user.id)).first();
      if (u) return u.id;
    }
    if (e.type === 'mention') {
      const nick = text.substr(e.offset + 1, e.length - 1).toLowerCase();
      const u = await db.prepare('SELECT id FROM users WHERE lower(tg_username) = ?')
        .bind(nick).first();
      if (u) return u.id;
    }
  }
  return null;
}

/** Отправка сообщения в Telegram. Токен лежит в секретах, не в коде. */
async function sendTelegram(env, chatId, text, extra = {}) {
  if (!env.TG_TOKEN || !chatId) return null;
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
    }),
  });
  return res.json().catch(() => null);
}

/**
 * Напоминание о висящем вопросе. Задача не наказать, а не дать
 * сообщению потеряться: половина пропусков случается не из-за лени,
 * а потому что вопрос уехал вверх за десятком других.
 */
async function runEscalation(env, settings) {
  const db = env.DB;
  const after = num(settings, 'escalate_after_min', 30);
  const chatId = settings.tg_chat_id;
  if (!chatId) return { ok: false, error: 'не задан чат' };

  const cutoff = new Date(Date.now() - after * 60000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM chat_replies
       WHERE replied_at IS NULL AND escalated = 0 AND in_hours = 1 AND asked_at <= ?`
    )
    .bind(cutoff)
    .all();

  let sent = 0;
  for (const r of results) {
    if (!isWorkTime(Date.now(), settings)) continue; // ночью не будим
    const mins = Math.round((Date.now() - new Date(r.asked_at)) / 60000);
    await sendTelegram(
      env, chatId,
      `⏳ Вопрос висит без ответа ${mins} мин.`,
      { reply_to_message_id: Number(r.request_msg) || undefined }
    );
    await db.prepare('UPDATE chat_replies SET escalated = 1 WHERE id = ?').bind(r.id).run();
    sent += 1;
  }
  return { ok: true, escalated: sent };
}

/** Сегодня последний день месяца? Сводка уходит именно в этот день. */
function isLastDayOfMonth(tzOffset = 3) {
  const now = new Date(Date.now() + tzOffset * 3600e3);
  const tomorrow = new Date(now.getTime() + 86400e3);
  return tomorrow.getUTCDate() === 1;
}

/**
 * Месячная сводка руководителю отдела в личку — в последний день месяца.
 * Не «31 числа»: в коротких месяцах такого дня нет, а сводка нужна всегда.
 *
 * Показывает не только цифры, но и за что именно сняты и добавлены баллы,
 * со ссылками на конкретные сообщения в чате.
 */
async function sendMonthlyDigest(env, settings) {
  const db = env.DB;
  const tz = num(settings, 'tz_offset', 3);
  const now = new Date(Date.now() + tz * 3600e3);
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const lead = await db
    .prepare("SELECT * FROM users WHERE role = 'lead' AND tg_user_id IS NOT NULL AND active = 1")
    .first();
  if (!lead) return { ok: false, error: 'у руководителя отдела не указан Telegram' };

  const { results: people } = await db
    .prepare("SELECT * FROM users WHERE role = 'assistant' AND active = 1 ORDER BY name")
    .all();

  const chatId = settings.tg_chat_id;
  const lines = [`<b>Итоги ${period}</b>`, ''];

  for (const p of people) {
    const { tasks, replies } = await fetchUserData(db, p.id, period, p.role);
    const m = computeMetrics({ tasks, replies, settings, grade: p.grade });
    const s = m.breakdown.speed;

    lines.push(
      `<b>${p.name}</b> — скорость <b>${m.speed}</b> из 10`,
      `  реакция ${s.chatScore} (${s.chatFormula})`,
      `  медиана ответа: ${s.medianReply === null ? '—' : humanSeconds(s.medianReply)}`,
      `  быстро: ${s.repliesFast} · медленно: ${s.repliesSlow} · вне часов: ${s.offHoursAnswered}`,
      `  пропусков: ${s.misses}`
    );

    // за что сняли баллы — со ссылками на сообщения
    const bad = (s.detail || []).filter((d) => d.delta < 0).slice(0, 5);
    for (const d of bad) {
      lines.push(`    −${Math.abs(d.delta)} ${d.why} ${msgLink(chatId, d.request_msg)}`);
    }
    // и за что добавили сверх обычного
    const great = (s.detail || []).filter((d) => d.kind === 'offhours').slice(0, 3);
    for (const d of great) {
      lines.push(`    +${d.delta} ${d.why} ${msgLink(chatId, d.request_msg)}`);
    }
    lines.push('');
  }

  lines.push(`Полный разбор с задачами — в приложении, раздел «Отчёт».`);

  // Telegram не принимает сообщения длиннее 4096 символов
  const text = lines.join('\n');
  for (let i = 0; i < text.length; i += 3900) {
    await sendTelegram(env, lead.tg_user_id, text.slice(i, i + 3900));
  }
  return { ok: true, period, people: people.length };
}

/** Ссылка на сообщение в супергруппе: t.me/c/<id без -100>/<message_id>. */
function msgLink(chatId, messageId) {
  if (!chatId || !messageId) return '';
  const id = String(chatId).replace('-100', '');
  return `<a href="https://t.me/c/${id}/${messageId}">→</a>`;
}

const humanSeconds = (s) =>
  s < 60 ? `${s} сек` : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`;

/** Попадает ли момент в рабочее окно (с учётом часового пояса и выходных). */
function isWorkTime(ms, settings) {
  const tz = num(settings, 'tz_offset', 3);
  const d = new Date(ms + tz * 3600e3);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const [sh, sm] = (settings.work_start || '10:00').split(':').map(Number);
  const [eh, em] = (settings.work_end || '20:00').split(':').map(Number);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes >= sh * 60 + sm && minutes <= eh * 60 + em;
}

// ── точка входа ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: 'сбой на сервере', detail: String(err) }, 500);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Фронтенд не подключён', { status: 404 });
  },

  async scheduled(event, env) {
    const settings = await loadSettings(env.DB);
    const tz = num(settings, 'tz_offset', 3);

    // вечер последнего дня месяца — итоговая сводка
    if (event.cron === '0 18 * * *') {
      if (isLastDayOfMonth(tz)) await sendMonthlyDigest(env, settings);
      return;
    }

    // каждые 15 минут — напоминание о висящих вопросах
    await runEscalation(env, settings);

    // раз в час — подстраховочная синхронизация задач
    if (new Date().getUTCMinutes() < 15) {
      await syncYougile(env, settings);
    }
  },
};
