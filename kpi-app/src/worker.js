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

  const inTime = task.deadline && task.done_at
    ? new Date(task.done_at) <= new Date(task.deadline)
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
  const closed = tasks.filter((t) => ['accepted', 'failed'].includes(t.status));

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

  // Скорость — 4 балла за реакцию в чате, 6 за попадание в срок, минус молчание
  const target = num(settings, 'reply_target_min', 15);
  const urgentTarget = num(settings, 'urgent_target_min', 5);

  const inHours = replies.filter((r) => r.in_hours === 1);
  const answered = inHours.filter((r) => r.seconds !== null);
  const fastReplies = answered.filter((r) => {
    const limit = (r.urgent ? urgentTarget : target) * 60;
    return r.seconds <= limit;
  }).length;

  // Знаменатель — все запросы рабочего времени, а не только отвеченные:
  // промолчать теперь дороже, чем ответить медленно.
  const replyRate = inHours.length ? fastReplies / inHours.length : 0;

  const misses = replies.filter((r) => isMiss(r, settings));
  const missCount = misses.length;

  const withDeadline = closed.filter((t) => t.deadline);
  const inTimeCount = withDeadline.filter((t) => scoreTask(t).flags.inTime).length;
  const slaRate = withDeadline.length ? inTimeCount / withDeadline.length : 0;

  const speedBase = 4 * replyRate + 6 * slaRate;
  const penalty = missCount * num(settings, 'miss_penalty', 0.5);
  let speed = Math.max(0, speedBase - penalty);

  // Потолок: систематическое молчание нельзя закрыть быстрыми ответами
  // на удобные сообщения — это и есть главный рычаг всей метрики.
  const capCount = num(settings, 'miss_cap_count', 3);
  const capScore = num(settings, 'miss_cap_score', 5);
  const capped = missCount >= capCount && speed > capScore;
  if (capped) speed = capScore;

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
    quality: round2(quality),
    speed: round2(speed),
    autonomy: round2(autonomy),
    proactivity: round2(proactivity),
    breakdown: {
      quality: {
        tasks: closed.length,
        weight: round2(weight),
        points: round2(points),
        formula: `${round2(points)} баллов ÷ ${round2(weight)} размеров`,
      },
      speed: {
        requests: inHours.length,
        repliesCounted: answered.length,
        repliesFast: fastReplies,
        replyRate: pct(replyRate),
        medianReply: medianSeconds(answered),
        unanswered: inHours.filter((r) => r.seconds === null).length,
        misses: missCount,
        penalty: round2(penalty),
        capped,
        offHours: replies.filter((r) => r.in_hours === 0).length,
        offHoursAnswered: replies.filter((r) => r.in_hours === 0 && r.seconds !== null).length,
        withDeadline: withDeadline.length,
        inTime: inTimeCount,
        slaRate: pct(slaRate),
        formula: capped
          ? `потолок ${capScore} из-за ${missCount} пропусков`
          : `4 × ${pct(replyRate)} + 6 × ${pct(slaRate)}${penalty ? ` − ${round2(penalty)} за ${missCount} пропусков` : ''}`,
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

async function fetchUserData(db, userId, period) {
  const tasks = await db
    .prepare('SELECT * FROM tasks WHERE assignee_id = ? AND (period = ? OR period IS NULL) ORDER BY created_at DESC')
    .bind(userId, period)
    .all();
  const replies = await db
    .prepare('SELECT * FROM chat_replies WHERE user_id = ? AND period = ?')
    .bind(userId, period)
    .all();
  const awards = await db
    .prepare('SELECT * FROM awards WHERE user_id = ? AND period = ?')
    .bind(userId, period)
    .all();
  return { tasks: tasks.results, replies: replies.results, awards: awards.results };
}

/** Полная карточка человека: метрики, деньги, задачи с таймингами. */
async function buildProfile(db, user, period, settings) {
  const { tasks, replies, awards } = await fetchUserData(db, user.id, period);
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
    openTasks: tasks.filter((t) => !['accepted', 'failed'].includes(t.status)).map(decorateTask),
  };
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
    return json(await buildProfile(db, full, period, settings));
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
        shareZaeb: Math.round(teamZaeb * leadShareZaeb),
        shareSaving: Math.round(savingCommission(teamSaving, settings) * 0 + teamSaving * leadShareSaving),
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
    return json(await buildProfile(db, user, period, settings));
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

/** Периодическая синхронизация: подстраховка, если вебхук что-то потерял. */
async function syncYougile(env, settings) {
  const db = env.DB;
  const key = settings.yougile_key;
  if (!key) return { ok: false, error: 'не задан ключ YouGile в настройках' };

  const base = settings.yougile_base || 'https://ru.yougile.com/api-v2';
  const res = await fetch(`${base}/tasks?limit=1000`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return { ok: false, error: `YouGile ответил ${res.status}` };

  const data = await res.json().catch(() => ({}));
  const list = data.content || data.tasks || (Array.isArray(data) ? data : []);
  let touched = 0;
  for (const t of list) {
    await upsertTaskFromYougile(db, t, settings);
    touched += 1;
  }
  return { ok: true, synced: touched };
}

async function upsertTaskFromYougile(db, t, settings) {
  const existing = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(t.id).first();

  const assignee = Array.isArray(t.assigned) ? t.assigned[0] : t.assigned || null;
  const user = assignee
    ? await db.prepare('SELECT id FROM users WHERE yougile_id = ?').bind(assignee).first()
    : null;

  const colInProgress = settings.column_in_progress;
  const colReview = settings.column_review;
  const colDone = settings.column_done;

  const patch = {
    title: t.title || existing?.title || 'Без названия',
    url: t.id ? `https://ru.yougile.com/team/#/task/${t.id}` : null,
    assignee_id: user?.id || existing?.assignee_id || null,
    deadline: t.deadline?.deadline
      ? new Date(t.deadline.deadline).toISOString()
      : existing?.deadline || null,
    created_at: existing?.created_at || (t.timestamp ? new Date(t.timestamp).toISOString() : nowIso()),
  };

  let status = existing?.status || 'open';
  let taken = existing?.taken_at || null;
  let submitted = existing?.submitted_at || null;
  let returns = existing?.returns || 0;

  if (t.columnId && t.columnId === colInProgress) {
    if (status === 'review') returns += 1; // вернулась с проверки
    status = 'in_progress';
    taken = taken || nowIso();
  } else if (t.columnId && t.columnId === colReview) {
    status = 'review';
    submitted = nowIso();
  } else if (t.columnId && t.columnId === colDone) {
    status = 'accepted';
  }

  if (existing) {
    await db
      .prepare(
        `UPDATE tasks SET title=?, url=?, assignee_id=?, deadline=?, status=?, taken_at=?,
         submitted_at=?, returns=?, updated_at=? WHERE id=?`
      )
      .bind(patch.title, patch.url, patch.assignee_id, patch.deadline, status,
            taken, submitted, returns, nowIso(), t.id)
      .run();
  } else {
    const isInitiative = user && t.createdBy && t.createdBy === assignee ? 1 : 0;
    await db
      .prepare(
        `INSERT INTO tasks (id, title, url, assignee_id, author_id, created_at, deadline,
         status, taken_at, submitted_at, returns, is_initiative)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(t.id, patch.title, patch.url, patch.assignee_id, t.createdBy || null,
            patch.created_at, patch.deadline, status, taken, submitted, returns, isInitiative)
      .run();
    await logEvent(db, { taskId: t.id, type: 'created', at: patch.created_at });
  }

  if (status === 'in_progress' && !existing?.taken_at) {
    await logEvent(db, { taskId: t.id, type: 'taken' });
  }
  if (status === 'review' && existing?.status !== 'review') {
    await logEvent(db, { taskId: t.id, type: 'submitted' });
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
  const msg = update?.message || update?.edited_message;
  if (!msg || !msg.from || msg.from.is_bot) return json({ ok: true });

  const wanted = settings.tg_chat_id;
  if (wanted && String(msg.chat.id) !== String(wanted)) return json({ ok: true });

  const user = await db
    .prepare('SELECT id, role, name FROM users WHERE tg_user_id = ? AND active = 1')
    .bind(String(msg.from.id))
    .first();
  if (!user) return json({ ok: true, skipped: 'неизвестный отправитель' });

  const at = new Date(msg.date * 1000).toISOString();
  const tz = num(settings, 'tz_offset', 3);
  const period = currentPeriod(tz);
  const inHours = isWorkTime(msg.date * 1000, settings) ? 1 : 0;

  // запрос от руководителя или лида
  if (user.role === 'chief' || user.role === 'lead') {
    const text = (msg.text || msg.caption || '').toLowerCase();
    const words = (settings.urgent_words || '').split(',').map((w) => w.trim()).filter(Boolean);
    const urgent = words.some((w) => text.includes(w)) ? 1 : 0;

    // если обратились к конкретному человеку — ждём именно его
    let mentionId = null;
    const mention = (msg.entities || []).find((e) => e.type === 'text_mention');
    if (mention?.user?.id) {
      const target = await db
        .prepare('SELECT id FROM users WHERE tg_user_id = ?')
        .bind(String(mention.user.id))
        .first();
      mentionId = target?.id || null;
    }

    await db
      .prepare(
        `INSERT INTO chat_replies (user_id, chat_id, request_msg, asked_by, asked_at, in_hours, urgent, mention_id, period)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(String(msg.chat.id), String(msg.message_id), user.id, at, inHours, urgent, mentionId, period)
      .run();
    return json({ ok: true, tracked: 'request', urgent: !!urgent });
  }

  // ответ ассистента
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

/** Месячная сводка руководителю отдела в личку. */
async function sendMonthlyDigest(env, settings) {
  const db = env.DB;
  const tz = num(settings, 'tz_offset', 3);
  const prev = new Date(Date.now() + tz * 3600e3);
  prev.setUTCDate(0); // последний день предыдущего месяца
  const period = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

  const lead = await db
    .prepare("SELECT * FROM users WHERE role = 'lead' AND tg_user_id IS NOT NULL AND active = 1")
    .first();
  if (!lead) return { ok: false, error: 'у руководителя отдела не указан Telegram' };

  const { results: people } = await db
    .prepare("SELECT * FROM users WHERE role = 'assistant' AND active = 1 ORDER BY name")
    .all();

  const lines = [`<b>Скорость ответов за ${period}</b>`, ''];
  for (const p of people) {
    const { tasks, replies } = await fetchUserData(db, p.id, period);
    const m = computeMetrics({ tasks, replies, settings, grade: p.grade });
    const s = m.breakdown.speed;
    lines.push(
      `<b>${p.name}</b>`,
      `  медиана ответа: ${s.medianReply === null ? '—' : humanSeconds(s.medianReply)}`,
      `  быстрее нормы: ${s.repliesFast} из ${s.requests}`,
      `  без ответа: ${s.misses}${s.capped ? ' ⚠️ включён потолок' : ''}`,
      `  вне рабочего времени ответил: ${s.offHoursAnswered} из ${s.offHours}`,
      `  оценка скорости: <b>${m.speed}</b> из 10`,
      ''
    );
  }

  const total = people.length;
  lines.push(`Всего ассистентов: ${total}`);
  await sendTelegram(env, lead.tg_user_id, lines.join('\n'));
  return { ok: true, period, people: total };
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

    // первого числа — сводка по скорости ответов за прошлый месяц
    if (event.cron === '0 6 1 * *') {
      await sendMonthlyDigest(env, settings);
      return;
    }

    // каждые 15 минут — напоминание о висящих вопросах
    await runEscalation(env, settings);

    // раз в час — подстраховочная синхронизация задач
    if (new Date().getUTCMinutes() < 15 && settings.yougile_key) {
      await syncYougile(env, settings);
    }
  },
};
