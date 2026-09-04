import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
cards = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
want = sys.argv[1:]
for w in want:
    hits = [c for c in cards if c["pt"].lower() == w.lower()]
    if not hits:
        print(f"{w:<14} — в колоде нет")
    for c in hits:
        img = os.path.basename(c["image"]) if c.get("image") else "без картинки"
        print(f"{w:<14} — есть: «{c['pt']}» = {c['ru']}  [{img}]")
