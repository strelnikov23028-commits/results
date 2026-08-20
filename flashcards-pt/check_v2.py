#!/usr/bin/env python3
"""
Проверяет новый набор сцен перед генерацией: покрыты ли все слова
и не повторяются ли образы между карточками.
"""
import json, os, re
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
PARTS = ["scenes_v2_nouns.json", "scenes_v2_adj.json",
         "scenes_v2_verbs.json", "scenes_v2_rest.json"]

KEY = re.compile(r"""\b(apple|coin|calendar|clock|watch|hourglass|book|cup|mug|door|key|
    palm|finger|thumb|check|cross|map|pin|sign|road|train|station|suitcase|feather|passport|
    twin|shelf|shop|market|flower|rose|tree|cat|dog|bottle|glass|plate|meal|table|chair|
    phone|letter|mailbox|postbox|umbrella|rain|sun|cloud|candle|cake|box|bag|car|bus|
    bicycle|ball|sneakers|jar|lid|lens|mirror|puzzle|domino|scale|barbell|staircase|
    window|wallet|coins|banknote|price|badge|photograph|notebook|blackboard|paper|
    strawberry|orange|tomato|garbage|scrap|sprout|plant|candle|medal|flag|helmet)\b""",
    re.I | re.X)


def main():
    scenes = {}
    for p in PARTS:
        d = json.load(open(D("data", p), encoding="utf-8"))
        d.pop("_comment", None)
        for k, v in d.items():
            if k in scenes:
                print(f"  ! слово «{k}» описано дважды в разных файлах")
            scenes[k] = v

    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    words = {c["pt"] for c in cards}
    missing = sorted(words - set(scenes))
    extra = sorted(set(scenes) - words)

    print(f"слов в колоде: {len(words)}, сцен написано: {len(scenes)}")
    print(f"без сцены ({len(missing)}): {', '.join(missing) if missing else 'нет'}")
    print(f"лишних ({len(extra)}): {', '.join(extra) if extra else 'нет'}")

    by_obj = defaultdict(list)
    for pt, sc in scenes.items():
        for m in set(w.lower().rstrip("s") for w in KEY.findall(sc)):
            by_obj[m].append(pt)
    print("\nобразы, встречающиеся более чем в двух сценах:")
    worst = [(o, w) for o, w in by_obj.items() if len(w) > 2]
    if not worst:
        print("  таких нет")
    for obj, ws in sorted(worst, key=lambda x: -len(x[1])):
        print(f"  {obj:<12} ×{len(ws)}  {', '.join(ws)}")

    dup = defaultdict(list)
    for pt, sc in scenes.items():
        dup[sc.lower()].append(pt)
    same = {s: w for s, w in dup.items() if len(w) > 1}
    print(f"\nдословных повторов: {len(same)}")
    for s, w in same.items():
        print(f"  {', '.join(w)}: {s[:60]}")


if __name__ == "__main__":
    main()
