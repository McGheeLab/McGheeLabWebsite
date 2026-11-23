# Hero video — a needle writing cell-laden ink into a liquid-like solid

The landing-page hero (`Videos/hero-lls-print.webm`) is made here, in five steps:

```
python3 scripts/hero_video/simulate.py  /tmp/hero/sim.npz                      # ~4 min: the physics
python3 scripts/hero_video/loopify.py   /tmp/hero/sim.npz /tmp/hero/loop.npz   # closes the seam, works out the squash
/Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/hero_video/render_blender.py -- \
        /tmp/hero/loop.npz /tmp/hero/render                                    # ~25 min: 4 depth bands per frame
python3 scripts/hero_video/optics.py    /tmp/hero/render /tmp/hero/frames      # defocus, glow, grain
python3 scripts/hero_video/encode.py    /tmp/hero/frames Videos                # webm + mp4 + poster
```

Nothing here is deployed: `deploy/site.json` ships `Videos/**` only. Intermediate
files are large (a few hundred MB) and belong in a scratch folder.

## What the pictures show

A close side view of the needle in the bath, zoomed so the bed's surface and
floor are out of frame. The bath in front of the needle's axis is cut away;
everything behind it is there, in focus near the needle's axis and
increasingly blurred and dim with depth, as through a lens focused on the
needle.

* **Green chunks** are the jammed microgel bath (a liquid-like solid), drawn as
  rough convex polyhedra — the crushed, sieved granules of the lab's baths —
  mostly transparent and self-luminous, as if the whole gel were FITC. Each is
  squashed by its contacts (see below), so granules flatten against the needle
  and against each other.
* **The needle** is a blunt steel cannula, 3.5 granule diameters across, moving
  at constant speed with its tip in the bed.
* **Orange-red chunks** are the ink, as if dyed with rhodamine: a granular ink of
  slightly smaller microgels, pushed out of the needle's bore.
* **Magenta blobs** (Cy5) are cells carried in the ink, following the GELLS-DEM
  life cycle on a clock compressed from days to seconds: suspended → attach to a
  granule surface (ink granules preferred) → spread → crawl (persistent random
  walk on the surface) → reach across a void to a neighbouring granule →
  contract, pulling the two granules together. Cells live on granule surfaces
  and in the voids, never inside granules (GELS).

Distance behind the needle stands in for time: next to the tip the ink has just
left the bore; at the left edge of the frame its cells have spread and started
pulling granules together.

## The physics (simulate.py)

Nothing the bath does is scripted. It is Durian's bubble model in 3D, the
standard model for foams, emulsions and soft microgel packs: overdamped soft
spheres with Hookean contacts, each dragged against the solvent at rest. The
pack is made by growing spheres to φ = 0.72 (above jamming) in a tile periodic
along the print direction and relaxing it to mechanical equilibrium with FIRE,
so it starts as a compressed solid with a yield stress. The container is
no-slip: granules touching the floor and side walls are fixed; the lid, far
above the frame, is smooth. The bath yields beside the needle, flows round it
and re-jams behind it purely from contact forces (compare McGhee 2018, *Exp
Mech* 58:137: fluid-like beside the needle, solid-like ahead and behind,
displacement about one needle diameter).

The needle is a rigid hollow cannula. Bath granules see a solid flat-tipped
cylinder. Ink granules are fed into the top of the bore on a fixed schedule, a
piston force pushes the column down, the inner wall confines it, and the ink
leaves through the bore's mouth, pushing bath granules aside to make room. The
feed rate sets the flow; where the line sits, how wide it is and how much of
the shaft's crevasse it fills all come out of the contacts.

Cells are agents riding on the physics: their contraction is a capped force
between two granules, applied through the same contact mechanics.

## The squash (loopify.py)

The simulation's overlaps stand for flattened contacts. Every contact a
granule makes — with another granule or with the needle — flattens it along
the contact normal by its share of the overlap; the resulting shape tensor is
made volume-preserving (hydrogel granules are nearly incompressible), so a
granule pressed against the needle flattens there and bulges sideways. The
renderer applies the tensor to each granule's polyhedron.

## Why it loops

The bath is a strip of identical tiles, periodic with period `L = v·T` (one
loop of needle travel); the feed schedule and every random stream are periodic
with the same period; the camera tracks the needle. In the needle's frame the
process is steady, so frame `T` repeats frame 0 shifted by `L` — except that
yielding is chaotic: the arrangement of the wake repeats closely but the
identities do not. `loopify.py` closes the seam on the arrangement: at the last
frame every granule and cell is matched to the nearest unclaimed one in the
loop-start arrangement and glides onto its track over the last 72 frames (2.4 s), eased
in and out (a morph of the data, not a crossfade of the pictures); the few
unmatched ones shrink away or grow in.

## Depth of field (render_blender.py, optics.py)

Each frame is rendered four times, once per depth band (centred 0, 2.5, 5.5 and
9 units behind the needle's axis). Every granule goes into the two bands either
side of its depth with weights sliding linearly between them, so nothing pops
as granules flow round the needle. `optics.py` blurs each band by its own
defocus (σ 0, 3, 7, 12 px at 1920 wide), keeps the blurred background off the
needle's silhouette, adds the bands in linear light (fluorescence adds), and
finishes with a faint glow and a light grain. Granules also dim with depth.
Lights touch only the needle: a studio environment the camera does not see,
plus two softboxes; its raytraced reflections pick up the glowing granules
beside it.

## Units and sizes

Lengths are in mean granule radii, time in seconds. Bath granule radii
0.78–1.22, ink 0.68–1.02, cells 0.33 (a 16 µm cell on 50 µm granules); needle
radius 3.5 with a bore of 2.45, tip 11 above the floor in a bed 20 deep and 30
wide; needle speed 3 per second; the frame shows 35 × 14 units (z 3 to 17);
loop 16 s at 30 fps = 480 frames, rendered 1920×768, encoded 1600 wide.
