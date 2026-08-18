#!/usr/bin/env python3
"""
Перегенерирует картинки для слов, которые не устроили.

Сцены берёт из data/scenes_fix.json (ключ — португальское слово),
удаляет старые файлы и собирает отдельную пачку заданий jobs/regen_*.json.

    python regen.py           # подготовить задания и запустить генерацию
    python regen.py --prep    # только подготовить, не запускать
"""
import json, os, subprocess, sys, threading
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))
GROK = os.path.expanduser(r"~\.grok\bin\grok.exe")
PER_BATCH = 6          # мелкими пачками — быстрее и надёжнее
WORKERS = 5
lock = threading.Lock()


def main():
    fixes = json.load(open(D("data", "scenes_fix.json"), encoding="utf-8"))
    fixes.pop("_comment", None)
    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    by_pt = {c["pt"]: c for c in cards}

    jobs = []
    for pt, scene in fixes.items():
        c = by_pt.get(pt)
        if not c:
            print(f"  ! слова «{pt}» нет в колоде"); continue
        # чистим прежние файлы, иначе генерация решит, что всё готово
        old_png = D("img", f"gen_{c['id']}.png")
        if os.path.exists(old_png):
            os.remove(old_png)
        if c.get("image"):
            old_webp = os.path.join(IMG_OUT, os.path.basename(c["image"]))
            if os.path.exists(old_webp):
                os.remove(old_webp)
        jobs.append({"id": c["id"], "pt": pt, "ru": c["ru"], "scene": scene})

    # раскладываем по маленьким пачкам
    for f in os.listdir(D("jobs")):
        if f.startswith("regen_"):
            os.remove(D("jobs", f))
    batches = [jobs[i:i + PER_BATCH] for i in range(0, len(jobs), PER_BATCH)]
    paths = []
    for n, b in enumerate(batches, 1):
        p = D("jobs", f"regen_{n:02d}.json")
        json.dump(b, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        paths.append(p)

    print(f"к перегенерации: {len(jobs)} слов, пачек: {len(paths)}")
    for j in jobs:
        print(f"   {j['pt']:<20} → {j['scene'][:70]}")
    if "--prep" in sys.argv:
        return

    def run(path):
        batch = json.load(open(path, encoding="utf-8"))
        lines = "\n".join(f"{i+1}. save to img/gen_{j['id']}.png — scene: {j['scene']}"
                          for i, j in enumerate(batch))
        prompt = f"""Generate {len(batch)} images with the image_gen tool and save each to the exact path given.

These illustrate flashcards for learning Portuguese: each image must be instantly and unmistakably readable, recognisable in one second without any caption.

Rules for every image:
- Photorealistic photograph, natural lighting, sharp focus, ordinary everyday setting.
- The subject fills the frame and is the clear centre of attention; simple uncluttered background.
- No text, letters, numbers, captions, logos or watermarks anywhere.
- Aspect ratio 4:3.

Images:
{lines}

Generate them one by one without asking. Print DONE when every file exists."""
        with lock:
            print(f"[{os.path.basename(path)}] старт, {len(batch)} шт.")
        try:
            subprocess.run([GROK, "-p", prompt, "--yolo", "--max-turns", "60",
                            "--disallowed-tools", "web_search,web_fetch"],
                           cwd=ROOT, capture_output=True, text=True, timeout=2400)
        except subprocess.TimeoutExpired:
            with lock: print(f"[{os.path.basename(path)}] вышло время")
        done = sum(1 for j in batch if os.path.exists(D("img", f"gen_{j['id']}.png")))
        with lock:
            print(f"[{os.path.basename(path)}] готово {done}/{len(batch)}")

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(run, paths))

    ok = sum(1 for j in jobs if os.path.exists(D("img", f"gen_{j['id']}.png")))
    print(f"\nперегенерировано: {ok} из {len(jobs)}")


if __name__ == "__main__":
    main()
