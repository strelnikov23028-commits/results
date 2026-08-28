#!/usr/bin/env python3
"""
Добавляет в колоду слова из data/extra_words4.json и переносит их сцены
в общий набор scenes_v2_*, чтобы дальше всё жило по одним правилам.
"""
import json, os, re, unicodedata

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
SRC = "extra_words4.json"

POS_FILE = {"nouns": "scenes_v2_nouns.json", "adjectives": "scenes_v2_adj.json",
            "verbs": "scenes_v2_verbs.json", "adverbs": "scenes_v2_rest.json",
            "function words": "scenes_v2_rest.json", "phrases": "scenes_v2_rest.json"}


def norm(s):
    s = s.lower().strip()
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z ]", "", s).strip()


def main():
    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    new = json.load(open(D("data", SRC), encoding="utf-8"))
    have = {norm(c["pt"]) for c in cards}
    nid = max(c["id"] for c in cards)

    scenes = {f: json.load(open(D("data", f), encoding="utf-8")) for f in set(POS_FILE.values())}
    added = 0
    for w in new:
        if norm(w["pt"]) in have:
            print(f"  пропуск, уже есть: {w['pt']}"); continue
        nid += 1
        card = {"id": nid, "pt": w["pt"], "en": w["en"], "ru": w["ru"], "pos": w["pos"],
                "examples": [], "imgQuery": w["imgQuery"], "image": None,
                "credit": None, "sources": ["extra4"]}
        for opt in ("note", "fix"):
            if w.get(opt):
                card[opt] = w[opt]
        cards.append(card)
        scenes[POS_FILE[w["pos"]]][w["pt"]] = w["imgQuery"]
        have.add(norm(w["pt"]))
        added += 1

    json.dump(cards, open(D("data", "words.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    for f, d in scenes.items():
        json.dump(d, open(D("data", f), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"\nдобавлено карточек: {added}, всего в колоде: {len(cards)}")
    print(f"с исправленным написанием: {sum(1 for w in new if w.get('fix'))}")


if __name__ == "__main__":
    main()
