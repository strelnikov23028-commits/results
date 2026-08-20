#!/usr/bin/env python3
"""
Перегенерирует ВСЕ картинки по новому набору сцен (data/scenes_v2_*.json).

Отличие от прежних промптов: требуем изолированный предмет без посторонних
деталей — слово должно означать ровно то, что в кадре.

    python regen_all.py            # всё заново
    python regen_all.py --rest     # только те, которых ещё нет
"""
import json, os, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
IMG_OUT = os.path.abspath(os.path.join(ROOT, "..", "cartoes-img"))
GROK = os.path.expanduser(r"~\.grok\bin\grok.exe")
PARTS = ["scenes_v2_nouns.json", "scenes_v2_adj.json",
         "scenes_v2_verbs.json", "scenes_v2_rest.json"]
PER_BATCH, WORKERS = 8, 10
lock = threading.Lock()
done_count = 0


def scenes():
    out = {}
    for p in PARTS:
        d = json.load(open(D("data", p), encoding="utf-8"))
        d.pop("_comment", None)
        out.update(d)
    return out


def build_prompt(batch):
    lines = "\n".join(
        f'{i+1}. save to img/gen_{j["id"]}.png — {j["scene"]}'
        for i, j in enumerate(batch))
    return f"""Generate {len(batch)} photographs with the image_gen tool and save each to the exact path given.

These illustrate vocabulary flashcards. The learner sees only the picture and must recognise one specific word from it, so each image must show exactly the thing described and nothing that could suggest a different word.

Rules for every image:
- Photorealistic photograph, natural lighting, sharp focus.
- Show ONLY what the description names. No extra objects, props or scenery that are not mentioned.
- The subject fills most of the frame against a simple, uncluttered background.
- No text, letters, numbers, captions, logos or watermarks anywhere in the image.
- When the description asks for a plain colour surface, produce exactly that: a uniform field of that colour edge to edge, with no object, no gradient, no texture and no shadow.
- Aspect ratio 4:3.

Images:
{lines}

Generate them one after another without asking for confirmation. Print DONE when all files exist."""


def run(path):
    global done_count
    batch = json.load(open(path, encoding="utf-8"))
    todo = [j for j in batch if not os.path.exists(D("img", f"gen_{j['id']}.png"))]
    if not todo:
        return
    name = os.path.basename(path)
    t0 = time.time()
    try:
        subprocess.run([GROK, "-p", build_prompt(todo), "--yolo", "--max-turns", "80",
                        "--disallowed-tools", "web_search,web_fetch"],
                       cwd=ROOT, capture_output=True, text=True, timeout=2700)
    except subprocess.TimeoutExpired:
        with lock: print(f"[{name}] вышло время")
    got = sum(1 for j in batch if os.path.exists(D("img", f"gen_{j['id']}.png")))
    with lock:
        done_count += got
        print(f"[{name}] {got}/{len(batch)} за {(time.time()-t0)/60:.1f} мин  "
              f"(всего готово ~{done_count})")


def main():
    sc = scenes()
    cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
    jobs = [{"id": c["id"], "pt": c["pt"], "scene": sc[c["pt"]]}
            for c in cards if c["pt"] in sc]

    if "--rest" not in sys.argv:
        # чистим прежние картинки: сцены изменились у всех
        for f in os.listdir(D("img")):
            if f.startswith("gen_"):
                os.remove(D("img", f))
        if os.path.isdir(IMG_OUT):
            for f in os.listdir(IMG_OUT):
                os.remove(os.path.join(IMG_OUT, f))
        print("прежние картинки удалены")

    for f in os.listdir(D("jobs")):
        if f.startswith("v2_"):
            os.remove(D("jobs", f))
    paths = []
    for n in range(0, len(jobs), PER_BATCH):
        p = D("jobs", f"v2_{n//PER_BATCH:02d}.json")
        json.dump(jobs[n:n + PER_BATCH], open(p, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        paths.append(p)

    print(f"к генерации: {len(jobs)} картинок, пачек по {PER_BATCH}: {len(paths)}, потоков: {WORKERS}\n")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(run, paths))
    have = sum(1 for j in jobs if os.path.exists(D("img", f"gen_{j['id']}.png")))
    print(f"\nготово {have} из {len(jobs)} за {(time.time()-t0)/60:.1f} мин")


if __name__ == "__main__":
    main()
