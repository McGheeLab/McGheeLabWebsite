#!/usr/bin/env python3
"""Author the custom gap icons Heroicons v2 doesn't ship.

House style copied from upstream exactly so the two are indistinguishable:
  outline -> viewBox 0 0 24 24, fill=none, stroke=currentColor,
             stroke-width=1.5, round cap/join
  solid   -> viewBox 0 0 24 24, fill=currentColor, evenodd

Every design here was rendered at 16/20/24/56px and visually checked before
being kept. Rejected along the way, recorded so nobody redraws them:
  - books as three upright bars      -> read as a bar chart
  - books as a horizontal stack      -> read as a list/table
  - microscope as tube + stage       -> read as a pen or a highlighter
  - handshake, two attempts          -> read as a squiggle at every size;
    DROPPED. 🤝 maps to upstream `user-group`, which actually reads.
"""
import pathlib, sys

OUT = pathlib.Path(sys.argv[1])
OUTLINE_HDR = ('<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" '
               'stroke-width="1.5" stroke="currentColor" aria-hidden="true" data-slot="icon">')
SOLID_HDR = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
             'fill="currentColor" aria-hidden="true" data-slot="icon">')

# Diagonal stripe knocked out of the construction rail (top y 8.25 -> bottom
# 12.75). Three at width 1.2 was picked by rendering 4x1.5 / 3x1.2 / 3x1.5 /
# no-stripes side by side: 4 stripes ate the rail and clipped the corner, and
# a stripeless rail just reads as a table.
def _stripe(x0):
    return f"M{x0} 8.25h1.2l-2.25 4.5h-1.2z"

OUTLINE = {
    # concentric rings + centre dot
    "target": [
        "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
        "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z",
        "M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
    ],
    # two upright volumes + one leaning — the leaning one is what stops this
    # reading as a bar chart
    "books": [
        "M3.75 20.25h16.5",
        "M6.75 20.25V7.5a1.5 1.5 0 0 1 1.5-1.5h1.5a1.5 1.5 0 0 1 1.5 1.5v12.75",
        "M6.75 9.75h4.5",
        "M14.03 20.25 16.6 8.4a1.5 1.5 0 0 0-1.15-1.78l-1.1-.24",
        "M13.2 10.2l3.6.78",
    ],
    # thumbtack head-on
    "pin": [
        "M9 3.75h6",
        "M9.75 3.75v4.5L7.5 10.5v1.5h9v-1.5L14.25 8.25v-4.5",
        "M12 13.5v6.75",
    ],
    # ringed dial + kite needle
    "compass": [
        "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
        "M15.75 8.25l-2.121 5.379L8.25 15.75l2.121-5.379L15.75 8.25Z",
    ],
    # base + pillar, stage, arm arc, angled tube, focus knuckle
    "microscope": [
        "M4.5 20.25h15",
        "M8.25 20.25V18h7.5v2.25",
        "M6.75 14.25h6",
        "M15.75 14.25a5.25 5.25 0 0 1-5.25 5.25",
        "M11.16 3.66a1.5 1.5 0 0 1 2.12 0l1.06 1.06a1.5 1.5 0 0 1 0 2.12l-4.6 4.6-3.18-3.18 4.6-4.6Z",
        "M8.03 8.03 6.44 9.62a1.5 1.5 0 0 0 0 2.12l1.82 1.82a1.5 1.5 0 0 0 2.12 0l1.59-1.59",
    ],
    # barricade: hatched rail on two legs
    "construction": [
        "M3.75 7.5h16.5v5.25H3.75z",
        "M6 12.75v7.5",
        "M18 12.75v7.5",
        "M8.25 7.5l-3 5.25",
        "M13.5 7.5l-3 5.25",
        "M18.75 7.5l-3 5.25",
    ],
    # double helix
    "dna": [
        "M6.75 3v1.5c0 4.5 10.5 4.5 10.5 9s-10.5 4.5-10.5 9v1.5",
        "M17.25 3v1.5c0 4.5-10.5 4.5-10.5 9s10.5 4.5 10.5 9v1.5",
        "M8.25 7.5h7.5",
        "M8.25 16.5h7.5",
    ],
    # V3.861 — status dot. Outline is a ring; status sites ask for the solid disc
    "dot": [
        "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z",
    ],
}

SOLID = {
    "target": [
        "M12 2.25a9.75 9.75 0 1 0 0 19.5 9.75 9.75 0 0 0 0-19.5ZM4.5 12a7.5 7.5 0 1 1 15 0 7.5 7.5 0 0 1-15 0Z",
        "M12 6.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5Zm-3 5.25a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z",
        "M13.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z",
    ],
    "books": [
        "M3 20.25a.75.75 0 0 1 .75-.75h16.5a.75.75 0 0 1 0 1.5H3.75a.75.75 0 0 1-.75-.75Z",
        # upright pair, with a cut band near the top so it reads as a cover
        ("M6.75 6a2.25 2.25 0 0 0-2.25 2.25V18h8.25V8.25A2.25 2.25 0 0 0 10.5 6h-3.75Z"
         "m-.75 3.75h6.75v1.5H6v-1.5Z"),
        # the leaning volume
        ("M14.66 5.63a1.5 1.5 0 0 0-1.15 1.78L15.9 18l4.4-.95L17.9 6.46a1.5 1.5 0 0 0-1.78-1.15l-1.47.32Z"
         "m-.2 3.3 4.4.95.32 1.47-4.4-.95-.32-1.47Z"),
    ],
    "pin": [
        ("M8.25 3.75A.75.75 0 0 1 9 3h6a.75.75 0 0 1 0 1.5h-.75v3.44l2.03 2.03c.14.14.22.33.22.53v1.5"
         "a.75.75 0 0 1-.75.75h-3v7.5a.75.75 0 0 1-1.5 0v-7.5h-3a.75.75 0 0 1-.75-.75v-1.5"
         "c0-.2.08-.39.22-.53l2.03-2.03V4.5H9a.75.75 0 0 1-.75-.75Z"),
    ],
    "compass": [
        ("M12 2.25a9.75 9.75 0 1 0 0 19.5 9.75 9.75 0 0 0 0-19.5Zm4.457 6.02a.75.75 0 0 0-.95-.95"
         "l-5.16 1.72a.75.75 0 0 0-.462.462l-1.72 5.16a.75.75 0 0 0 .95.95l5.16-1.72"
         "a.75.75 0 0 0 .462-.462l1.72-5.16Z"),
    ],
    "microscope": [
        "M3.75 20.25a.75.75 0 0 1 .75-.75h15a.75.75 0 0 1 0 1.5h-15a.75.75 0 0 1-.75-.75Z",
        "M8.25 17.25h7.5v2.25h-7.5v-2.25Z",
        "M6 14.25a.75.75 0 0 1 .75-.75h6a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1-.75-.75Z",
        "M16.5 14.25a6 6 0 0 1-6 6 .75.75 0 0 1 0-1.5 4.5 4.5 0 0 0 4.5-4.5.75.75 0 0 1 1.5 0Z",
        ("M10.63 3.13a2.25 2.25 0 0 1 3.18 0l1.06 1.06a2.25 2.25 0 0 1 0 3.18l-4.6 4.6"
         "a.75.75 0 0 1-1.06 0L5.5 8.26a.75.75 0 0 1 0-1.06l5.13-4.07Z"),
        ("M7.5 9.44 5.91 11.03a2.25 2.25 0 0 0 0 3.18l.82.82a2.25 2.25 0 0 0 3.18 0l1.59-1.59"
         "-1.06-1.06-1.59 1.59a.75.75 0 0 1-1.06 0l-.82-.82a.75.75 0 0 1 0-1.06L8.56 10.5 7.5 9.44Z"),
    ],
    "construction": [
        # rail with the stripes knocked out (evenodd), then the two legs
        "M3 8.25h18v4.5H3z" + "".join(_stripe(x) for x in (8.25, 13.5, 18.75)),
        "M5.1 13.5h1.8v6.75a.9.9 0 0 1-1.8 0V13.5Z",
        "M17.1 13.5h1.8v6.75a.9.9 0 0 1-1.8 0V13.5Z",
    ],
    "dna": [
        ("M7.5 2.25a.75.75 0 0 0-1.5 0V3c0 2.9 2.02 4.53 3.72 5.72l.24.17c1.9 1.32 3.29 2.4 3.29 3.86"
         "s-1.39 2.54-3.29 3.86l-.24.17C8.02 18.03 6 19.65 6 22.5a.75.75 0 0 0 1.5 0"
         "c0-1.46 1.39-2.54 3.29-3.86l.24-.17c1.7-1.19 3.72-2.82 3.72-4.97s-2.02-3.78-3.72-4.97"
         "l-.24-.17C8.89 6.04 7.5 4.96 7.5 3.5v-1.25Z"),
        ("M18 2.25a.75.75 0 0 0-1.5 0V3.5c0 1.46-1.39 2.54-3.29 3.86l-.24.17C11.27 8.72 9.25 10.35 9.25 12.5"
         "s2.02 3.78 3.72 4.97l.24.17C15.11 18.96 16.5 20.04 16.5 21.5v.75a.75.75 0 0 0 1.5 0V21.5"
         "c0-2.85-2.02-4.47-3.72-5.72l-.24-.17c-1.9-1.32-3.29-2.4-3.29-3.86s1.39-2.54 3.29-3.86"
         "l.24-.17C15.98 6.53 18 4.9 18 2.25Z"),
        "M8.25 6.75h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5Z",
        "M8.25 15.75h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5Z",
    ],
    # V3.861 — status dot: a filled disc, tinted per use (ICON.render of 🔴🟢🟡…)
    "dot": [
        "M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z",
    ],
}


def write(kind, name, paths):
    d = OUT / "custom" / "24" / kind
    d.mkdir(parents=True, exist_ok=True)
    if kind == "outline":
        body = "\n  ".join(
            f'<path stroke-linecap="round" stroke-linejoin="round" d="{p}"/>' for p in paths)
        svg = f"{OUTLINE_HDR}\n  {body}\n</svg>\n"
    else:
        body = "\n  ".join(
            f'<path fill-rule="evenodd" clip-rule="evenodd" d="{p}"/>' for p in paths)
        svg = f"{SOLID_HDR}\n  {body}\n</svg>\n"
    (d / f"{name}.svg").write_text(svg)


# a stale file from an earlier draft would silently keep shipping
for stale in (OUT / "custom" / "24" / "outline", OUT / "custom" / "24" / "solid"):
    if stale.exists():
        for f in stale.glob("*.svg"):
            if f.stem not in OUTLINE:
                f.unlink()
                print(f"removed stale {f.relative_to(OUT)}")

for n, p in OUTLINE.items():
    write("outline", n, p)
for n, p in SOLID.items():
    write("solid", n, p)

assert set(OUTLINE) == set(SOLID), "every custom icon needs both weights"
print(f"{len(OUTLINE)} custom icons x2 weights:", ", ".join(sorted(OUTLINE)))
