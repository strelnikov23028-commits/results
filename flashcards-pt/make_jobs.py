#!/usr/bin/env python3
"""
Готовит задания на генерацию картинок для всех карточек.

Для каждого слова собирает сцену: у 189 карточек ориентир уже был (imgQuery),
для остальных 122 сцены заданы в data/scenes_extra.json.

Имя файла — русский перевод плюс португальское слово, чтобы папку можно было
листать глазами: «дом — casa.png».

Результат: jobs/batch_01.json … batch_16.json по 20 слов в каждом.
"""
import json, os, re, unicodedata

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
BATCH = 20

BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def filename(card):
    """«сын; дочь» + filho(a) → «сын, дочь — filho(a).png»"""
    ru = card["ru"].split("(")[0].strip(" ;,")
    ru = ru.replace(";", ",").replace("/", "-")
    ru = re.sub(r"\s+", " ", ru)[:48].strip(" ,")
    # слеш в имени файла недопустим, но терять его нельзя: em/na/no → em-na-no
    pt = card["pt"].replace("/", "-")
    name = f"{ru} — {pt}"
    name = BAD_CHARS.sub("", name).strip(" .")
    return name + ".png"


def main():
    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    extra = json.load(open(D("data", "scenes_extra.json"), encoding="utf-8"))
    extra.pop("_comment", None)

    jobs, missing = [], []
    used = {}
    for c in cards:
        scene = extra.get(c["pt"]) or c.get("imgQuery")
        if not scene:
            missing.append(c["pt"]); continue
        fn = filename(c)
        # на всякий случай разводим совпадающие имена
        if fn.lower() in used:
            base, ext = os.path.splitext(fn)
            fn = f"{base} ({c['id']}){ext}"
        used[fn.lower()] = True
        jobs.append({"id": c["id"], "pt": c["pt"], "ru": c["ru"], "file": fn, "scene": scene})

    if missing:
        raise SystemExit("Без сцены остались: " + ", ".join(missing))

    os.makedirs(D("jobs"), exist_ok=True)
    os.makedirs(D("img"), exist_ok=True)
    for f in os.listdir(D("jobs")):
        os.remove(D("jobs", f))

    batches = [jobs[i:i + BATCH] for i in range(0, len(jobs), BATCH)]
    for n, b in enumerate(batches, 1):
        json.dump(b, open(D("jobs", f"batch_{n:02d}.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)

    print(f"заданий: {len(jobs)}, пачек по {BATCH}: {len(batches)}")
    print("примеры имён файлов:")
    for j in jobs[:3] + jobs[150:152]:
        print(f"   {j['file']}")
        print(f"      сцена: {j['scene'][:70]}")


if __name__ == "__main__":
    main()
