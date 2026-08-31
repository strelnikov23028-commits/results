#!/usr/bin/env python3
"""
Убирает карточки из колоды вместе с их сценами и картинками.

    python remove_words.py "isso acontece" "cada"
"""
import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))
PARTS = ["scenes_v2_nouns.json", "scenes_v2_adj.json",
         "scenes_v2_verbs.json", "scenes_v2_rest.json"]


def main():
    words = sys.argv[1:]
    if not words:
        raise SystemExit("укажи слова для удаления")

    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    keep, dropped = [], []
    for c in cards:
        if c["pt"] in words:
            dropped.append(c)
        else:
            keep.append(c)

    for c in dropped:
        png = D("img", f"gen_{c['id']}.png")
        if os.path.exists(png):
            os.remove(png)
        if c.get("image"):
            webp = os.path.join(IMG_OUT, os.path.basename(c["image"]))
            if os.path.exists(webp):
                os.remove(webp)
        print(f"убрано: {c['pt']} ({c['ru']})")

    missing = [w for w in words if w not in {c['pt'] for c in dropped}]
    if missing:
        print("не найдено в колоде:", ", ".join(missing))

    json.dump(keep, open(D("data", "words.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    for f in PARTS:
        p = D("data", f)
        d = json.load(open(p, encoding="utf-8"))
        changed = False
        for w in words:
            if w in d:
                del d[w]; changed = True
        if changed:
            json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"\nбыло {len(cards)}, стало {len(keep)}")


if __name__ == "__main__":
    main()
