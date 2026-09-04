import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
cards = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
have = {c["pt"]: c for c in cards}

new = ["criança","imprensa","escuro","claro","transparente","limpar","chance",
       "imediatamente","perder","morder","ontem","aluguel diário","ótimo","enquanto",
       "traga","decisão","boneca","andar","andar de bicicleta","entrevista","matéria",
       "jornalista","posso...?","saber","conhecer","revista","arquitetura","lado","comum",
       "segundo","colaboração","um segundo","som","igual","inserir","elevado","criado",
       "prédio","significativo","sinceramente","honestamente","importante","essencial",
       "verbo","irregular","misturando","lado de fora","lado de dentro","lado de cima",
       "lado de baixo","acima de","abaixo de","vendido","promoção"]

dup = [w for w in new if w in have]
print("уже есть в колоде:")
for w in dup:
    print(f"  {w:<20} → {have[w]['ru']}")
print(f"\nв списке: {len(new)}, новых: {len(new)-len(dup)}, в колоде: {len(cards)}")
