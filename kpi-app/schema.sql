-- KPI отдела ассистентов. Cloudflare D1.
-- Применить: npx wrangler d1 execute kpi --file=schema.sql --remote

DROP TABLE IF EXISTS chat_replies;
DROP TABLE IF EXISTS awards;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS settings;

-- ── Люди ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('assistant','lead','chief')),
  grade        TEXT NOT NULL DEFAULT 'A2',   -- A1 / A2 / A3
  key_hash     TEXT,                          -- sha256 ключа доступа
  yougile_id   TEXT,                          -- id пользователя в YouGile
  tg_user_id   TEXT,                          -- id в Telegram, для замера ответов
  salary       INTEGER NOT NULL DEFAULT 0,    -- оклад, для итоговой сводки
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_key ON users(key_hash);
CREATE INDEX idx_users_yg  ON users(yougile_id);
CREATE INDEX idx_users_tg  ON users(tg_user_id);

-- ── Задачи ──────────────────────────────────────────────────────────────────
-- Тайминги хранятся как ISO-строки UTC. Всё, что можно вывести, выводится
-- на лету — в базе только факты с отметками времени.
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,          -- id задачи в YouGile
  title             TEXT NOT NULL,
  url               TEXT,
  assignee_id       TEXT REFERENCES users(id),
  author_id         TEXT,                      -- кто завёл: если ассистент — инициатива
  size              INTEGER NOT NULL DEFAULT 1 CHECK (size IN (1,2,3)),
  night             INTEGER NOT NULL DEFAULT 0,-- ночь/выходной/форс-мажор → размер ×1.5

  created_at        TEXT,                      -- поставлена
  taken_at          TEXT,                      -- взята в работу (первый переход в «В работе»)
  submitted_at      TEXT,                      -- отправлена на проверку
  done_at           TEXT,                      -- принята окончательно
  deadline          TEXT,

  returns           INTEGER NOT NULL DEFAULT 0,-- сколько раз вернули из «На проверке»
  chief_touched     INTEGER NOT NULL DEFAULT 0,-- руководитель писал в карточке до закрытия
  is_initiative     INTEGER NOT NULL DEFAULT 0,
  initiative_useful INTEGER,                   -- NULL — не отвечено, 1/0 — ответ руководителя

  status            TEXT NOT NULL DEFAULT 'open',
                    -- open | in_progress | review | accepted | returned | failed
  disputed          INTEGER NOT NULL DEFAULT 0,-- лид списал признак как «вопрос по делу»
  dispute_note      TEXT,
  period            TEXT,                      -- YYYY-MM, проставляется при закрытии
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_user   ON tasks(assignee_id);
CREATE INDEX idx_tasks_period ON tasks(period);
CREATE INDEX idx_tasks_status ON tasks(status);

-- ── Лог событий: на нём держится вся прозрачность ────────────────────────────
-- Любую цифру в отчёте можно развернуть до списка событий с временем и автором.
CREATE TABLE events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  TEXT,
  user_id  TEXT,
  type     TEXT NOT NULL,   -- created|taken|submitted|returned|accepted|chief_message|initiative_answer|manual
  actor    TEXT,            -- кто вызвал событие
  at       TEXT NOT NULL,
  note     TEXT,
  source   TEXT NOT NULL DEFAULT 'yougile' -- yougile | telegram | manual
);
CREATE INDEX idx_events_task ON events(task_id);
CREATE INDEX idx_events_user ON events(user_id, at);

-- ── Скорость ответа в общем чате Telegram ───────────────────────────────────
CREATE TABLE chat_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT REFERENCES users(id),
  chat_id      TEXT,
  request_msg  TEXT,     -- id сообщения-запроса
  reply_msg    TEXT,
  asked_by     TEXT,     -- кто спросил: id руководителя или лида
  asked_at     TEXT NOT NULL,
  replied_at   TEXT,
  seconds      INTEGER,  -- NULL — остался без ответа
  in_hours     INTEGER NOT NULL DEFAULT 1, -- попало ли в рабочее окно
  urgent       INTEGER NOT NULL DEFAULT 0, -- помечено как срочное
  escalated    INTEGER NOT NULL DEFAULT 0, -- бот уже напоминал
  mention_id   TEXT,     -- если обращались к конкретному человеку
  period       TEXT NOT NULL
);
CREATE INDEX idx_chat_user ON chat_replies(user_id, period);

-- ── Призы за заёбы и экономия ───────────────────────────────────────────────
CREATE TABLE awards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT REFERENCES users(id),
  kind         TEXT NOT NULL,       -- zaeb | saving
  title        TEXT NOT NULL,
  tier         TEXT,                -- S | M | L | XL, для заёбов
  amount       INTEGER NOT NULL DEFAULT 0, -- сотруднику
  lead_amount  INTEGER NOT NULL DEFAULT 0, -- доля лида
  base_price   INTEGER,             -- для экономии: цена до переговоров
  final_price  INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | half_paid | confirmed | rejected
  period       TEXT NOT NULL,
  proof_url    TEXT,                -- скриншот базовой цены
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  confirm_due  TEXT,                -- когда спросить «не всплывало?»
  confirmed_at TEXT
);
CREATE INDEX idx_awards_user ON awards(user_id, period);

-- ── Настройки: всё, что можно подкрутить без правки кода ────────────────────
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('bonus_pool',        '50000'),
  ('purse_quality',     '17500'),
  ('purse_speed',       '12500'),
  ('purse_autonomy',    '10000'),
  ('purse_proactivity', '10000'),
  ('lead_pool',         '50000'),
  ('lead_purse_team',   '20000'),
  ('lead_purse_filter', '15000'),
  ('lead_purse_unload', '10000'),
  ('lead_purse_growth', '5000'),
  ('lead_share_zaeb',   '0.17'),
  ('lead_share_saving', '0.05'),
  ('saving_rate_1',     '0.30'),
  ('saving_rate_2',     '0.20'),
  ('saving_rate_3',     '0.10'),
  ('reply_target_min',  '15'),
  ('work_start',        '09:00'),
  ('work_end',          '22:00'),
  ('tz_offset',         '3'),
  -- молчание
  ('miss_after_min',    '60'),   -- запрос без ответа дольше этого = пропуск
  ('miss_night_hours',  '12'),   -- ночной запрос без ответа дольше этого = пропуск
  ('escalate_after_min','30'),   -- через сколько бот напомнит в чат
  ('miss_penalty',      '0.5'),  -- сколько баллов снимает один пропуск
  ('miss_cap_count',    '3'),    -- с этого числа пропусков включается потолок
  ('miss_cap_score',    '5'),    -- выше этого скорость не поднимется
  ('streak_bonus',      '2000'), -- месяц без единого пропуска
  ('urgent_target_min', '5'),    -- норма ответа на срочное
  ('urgent_words',      'срочно,сро́чно,asap,горит'),
  ('duty_user_id',      ''),     -- кто на дежурстве вне рабочего окна
  ('duty_shift_pay',    '1500'), -- доплата за смену выходного дня
  ('norm_autonomy_A1',  '0.60'),
  ('norm_autonomy_A2',  '0.85'),
  ('norm_autonomy_A3',  '0.95'),
  ('norm_proactivity',  '4'),
  ('cut_threshold',     '5'),
  ('cut_factor',        '0.85'),
  ('yougile_key',       ''),
  ('yougile_base',      'https://ru.yougile.com/api-v2'),
  ('column_in_progress',''),
  ('column_review',     ''),
  ('column_done',       ''),
  ('tg_chat_id',        '');
