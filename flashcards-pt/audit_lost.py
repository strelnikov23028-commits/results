#!/usr/bin/env python3
"""
Ищет слова, которые заявлялись в списках extra_words*.json, но в колоду
не попали. Такое случается, когда проверка дублей сравнивает написание
без диакритики: país (страна) выглядит как pais (родители), хотя это
разные слова.
"""
import glob, json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
cards = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
have = {c["pt"] for c in cards}          # сравниваем точно, вместе с диакритикой

lost = []
for path in sorted(glob.glob(os.path.join(ROOT, "data", "extra_words*.json"))):
    for w in json.load(open(path, encoding="utf-8")):
        if w["pt"] not in have:
            lost.append((os.path.basename(path), w["pt"], w["ru"]))

print(f"карточек в колоде: {len(cards)}")
print(f"заявлено, но отсутствует: {len(lost)}\n")
for src, pt, ru in lost:
    print(f"  {pt:<22} {ru[:40]:<42} ({src})")
