import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
P = lambda f: os.path.join(ROOT, "data", f)

# vez — существительное, его место в nouns; из rest убираем задвоение
nouns = json.load(open(P("scenes_v2_nouns.json"), encoding="utf-8"))
nouns["vez"] = "five chalk tally marks scratched on a rough concrete wall"
json.dump(nouns, open(P("scenes_v2_nouns.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

rest = json.load(open(P("scenes_v2_rest.json"), encoding="utf-8"))
removed = rest.pop("vez", None)
json.dump(rest, open(P("scenes_v2_rest.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

print("vez перенесён в существительные, из rest удалён:", bool(removed))
