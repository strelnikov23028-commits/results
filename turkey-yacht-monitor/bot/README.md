# Aquila-Watch — Telegram-бот

Long-polling Python-бот, который отвечает на команды в @Search_aquila_bot
и при `/search` дёргает GitHub Actions workflow.

## Деплой одной командой

На любом Linux VPS (Ubuntu/Debian) под root:

```bash
curl -sL https://raw.githubusercontent.com/strelnikov23028-commits/results/main/turkey-yacht-monitor/bot/deploy.sh | bash
```

Это:
1. Установит python3-venv, git
2. Склонирует репо в `/opt/aquila-watch-bot-src`
3. Установит зависимости в venv
4. Скопирует `aquila-watch-bot.service` в `/etc/systemd/system/`
5. Создаст `/opt/aquila-watch-bot/.env` (из примера — с уже верными значениями)
6. Запустит и включит автозапуск systemd-юнита

## Что внутри `.env`

`.env.example` — шаблон с placeholder'ами. После деплоя нужно вписать
**реальные** значения в `/opt/aquila-watch-bot/.env`:

| переменная | где взять |
|---|---|
| `TELEGRAM_BOT_TOKEN` | у @BotFather (`/mybots → ... → API Token`), или из `repo secrets/TELEGRAM_BOT_TOKEN` на GitHub |
| `GH_TOKEN` | Settings → Developer settings → PATs → fine-grained, scope `actions:write` + `contents:read` на этом репо |
| `OWNER_TG_ID` | твой числовой Telegram id (для @Search_aquila_bot = 292525734) |

После правки:
```bash
systemctl restart aquila-watch-bot
journalctl -u aquila-watch-bot -f
```

## Команды боту

| команда | что делает |
|---|---|
| `/start`, `/help` | справка + inline-клавиатура |
| `/search` | мгновенно запускает workflow, через 1-2 мин отчёт |
| `/status` | статус последнего workflow run'а |
| `/sources` | сколько и какие источники мониторим |

## Логи и управление

```bash
journalctl -u aquila-watch-bot -f      # logs live
systemctl restart aquila-watch-bot     # перезапуск
systemctl status aquila-watch-bot      # статус
```

## Безопасность

- Бот игнорирует все сообщения кроме `OWNER_TG_ID`. Если кто-то найдёт бота
  и напишет — молчит.
- Если меняешь `GH_TOKEN` — обнови `/opt/aquila-watch-bot/.env` и рестартни.
