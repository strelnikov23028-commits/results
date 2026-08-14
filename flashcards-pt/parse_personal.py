#!/usr/bin/env python3
"""
Разбирает личный список слов (~/Downloads/Слова португальский.txt).

Формат в файле неровный, поэтому парсер терпимый:
  • разделители «-», «=», «—» вперемешку;
  • markdown-строки вида «- **Cardápio** — Menu (пояснение)»;
  • выделение ударной буквы двойными равно: «ap==e==nas», «almo==c==ar»;
  • стороны местами меняются: «Comprar - buy», но «Save - salvar» и «Сидеть - Sentar-se»;
  • перевод то английский, то русский, иногда отсутствует.

Результат: data/personal_parsed.json — список {pt, gloss, gloss_lang, note, raw}.
Строки, где сторону определить не удалось, попадают в secция "unclear" для ручной правки.
"""
import json, os, re, unicodedata

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.expanduser("~/Downloads/Слова португальский.txt")
OUT = os.path.join(ROOT, "data", "personal_parsed.json")

PT_DIACRITICS = set("ãõáéíóúâêôàç")
# характерные окончания и служебные слова португальского
PT_HINTS = re.compile(r"(ção$|ções$|mente$|dade$|agem$|inho$|inha$|[aeiou]r$|ar$|er$|ir$)", re.I)
PT_KNOWN = {
    "bem","bom","boa","ter","aqui","russo","rapido","homem","mulher","moro","frutas","bonita",
    "cidade","namorada","nasci","agora","ano","anos","mas","com","con","melhor","pior","lá","la",
    "hoje","casa","pai","claro","talvez","apenas","tchau","tranquilo","tudo","todo","mundo","quase",
    "fica","ficar","medio","pequeno","fazer","proprio","negócio","então","idade","fêmea","estava",
    "depois","somente","estudar","atras","início","quando","alguns","tempo","fácil","mais","desafio",
    "impostos","mesmo","vai","frequentemente","infância","quadra","bola","raquete","jogador",
    "professor","ainda","cada","aberta","coberta","copo","espero","contar","perto","tomar","beber",
    "comer","conversa","por","desenvolvimento","focar","vir","quanto","festa","desde","como","porque",
    "embora","haver","nada","jantar","fim","especialmente","area","clima","atmosfera","insegurança",
    "seguro","arma","drogas","repetir","sobrenome","soletrar","aula","nascimento","reserva","brancos",
    "oi","transito","sentar","levante","salvar","faça","conta","espaço","sentir","confortavel",
    "comprar","assim","ligo","mandar","mando","amo","alugar","alugado","aluguei","rio","calma",
    "extra","sobremesa","cabana","complicado","vida","estilo","poder","subir","pais","peru","cultura",
    "sei","acho","chá","cha","pedra","meio","começar","deitar","mentir","mentira","quente","frio",
    "pia","saboroso","ali","filme","experiência","ator","existe","tal","algumas","poucos","metade",
    "meu","garçon","garson","separar","virá","cardápio","normalmente","pronto","férias","peixe",
    "pescar","tentar","provar","profundo","cliente","cozinhar","acontece","carregador","precisar",
    "terminar","bolsa","sacola","saco","pegar","anzol","gancho","vermelho","verde","amarelo","loja",
    "maneiro","comida","gosto","ativo","trabalho","empresa","chama","garrafa","garafa","braço",
    "onde","papel","riso","roer","unhas","retortar","voltei","voltar","deixa","nome","lembro",
    "disculpe","desculpe","vezes","grande","almoçar","também","nau","não","gostar","poucos",
}
EN_KNOWN = {
    "too","cool","food","no","active","company","called","paper","well","good","have","here","fast",
    "return","laugh","bite","man","woman","live","fruits","beautiful","city","girlfriend","cup","born",
    "year","years","but","with","better","worse","there","back","today","let","home","papa","name",
    "remember","course","sorry","think","maybe","just","sometimes","calm","everything","all","world",
    "almost","from","big","medium","small","do","own","business","so","age","was","before","after",
    "only","study","ago","start","when","few","time","easy","bigger","challenge","taxes","same","than",
    "go","often","childhood","court","ball","player","teacher","still","each","happens","outdoor",
    "indoor","hope","tell","close","take","drink","eat","chat","by","development","focus","come",
    "below","many","party","since","as","because","although","nothing","lunch","dinner","final",
    "especial","area","climate","weapon","drugs","spell","lesson","birthday","people","hello","gold",
    "rise","like","save","count","space","feel","more","comfortable","buy","that","know","call",
    "send","control","love","rent","rented","river","dessert","complicated","life","style","parents",
    "country","turkey","culture","tea","stone","middle","half","lie","hot","cold","basin","tasty",
    "film","experience","actor","exist","such","some","mine","separate","menu","usually","ready",
    "vacation","fish","try","deep","client","cook","charger","need","finish","bag","catch","hook",
    "red","green","yellow","store","can","work","surname",
}


def has_cyr(s):
    return bool(re.search(r"[а-яё]", s, re.I))


def clean(s):
    s = s.replace("==", "")                       # выделение ударной буквы
    s = re.sub(r"\*\*|\*|`", "", s)                # markdown
    s = re.sub(r"^\s*[-•]\s*", "", s)              # маркер списка
    return s.strip(" \t.;,")


def strip_note(s):
    """Отделяет пояснение в скобках/фигурных скобках от самого слова."""
    notes = re.findall(r"[({\[]([^)}\]]*)[)}\]]", s)
    core = re.sub(r"[({\[][^)}\]]*[)}\]]", " ", s)
    return re.sub(r"\s+", " ", core).strip(" \t.;,=-"), "; ".join(n.strip() for n in notes if n.strip())


def pt_score(s):
    """Насколько строка похожа на португальское слово."""
    if not s or has_cyr(s):
        return -5
    low = s.lower().strip()
    first = low.split()[0] if low.split() else low
    score = 0
    if first in PT_KNOWN or low in PT_KNOWN:
        score += 6
    if first in EN_KNOWN or low in EN_KNOWN:
        score -= 6
    if set(low) & PT_DIACRITICS:
        score += 4
    if PT_HINTS.search(low):
        score += 1
    if re.search(r"\b(the|to|a|an|of)\b", low):     # английские артикли/предлоги
        score -= 2
    return score


def main():
    rows, unclear = [], []
    for raw in open(SRC, encoding="utf-8"):
        line = clean(raw)
        if not line:
            continue
        # делим по первому разделителю: — / = / -
        m = re.split(r"\s*—\s*|\s*=\s*|\s+-\s+|\s*–\s*", line, maxsplit=1)
        if len(m) < 2:
            # строка без перевода вида «garafa» или «mi braso»
            core, note = strip_note(line)
            if core:
                rows.append({"pt": core, "gloss": "", "gloss_lang": "", "note": note, "raw": line})
            continue
        left, right = (strip_note(m[0]), strip_note(m[1]))
        (lcore, lnote), (rcore, rnote) = left, right
        note = "; ".join(n for n in (lnote, rnote) if n)

        ls, rs = pt_score(lcore), pt_score(rcore)
        if ls > rs:
            pt, gloss = lcore, rcore
        elif rs > ls:
            pt, gloss = rcore, lcore
        else:
            # ничья: в этом файле португальское слово почти всегда слева
            pt, gloss = lcore, rcore
            unclear.append({"raw": line, "left": lcore, "right": rcore})
        if not pt:
            continue
        rows.append({"pt": pt, "gloss": gloss,
                     "gloss_lang": "ru" if has_cyr(gloss) else ("en" if gloss else ""),
                     "note": note, "raw": line})

    json.dump({"words": rows, "unclear": unclear}, open(OUT, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"Разобрано строк: {len(rows)}")
    print(f"Не удалось определить сторону: {len(unclear)}")
    for u in unclear:
        print(f"   ? {u['left']}  |  {u['right']}")
    empty = [r["pt"] for r in rows if not r["gloss"]]
    print(f"\nБез перевода ({len(empty)}): {', '.join(empty)}")
    ru = sum(1 for r in rows if r["gloss_lang"] == "ru")
    print(f"Перевод русским: {ru}, английским: {sum(1 for r in rows if r['gloss_lang']=='en')}")


if __name__ == "__main__":
    main()
