import json, os, unicodedata
ROOT = os.path.dirname(os.path.abspath("."))
cards = json.load(open("data/words.json", encoding="utf-8"))
for c in cards:
    if "pais" in unicodedata.normalize("NFD", c["pt"]).encode("ascii","ignore").decode().lower():
        print(repr(c["pt"]), "=", c["ru"], "| id", c["id"])
