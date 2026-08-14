#!/usr/bin/env python3
"""
Подбирает картинку к каждой карточке из data/words.json.

Источники (по приоритету):
  1. Pexels    — если задан PEXELS_API_KEY. Лимит 200 запросов/час, 20 000/мес, бесплатно.
                 https://www.pexels.com/api/  (ключ выдают сразу после регистрации)
  2. Wikimedia Commons — без ключа, безлимитно. Качество ниже, но работает всегда.

Карточки с imgQuery = null (служебные слова) намеренно остаются без фото —
в приложении у них показывается пример фразы вместо картинки.

Запуск:
    python3 fetch_images.py                 # только пустые (докачать)
    python3 fetch_images.py --force         # перекачать все
    PEXELS_API_KEY=xxx python3 fetch_images.py --force
"""
import json, os, ssl, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
WORDS = os.path.join(ROOT, "data", "words.json")
UA = "flashcards-pt/1.0 (personal language-learning deck; contact: local user)"
PEXELS_KEY = os.environ.get("PEXELS_API_KEY", "").strip()

# На macOS системные сертификаты Python по умолчанию не подключены → берём из certifi
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()


def get(url, headers=None, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return json.load(r)


def from_pexels(query):
    url = "https://api.pexels.com/v1/search?" + urllib.parse.urlencode(
        {"query": query, "per_page": 1, "orientation": "landscape"})
    data = get(url, {"Authorization": PEXELS_KEY})
    for p in data.get("photos", []):
        return {"image": p["src"]["large"],
                "credit": {"author": p.get("photographer", ""),
                           "url": p.get("url", ""),
                           "source": "Pexels", "license": "Pexels License"}}
    return None


def from_commons(query):
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({
        "action": "query", "generator": "search", "gsrsearch": f"filetype:bitmap {query}",
        "gsrlimit": 6, "gsrnamespace": 6, "prop": "imageinfo",
        "iiprop": "url|extmetadata", "iiurlwidth": 900, "format": "json"})
    pages = get(url).get("query", {}).get("pages", {})
    # generator=search не гарантирует порядок в dict — сортируем по релевантности (index)
    for page in sorted(pages.values(), key=lambda p: p.get("index", 99)):
        info = (page.get("imageinfo") or [{}])[0]
        thumb = info.get("thumburl")
        if not thumb:
            continue
        meta = info.get("extmetadata", {})
        return {"image": thumb.split("?")[0],
                "credit": {"author": strip_html(meta.get("Artist", {}).get("value", "")),
                           "url": info.get("descriptionurl", ""),
                           "source": "Wikimedia Commons",
                           "license": meta.get("LicenseShortName", {}).get("value", "")}}
    return None


def strip_html(s):
    import re
    return re.sub(r"<[^>]+>", "", s or "").strip()[:80]


def main():
    force = "--force" in sys.argv
    cards = json.load(open(WORDS, encoding="utf-8"))
    todo = [c for c in cards if c["imgQuery"] and (force or not c["image"])]
    if not todo:
        print("Нечего качать — все карточки с фото уже заполнены.")
        return

    src_name = "Pexels" if PEXELS_KEY else "Wikimedia Commons"
    print(f"Источник: {src_name}. К обработке: {len(todo)} карточек.\n")

    ok = fail = 0
    for i, c in enumerate(todo, 1):
        res = None
        try:
            res = from_pexels(c["imgQuery"]) if PEXELS_KEY else None
        except Exception as e:
            print(f"  ! Pexels упал на «{c['pt']}»: {e}")
        if not res:
            try:
                res = from_commons(c["imgQuery"])
            except Exception as e:
                print(f"  ! Commons упал на «{c['pt']}»: {e}")
        if res:
            c.update(res); ok += 1
            tag = res["credit"]["source"][:4]
            print(f"  [{i:>3}/{len(todo)}] {c['pt']:<14} ← {tag}  {res['image'][:78]}")
        else:
            fail += 1
            print(f"  [{i:>3}/{len(todo)}] {c['pt']:<14} ← НЕ НАЙДЕНО ({c['imgQuery']})")
        json.dump(cards, open(WORDS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        time.sleep(0.35 if PEXELS_KEY else 0.6)   # вежливо к API

    print(f"\nГотово: {ok} найдено, {fail} без картинки.")
    empty = [c["pt"] for c in cards if c["imgQuery"] and not c["image"]]
    if empty:
        print("Без фото остались:", ", ".join(empty))


if __name__ == "__main__":
    main()
