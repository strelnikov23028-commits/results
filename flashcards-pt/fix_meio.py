import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))

# Новые слова попали в уже перегруженные образы: двери (11 сцен), монеты (5),
# полки (5). Разводим до генерации, чтобы карточки не сливались.
EDITS = {
    "scenes_v2_verbs.json": {
        # дверь занята десятком слов — оставляем только передачу из рук в руки
        "entregar": ("a parcel passing from the courier's hands into the recipient's "
                     "hands, close-up on the handover"),
        # полка занята; «положи» показываем через цветок в вазе
        "coloque": "a hand placing a cut flower into a vase of water",
        # монеты уже у пяти слов — берём слияние двух потоков в один
        "juntar": "two small streams merging together into a single river",
        # ящик на полку повторял poder; несём тяжесть в гору
        "consigo": ("a hiker carrying a heavy backpack up a steep slope, managing it "
                    "under their own strength"),
    },
    "scenes_v2_rest.json": {
        # закрытая дверь магазина сливалась с loja, fica и nunca
        "infelizmente": ("a defeated footballer sitting on the pitch holding his head "
                         "after losing the match"),
        # ещё одна дверная ручка была бы двенадцатой дверью в колоде
        "assim que der": ("a finger poised right above a button, ready to press it the "
                          "moment it becomes possible"),
    },
}

cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
by_pt = {c["pt"]: c for c in cards}

for fname, changes in EDITS.items():
    p = D("data", fname)
    d = json.load(open(p, encoding="utf-8"))
    for word, scene in changes.items():
        print(f"{word:<14} → {scene[:66]}")
        d[word] = scene
        c = by_pt.get(word)
        if not c:
            print("  ! слова нет в колоде"); continue
        c["imgQuery"] = scene
        png = D("img", f"gen_{c['id']}.png")
        if os.path.exists(png):
            os.remove(png)
        if c.get("image"):
            webp = os.path.join(IMG_OUT, os.path.basename(c["image"]))
            if os.path.exists(webp):
                os.remove(webp)
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

json.dump(cards, open(D("data", "words.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("\nготово")
