#!/usr/bin/env python3
"""
Собирает единую колоду из двух источников:
  • 100 слов с speakingbrazilian.com  → data/words_site.json
  • личный список из файла Ярослава    → data/personal_parsed.json + personal_overlay.json

Слова, встречающиеся в обоих списках, склеиваются в одну карточку
с пометкой обоих источников. Результат — data/words.json.
"""
import json, os, re, unicodedata

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, "data", *p)


def norm(s):
    s = s.lower().strip()
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z ]", "", s).strip()


def main():
    site = json.load(open(D("words_site.json"), encoding="utf-8"))
    parsed = json.load(open(D("personal_parsed.json"), encoding="utf-8"))["words"]
    ov = json.load(open(D("personal_overlay.json"), encoding="utf-8"))
    ov.pop("_comment", None)

    cards, seen = [], {}
    for c in site:
        c = dict(c)
        c["sources"] = ["site"]
        cards.append(c)
        seen[norm(c["pt"].split("/")[0].replace("(a)", ""))] = c

    nid = max(c["id"] for c in cards)
    added = fixes = 0
    for p in parsed:
        key = norm(p["pt"])
        if key in seen:                       # уже есть из списка с сайта
            if "personal" not in seen[key]["sources"]:
                seen[key]["sources"].append("personal")
            continue
        o = ov.get(p["pt"])
        if not o:
            continue
        k2 = norm(o["pt"])
        if k2 in seen:                        # совпало после исправления написания
            if "personal" not in seen[k2]["sources"]:
                seen[k2]["sources"].append("personal")
            continue
        nid += 1
        card = {
            "id": nid, "pt": o["pt"], "en": o["en"], "ru": o["ru"], "pos": o["pos"],
            "examples": [], "imgQuery": o.get("img"), "image": None, "credit": None,
            "sources": ["personal"],
        }
        if o.get("note"):
            card["note"] = o["note"]
        if o.get("fix"):
            card["fix"] = o["fix"]; fixes += 1
        cards.append(card)
        seen[k2] = card
        added += 1

    json.dump(cards, open(D("words.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    both = sum(1 for c in cards if len(c["sources"]) > 1)
    withimg = sum(1 for c in cards if c["imgQuery"])
    print(f"Всего карточек: {len(cards)}")
    print(f"  с сайта:            {sum(1 for c in cards if 'site' in c['sources'])}")
    print(f"  из личного списка:  {sum(1 for c in cards if 'personal' in c['sources'])}")
    print(f"  в обоих списках:    {both}")
    print(f"  добавлено новых:    {added}")
    print(f"  с исправленным написанием: {fixes}")
    print(f"  предполагают картинку:     {withimg}")
    print(f"  без картинки (по смыслу):  {len(cards) - withimg}")


if __name__ == "__main__":
    main()
