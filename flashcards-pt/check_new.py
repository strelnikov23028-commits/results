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

new = ["conseguir","parecido","demais","cartório","entregar","notícias","gerada",
       "barato","caro","ontem","apresentar","juntar","comum","afinidade","calor",
       "coloque","infelizmente","consigo","mano","mana","durante","enviar",
       "assim que der","tratar","preço","preparar"]

dup = []
print("уже есть в колоде:")
for w in new:
    c = have.get(norm(w))
    if c:
        dup.append(w)
        print(f"  {w:<16} → «{c['pt']}» ({c['ru']})")
if not dup:
    print("  нет")
print(f"\nв списке: {len(new)}, новых: {len(new)-len(dup)}, в колоде: {len(cards)}")
