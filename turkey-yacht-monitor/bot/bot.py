"""
Long-polling Telegram-бот для Aquila-Watch.

Что делает:
  /start, /help — справка и кнопка
  /search       — мгновенно запускает GitHub Actions workflow (dispatch).
                  Через ~1-2 мин в этот же чат прилетит отчёт от Actions.
  /status       — статус последнего run'а (success/failure + время)
  /sources      — счётчик источников (читает sources.yaml из репо)
  callback      — кнопка «🔄 Проверить сейчас» в любом сообщении дёргает /search

Доступ только у владельца (OWNER_TG_ID). Чужие /start получают молчание.

env:
  TELEGRAM_BOT_TOKEN  — токен бота (@Search_aquila_bot)
  OWNER_TG_ID         — Telegram user_id владельца (целое число)
  GH_TOKEN            — Personal Access Token с правом repo:write
  GH_REPO             — owner/repo, по умолчанию strelnikov23028-commits/results
  GH_WORKFLOW         — имя workflow-файла, по умолчанию turkey-yacht-monitor.yml
  GH_REF              — ветка, по умолчанию main
"""
from __future__ import annotations

import logging
import os
import sys

import requests
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("aquila-bot")


def env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, default)
    if v is None or v == "":
        print(f"FATAL: env var {name} is required", file=sys.stderr)
        sys.exit(1)
    return v


BOT_TOKEN = env("TELEGRAM_BOT_TOKEN")
OWNER_TG_ID = int(env("OWNER_TG_ID"))
GH_TOKEN = env("GH_TOKEN")
GH_REPO = env("GH_REPO", "strelnikov23028-commits/results")
GH_WORKFLOW = env("GH_WORKFLOW", "turkey-yacht-monitor.yml")
GH_REF = env("GH_REF", "main")

GH_HEADERS = {
    "Authorization": f"Bearer {GH_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "aquila-watch-bot",
}
GH_API = f"https://api.github.com/repos/{GH_REPO}"


def owner_only(handler):
    """Decorator: handler runs only for OWNER_TG_ID."""
    async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        user_id = update.effective_user.id if update.effective_user else None
        if user_id != OWNER_TG_ID:
            log.info(f"reject from user_id={user_id}")
            return
        return await handler(update, ctx)
    return wrapper


def main_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("\U0001f504 Проверить сейчас",
                                  callback_data="search")],
            [InlineKeyboardButton("\U0001f4ca Статус", callback_data="status"),
             InlineKeyboardButton("\U0001f4cb Aquila 50 Sail",
                                  url="https://www.aquilaboats.com/models/sail-catamarans/50")],
        ]
    )


def dispatch_workflow() -> tuple[bool, str]:
    url = f"{GH_API}/actions/workflows/{GH_WORKFLOW}/dispatches"
    try:
        r = requests.post(url, headers=GH_HEADERS,
                          json={"ref": GH_REF}, timeout=20)
    except requests.RequestException as e:
        return False, f"network error: {e}"
    if r.status_code in (200, 201, 204):
        return True, "ok"
    return False, f"HTTP {r.status_code}: {r.text[:200]}"


def latest_run_info() -> str:
    url = f"{GH_API}/actions/workflows/{GH_WORKFLOW}/runs?per_page=1"
    try:
        runs = requests.get(url, headers=GH_HEADERS, timeout=20).json()
    except requests.RequestException as e:
        return f"⚠️ Не удалось получить статус: {e}"
    items = runs.get("workflow_runs", [])
    if not items:
        return "Запусков ещё не было."
    r = items[0]
    return (
        f"Последний run #{r['run_number']}:\n"
        f"• статус: <b>{r['status']}</b> / {r['conclusion']}\n"
        f"• когда: {r['created_at']}\n"
        f"• событие: {r['event']}\n"
        f"• <a href=\"{r['html_url']}\">Открыть в GitHub</a>"
    )


def count_sources() -> str:
    """Pull sources.yaml from repo and count."""
    raw = (f"https://raw.githubusercontent.com/{GH_REPO}/{GH_REF}/"
           "turkey-yacht-monitor/sources.yaml")
    try:
        text = requests.get(raw, timeout=15).text
    except requests.RequestException as e:
        return f"⚠️ Не удалось прочитать sources.yaml: {e}"
    names = [line.split(":", 1)[1].strip()
             for line in text.splitlines()
             if line.startswith("  - name:")]
    return f"Источников: <b>{len(names)}</b>\n" + "\n".join(
        f"• {n}" for n in names
    )


# ---- Handlers ---------------------------------------------------------------


@owner_only
async def start_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = (
        "🛥️ <b>AQUILA-WATCH</b>\n\n"
        "Мониторинг чартерных компаний Турции на появление яхты "
        "<b>Aquila 50 Sail Catamaran</b>.\n\n"
        "Команды:\n"
        "/search — запустить проверку прямо сейчас\n"
        "/status — статус последнего запуска\n"
        "/sources — список всех проверяемых сайтов\n"
        "/help — эта справка\n\n"
        "Ежедневный автоотчёт приходит в 09:02 МСК."
    )
    await update.message.reply_html(text, reply_markup=main_keyboard())


@owner_only
async def help_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await start_cmd(update, ctx)


@owner_only
async def search_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_html("🚀 Запускаю проверку…")
    ok, detail = dispatch_workflow()
    if ok:
        await msg.edit_text(
            "🚀 <b>Проверка запущена.</b>\n"
            "Через ~1-2 минуты пришлю отчёт со всеми сайтами.",
            parse_mode=ParseMode.HTML,
        )
    else:
        await msg.edit_text(
            f"❌ Не удалось запустить: <code>{detail}</code>",
            parse_mode=ParseMode.HTML,
        )


@owner_only
async def status_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_html(latest_run_info(),
                                    reply_markup=main_keyboard())


@owner_only
async def sources_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = count_sources()
    if len(text) > 3800:
        text = text[:3800] + "\n…(список обрезан)"
    await update.message.reply_html(text)


@owner_only
async def on_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    if q.data == "search":
        ok, detail = dispatch_workflow()
        if ok:
            await q.message.reply_html(
                "🚀 <b>Проверка запущена.</b>\nЧерез ~1-2 мин будет отчёт."
            )
        else:
            await q.message.reply_html(
                f"❌ Не удалось запустить: <code>{detail}</code>"
            )
    elif q.data == "status":
        await q.message.reply_html(latest_run_info())


def main() -> None:
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("search", search_cmd))
    app.add_handler(CommandHandler("status", status_cmd))
    app.add_handler(CommandHandler("sources", sources_cmd))
    app.add_handler(CallbackQueryHandler(on_callback))
    log.info("aquila-watch-bot started, polling…")
    app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)


if __name__ == "__main__":
    main()
