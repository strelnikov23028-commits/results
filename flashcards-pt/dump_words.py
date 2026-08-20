import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
cards = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
group = sys.argv[1] if len(sys.argv) > 1 else None
for c in cards:
    if group and c["pos"] != group:
        continue
    print(f'{c["id"]:>3} {c["pt"]:<26} {c["ru"][:46]:<48} [{c["en"][:30]}]')
print(f"— всего: {sum(1 for c in cards if not group or c['pos']==group)}")
