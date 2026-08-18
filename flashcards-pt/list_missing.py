import json
cards = json.load(open("data/words.json", encoding="utf-8"))
no_hint = [c for c in cards if not c.get("imgQuery")]
print(f"всего карточек: {len(cards)}")
print(f"есть ориентир (imgQuery): {len(cards)-len(no_hint)}")
print(f"нужно придумать сцену:    {len(no_hint)}\n")
for c in no_hint:
    mark = "СИМВОЛ" if c.get("icon") else "текст "
    print(f"{mark} | {c['pt']:<26} | {c['ru'][:44]:<46} | {c['en'][:28]}")
