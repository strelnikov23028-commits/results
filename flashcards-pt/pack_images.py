#!/usr/bin/env python3
"""
Приводит сгенерированные картинки в рабочий вид:

  img/gen_<id>.png  →  ../cartoes-img/«дом — casa.webp»

PNG от Grok весит ~1.4 МБ, в репозиторий столько класть нельзя, поэтому
ужимаем в WebP 1000 px (~60 КБ) — на карточке разница не видна.
Имя файла — русский перевод плюс португальское слово, чтобы папку
можно было листать глазами.

Затем прописывает новые пути в data/words.json.

    python pack_images.py            # обработать всё, что появилось
    python pack_images.py --check    # только показать, чего не хватает
"""
import json, os, sys

from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
OUT_DIR = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))
WIDTH, QUALITY = 1000, 82


def load_jobs():
    """Имена файлов заданы в batch_*.json; regen_*.json задаёт только новые
    сцены и поля file не содержит, поэтому его здесь пропускаем."""
    jobs = {}
    for f in sorted(os.listdir(D("jobs"))):
        if f.startswith("batch_") and f.endswith(".json"):
            for j in json.load(open(D("jobs", f), encoding="utf-8")):
                jobs[j["id"]] = j
    return jobs


def main():
    jobs = load_jobs()
    have = {int(f[4:-4]) for f in os.listdir(D("img"))
            if f.startswith("gen_") and f.endswith(".png")}
    missing = [j for i, j in jobs.items() if i not in have]

    print(f"заданий: {len(jobs)}, сгенерировано: {len(have)}, не хватает: {len(missing)}")
    if missing:
        print("нет картинки у:", ", ".join(j["pt"] for j in missing[:40]),
              "…" if len(missing) > 40 else "")
    if "--check" in sys.argv:
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    by_id = {c["id"]: c for c in cards}

    done = 0
    total_kb = 0
    for cid in sorted(have):
        job = jobs.get(cid)
        if not job:
            continue
        src = D("img", f"gen_{cid}.png")
        name = os.path.splitext(job["file"])[0] + ".webp"
        dst = os.path.join(OUT_DIR, name)
        try:
            im = Image.open(src).convert("RGB")
            h = round(im.height * WIDTH / im.width)
            im.resize((WIDTH, h), Image.LANCZOS).save(dst, "WEBP", quality=QUALITY, method=6)
        except Exception as e:
            print(f"  ! {job['pt']}: {e}")
            continue
        total_kb += os.path.getsize(dst) / 1024
        card = by_id.get(cid)
        if card:
            card["image"] = "cartoes-img/" + name
            card["credit"] = {"author": "", "url": "", "source": "Grok Build", "license": "сгенерировано ИИ"}
            card.pop("icon", None)      # фото заменяет прежний символ
        done += 1

    json.dump(cards, open(D("data", "words.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"\nупаковано: {done} картинок, всего {total_kb/1024:.1f} МБ")
    print(f"папка: {OUT_DIR}")
    if done:
        print("примеры:", ", ".join(sorted(os.listdir(OUT_DIR))[:3]))


if __name__ == "__main__":
    main()
