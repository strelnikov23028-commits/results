#!/usr/bin/env python3
"""
Ищет повторы среди сцен: какие предметы кочуют из карточки в карточку.

Картинки должны быть все разные, иначе при повторении одного и того же
яблока или календаря слова перестают различаться зрительно.
"""
import json, os, re
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)

# что считаем «предметом» сцены
KEY = re.compile(r"""\b(apple|coin|calendar|clock|hourglass|book|cup|mug|door|key|hand|hands|
    finger|thumbs?|check|cross|map|pin|sign|road|train|station|suitcase|feather|passport|
    twins?|shelf|shop|market|flower|tree|cat|dog|bottle|glass|plate|food|meal|table|chair|
    phone|letter|mailbox|postbox|umbrella|rain|sun|cloud|candle|cake|box|boxes|bag|car|
    bicycle|ball|shoes|sneakers|jar|lid|magnifying|mirror|puzzle|domino|scale|weights?|
    barbell|stairs|staircase|window|wallet|banknote|money|price|tag|badge|photo|photograph|
    notebook|pencil|pen|paper|newspaper|garbage|landfill|sprout|seedling|plant|leaf|leaves)\b""",
    re.I | re.X)


def main():
    scenes = {}
    for f in sorted(os.listdir(D("jobs"))):
        if f.startswith("batch_") and f.endswith(".json"):
            for j in json.load(open(D("jobs", f), encoding="utf-8")):
                scenes[j["pt"]] = j["scene"]
    fix = json.load(open(D("data", "scenes_fix.json"), encoding="utf-8"))
    fix.pop("_comment", None)
    scenes.update(fix)

    by_obj = defaultdict(list)
    for pt, sc in scenes.items():
        for m in set(w.lower().rstrip("s") for w in KEY.findall(sc)):
            by_obj[m].append(pt)

    print(f"всего сцен: {len(scenes)}\n")
    print("предметы, встречающиеся в трёх и более сценах:")
    for obj, words in sorted(by_obj.items(), key=lambda x: -len(x[1])):
        if len(words) >= 3:
            print(f"  {obj:<12} ×{len(words):<3} {', '.join(words[:11])}"
                  + (" …" if len(words) > 11 else ""))

    # полностью одинаковых формулировок быть не должно
    dupes = [(s, n) for s, n in Counter(scenes.values()).items() if n > 1]
    print(f"\nдословных повторов сцены: {len(dupes)}")
    for s, n in dupes:
        print(f"  ×{n}: {s[:70]}")


if __name__ == "__main__":
    main()
