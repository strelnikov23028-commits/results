import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))

# julho добавлялся раньше остальных месяцев и получил подсолнухи, тогда как
# все одиннадцать других месяцев — страницы календаря с названием. Приводим
# к общему виду: месяцы должны различаться только надписью, как дни недели.
EDITS = {
    "scenes_v2_nouns.json": {
        "julho": "a wall calendar page for the month with JULHO printed at the top",
    },
}

cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
by_pt = {c["pt"]: c for c in cards}

for fname, changes in EDITS.items():
    p = D("data", fname)
    d = json.load(open(p, encoding="utf-8"))
    for word, scene in changes.items():
        print(f"{word}:\n  было:  {d.get(word)}\n  стало: {scene}")
        d[word] = scene
        c = by_pt.get(word)
        if not c:
            print("  ! слова нет в колоде"); continue
        c["imgQuery"] = scene
        png = D("img", f"gen_{c['id']}.png")
        if os.path.exists(png):
            os.remove(png); print("  удалён исходник")
        if c.get("image"):
            webp = os.path.join(IMG_OUT, os.path.basename(c["image"]))
            if os.path.exists(webp):
                os.remove(webp); print("  удалён webp")
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

json.dump(cards, open(D("data", "words.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("\nготово")
