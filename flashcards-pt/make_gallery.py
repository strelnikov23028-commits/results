#!/usr/bin/env python3
"""
Собирает страницу со всеми сгенерированными картинками — чтобы разом
просмотреть и сказать, какие переделать.

Под каждой картинкой: португальское слово, перевод и имя файла.
Открывается двойным кликом: gallery.html рядом с папкой cartoes-img.
"""
import html, json, os, sys, urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
OUT = os.path.abspath(os.path.join(ROOT, "..", "gallery.html"))
IMG_DIR = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))


def main():
    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    have = [c for c in cards if c.get("image") and
            os.path.exists(os.path.join(IMG_DIR, os.path.basename(c["image"])))]
    miss = [c for c in cards if c not in have]

    # --fix: показать только перегенерированные, сохранив их номера из полной галереи
    only_fixed = "--fix" in sys.argv
    numbered = list(enumerate(have, 1))
    if only_fixed:
        fixes = json.load(open(D("data", "scenes_fix.json"), encoding="utf-8"))
        fixes.pop("_comment", None)
        numbered = [(n, c) for n, c in numbered if c["pt"] in fixes]
        miss = []

    items = []
    for i, c in numbered:
        src = "cartoes-img/" + urllib.parse.quote(os.path.basename(c["image"]))
        items.append(f"""<figure>
  <span class="num">{i}</span>
  <img src="{src}" loading="lazy" alt="">
  <figcaption><b>{html.escape(c['pt'])}</b><span>{html.escape(c['ru'])}</span></figcaption>
</figure>""")

    title = (f"Переделанные картинки — {len(items)} шт."
             if only_fixed else f"Картинки к карточкам — {len(have)} из {len(cards)}")
    sub = ("Номера те же, что были в полной галерее. Не устраивает — назови номер, переделаю."
           if only_fixed else
           "Не устраивает картинка — назови номер или слово, перегенерирую."
           + (f" Ещё не готовы: {len(miss)}." if miss else ""))

    doc = f"""<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<title>{title}</title>
<style>
 body{{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#111;color:#eee;margin:0;padding:18px}}
 h1{{font-size:19px;font-weight:600;margin:0 0 4px}}
 p.sub{{color:#999;font-size:13px;margin:0 0 18px}}
 .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}}
 figure{{margin:0;background:#1c1c1e;border-radius:12px;overflow:hidden;position:relative}}
 .num{{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.66);color:#fff;
   font-size:11px;padding:2px 7px;border-radius:20px;z-index:1}}
 img{{width:100%;height:150px;object-fit:contain;background:#000;display:block}}
 figcaption{{padding:8px 10px 11px;line-height:1.3}}
 figcaption b{{display:block;font-size:14px}}
 figcaption span{{display:block;font-size:11.5px;color:#9a9a9e;margin-top:2px}}
</style></head><body>
<h1>{title}</h1>
<p class="sub">{sub}</p>
<div class="grid">
{chr(10).join(items)}
</div></body></html>"""

    open(OUT, "w", encoding="utf-8").write(doc)
    print(f"галерея: {OUT}")
    print(f"картинок в ней: {len(items)}" + ("" if only_fixed else f", ещё нет: {len(miss)}"))


if __name__ == "__main__":
    main()
