#!/usr/bin/env python3
"""
encode.py — PNG frames (render_blender.py) → the hero video files.

  python3 scripts/hero_video/encode.py <frames_dir> <out_dir> [--fps 30] [--name hero-lls-print] [--width 1600] [--crf 46]

Writes <name>.webm (VP9, the source index.html prefers), <name>.mp4 (H.264
fallback for browsers without VP9) and hero-poster.jpg (the first frame, used
as the <video> poster so nothing external is fetched for it). The frames are
scaled to --width (the hero shows the video at 20 % opacity under a scrim, so
it need not be sharper than the page) and --crf sets the VP9 quality (the mp4
uses crf-14).
"""
import os, subprocess, sys

argv = sys.argv[1:]
def opt(name, default):
    return argv[argv.index(name) + 1] if name in argv else default
frames, out = argv[0], argv[1]
fps = int(opt('--fps', 30)); name = opt('--name', 'hero-lls-print')
width = int(opt('--width', 1600)); crf = int(opt('--crf', 46))
scale = f'scale={width}:-2'
os.makedirs(out, exist_ok=True)
seq = os.path.join(frames, 'f_%04d.png')
def run(*cmd):
    print(' '.join(cmd)); subprocess.run(cmd, check=True)
webm = os.path.join(out, name + '.webm'); mp4 = os.path.join(out, name + '.mp4'); poster = os.path.join(out, 'hero-poster.jpg')
run('ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', seq,
    '-vf', scale, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', str(crf), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
    '-pix_fmt', 'yuv420p', '-an', webm)
run('ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', seq,
    '-vf', scale, '-c:v', 'libx264', '-crf', str(crf - 14), '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4)
run('ffmpeg', '-y', '-loglevel', 'error', '-i', os.path.join(frames, 'f_0001.png'), '-vf', scale, '-q:v', '5', poster)
for f in (webm, mp4, poster):
    print(f'{f}: {os.path.getsize(f)/1e6:.2f} MB')
