"""
Daily-мониторинг чартерных компаний Турции на ключевое слово "Aquila"
(в первую очередь модель Aquila 50 Sail Catamaran).

Алгоритм:
  1. Берём список URL из sources.yaml
  2. Для каждого URL — GET, ищем \\baquila\\b case-insensitive
  3. Сравниваем со state/last_status.json (что нашли в прошлый раз)
  4. Отчёт о НОВЫХ находках кладём в state/last_run.json
     (workflow прочтёт его и отправит в Telegram)
  5. Сохраняем актуальный список находок в state/last_status.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
import yaml

ROOT = Path(__file__).parent
SOURCES_PATH = ROOT / "sources.yaml"
STATE_DIR = ROOT / "state"
STATE_FILE = STATE_DIR / "last_status.json"
RUN_FILE = STATE_DIR / "last_run.json"

KEYWORD_RE = re.compile(r"\baquila\b", re.IGNORECASE)
CONTEXT_CHARS = 100

# Шаблоны контекста, которые НЕ считаются настоящей находкой.
# Это глобальные списки брендов в HTML агрегаторов (SamBoat, 12knots, ...)
# — они есть даже когда в Турции ноль яхт Aquila.
EXCLUDE_CONTEXT_PATTERNS = [
    # SamBoat: вкрапленный JSON фильтра брендов
    # {"id":23334,"name":"Aquila","boats_count":49}
    re.compile(r'"\s*name\s*"\s*:\s*"\s*aquila\s*"\s*,\s*"\s*boats_count', re.IGNORECASE),
    re.compile(r'&quot;name&quot;:&quot;Aquila&quot;,&quot;boats_count', re.IGNORECASE),
    # 12knots / yasido / прочие dropdown'ы вида <option value="aquila">Aquila</option>
    re.compile(r'<option[^>]*value\s*=\s*"[^"]*aquila[^"]*"[^>]*>\s*aquila\s*</option>', re.IGNORECASE),
    # Sailo etc.: бренд в JSON каталога без счётчика яхт
    re.compile(r'"manufacturer"\s*:\s*"aquila"\s*,\s*"count"\s*:\s*0', re.IGNORECASE),
]


def is_excluded(snippet_around_match: str) -> bool:
    """True if this match looks like a global brand-filter dropdown, not real listing."""
    for pat in EXCLUDE_CONTEXT_PATTERNS:
        if pat.search(snippet_around_match):
            return True
    return False

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
}

TIMEOUT = 30


def extract_matches(text: str) -> list[str]:
    """Find all 'aquila' occurrences with surrounding context, dedup by context.

    Skips matches whose surrounding raw HTML matches EXCLUDE_CONTEXT_PATTERNS
    (false positives — brand-filter dropdowns on aggregator sites).
    """
    seen = set()
    out = []
    for m in KEYWORD_RE.finditer(text):
        raw_start = max(0, m.start() - CONTEXT_CHARS)
        raw_end = min(len(text), m.end() + CONTEXT_CHARS)
        raw_ctx = text[raw_start:raw_end]
        if is_excluded(raw_ctx):
            continue
        # Cleaned version for the human-readable snippet
        ctx = re.sub(r"<[^>]+>", " ", raw_ctx)
        ctx = re.sub(r"\s+", " ", ctx).strip()
        key = ctx.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(ctx)
    return out


def fetch(url: str, timeout: int = TIMEOUT) -> tuple[str | None, str | None]:
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
    except requests.RequestException as e:
        return None, f"request_error: {e.__class__.__name__}: {e}"
    if r.status_code >= 400:
        return None, f"http_{r.status_code}"
    return r.text, None


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"findings": {}, "errors": {}}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def write_run_report(report: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    RUN_FILE.write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def main() -> int:
    sources = yaml.safe_load(SOURCES_PATH.read_text(encoding="utf-8"))["sources"]
    old_state = load_state()
    old_findings = old_state.get("findings", {})
    old_errors = old_state.get("errors", {})  # name -> last_error_code

    new_findings: dict[str, dict] = {}
    errors_map: dict[str, dict] = {}  # name -> {url, error}
    checked = 0

    for s in sources:
        name = s["name"]
        url = s["url"]
        timeout = int(s.get("timeout", TIMEOUT))
        checked += 1
        html, err = fetch(url, timeout=timeout)
        if err:
            errors_map[name] = {"url": url, "error": err}
            # Polite delay
            time.sleep(1.0)
            continue

        matches = extract_matches(html or "")
        if matches:
            new_findings[name] = {
                "url": url,
                "host": urlparse(url).netloc,
                "matches": matches[:8],  # cap to keep payload small
                "match_count": len(matches),
            }
        time.sleep(1.0)

    # Determine fresh hits = new findings that were not in previous state
    fresh_hits = {}
    for name, info in new_findings.items():
        old = old_findings.get(name)
        if not old:
            fresh_hits[name] = info
            continue
        old_set = {m.lower() for m in old.get("matches", [])}
        new_set = {m.lower() for m in info["matches"]}
        added = new_set - old_set
        if added:
            fresh_hits[name] = {
                **info,
                "new_match_snippets": [
                    m for m in info["matches"] if m.lower() in added
                ][:5],
            }

    # New errors = sources that error'd now AND either didn't error before
    # or had a different error code. (We don't spam if a flaky source keeps
    # returning the same 503 every day.)
    new_errors: dict[str, dict] = {}
    for name, info in errors_map.items():
        prev = old_errors.get(name)
        if prev != info["error"]:
            new_errors[name] = info

    ts = datetime.now(timezone.utc).isoformat()
    errors_list = [{"name": n, **info} for n, info in errors_map.items()]
    report = {
        "ts": ts,
        "checked": checked,
        "errors": errors_list,
        "new_errors": [{"name": n, **info} for n, info in new_errors.items()],
        "all_findings": new_findings,
        "fresh_hits": fresh_hits,
    }

    save_state({
        "ts": ts,
        "findings": new_findings,
        "errors": {n: info["error"] for n, info in errors_map.items()},
    })
    write_run_report(report)

    # Stdout summary (for CI logs)
    print(f"[{ts}] checked={checked} sources_with_aquila={len(new_findings)} "
          f"fresh_hits={len(fresh_hits)} errors={len(errors_list)} "
          f"new_errors={len(new_errors)}")
    for name, info in new_findings.items():
        flag = "NEW" if name in fresh_hits else "seen"
        print(f"  [{flag}] {name} ({info['match_count']} match) -> {info['url']}")
    for name, info in errors_map.items():
        flag = "NEW" if name in new_errors else "stale"
        print(f"  [err-{flag}] {name}: {info['error']}")

    # Exit code 0 always — GH Actions step checks fresh_hits separately
    return 0


if __name__ == "__main__":
    sys.exit(main())
