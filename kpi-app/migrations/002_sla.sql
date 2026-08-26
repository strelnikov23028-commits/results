-- Отделение «работа сдана» от «результат получен».
--
-- Применять на боевой базе только этим файлом: schema.sql начинается
-- с DROP TABLE и уничтожит данные.
--
--   sqlite3 /opt/kpi-app/data/kpi.db < migrations/002_sla.sql

-- Момент, когда ассистент закончил свою часть. Для заказа гаджета это день
-- оформления заказа, а не день, когда посылка доехала из США.
ALTER TABLE tasks ADD COLUMN work_done_at   TEXT;
ALTER TABLE tasks ADD COLUMN work_done_kind TEXT;

-- Снимок приоритета на момент назначения: смена стикера задним числом
-- не должна отматывать уже накопленную просрочку.
ALTER TABLE tasks ADD COLUMN priority INTEGER;

-- Колонки, разведённые по смыслу.
-- «Блокер» — работа стоит не по вине исполнителя, но и не сдана.
INSERT INTO settings (key, value) VALUES
  ('column_blocked', '6402f460-bf23-4ed5-a0d9-ce618332af2e')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- «В ожидании», «Гаджеты» — работа сделана, ждём внешний результат.
INSERT INTO settings (key, value) VALUES
  ('column_waiting', '906ca640-b92e-4458-864c-b1e2fc596b4f,0a9692b2-d12d-4923-9208-e2b044be5a88,c5952427-f95b-4b20-87a1-3dbd800f051a')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- Задачи, стоявшие в статусе paused, переводим в blocked:
-- статус paused из расчёта выпадал целиком.
UPDATE tasks SET status = 'blocked' WHERE status = 'paused';
