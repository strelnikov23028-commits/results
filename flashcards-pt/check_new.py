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

new = ["mensagem","avião","defeito","esquerda","exato","janela","porta","cadeira","teto",
       "esqueci","principal","assustador","estranho","em algum lugar","aguarde","vazio",
       "imediatamente","mesa","chuva","nuvens","nublado","gentileza","ideia","beleza",
       "joia","tá top","bacana","de boa","tô","suave","firmeza","na paz","tirei","cheio",
       "invasão","prática","verificar","peça","gordo","atravessa","estrada","país",
       "percebido","em vez disso","pão","pau","queijo","tamanho","anotar","queda","conseguir"]

dup = []
print("уже есть в колоде:")
for w in new:
    c = have.get(norm(w))
    if c:
        dup.append(w)
        print(f"  {w:<18} → «{c['pt']}» ({c['ru']})")
print(f"\nв списке: {len(new)}, новых: {len(new)-len(dup)}, в колоде: {len(cards)}")
