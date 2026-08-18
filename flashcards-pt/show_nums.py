import json, os, sys

nums = [int(a) for a in sys.argv[1:]] or [3,6,19,26,27,32,41,42,47,56,81,95,101,140,147,163,266]
cards = json.load(open("data/words.json", encoding="utf-8"))
IMG = os.path.abspath(os.path.join("..", "cartoes-img"))
have = [c for c in cards if c.get("image") and
        os.path.exists(os.path.join(IMG, os.path.basename(c["image"])))]

jobs = {}
for f in sorted(os.listdir("jobs")):
    if f.endswith(".json"):
        for j in json.load(open(os.path.join("jobs", f), encoding="utf-8")):
            jobs[j["id"]] = j

for n in nums:
    if n < 1 or n > len(have):
        print(f"{n}: нет такого номера (всего {len(have)})"); continue
    c = have[n - 1]
    print(f"{n:>4}. id={c['id']:<4} {c['pt']:<24} | {c['ru'][:40]}")
    print(f"      было: {jobs[c['id']]['scene'][:92]}")
