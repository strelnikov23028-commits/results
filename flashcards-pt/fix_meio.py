import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))

# início — «начало». Просят старт, но беговые образы уже разобраны:
#   pronto — бегун в стартовых колодках, começa — флажок на старте гонки,
#   começar — взлёт ракеты. Берём стартовый пистолет: тот же смысл, свой кадр.
EDITS = {
    "scenes_v2_nouns.json": {
        "início": ("a raised starter pistol firing at the beginning of a race, "
                   "small puff of smoke at the muzzle, arm outstretched against the sky"),
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
        png = D("img", f"gen_{c['id']}.png")
        if os.path.exists(png):
            os.remove(png); print("  удалён исходник")
        if c.get("image"):
            webp = os.path.join(IMG_OUT, os.path.basename(c["image"]))
            if os.path.exists(webp):
                os.remove(webp); print("  удалён webp")
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("\nготово")
