#!/usr/bin/env python3
"""
Подбирает картинку к каждой карточке из data/words.json.

Источники по приоритету:
  1. Openverse — ищет по смыслу (индексирует Flickr и др.), ключ скрипт получает
     САМ при первом запуске и кладёт в data/openverse_creds.json. Ничего вводить не нужно.
  2. Pexels — если задан PEXELS_API_KEY (200 запросов/час, 20 000/мес).
  3. Wikimedia Commons — без ключа, как последний резерв. Качество заметно хуже:
     это архив, а не фотобанк, поиск «улица» может вернуть интерьер собора.

Карточки с imgQuery = null (предлоги, союзы, артикли) намеренно остаются без фото.

Запуск:
    python3 fetch_images.py            # только те, где картинки ещё нет
    python3 fetch_images.py --force    # перекачать все заново
"""
import json, os, re, ssl, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
WORDS = os.path.join(ROOT, "data", "words.json")
CREDS = os.path.join(ROOT, "data", "openverse_creds.json")
UA = "cartoes-pt/1.0 (personal language-learning flashcards)"
PEXELS_KEY = os.environ.get("PEXELS_API_KEY", "").strip()

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

# Фотоархивы содержат в том числе медицинский и анатомический материал:
# запрос "young adult person" однажды вернул клиническое фото соска.
BAD = re.compile(r"""(nipple|areola|breast|mammar|nude|naked|topless|underwear|lingerie|bikini
    |genital|penis|vagina|vulva|anus|pubic|erotic|porn|sexual|fetish
    |anatom|autops|cadaver|corpse|morgue|wound|injur|surger|disease|infect|lesion
    |tumor|cancer|rash|ulcer|blood|gore|weapon|gun|knife)""", re.I | re.X)


def req(url, headers=None, data=None, timeout=30):
    body = urllib.parse.urlencode(data).encode() if data else None
    r = urllib.request.Request(url, data=body, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(r, timeout=timeout, context=SSL_CTX) as resp:
        return json.load(resp)


def strip_html(s):
    return re.sub(r"<[^>]+>", " ", s or "").strip()


# ─────────────────────────── Openverse ───────────────────────────
def openverse_token():
    """Берёт сохранённый ключ, а если его нет — регистрирует приложение сам."""
    creds = {}
    if os.path.exists(CREDS):
        creds = json.load(open(CREDS, encoding="utf-8"))
    if not creds.get("client_id"):
        print("  Регистрирую приложение в Openverse…")
        creds = _register()
        json.dump(creds, open(CREDS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    tok = req("https://api.openverse.org/v1/auth_tokens/token/",
              data={"client_id": creds["client_id"], "client_secret": creds["client_secret"],
                    "grant_type": "client_credentials"})
    return tok["access_token"]


def _register():
    payload = json.dumps({
        "name": f"cartoes-pt-{int(time.time())}",
        "description": "Personal language-learning flashcard deck, non-commercial use",
        "email": "claudeNimchenko@proton.me"}).encode()
    r = urllib.request.Request("https://api.openverse.org/v1/auth_tokens/register/",
                               data=payload,
                               headers={"User-Agent": UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=30, context=SSL_CTX) as resp:
        return json.load(resp)


def from_openverse(query, token):
    url = "https://api.openverse.org/v1/images/?" + urllib.parse.urlencode({
        "q": query, "page_size": 12, "mature": "false",
        "license_type": "all", "aspect_ratio": "wide"})
    data = req(url, {"Authorization": f"Bearer {token}"})
    res = data.get("results") or []
    if not res:   # для редких запросов «широких» может не быть — пробуем без ограничения
        url = "https://api.openverse.org/v1/images/?" + urllib.parse.urlencode({
            "q": query, "page_size": 12, "mature": "false", "license_type": "all"})
        res = (req(url, {"Authorization": f"Bearer {token}"}).get("results") or [])
    # Openverse отдаёт результаты не по релевантности к смыслу, поэтому ранжируем
    # сами: чем больше слов запроса встретилось в заголовке и тегах, тем лучше.
    terms = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 2]
    scored = []
    for p in res:
        title = p.get("title") or ""
        tags = " ".join(t.get("name", "") for t in (p.get("tags") or []))
        text = f"{title} {tags}"
        if BAD.search(text):
            print(f"      ↷ пропущен небезопасный: {title[:55]}")
            continue
        if not p.get("url"):
            continue
        low = text.lower()
        hits = sum(1 for t in terms if t in low)
        # первое слово запроса — ключевое, за него отдельный вес
        if terms and terms[0] in (title or "").lower():
            hits += 2
        scored.append((hits, p))
    if not scored:
        return None
    scored.sort(key=lambda s: -s[0])
    best, p = scored[0]
    if best == 0:                      # ни одного попадания — считаем, что не нашли
        return None
    return {"image": p["url"],
            "credit": {"author": (p.get("creator") or "")[:80],
                       "url": p.get("foreign_landing_url") or "",
                       "source": "Openverse / " + (p.get("provider") or "").title(),
                       "title": (p.get("title") or "")[:90],
                       "license": f"CC {(p.get('license') or '').upper()} {p.get('license_version') or ''}".strip()}}


# ─────────────────────────── Pexels ───────────────────────────
def from_pexels(query):
    url = "https://api.pexels.com/v1/search?" + urllib.parse.urlencode(
        {"query": query, "per_page": 5, "orientation": "landscape"})
    for p in req(url, {"Authorization": PEXELS_KEY}).get("photos", []):
        if BAD.search(p.get("alt") or ""):
            continue
        return {"image": p["src"]["large"],
                "credit": {"author": p.get("photographer", ""), "url": p.get("url", ""),
                           "source": "Pexels", "license": "Pexels License"}}
    return None


# ─────────────────────── Wikimedia Commons ───────────────────────
def from_commons(query):
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({
        "action": "query", "generator": "search", "gsrsearch": f"filetype:bitmap {query}",
        "gsrlimit": 12, "gsrnamespace": 6, "prop": "imageinfo",
        "iiprop": "url|size|extmetadata", "iiurlwidth": 1000, "format": "json"})
    pages = req(url).get("query", {}).get("pages", {})
    cands = []
    for page in sorted(pages.values(), key=lambda p: p.get("index", 99)):
        info = (page.get("imageinfo") or [{}])[0]
        if not info.get("thumburl"):
            continue
        meta = info.get("extmetadata", {})
        text = " ".join([urllib.parse.unquote(page.get("title", "")),
                         strip_html(meta.get("ImageDescription", {}).get("value", ""))[:300],
                         strip_html(meta.get("Categories", {}).get("value", ""))[:300]])
        if BAD.search(text):
            print(f"      ↷ пропущен небезопасный: {page.get('title','')[:55]}")
            continue
        w, h = info.get("width") or 1, info.get("height") or 1
        cands.append((0 if w / h >= 1.2 else 1, info, meta))
    if not cands:
        return None
    cands.sort(key=lambda c: c[0])
    _, info, meta = cands[0]
    return {"image": info["thumburl"].split("?")[0],
            "credit": {"author": strip_html(meta.get("Artist", {}).get("value", ""))[:80],
                       "url": info.get("descriptionurl", ""),
                       "source": "Wikimedia Commons",
                       "license": meta.get("LicenseShortName", {}).get("value", "")}}


def main():
    force = "--force" in sys.argv
    cards = json.load(open(WORDS, encoding="utf-8"))
    todo = [c for c in cards if c["imgQuery"] and (force or not c["image"])]
    if not todo:
        print("Нечего качать — у всех карточек с картинками фото уже есть.")
        return

    token = None
    try:
        token = openverse_token()
        print("Openverse: ключ получен.")
    except Exception as e:
        print(f"Openverse недоступен ({e}) — работаем на резервных источниках.")

    print(f"К обработке: {len(todo)} карточек.\n")
    ok = fail = 0
    for i, c in enumerate(todo, 1):
        res = None
        for name, fn in (("Openverse", lambda: from_openverse(c["imgQuery"], token) if token else None),
                         ("Pexels",    lambda: from_pexels(c["imgQuery"]) if PEXELS_KEY else None),
                         ("Commons",   lambda: from_commons(c["imgQuery"]))):
            try:
                res = fn()
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    print(f"      ! {name}: превышен лимит, жду 60 с")
                    time.sleep(60)
                    try:
                        res = fn()
                    except Exception:
                        res = None
                else:
                    print(f"      ! {name} ответил {e.code}")
            except Exception as e:
                print(f"      ! {name}: {e}")
            if res:
                break
        if res:
            c.update(res); ok += 1
            print(f"  [{i:>3}/{len(todo)}] {c['pt']:<13} ← {res['credit']['source'][:22]:<22} {res['image'][:60]}")
        else:
            fail += 1
            print(f"  [{i:>3}/{len(todo)}] {c['pt']:<13} ← НЕ НАЙДЕНО ({c['imgQuery']})")
        json.dump(cards, open(WORDS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        time.sleep(0.3)

    print(f"\nГотово: {ok} найдено, {fail} без картинки.")
    empty = [c["pt"] for c in cards if c["imgQuery"] and not c["image"]]
    if empty:
        print("Без фото остались:", ", ".join(empty))


if __name__ == "__main__":
    main()
