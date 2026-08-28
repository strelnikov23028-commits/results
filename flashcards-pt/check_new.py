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

new = ["conheça","espere","alguém","resultado","mais uma vez","preocupação","curto",
       "mosca","lixo","pintar","irmão","irmã","saque","saúde","palavra","preciso",
       "arroz","sopa","outono","tubos","segunda-feira","terça-feira","quinta-feira",
       "explosão","será que","cobrir","cabeça","barriga","dor","frase","terra","escada",
       "finalmente","praia","visto","tirar","julho","cor","qual","passaporte",
       "qual é, parceiro?","que tá pegando?","cinza","cabelos","desde","relógio",
       "pra quê","suporte","notebook","cabo","conectar","cartão","vagabundo","vagabunda",
       "microfone","escolher","tradução","pensar","fosse","remoto","manhã","chuvosa",
       "sol","fui","aeromoça","empresário","faxineiro","funcionar","quarto","sala"]

dup = []
print("уже есть в колоде:")
for w in new:
    c = have.get(norm(w))
    if c:
        dup.append(w)
        print(f"  {w:<18} → «{c['pt']}» ({c['ru']})")
if not dup:
    print("  нет")
print(f"\nв списке: {len(new)}, новых: {len(new)-len(dup)}, в колоде сейчас: {len(cards)}")
