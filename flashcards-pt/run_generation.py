#!/usr/bin/env python3
"""
Гоняет генерацию картинок через Grok Build: 16 пачек по 20 слов, 5 потоков.

Grok сохраняет файлы под техническим именем gen_<id>.png — так надёжнее,
чем просить его писать кириллицу. Переименование в «дом — casa.png»
делает rename_images.py после генерации.

    python run_generation.py            # все пачки
    python run_generation.py 3 4 5      # только указанные пачки
"""
import json, os, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
GROK = os.path.expanduser(r"~\.grok\bin\grok.exe")
WORKERS = 5
lock = threading.Lock()


def build_prompt(batch):
    lines = []
    for j in batch:
        lines.append(f'{len(lines)+1}. save to img/gen_{j["id"]}.png — scene: {j["scene"]}')
    listing = "\n".join(lines)
    return f"""Generate {len(batch)} images with the image_gen tool and save each one to the exact file path given below.

These are flashcards for learning Portuguese, so every image must be instantly, unmistakably readable: a person seeing it should recognise the concept in one second without any caption.

Rules for every image:
- Photorealistic photograph, natural lighting, sharp focus, ordinary everyday setting.
- The subject fills the frame and is the obvious centre of attention; simple uncluttered background.
- Absolutely no text, letters, numbers, captions, logos or watermarks anywhere in the image.
- Aspect ratio 4:3.
- If the scene below is short, expand it into a full vivid description yourself, keeping the meaning exactly.

Images to generate:
{listing}

Work through them one by one. After each image is saved, continue to the next without asking. When every file exists, print DONE."""


def run_batch(path):
    name = os.path.basename(path)
    batch = json.load(open(path, encoding="utf-8"))
    missing = [j for j in batch if not os.path.exists(D("img", f"gen_{j['id']}.png"))]
    if not missing:
        with lock: print(f"[{name}] уже готова, пропускаю")
        return name, len(batch), 0

    t0 = time.time()
    with lock: print(f"[{name}] старт, картинок к генерации: {len(missing)}")
    try:
        subprocess.run([GROK, "-p", build_prompt(missing), "--yolo",
                        "--max-turns", "120",
                        "--disallowed-tools", "web_search,web_fetch"],
                       cwd=ROOT, capture_output=True, text=True, timeout=3600)
    except subprocess.TimeoutExpired:
        with lock: print(f"[{name}] превышено время ожидания")

    done = sum(1 for j in batch if os.path.exists(D("img", f"gen_{j['id']}.png")))
    dt = time.time() - t0
    with lock:
        print(f"[{name}] готово {done}/{len(batch)} за {dt/60:.1f} мин")
    return name, done, len(batch) - done


def main():
    files = sorted(f for f in os.listdir(D("jobs")) if f.endswith(".json"))
    if len(sys.argv) > 1:
        want = {f"batch_{int(a):02d}.json" for a in sys.argv[1:]}
        files = [f for f in files if f in want]
    paths = [D("jobs", f) for f in files]
    print(f"пачек: {len(paths)}, потоков: {WORKERS}\n")

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        results = list(ex.map(run_batch, paths))

    total = sum(r[1] for r in results)
    lost = sum(r[2] for r in results)
    print(f"\nИТОГО: {total} картинок, не хватает {lost}, время {(time.time()-t0)/60:.1f} мин")
    if lost:
        print("Пачки с пропусками:", ", ".join(r[0] for r in results if r[2]))


if __name__ == "__main__":
    main()
