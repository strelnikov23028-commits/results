-- Стартовый состав. ID пользователей взяты из вашего YouGile (GET /api-v2/users).
-- Ключи доступа здесь НЕ проставлены: их выдаёт бот командой /key @ник,
-- чтобы ключ показался один раз и не лежал в файле.
--
-- Применить после schema.sql:
--   npx wrangler d1 execute kpi --file=seed.sql --remote
--
-- Ники в Telegram проставьте свои: Telegram не отдаёт id по нику,
-- поэтому человек «оживает», когда впервые напишет в рабочем чате.

INSERT INTO users (id, name, role, grade, yougile_id, tg_username, salary) VALUES
  ('u-yaroslav',  'Ярослав Стрельников', 'lead',      'A3', '8e7068f8-18d4-45b8-9e60-4a60f92be65f', NULL, 0),
  ('u-ekaterina', 'Екатерина Мальцева',  'assistant', 'A2', '75cfe5e1-1e05-40f4-adc6-db90188810fb', NULL, 0),
  ('u-kseniia',   'Kseniia',             'assistant', 'A2', '24c6fa5d-4670-4115-b2aa-028c064d7620', NULL, 0),
  ('u-viktor',    'Виктор',              'assistant', 'A2', 'f520ecf2-c831-4afc-9be9-6d0ee8a0ac27', NULL, 0),
  ('u-forwork',   'Forwork',             'assistant', 'A2', '55fe21b7-44dd-4b84-9c58-1c92c7a76286', NULL, 0);

-- Кто именно ваш руководитель — проставьте вручную, сменив роль на 'chief':
--   UPDATE users SET role = 'chief' WHERE id = 'u-viktor';
