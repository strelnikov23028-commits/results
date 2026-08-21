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

new = ["chegou","esse","bairro","quarta-feira","sexta-feira","em breve","divertido",
       "senha","cada","pelo","funciona","a propósito","possível","contato","marcar",
       "treina","canta","né","livre","vez","vencer","balada","escutar","vocês",
       "tosse","se","doença","esquerda","direita","à frente"]

print("уже в колоде:")
dup = []
for w in new:
    c = have.get(norm(w))
    if c:
        dup.append(w)
        print(f"  {w:<16} → есть карточка «{c['pt']}» ({c['ru']})")
print(f"\nновых к добавлению: {len(new)-len(dup)} из {len(new)}")
