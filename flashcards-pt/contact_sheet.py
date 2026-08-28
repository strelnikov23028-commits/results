#!/usr/bin/env python3
"""
Склеивает выбранные картинки в один лист с подписями — чтобы посмотреть
пачку разом, а не открывать по одной.

    python contact_sheet.py tempo vez "moço(a)" ...
    python contact_sheet.py --fix          # всё, что перечислено в scenes_fix.json
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))
OUT = D("_sheet.png")

CELL_W, CELL_H, PAD, CAP = 380, 285, 10, 46
COLS = 5


def font(size):
    for name in ("arial.ttf", "segoeui.ttf", "tahoma.ttf"):
        p = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def main():
    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    by_pt = {c["pt"]: c for c in cards}

    # слова с диакритикой ломаются при передаче через аргументы PowerShell,
    # поэтому пачку можно задать файлом: --from data/extra_words4.json
    src = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--from=")), None)
    if src:
        data = json.load(open(D(*src.split("/")), encoding="utf-8"))
        words = [w["pt"] for w in data] if isinstance(data, list) else list(data)
    elif "--fix" in sys.argv:
        fixes = json.load(open(D("data", "scenes_fix.json"), encoding="utf-8"))
        fixes.pop("_comment", None)
        words = list(fixes)
    else:
        words = [a for a in sys.argv[1:] if not a.startswith("--")]

    # можно ограничить диапазоном: --slice=0:15
    rng = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--slice=")), None)
    if rng:
        a, b = (int(x) if x else None for x in rng.split(":"))
        words = words[a:b]

    items = []
    for w in words:
        c = by_pt.get(w)
        if not c or not c.get("image"):
            print(f"  ! пропуск: {w}"); continue
        p = os.path.join(IMG, os.path.basename(c["image"]))
        if os.path.exists(p):
            items.append((c, p))

    rows = (len(items) + COLS - 1) // COLS
    W = COLS * (CELL_W + PAD) + PAD
    H = rows * (CELL_H + CAP + PAD) + PAD
    sheet = Image.new("RGB", (W, H), (24, 24, 26))
    dr = ImageDraw.Draw(sheet)
    f_pt, f_ru = font(21), font(15)

    for i, (c, path) in enumerate(items):
        col, row = i % COLS, i // COLS
        x = PAD + col * (CELL_W + PAD)
        y = PAD + row * (CELL_H + CAP + PAD)
        im = Image.open(path).convert("RGB")
        im.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
        sheet.paste(im, (x + (CELL_W - im.width) // 2, y + (CELL_H - im.height) // 2))
        dr.text((x + 4, y + CELL_H + 4), c["pt"], font=f_pt, fill=(255, 255, 255))
        dr.text((x + 4, y + CELL_H + 26), c["ru"][:40], font=f_ru, fill=(160, 160, 168))

    sheet.save(OUT, quality=92)
    print(f"лист: {OUT}  ({len(items)} картинок, {sheet.width}x{sheet.height})")


if __name__ == "__main__":
    main()
