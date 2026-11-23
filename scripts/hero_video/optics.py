#!/usr/bin/env python3
"""
optics.py — the lens and the detector: turn render_blender.py's depth bands
into finished frames.

  python3 scripts/hero_video/optics.py <render_dir> <frames_out> [--photons 400] [--glow 0.12]

For each frame f_NNNN.png:
  * defocus — every band behind the in-focus one is blurred by its own
    Gaussian (sigma from layout.json, growing with depth) after being scaled up
    from the half resolution it was rendered at; fluorescence adds, so the
    bands are summed in linear light;
  * the needle hides what is behind it, so the blurred background is masked
    off the needle's silhouette (the camera tracks the needle, so the
    silhouette is the same rectangle in every frame);
  * glow — a wide, faint halo of the bright dye, as scattered light gives;
  * a fine grain — photon (Poisson) and read noise, drawn afresh each frame,
    kept light: noise is what costs bytes in a looping web video.
"""
import os, sys, json, glob
import numpy as np
from multiprocessing import Pool
from scipy.ndimage import gaussian_filter
from PIL import Image

argv = sys.argv[1:]
def opt(name, default, cast=float):
    return cast(argv[argv.index(name) + 1]) if name in argv else default
SRC, DST = argv[0], argv[1]
PHOTONS = opt('--photons', 400.0)
READ = opt('--read', 0.004)
GLOW = opt('--glow', 0.06)
LAY = json.load(open(os.path.join(SRC, 'layout.json')))
W, H = LAY['res']; SIG = LAY['sigma']; BANDS = LAY['bands']
os.makedirs(DST, exist_ok=True)
x0, x1, ytip = LAY['needle_px']
yy, xx = np.mgrid[0:H, 0:W]
# the needle's silhouette, softened by a pixel; behind it nothing from the background bands shows
mask = np.clip(np.minimum(np.minimum(xx - x0, x1 - xx), ytip - yy) + 0.5, 0, 1).astype(np.float32)
keep = (1 - mask)[..., None]

def load_lin(path, size=None):
    im = Image.open(path).convert('RGB')
    if size and im.size != size: im = im.resize(size, Image.BICUBIC)
    return (np.asarray(im).astype(np.float32)/255.0)**2.2

def process(name):
    fi = int(name[2:6])
    rng = np.random.default_rng(5000 + fi)
    out = load_lin(os.path.join(SRC, 'b0', name), (W, H)) if 0 in BANDS else np.zeros((H, W, 3), np.float32)
    for b in BANDS:
        if b == 0: continue
        img = load_lin(os.path.join(SRC, f'b{b}', name), (W, H))
        if SIG[b] > 0: img = gaussian_filter(img, sigma=(SIG[b], SIG[b], 0))
        out += img*keep
    out += GLOW*gaussian_filter(out, sigma=(24, 24, 0))
    out = rng.poisson(np.clip(out, 0, None)*PHOTONS).astype(np.float32)/PHOTONS
    out += rng.normal(0, READ, out.shape).astype(np.float32)
    out = np.clip(out, 0, 1)**(1/2.2)
    Image.fromarray((out*255 + 0.5).astype(np.uint8)).save(os.path.join(DST, name), compress_level=3)
    return name

if __name__ == '__main__':
    ref = 0 if 0 in BANDS else BANDS[0]
    names = sorted(os.path.basename(p) for p in glob.glob(os.path.join(SRC, f'b{ref}', 'f_*.png')))
    with Pool(8) as pool:
        for k, n in enumerate(pool.imap_unordered(process, names, chunksize=4)):
            if k % 60 == 0: print(f'{k + 1}/{len(names)} {n}', flush=True)
    print(f'wrote {len(names)} frames → {DST}')
