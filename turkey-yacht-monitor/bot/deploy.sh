#!/usr/bin/env bash
# Деплой бота на VPS.
#
# Использование (один раз на свежем сервере):
#   curl -sL https://raw.githubusercontent.com/strelnikov23028-commits/results/main/turkey-yacht-monitor/bot/deploy.sh | bash
#
# Скрипт идемпотентен — можно запускать повторно для обновления.

set -euo pipefail

REPO="${REPO:-https://github.com/strelnikov23028-commits/results.git}"
BRANCH="${BRANCH:-main}"
DIR="/opt/aquila-watch-bot"
REPO_DIR="/opt/aquila-watch-bot-src"

echo "[1/6] System deps…"
if command -v apt-get >/dev/null; then
  apt-get update -qq
  apt-get install -qq -y python3 python3-venv python3-pip git >/dev/null
fi

echo "[2/6] Clone or pull source…"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch --depth=1 origin "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
else
  rm -rf "$REPO_DIR"
  git clone --depth=1 --branch "$BRANCH" "$REPO" "$REPO_DIR"
fi

echo "[3/6] Sync code into $DIR…"
mkdir -p "$DIR"
cp "$REPO_DIR/turkey-yacht-monitor/bot/bot.py" "$DIR/"
cp "$REPO_DIR/turkey-yacht-monitor/bot/requirements.txt" "$DIR/"
cp "$REPO_DIR/turkey-yacht-monitor/bot/aquila-watch-bot.service" "/etc/systemd/system/"

echo "[4/6] Python venv + deps…"
if [ ! -d "$DIR/venv" ]; then
  python3 -m venv "$DIR/venv"
fi
"$DIR/venv/bin/pip" install -q --upgrade pip
"$DIR/venv/bin/pip" install -q -r "$DIR/requirements.txt"

echo "[5/6] Check .env…"
if [ ! -f "$DIR/.env" ]; then
  cp "$REPO_DIR/turkey-yacht-monitor/bot/.env.example" "$DIR/.env"
  chmod 600 "$DIR/.env"
  echo
  echo "  ⚠️  Создан $DIR/.env из шаблона — допиши реальные TELEGRAM_BOT_TOKEN и GH_TOKEN:"
  echo "       nano $DIR/.env"
  echo "       systemctl restart aquila-watch-bot"
  echo
  echo "  (бот не запустится с PUT_..._HERE значениями — это сделано специально)"
fi

echo "[6/6] Restart systemd unit…"
systemctl daemon-reload
systemctl enable --now aquila-watch-bot.service
sleep 2
systemctl status aquila-watch-bot.service --no-pager -l | head -20

echo
echo "✅ Готово. Логи: journalctl -u aquila-watch-bot -f"
echo "   После /start у @Search_aquila_bot напиши /search."
