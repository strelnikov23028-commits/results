"""
Отправка результатов мониторинга в Telegram.

Читает state/last_run.json и шлёт в @-чат пользователя:
  - если fresh_hits есть — большое сообщение со всеми новыми находками
  - если fresh_hits пусто — ничего не делаем (тихо)
  - ошибки логируем в stdout, но в Telegram не шлём (чтобы не спамить)

Опции через env:
  TELEGRAM_BOT_TOKEN  (обязательно)
  TELEGRAM_CHAT_ID    (обязательно)
  ALWAYS_PING=1       (по желанию: шлём heartbeat-сообщение даже если новых нет)
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


def send(token: str, chat_id: str, text: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    r = requests.post(url, json=payload, timeout=30)
    if r.status_code >= 400:
        print(f"[notify] telegram error {r.status_code}: {r.text[:300]}",
              file=sys.stderr)
    r.raise_for_status()


def html_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def build_message(report: dict) -> str | None:
    fresh = report.get("fresh_hits", {})
    if not fresh:
        return None

    lines = [
        "\U0001f6e5️ <b>AQUILA-WATCH</b> — новые находки в Турции",
        f"<i>{html_escape(report.get('ts', '?'))}</i>",
        "",
    ]
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

    text = "\n".join(lines)
    if len(text) > MAX_TELEGRAM_LEN:
        text = text[: MAX_TELEGRAM_LEN - 30] + "\n…(сообщение обрезано)"
    return text


def build_heartbeat(report: dict) -> str:
    checked = report.get("checked", 0)
    findings = report.get("all_findings", {})
    errors = report.get("errors", [])
    lines = [
        "\U0001f6e5️ <b>AQUILA-WATCH</b> — heartbeat",
        f"<i>{html_escape(report.get('ts', '?'))}</i>",
        f"проверено источников: {checked}",
        f"уже содержат \"aquila\": {len(findings)}",
        f"ошибки запроса: {len(errors)}",
        "",
        "Новых появлений нет.",
    ]
    return "\n".join(lines)


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
    msg = build_message(report)

    if msg:
        send(token, chat_id, msg)
        print("[notify] sent fresh-hits message")
    elif os.environ.get("ALWAYS_PING") == "1":
        send(token, chat_id, build_heartbeat(report))
        print("[notify] sent heartbeat")
    else:
        print("[notify] no fresh hits, silent")

    return 0


if __name__ == "__main__":
    sys.exit(main())
