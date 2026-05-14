# Turkey Yacht Charter — Aquila Watch

Ежедневно (через GitHub Actions) обходит сайты турецких чартерных компаний
(Ediba, Saysail, Sailfleet, Navigare, Irmak, Rotaneta, Marmaris Sailing, Dream
Yacht, Boating Turkey, и др.) + крупные агрегаторы (SamBoat, 12knots, Sailo,
Viravira, Plainsailing, Yasido) и ищет ключевое слово `aquila`
(целевая модель — [Aquila 50 Sail Catamaran](https://www.aquilaboats.com/models/sail-catamarans/50)).

Если на каком-то источнике появилось **новое** упоминание Aquila —
шлёт сообщение в Telegram-бота владельцу.

## Файлы

- `sources.yaml` — список URL для мониторинга
- `monitor.py` — обход сайтов, поиск ключевого слова, дифф со вчерашним состоянием
- `notify.py` — Telegram-уведомление через `sendMessage`
- `state/last_status.json` — что нашли в прошлый раз (закоммичено, для дифа)
- `state/last_run.json` — отчёт текущего запуска (gitignored)
- `../.github/workflows/turkey-yacht-monitor.yml` — cron

## Локальный запуск

```bash
cd turkey-yacht-monitor
pip install -r requirements.txt

# Один проход без уведомлений:
python3 monitor.py

# С Telegram-уведомлением (заполнить .env):
cp .env.example .env
# отредактировать токен/chat_id
set -a; source .env; set +a
python3 monitor.py && python3 notify.py
```

## Расписание

Запускается ежедневно в `06:17 UTC` через GitHub Actions (см. workflow).
Это даёт обнаружение в течение суток после появления яхты в любом из источников.

## Как добавить новую компанию

1. Открыть `sources.yaml`
2. Добавить запись:
   ```yaml
   - name: Имя компании
     url: https://example.com/fleet
     kind: company       # или aggregator
   ```
3. Закоммитить — workflow подхватит при следующем запуске.

## Ограничения

- Использует обычный HTTP-GET (без headless-браузера). Сайты с тяжёлым JS-рендером
  (SamBoat, Sailo) могут отдавать пустой каркас — но как правило, серверный HTML
  всё равно содержит названия марок для SEO. Если выявим SPA-проблему — добавим
  Playwright.
- Ключевое слово ищется как `\baquila\b` — без `aquilino`, `aquilon` и подобного.
- Дедупликация по точному тексту окружающего контекста — если у компании
  «aquila 50» уже была вчера, сегодня молчим. Если завтра появится «aquila 44»,
  пришлём.

## Telegram setup

Бот: переиспользует **Pomni-бот** (token из `pomni/.env: BOT_TOKEN`).
Chat ID: `OWNER_TG_ID` из того же файла (приватный чат = user_id).

Эти значения должны быть в **GitHub repo secrets**:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

См. `setup-secrets.sh`.
