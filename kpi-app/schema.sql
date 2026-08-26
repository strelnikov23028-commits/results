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
  tg_username  TEXT,                          -- ник: по нему человека заводят
                                              -- до первого сообщения, id придёт позже
  salary       INTEGER NOT NULL DEFAULT 0,    -- оклад, для итоговой сводки
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_key ON users(key_hash);
CREATE INDEX idx_users_yg  ON users(yougile_id);
CREATE INDEX idx_users_tg  ON users(tg_user_id);
CREATE INDEX idx_users_nick ON users(tg_username);

-- ── Задачи ──────────────────────────────────────────────────────────────────
-- Тайминги хранятся как ISO-строки UTC. Всё, что можно вывести, выводится
-- на лету — в базе только факты с отметками времени.
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,          -- id задачи в YouGile
  title             TEXT NOT NULL,
  number            TEXT,                      -- человекочитаемый номер, ID-236
  url               TEXT,
  board_id          TEXT,
  column_id         TEXT,
  keywords          TEXT,                      -- поисковый индекс: считается один раз
                                               -- при появлении задачи, дальше не трогается
  assignee_id       TEXT REFERENCES users(id),
  author_id         TEXT,                      -- кто завёл: если ассистент — инициатива
  -- Вес со стикера «Размер задачи»: S=1, M=2, L=3, XL=5
  size              INTEGER NOT NULL DEFAULT 1 CHECK (size IN (1,2,3,5)),
  night             INTEGER NOT NULL DEFAULT 0,-- ночь/выходной/форс-мажор → размер ×1.5

  created_at        TEXT,                      -- поставлена
  taken_at          TEXT,                      -- взята в работу (первый переход в «В работе»)
  submitted_at      TEXT,                      -- отправлена на проверку
  done_at           TEXT,                      -- принята окончательно
  deadline          TEXT,

  -- Момент, когда ассистент сделал свою часть. Отличается от done_at там,
  -- где результат приходит извне: заказ уехал в США, работа сдана, а карточка
  -- закроется через месяцы, когда посылка доедет. Срок меряется по этой дате.
  work_done_at      TEXT,
  work_done_kind    TEXT,                      -- submitted | handed_off | accepted
  priority          INTEGER,                   -- снимок приоритета на момент назначения

  -- Время в «Блокере» и «В ожидании» не идёт против ассистента:
  -- он не виноват, что ждали ответа третьей стороны.
  paused_min        INTEGER NOT NULL DEFAULT 0,
  paused_since      TEXT,

  returns           INTEGER NOT NULL DEFAULT 0,-- сколько раз вернули из «На проверке»
  chief_touched     INTEGER NOT NULL DEFAULT 0,-- руководитель писал в карточке до закрытия
  is_initiative     INTEGER NOT NULL DEFAULT 0,
  -- Задача из колонки «Заёб». В KPI не участвует вообще: ни время,
  -- ни качество, ни автономность. Приносит только приз тому, кто закрыл.
  is_zaeb           INTEGER NOT NULL DEFAULT 0,
  zaeb_awarded      INTEGER NOT NULL DEFAULT 0,
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
  asked_role   TEXT,     -- chief | lead — от этого зависит, кто может ответить
  asked_at     TEXT NOT NULL,
  replied_at   TEXT,
  seconds      INTEGER,  -- NULL — остался без ответа
  in_hours     INTEGER NOT NULL DEFAULT 1, -- попало ли в рабочее окно
  urgent       INTEGER NOT NULL DEFAULT 0, -- помечено как срочное
  escalated    INTEGER NOT NULL DEFAULT 0, -- бот уже напоминал
  mention_id   TEXT,     -- если обращались к конкретному человеку
  no_reply_needed INTEGER NOT NULL DEFAULT 0, -- «понял, спасибо» — таймер не в счёт
  period       TEXT NOT NULL
);
CREATE INDEX idx_chat_user ON chat_replies(user_id, period);

-- Состояние переписки: нужно, чтобы отличить новый вопрос от продолжения
-- разговора. Пока диалог идёт, новые таймеры не открываются — иначе за одну
-- живую беседу можно набрать десяток «быстрых ответов».
CREATE TABLE chat_state (
  chat_id     TEXT PRIMARY KEY,
  last_msg_at TEXT,
  last_from   TEXT
);

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
  -- Три кошелька. Проактивность убрана: все задачи заводит руководитель
  -- отдела, поэтому «инициативу ассистента» нечем измерить, а требовать
  -- от владельца нажимать кнопку на каждую — лишнее действие.
  -- Её доля разошлась по остальным пропорционально: 45 / 30 / 25 %.
  ('purse_quality',     '22500'),
  ('purse_speed',       '15000'),
  ('purse_autonomy',    '12500'),
  ('lead_pool',         '50000'),
  ('lead_purse_team',   '20000'),
  ('lead_purse_filter', '15000'),
  ('lead_purse_unload', '10000'),
  ('lead_purse_growth', '5000'),
  ('lead_share_zaeb',   '0.10'),
  ('lead_share_saving', '0.05'),
  ('saving_rate_1',     '0.30'),
  ('saving_rate_2',     '0.20'),
  ('saving_rate_3',     '0.10'),
  ('reply_target_min',  '15'),
  -- Доля задач со сроком, начиная с которой срок вообще учитывается.
  -- Если сроки почти не проставляют, скорость меряется по одной реакции:
  -- иначе человек теряет полкошелька за то, как оформлены чужие задачи.
  ('sla_min_coverage',  '0.3'),
  ('work_start',        '09:00'),
  ('work_end',          '22:00'),
  ('tz_offset',         '3'),
  -- Баллы за ответы. Пропуск стоит ровно трёх быстрых ответов: три пропуска
  -- отыгрываются девятью. Потолка нет — до 10 дойти можно всегда,
  -- выше 10 подняться нельзя.
  ('pt_fast',           '1'),    -- быстрый ответ в рабочее время
  ('pt_slow',           '0'),    -- ответил, но медленнее нормы
  ('pt_offhours',       '2'),    -- ответ в нерабочее время: не был обязан
  ('pt_miss',           '-3'),   -- промолчал в рабочее время
  ('miss_after_min',    '60'),   -- запрос без ответа дольше этого = пропуск
  ('miss_night_hours',  '12'),   -- ночной запрос, не разгребённый к утру
  ('escalate_after_min','30'),   -- через сколько бот напомнит в чат
  ('streak_bonus',      '2000'), -- месяц без единого пропуска
  ('urgent_target_min', '5'),    -- норма ответа на срочное
  ('urgent_words',      'срочно,asap,горит,срочное'),
  -- Сообщения, на которые отвечать не нужно: таймер не открывается
  ('no_reply_words',    'спасибо,спс,благодарю,понял,поняла,понятно,ясно,ок,окей,ok,хорошо,отлично,супер,класс,круто,принято,ага,угу,да,нет,плюс'),
  ('min_request_len',   '25'),   -- короткая реплика без вопроса — не запрос
  -- Дата запуска. Всё, что закрыто раньше, в расчёт не идёт: по старым
  -- задачам нет ни признаков приёмки, ни переписки. Проставляется один раз.
  ('start_from',        ''),
  -- Живой диалог не должен превращаться в десяток «быстрых ответов»:
  -- пока переписка идёт, новый таймер не открывается
  ('dialog_window_min', '20'),
  -- Распознавание задачи по сообщению
  ('llm_enabled',       '1'),
  ('llm_url',           'http://127.0.0.1:11434/api/generate'),
  ('llm_model',         'qwen3:8b'),
  ('llm_timeout_ms',    '45000'),
  ('llm_confidence',    '1.35'), -- отрыв лидера, при котором модель не нужна
  -- Скорость руководителя отдела: своя и командная
  ('lead_speed_personal','0.4'),
  ('lead_speed_team',    '0.6'),
  ('duty_user_id',      ''),     -- кто на дежурстве вне рабочего окна
  ('duty_shift_pay',    '1500'), -- доплата за смену выходного дня
  ('norm_autonomy_A1',  '0.60'),
  ('norm_autonomy_A2',  '0.85'),
  ('norm_autonomy_A3',  '0.95'),
  ('norm_proactivity',  '4'),
  ('cut_threshold',     '5'),
  ('cut_factor',        '0.85'),
  ('yougile_key',       ''),     -- задаётся секретом, в базу не пишется
  ('yougile_base',      'https://yougile.com/api-v2'),
  -- Колонки обеих рабочих досок: «Задачи ассистентов» и «Задачи Дмитрия».
  -- Списки через запятую — пайплайн у досок одинаковый.
  ('column_backlog',    '3b698e71-7a66-4806-a376-92c9890d5d9b,d79b6ea6-4a90-4f4f-b13b-df6fa0407e5d'),
  ('column_in_progress','2c8c024a-c0c5-4a6b-b092-7cb284e6427a,c45a6d3a-00e8-4a4b-8408-3fe0f90a5e0b'),
  ('column_review',     '8f532219-77c1-46f1-9700-f00be782255d,1589ae19-d477-490b-be8d-02320753a45b'),
  -- Закрыта по-настоящему: только «Завершена». Задача считается сделанной
  -- лишь тогда, когда она решена, а не отложена.
  ('column_done',       '1e0a69b2-b008-419b-89dd-0b0a3ccb6730,f0c8d7f5-82bd-43bd-a570-d0b7d8ecae27'),
  -- «Блокер»: работа стоит не по вине исполнителя. Часы на паузе,
  -- но задача НЕ считается сданной — иначе блокером можно было бы
  -- останавливать срок, не сделав ничего.
  ('column_blocked',    '6402f460-bf23-4ed5-a0d9-ce618332af2e'),
  -- «В ожидании» и «Гаджеты»: работа ассистента сделана, ждём внешний
  -- результат — доставку, ответ поставщика, согласование. Часы стоят
  -- И задача засчитывается сданной: заказ гаджета оценивается в месяц
  -- заказа, а не когда посылка доехала.
  ('column_waiting',    '906ca640-b92e-4458-864c-b1e2fc596b4f,0a9692b2-d12d-4923-9208-e2b044be5a88,c5952427-f95b-4b20-87a1-3dbd800f051a'),
  -- Оба списка вместе — для обратной совместимости расчёта паузы
  ('column_paused',     '6402f460-bf23-4ed5-a0d9-ce618332af2e,906ca640-b92e-4458-864c-b1e2fc596b4f,0a9692b2-d12d-4923-9208-e2b044be5a88,c5952427-f95b-4b20-87a1-3dbd800f051a'),
  -- Отложена: «На контроле» и «На потом». Из расчёта выпадает целиком,
  -- пока не будет решена и переведена в «Завершена».
  ('column_shelved',    '66b5d0b0-fa13-4026-8c30-0749a01fe3f5,958095f6-790b-49c8-9f35-a6368017b0af,a481b53b-fa5b-4596-b43b-0fd10a04c075'),
  -- Задача снята совсем
  ('column_cancelled',  '8462a7c2-4af8-4003-99be-113f0a4bf91a'),
  -- Реестр заёбов уже существует отдельной колонкой
  ('column_zaeb',       'c6a58d41-8ef3-4146-bac8-0478c2c6a0ed'),

  -- Стикеры YouGile. Оба уже заведены на доске, их значения читаются
  -- напрямую — заводить ничего не нужно.
  --
  -- «Приоритет» — это срок в РАБОЧИХ днях от постановки задачи:
  --   1  — в течение дня или в первый рабочий день после выходных
  --   3  — в течение двух-трёх рабочих дней
  --   7  — в течение недели
  --   30 — в течение месяца
  ('sticker_priority',  '0681807e-900b-47b6-8880-624802294bb0'),
  ('priority_states',   'ffd115a98702=1,e0051cdabb08=3,e6257641af72=7,4a0515f61bb0=30'),
  -- Срок по умолчанию, если приоритет не проставлен
  ('priority_default',  '7'),

  -- «Размер задачи» — вес в оценке качества
  ('sticker_size',      '19000680-c793-45ee-9061-4d8251343c4a'),
  ('size_states',       '9dd99e96c71c=1,0b2e97716e0e=2,b6e9a764ce20=3,d036c20324cb=5'),
  ('size_default',      '1'),
  ('tg_chat_id',        '');
