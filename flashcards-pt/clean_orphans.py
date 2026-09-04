#!/usr/bin/env python3
"""
Ищет в папке публикации картинки, на которые не ссылается ни одна карточка.
Такие остаются, когда у слова меняли сцену и вместе с ней имя файла.

    python clean_orphans.py          # только показать
    python clean_orphans.py --delete # удалить найденные
"""
import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))

cards = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
used = {os.path.basename(c["image"]) for c in cards if c.get("image")}
on_disk = set(os.listdir(IMG_OUT))

orphans = sorted(on_disk - used)
missing = sorted(used - on_disk)

print(f"карточек: {len(cards)}, файлов в папке: {len(on_disk)}")
print(f"\nлишние файлы ({len(orphans)}):")
for f in orphans:
    print(f"   {f}")
print(f"\nне хватает файлов ({len(missing)}):")
for f in missing:
    print(f"   {f}")

if "--delete" in sys.argv and orphans:
    for f in orphans:
        os.remove(os.path.join(IMG_OUT, f))
    print(f"\nудалено: {len(orphans)}")
