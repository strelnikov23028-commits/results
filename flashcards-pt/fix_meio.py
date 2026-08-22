import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))

# cada — «каждый»: почтовые ящики повторяли a cada (бутылки на полке).
#   Показываем не просто одинаковый ряд, а «в каждой ячейке по одному».
# possível — «возможный»: зелёный светофор читался как «можно идти»
#   и тянул к verde. Ключ, входящий в замок, — это именно «получается».
# já — «уже»: пустая тарелка сливалась с nada и vazio. Задутая свеча
#   ещё и рифмуется по контрасту с ainda, где свеча пока горит.
EDITS = {
    "scenes_v2_rest.json": {
        "cada": ("a baking tray of identical muffin cups with exactly one muffin "
                 "sitting in every single cup"),
        "já": ("a just blown out candle with a thin curl of smoke rising from the "
               "extinguished wick"),
    },
    "scenes_v2_adj.json": {
        "possível": ("a key inserted into a lock and turning, the mechanism giving way"),
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
