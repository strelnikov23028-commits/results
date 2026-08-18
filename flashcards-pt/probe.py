from PIL import Image
import os
src = "img/_test_praia.png"
im = Image.open(src).convert("RGB")
print("исходник:", im.size, f"{os.path.getsize(src)/1024:.0f} КБ")
for w, q in ((1000, 82), (860, 80), (720, 78)):
    h = round(im.height * w / im.width)
    out = f"img/_probe_{w}.webp"
    im.resize((w, h), Image.LANCZOS).save(out, "WEBP", quality=q, method=6)
    print(f"  {w}px q{q}: {os.path.getsize(out)/1024:.0f} КБ  ->  x311 = {os.path.getsize(out)*311/1024/1024:.0f} МБ")
