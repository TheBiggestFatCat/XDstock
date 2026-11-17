"""Toy 产物图片瘦身：只改 toy/dist 里的副本，不动 public 原始资源。
用法：python optimize-assets.py <dist目录> [--quantize]
"""
import os
import sys

from PIL import Image

root = sys.argv[1]
quantize = '--quantize' in sys.argv

RULES = {
    os.path.join(root, 'assets', 'stocks'): 128,
    os.path.join(root, 'assets', 'achievement'): 160,
    os.path.join(root, 'assets', 'emo_lv1'): 96,
    os.path.join(root, 'assets', 'shop'): 128,
    os.path.join(root, 'assets', 'icons'): 192,
}
SINGLE = {
    os.path.join(root, 'assets', 'logo.png'): 256,
    os.path.join(root, 'assets', 'favicon.png'): 64,
}

before = after = 0


def optimize(p, maxdim):
    global before, after
    try:
        before += os.path.getsize(p)
        im = Image.open(p)
        if max(im.size) > maxdim:
            im.thumbnail((maxdim, maxdim), Image.LANCZOS)
        if quantize:
            if im.mode in ('RGBA', 'LA'):
                im = im.convert('RGBA').quantize(colors=128, method=Image.FASTOCTREE_QUANTIZE)
            elif im.mode in ('RGB', 'L'):
                im = im.convert('RGB').quantize(colors=128, method=Image.MEDIANCUT)
        im.save(p, optimize=True)
        after += os.path.getsize(p)
    except Exception as e:
        print('skip', p, e)


for folder, maxdim in RULES.items():
    if not os.path.isdir(folder):
        continue
    for name in os.listdir(folder):
        fp = os.path.join(folder, name)
        if os.path.isfile(fp) and name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            optimize(fp, maxdim)
for fp, maxdim in SINGLE.items():
    if os.path.isfile(fp):
        optimize(fp, maxdim)

print(f'assets: {before / 1024:.0f} KB -> {after / 1024:.0f} KB ({(1 - after / max(1, before)) * 100:.0f}% off)')
