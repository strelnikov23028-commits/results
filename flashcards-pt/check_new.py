import json, os, re, unicodedata

ROOT = os.path.dirname(os.path.abspath(__file__))
cards = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))

def norm(s):
    s = s.lower().strip()
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z ]", "", s).strip()

have = {}
for c in cards:
    have[norm(c["pt"])] = c
    for part in re.split(r"[/,]", c["pt"]):
        p = norm(part.replace("(a)", ""))
        if p:
            have.setdefault(p, c)

new = ["blindado","atropela","lembrar-se","lembro","resolvido","conhecer","há","já",
       "quatrocentos","hino","assistir","assustar","ainda não","semelhante","álcool",
       "energético","ao","foi","céu","ar","voar","além disso","mililitros","vazio","sempre"]

dup = []
print("пересечения с колодой:")
for w in new:
    c = have.get(norm(w))
    if c:
        dup.append(w)
        print(f"  {w:<14} → уже есть «{c['pt']}» ({c['ru']})")
if not dup:
    print("  нет")
print(f"\nвсего в списке: {len(new)}, новых: {len(new)-len(dup)}")
print(f"в колоде сейчас: {len(cards)}")
