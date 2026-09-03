import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))

EDITS = {
    "scenes_v2_verbs.json": {
        # человек в пустой комнате не читался как «забыл» — берём стёртую доску
        "esquecer": ("a school blackboard wiped clean with chalk smears left behind, "
                     "whatever was written on it now gone"),
        # смотреть на фото уже занято у me lembro и fosse — желание у фонтана
        "gostaria": ("a person tossing a coin into a wishing fountain, making a wish"),
        # по подсказке: проигрыш в казино
        "perder": ("a gambler at a casino table watching the croupier rake away his "
                   "last chips, hands empty"),
        # механик у капота читался как «чинить машину» — берём заботу и уход
        "tratar": ("a gardener carefully tending a plant, handling it gently"),
        # по подсказке: отправка посылки на почте; entregar остаётся про вручение
        "enviar": ("a customer handing a parcel across the counter at a post office, "
                   "the package being weighed for sending"),
    },
    "scenes_v2_nouns.json": {
        # верстак с замками читался как «замки» — показываем работу с ключом
        "serralheiro": ("a locksmith cutting a new key on a key-cutting machine, "
                        "sparks flying from the blade"),
        # показывать новое уже занято словом mostrar — берём ажиотаж вокруг новинки
        "novidade": ("a crowd pressing against a shop window to see a newly released "
                     "product on display"),
        # по подсказке: зашкаливающий градусник
        "calor": ("an outdoor thermometer with the red column shot right up past forty "
                  "degrees under a blazing sun"),
    },
}

cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
by_pt = {c["pt"]: c for c in cards}

for fname, changes in EDITS.items():
    p = D("data", fname)
    d = json.load(open(p, encoding="utf-8"))
    for word, scene in changes.items():
        print(f"{word:<14} → {scene[:64]}")
        d[word] = scene
        c = by_pt.get(word)
        if not c:
            print("  ! слова нет в колоде"); continue
        c["imgQuery"] = scene
        png = D("img", f"gen_{c['id']}.png")
        if os.path.exists(png):
            os.remove(png)
        if c.get("image"):
            webp = os.path.join(IMG_OUT, os.path.basename(c["image"]))
            if os.path.exists(webp):
                os.remove(webp)
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

json.dump(cards, open(D("data", "words.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("\nготово")
