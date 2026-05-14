"""
Отправка результатов мониторинга в Telegram.

Читает state/last_run.json и шлёт владельцу:
  - heartbeat-сводку (всегда, если ALWAYS_PING=1) со списком всех источников
  - отдельное сообщение, когда появились fresh hits или новые ошибки

Inline-кнопка "🔄 Проверить сейчас" ведёт на форму workflow_dispatch
в GitHub Actions (там пользователь жмёт "Run workflow" — задача стартует и
через ~1 минуту присылает свежий отчёт).

Опции через env:
  TELEGRAM_BOT_TOKEN  (обязательно)
  TELEGRAM_CHAT_ID    (обязательно)
  ALWAYS_PING=1       включает daily-отчёт даже без новых находок
  DISPATCH_URL        URL формы Run-workflow в GHA (для кнопки)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).parent
RUN_FILE = ROOT / "state" / "last_run.json"

MAX_TELEGRAM_LEN = 4000  # запас от лимита 4096


def send(token: str, chat_id: str, text: str, reply_markup: dict | None = None) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    r = requests.post(url, json=payload, timeout=30)
    if r.status_code >= 400:
        print(f"[notify] telegram error {r.status_code}: {r.text[:300]}",
              file=sys.stderr)
        if "chat not found" in r.text.lower():
            # First-time onboarding: tell the operator which bot to /start
            try:
                me = requests.get(
                    f"https://api.telegram.org/bot{token}/getMe", timeout=10
                ).json()
                username = me.get("result", {}).get("username", "?")
                print(
                    f"[notify] HINT: чат {chat_id} ещё не открыт у бота. "
                    f"Открой https://t.me/{username} и нажми /start, "
                    f"потом запусти workflow заново.",
                    file=sys.stderr,
                )
            except requests.RequestException as inner:
                print(f"[notify] getMe failed: {inner}", file=sys.stderr)
    r.raise_for_status()


def html_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def build_message(report: dict) -> str | None:
    """Return Telegram message text if there are fresh hits or new errors,
    otherwise None (silent run)."""
    fresh = report.get("fresh_hits", {})
    new_errors = report.get("new_errors", [])
    if not fresh and not new_errors:
        return None

    lines = ["\U0001f6e5️ <b>AQUILA-WATCH</b>",
             f"<i>{html_escape(report.get('ts', '?'))}</i>",
             ""]

    if fresh:
        lines.append("✨ <b>Новые упоминания Aquila:</b>")
        for name, info in fresh.items():
            url = info["url"]
            host = info.get("host", "")
            snippets = info.get("new_match_snippets") or info.get("matches", [])
            lines.append(f"⚓ <b>{html_escape(name)}</b> ({html_escape(host)})")
            lines.append(f"   {html_escape(url)}")
            for sn in snippets[:3]:
                sn_short = sn[:240] + ("…" if len(sn) > 240 else "")
                lines.append(f"   • <code>{html_escape(sn_short)}</code>")
            lines.append("")

    if new_errors:
        lines.append("⚠️ <b>Новые ошибки источников:</b>")
        for e in new_errors:
            lines.append(
                f"• <b>{html_escape(e['name'])}</b>: "
                f"<code>{html_escape(e['error'])[:120]}</code>"
            )
            lines.append(f"   {html_escape(e['url'])}")
        lines.append("")
        lines.append("<i>Если повторяется день за днём — этот источник, "
                     "видимо, мониторить нельзя. Поправлю sources.yaml.</i>")

    text = "\n".join(lines)
    if len(text) > MAX_TELEGRAM_LEN:
        text = text[: MAX_TELEGRAM_LEN - 30] + "\n…(сообщение обрезано)"
    return text


def build_heartbeat(report: dict, source_names: list[str]) -> str:
    checked = report.get("checked", 0)
    findings = report.get("all_findings", {})
    errors = report.get("errors", [])
    ok_count = checked - len(errors)
    lines = [
        "\U0001f6e5️ <b>AQUILA-WATCH</b> — ежедневный отчёт",
        f"<i>{html_escape(report.get('ts', '?'))}</i>",
        "",
        "🎯 Цель: <b>Aquila 50 Sail Catamaran</b>",
        "    https://www.aquilaboats.com/models/sail-catamarans/50",
        "",
        f"📊 Проверено: <b>{checked}</b> сайтов "
        f"(ок: {ok_count}, ошибка: {len(errors)})",
        f"🔍 Упоминаний «aquila» (включая старые): <b>{len(findings)}</b>",
    ]
    if findings:
        lines.append("")
        lines.append("🟡 <b>Где уже встречалось слово:</b>")
        for name, info in list(findings.items())[:10]:
            lines.append(f"• {html_escape(name)} — {html_escape(info['url'])}")
    else:
        lines.append("")
        lines.append("✅ Сегодня Aquila нигде не появилась.")

    if errors:
        lines.append("")
        lines.append("⚠️ <b>Не отвечают:</b>")
        for e in errors[:10]:
            lines.append(
                f"• {html_escape(e['name'])}: "
                f"<code>{html_escape(e['error'])[:80]}</code>"
            )
        if len(errors) > 10:
            lines.append(f"… и ещё {len(errors) - 10}")

    # Список всех опрошенных сайтов — компактно (5 в строке), чтобы влезть в лимит TG
    lines.append("")
    lines.append(f"<b>Список проверенных источников ({len(source_names)}):</b>")
    BATCH = 3
    for i in range(0, len(source_names), BATCH):
        chunk = source_names[i : i + BATCH]
        lines.append("· " + " · ".join(html_escape(s) for s in chunk))
    text = "\n".join(lines)
    if len(text) > MAX_TELEGRAM_LEN:
        text = text[: MAX_TELEGRAM_LEN - 30] + "\n…(список обрезан)"
    return text


def manual_keyboard() -> dict | None:
    dispatch_url = os.environ.get("DISPATCH_URL")
    if not dispatch_url:
        return None
    return {
        "inline_keyboard": [
            [{"text": "\U0001f504 Проверить сейчас", "url": dispatch_url}],
            [{"text": "\U0001f4cb Открыть Aquila 50 Sail",
              "url": "https://www.aquilaboats.com/models/sail-catamarans/50"}],
        ]
    }


def load_source_names() -> list[str]:
    import yaml
    sources_path = ROOT / "sources.yaml"
    data = yaml.safe_load(sources_path.read_text(encoding="utf-8"))
    return [s["name"] for s in data["sources"]]


def main() -> int:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("[notify] no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — skip",
              file=sys.stderr)
        return 0

    if not RUN_FILE.exists():
        print(f"[notify] {RUN_FILE} not found — nothing to send", file=sys.stderr)
        return 0

    report = json.loads(RUN_FILE.read_text(encoding="utf-8"))
    kb = manual_keyboard()

    # Сначала — фокусированное сообщение (если есть что показать)
    msg = build_message(report)
    if msg:
        send(token, chat_id, msg, reply_markup=kb)
        print("[notify] sent focused (fresh/errors) message")

    # Затем — ежедневный отчёт с полным списком источников (если включён)
    if os.environ.get("ALWAYS_PING") == "1":
        source_names = load_source_names()
        send(token, chat_id, build_heartbeat(report, source_names), reply_markup=kb)
        print("[notify] sent daily heartbeat")
    elif not msg:
        print("[notify] no fresh hits, silent")

    return 0


if __name__ == "__main__":
    sys.exit(main())
