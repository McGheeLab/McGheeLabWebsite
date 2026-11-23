"""
render_blender.py — Blender (Eevee) renderer for the hero loop (loopify.py's output).

  /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/hero_video/render_blender.py -- \
      <loop.npz> <outdir> [--frames A B] [--still N] [--bands 0 1 2 3] [--res 1920 768]

A close side view of the needle in the bath. The camera is orthographic, looks
along +y, tracks the needle and is zoomed so the bed's top and floor are out of
frame. The bath in front of the needle's axis is cut away (granule centres with
y < Y_CUT are not drawn); everything behind it is.

Depth of field is done in depth bands: each frame is rendered once per band,
every granule drawn into the two bands either side of its depth with weights
that slide linearly between them (so nothing pops as granules flow round the
needle), and optics.py blurs each band by its defocus and adds them up.
Granules also dim with depth. Band 0 (in focus) carries the needle; in the
other bands the needle is a holdout, so it hides what is behind it.

Granules are rough convex polyhedra (16 random hulls, each granule its own
rotation) — the crushed, sieved microgels of the lab's baths — squashed by the
volume-preserving shape tensor loopify.py computed from their contacts, so
they flatten against the needle and against each other. They are
self-luminous and mostly transparent, as if the whole gel were dyed: the bath
FITC green, the ink rhodamine orange-red, cells Cy5 magenta. Lights touch only
the needle, a brushed-steel cannula lit by a studio environment that the camera
does not see; its raytraced reflections pick up the glowing granules beside it.

Writes <outdir>/b<band>/f_NNNN.png (f_0001 = loop frame 0) and <outdir>/layout.json.
"""
import bpy, bmesh, sys, json, math, time, os
import numpy as np
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def opt(name, default, n=1, cast=float):
    if name in argv:
        i = argv.index(name); vals = [cast(v) for v in argv[i + 1:i + 1 + n]]
        return vals if n > 1 else vals[0]
    return default
def opt_list(name, default, cast=int):
    if name not in argv: return default
    i = argv.index(name) + 1; out = []
    while i < len(argv) and not argv[i].startswith('--'): out.append(cast(argv[i])); i += 1
    return out
NPZ, OUT = argv[0], argv[1]
RES = opt('--res', [1920, 768], 2, int)
FRAMES = opt('--frames', None, 2, int); STILL = opt('--still', None, 1, int)
BANDS = opt_list('--bands', [0, 1, 2, 3])
SAMPLES = {0: opt('--samples', 64, 1, int)}            # in-focus band; the blurred bands need fewer
SC = 0.01                     # 1 sim unit (one mean granule radius) = 1 cm
NEEDLE_FRAC = 0.62            # where the needle sits across the frame
VIEW_H = 14.0                 # sim units top to bottom of the frame
Z_CENTER = 10.0               # frame spans z = 3 … 17 (bed 0 … 20, so floor and top are out of frame)
Y_CUT = -1.2                  # granule centres nearer the camera than this are cut away
YB = [0.0, 2.5, 5.5, 9.0]     # depth-band centres (sim units behind the needle's axis)
Y_FAR = 12.5                  # nothing drawn beyond this depth
SIGMA = [0.0, 3.0, 7.0, 12.0] # defocus blur per band, px at 1920 wide (used by optics.py; written to layout.json)
BAND_SCALE = [1.0, 0.5, 0.5, 0.5]   # render resolution per band (blurred bands lose nothing at half size)
ALPHA = 0.32                  # a granule's opacity
DIM_LEN = 2.4                 # brightness falls by e every DIM_LEN units of depth past y = 0.5
INK_GAIN = 1.4                # the ink is brighter than the bath, so the line reads
COL_BATH = (0.20, 1.0, 0.28)  # FITC
COL_INK = (1.0, 0.12, 0.06)   # rhodamine
COL_CELL = (1.0, 0.10, 0.62)  # Cy5, as magenta
N_SHAPES = 16
os.makedirs(OUT, exist_ok=True)

d = np.load(NPZ); meta = json.loads(str(d['meta'])); P = meta['P']
gpos = d['gpos']; rad = d['rad'].astype(np.float32); typ = d['typ']
gscale = d['gscale'] if 'gscale' in d else None
gdef = d['gdef'] if 'gdef' in d else None
cpos = d['cpos']; cu = d['cu']; cspread = d['cspread']; cbr = d['cbr']; ptar = d['ptar']; pgrow = d['pgrow']; needle = d['needle']
cscale = d['cscale'] if 'cscale' in d else None
NF, N, _ = gpos.shape; C = cpos.shape[1]; S = ptar.shape[2]
Rn, ztip, r_cell = P['Rn'], P['ztip'], P['r_cell']
VIEW_W = VIEW_H*RES[0]/RES[1]
print(f'data: {NF} frames, {N} granules, {C} cells; frame {VIEW_W:.0f} × {VIEW_H:.0f} units; bands {BANDS}')

# ───────────────────────── scene ─────────────────────────
sc = bpy.context.scene
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.node_groups, bpy.data.collections):
    for x in list(coll):
        try: coll.remove(x)
        except Exception: pass
def link(ob, col=None): (col or sc.collection).objects.link(ob); return ob
def set_blend(m):
    for a_, v_ in (('surface_render_method', 'DITHERED'), ('blend_method', 'HASHED')):
        try: setattr(m, a_, v_)
        except Exception: pass

def fluor_material(name, edge, base):
    """Self-luminous and transparent; colour and opacity from the per-instance attribute 'col'; a little
    brighter at grazing edges and mottled by a noise, as dyed gel is."""
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    mix = nt.nodes.new('ShaderNodeMixShader'); trans = nt.nodes.new('ShaderNodeBsdfTransparent'); emi = nt.nodes.new('ShaderNodeEmission')
    attr = nt.nodes.new('ShaderNodeAttribute'); attr.attribute_name = 'col'; attr.attribute_type = 'INSTANCER'
    lw = nt.nodes.new('ShaderNodeLayerWeight'); lw.inputs['Blend'].default_value = 0.5
    pw = nt.nodes.new('ShaderNodeMath'); pw.operation = 'POWER'; pw.inputs[1].default_value = 2.0
    ma = nt.nodes.new('ShaderNodeMath'); ma.operation = 'MULTIPLY_ADD'; ma.inputs[1].default_value = edge; ma.inputs[2].default_value = base
    tco = nt.nodes.new('ShaderNodeTexCoord'); tex = nt.nodes.new('ShaderNodeTexNoise')
    tex.inputs['Scale'].default_value = 140; tex.inputs['Detail'].default_value = 2.5; tex.inputs['Roughness'].default_value = 0.6
    tr = nt.nodes.new('ShaderNodeMath'); tr.operation = 'MULTIPLY_ADD'; tr.inputs[1].default_value = 0.6; tr.inputs[2].default_value = 0.7
    mu = nt.nodes.new('ShaderNodeMath'); mu.operation = 'MULTIPLY'
    L = nt.links.new
    L(lw.outputs['Facing'], pw.inputs[0]); L(pw.outputs[0], ma.inputs[0])
    L(tco.outputs['Object'], tex.inputs['Vector']); L(tex.outputs['Fac'], tr.inputs[0])
    L(ma.outputs[0], mu.inputs[0]); L(tr.outputs[0], mu.inputs[1])
    L(attr.outputs['Color'], emi.inputs['Color']); L(mu.outputs[0], emi.inputs['Strength'])
    L(attr.outputs['Alpha'], mix.inputs['Fac'])
    L(trans.outputs[0], mix.inputs[1]); L(emi.outputs[0], mix.inputs[2]); L(mix.outputs[0], out.inputs['Surface'])
    set_blend(m); m.use_backface_culling = False
    return m
mat_g = fluor_material('gel', edge=1.3, base=0.42)
mat_c = fluor_material('cell', edge=0.5, base=0.7)
mat_steel = bpy.data.materials.new('steel'); mat_steel.use_nodes = True
bsdf = mat_steel.node_tree.nodes['Principled BSDF']
for k_, v_ in (('Base Color', (0.86, 0.87, 0.89, 1)), ('Metallic', 1.0), ('Roughness', 0.2), ('Anisotropic', 0.5)):
    if k_ in bsdf.inputs: bsdf.inputs[k_].default_value = v_
# fine vertical brushing: a stretched noise nudges the roughness
mt = mat_steel.node_tree
tco = mt.nodes.new('ShaderNodeTexCoord'); mp = mt.nodes.new('ShaderNodeMapping'); mp.inputs['Scale'].default_value = (400, 400, 4)
nz = mt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 1.0; nz.inputs['Detail'].default_value = 6
rm = mt.nodes.new('ShaderNodeMapRange'); rm.inputs['To Min'].default_value = 0.14; rm.inputs['To Max'].default_value = 0.28
mt.links.new(tco.outputs['Object'], mp.inputs['Vector']); mt.links.new(mp.outputs['Vector'], nz.inputs['Vector'])
mt.links.new(nz.outputs['Fac'], rm.inputs['Value']); mt.links.new(rm.outputs['Result'], bsdf.inputs['Roughness'])

# ── source geometry: 16 rough convex polyhedra, a cell ellipsoid, a protrusion cone ──
shapes = bpy.data.collections.new('shapes'); sc.collection.children.link(shapes)
rng = np.random.default_rng(11)
for k in range(N_SHAPES):
    n = int(rng.integers(9, 15))
    pts = rng.normal(size=(n, 3)); pts /= np.linalg.norm(pts, axis=1)[:, None]
    pts *= rng.uniform(0.82, 1.06, (n, 1))*rng.uniform(0.88, 1.12, (1, 3))     # a squashed, chipped chunk
    bm = bmesh.new()
    for p_ in pts: bm.verts.new(p_)
    bmesh.ops.convex_hull(bm, input=bm.verts)
    me = bpy.data.meshes.new(f'chunk{k:02d}'); bm.to_mesh(me); bm.free()
    me.materials.append(mat_g)
    ob = bpy.data.objects.new(f'chunk{k:02d}', me); shapes.objects.link(ob); ob.hide_render = True; ob.hide_viewport = True
def smooth(ob):
    for p in ob.data.polygons: p.use_smooth = True
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=1.0)
cel = bpy.context.object; cel.name = 'src_cell'; smooth(cel); cel.data.materials.append(mat_c); cel.hide_render = True; cel.hide_viewport = True
bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=1.0, radius2=0.35, depth=1.0)
cone = bpy.context.object; cone.name = 'src_cone'; cone.data.transform(Matrix.Translation((0, 0, 0.5))); smooth(cone)
cone.data.materials.append(mat_c); cone.hide_render = True; cone.hide_viewport = True

def points_object(name, n, attrs):
    me = bpy.data.meshes.new(name); me.from_pydata([(0.0, 0.0, -1.0)]*n, [], [])
    for an, at in attrs: me.attributes.new(an, at, 'POINT')
    return link(bpy.data.objects.new(name, me)), me
def gn_matrix_instancer(ob, coll, idx_attr):
    """Instance one of the collection's children per point and give it the point's full 4×4 transform."""
    ng = bpy.data.node_groups.new(ob.name + '_gn', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nin = ng.nodes.new('NodeGroupInput'); nout = ng.nodes.new('NodeGroupOutput')
    iop = ng.nodes.new('GeometryNodeInstanceOnPoints')
    info = ng.nodes.new('GeometryNodeCollectionInfo'); info.inputs['Collection'].default_value = coll
    info.inputs['Separate Children'].default_value = True; info.inputs['Reset Children'].default_value = True
    iop.inputs['Pick Instance'].default_value = True
    na_i = ng.nodes.new('GeometryNodeInputNamedAttribute'); na_i.data_type = 'INT'; na_i.inputs['Name'].default_value = idx_attr
    sit = ng.nodes.new('GeometryNodeSetInstanceTransform')
    na_m = ng.nodes.new('GeometryNodeInputNamedAttribute'); na_m.data_type = 'FLOAT4X4'; na_m.inputs['Name'].default_value = 'xf'
    L = ng.links.new
    L(nin.outputs['Geometry'], iop.inputs['Points']); L(info.outputs['Instances'], iop.inputs['Instance'])
    L(na_i.outputs['Attribute'], iop.inputs['Instance Index']); L(iop.outputs['Instances'], sit.inputs['Instances'])
    L(na_m.outputs['Attribute'], sit.inputs['Transform']); L(sit.outputs['Instances'], nout.inputs['Geometry'])
    ob.modifiers.new('gn', 'NODES').node_group = ng
def gn_instancer(ob, src):
    ng = bpy.data.node_groups.new(ob.name + '_gn', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nin = ng.nodes.new('NodeGroupInput'); nout = ng.nodes.new('NodeGroupOutput')
    iop = ng.nodes.new('GeometryNodeInstanceOnPoints')
    info = ng.nodes.new('GeometryNodeObjectInfo'); info.inputs['Object'].default_value = src
    na_s = ng.nodes.new('GeometryNodeInputNamedAttribute'); na_s.data_type = 'FLOAT_VECTOR'; na_s.inputs['Name'].default_value = 'scl'
    na_r = ng.nodes.new('GeometryNodeInputNamedAttribute'); na_r.data_type = 'FLOAT_VECTOR'; na_r.inputs['Name'].default_value = 'rot'
    L = ng.links.new
    L(nin.outputs['Geometry'], iop.inputs['Points']); L(info.outputs['Geometry'], iop.inputs['Instance'])
    L(na_s.outputs['Attribute'], iop.inputs['Scale']); L(na_r.outputs['Attribute'], iop.inputs['Rotation'])
    L(iop.outputs['Instances'], nout.inputs['Geometry'])
    ob.modifiers.new('gn', 'NODES').node_group = ng

ob_g, me_g = points_object('granules', N, [('xf', 'FLOAT4X4'), ('col', 'FLOAT_COLOR'), ('idx', 'INT')])
gn_matrix_instancer(ob_g, shapes, 'idx')
ob_c, me_c = points_object('cells', C, [('scl', 'FLOAT_VECTOR'), ('rot', 'FLOAT_VECTOR'), ('col', 'FLOAT_COLOR')])
gn_instancer(ob_c, cel)
NP = C*S
ob_p, me_p = points_object('protrusions', NP, [('scl', 'FLOAT_VECTOR'), ('rot', 'FLOAT_VECTOR'), ('col', 'FLOAT_COLOR')])
gn_instancer(ob_p, cone)
# static per granule: shape, a uniformly random rotation, a tint
me_g.attributes['idx'].data.foreach_set('value', rng.integers(0, N_SHAPES, N).astype(np.int32))
q = rng.normal(size=(N, 4)); q /= np.linalg.norm(q, axis=1)[:, None]
w_, x_, y_, z_ = q.T
ROT = np.stack([np.stack([1-2*(y_*y_+z_*z_), 2*(x_*y_-w_*z_), 2*(x_*z_+w_*y_)], -1),
                np.stack([2*(x_*y_+w_*z_), 1-2*(x_*x_+z_*z_), 2*(y_*z_-w_*x_)], -1),
                np.stack([2*(x_*z_-w_*y_), 2*(y_*z_+w_*x_), 1-2*(x_*x_+y_*y_)], -1)], 1)     # (N, 3, 3)
tint = rng.uniform(0.75, 1.15, N).astype(np.float32)
base_rgb = np.where((typ == 1)[:, None], INK_GAIN*np.array(COL_INK), np.array(COL_BATH)).astype(np.float32)*tint[:, None]

# ── the needle: a blunt steel cannula ──
Z_TOP = 40.0
bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=Rn*SC, depth=(Z_TOP - ztip)*SC)
nd = bpy.context.object; nd.name = 'needle'; nd.data.transform(Matrix.Translation((0, 0, 0.5*(Z_TOP + ztip)*SC)))
nd.data.materials.append(mat_steel)
bv = nd.modifiers.new('bevel', 'BEVEL'); bv.width = 0.18*SC; bv.segments = 4; bv.limit_method = 'ANGLE'; bv.angle_limit = math.radians(60)
bpy.context.view_layer.objects.active = nd; nd.select_set(True)
try: bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
except Exception as e: print('shade_smooth_by_angle unavailable:', e); smooth(nd)

# ── camera, lights and a world the camera does not see ──
cam = bpy.data.cameras.new('cam'); cam.type = 'ORTHO'; cam.ortho_scale = VIEW_W*SC; cam.clip_start = 0.01; cam.clip_end = 5
camo = link(bpy.data.objects.new('cam', cam)); sc.camera = camo
camo.rotation_euler = (math.radians(90), 0, 0)
def area(name, loc, energy, size, color=(1, 1, 1)):
    l = bpy.data.lights.new(name, 'AREA'); l.energy = energy; l.size = size; l.color = color
    o = link(bpy.data.objects.new(name, l)); o.location = loc
    o.rotation_euler = (-Vector(loc)).to_track_quat('-Z', 'Y').to_euler(); return o
key = area('key', (-0.25, -0.35, 0.30), 9.0, 0.08)            # a narrow softbox up and to the left: the long highlight
rim = area('rim', (0.30, 0.10, 0.20), 4.0, 0.15, (0.85, 0.92, 1.0))
lights = [key, rim]
w = bpy.data.worlds.new('world'); sc.world = w; w.use_nodes = True; wt = w.node_tree
for n in list(wt.nodes): wt.nodes.remove(n)
wout = wt.nodes.new('ShaderNodeOutputWorld'); bgL = wt.nodes.new('ShaderNodeBackground'); bgC = wt.nodes.new('ShaderNodeBackground')
bgC.inputs['Color'].default_value = (0, 0, 0, 1); bgC.inputs['Strength'].default_value = 0.0; bgL.inputs['Strength'].default_value = 0.6
env = wt.nodes.new('ShaderNodeTexEnvironment')
for dp, dn, fn in os.walk(os.path.dirname(bpy.app.binary_path) + '/../Resources'):
    if 'studio.exr' in fn: env.image = bpy.data.images.load(os.path.join(dp, 'studio.exr')); break
wt.links.new(env.outputs['Color'], bgL.inputs['Color'])
lp = wt.nodes.new('ShaderNodeLightPath'); wmix = wt.nodes.new('ShaderNodeMixShader')
wt.links.new(lp.outputs['Is Camera Ray'], wmix.inputs['Fac']); wt.links.new(bgL.outputs[0], wmix.inputs[1]); wt.links.new(bgC.outputs[0], wmix.inputs[2])
wt.links.new(wmix.outputs[0], wout.inputs['Surface'])

# ── render settings ──
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = RES
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'
sc.render.film_transparent = False
ee = sc.eevee
for a, v in (('use_raytracing', True), ('use_shadows', False), ('use_fast_gi', False)):
    if hasattr(ee, a): setattr(ee, a, v)
try: ee.ray_tracing_options.resolution_scale = '1'
except Exception: pass
sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'; sc.view_settings.exposure = 0.0
json.dump(dict(res=RES, sigma=SIGMA, band_scale=BAND_SCALE, bands=BANDS,
               needle_px=[NEEDLE_FRAC*RES[0] - Rn/VIEW_W*RES[0], NEEDLE_FRAC*RES[0] + Rn/VIEW_W*RES[0],
                          (Z_CENTER + VIEW_H/2 - ztip)/VIEW_H*RES[1]]),
          open(os.path.join(OUT, 'layout.json'), 'w'))

# ───────────────────────── per-frame update ─────────────────────────
def band_weight(y, b):
    """Hat functions over the band centres; band 0 holds everything in front of YB[0]; the last fades out by Y_FAR."""
    w = np.zeros_like(y)
    c = YB[b]
    if b == 0: w = np.where(y <= c, 1.0, 0.0)
    if b > 0:
        lo = YB[b - 1]; w = np.where((y > lo) & (y <= c), (y - lo)/(c - lo), w)
    if b < len(YB) - 1:
        hi = YB[b + 1]; w = np.where((y > c) & (y < hi), (hi - y)/(hi - c), w)
    else:
        w = np.where(y > c, np.clip((Y_FAR - y)/(Y_FAR - c), 0, 1), w)
    return w
def dim(y):
    return np.exp(-np.maximum(y - 0.5, 0)/DIM_LEN)
def euler_z(z, xhint):
    z = Vector(z); n = z.length
    z = z/n if n > 1e-9 else Vector((0, 0, 1))
    x = Vector(xhint) - z*(Vector(xhint).dot(z))
    if x.length < 1e-4:
        x = Vector((1, 0, 0)) - z*z.x
        if x.length < 1e-4: x = Vector((0, 1, 0)) - z*z.y
    x.normalize(); y = z.cross(x)
    return Matrix(((x.x, y.x, z.x), (x.y, y.y, z.y), (x.z, y.z, z.z))).to_euler('XYZ')

def set_frame(fi, band):
    xn, yn = float(needle[fi, 0]), float(needle[fi, 1])
    xcam = xn - (NEEDLE_FRAC - 0.5)*VIEW_W
    g = gpos[fi].astype(np.float64)
    gx = g[:, 0] - xcam; y = g[:, 1] - yn
    inframe = (g[:, 2] > -10) & (np.abs(gx) < VIEW_W/2 + 3) & (g[:, 2] > Z_CENTER - VIEW_H/2 - 3) & (g[:, 2] < Z_CENTER + VIEW_H/2 + 3)
    wb = band_weight(y, band)*(y >= Y_CUT)*inframe
    s = rad*(gscale[fi] if gscale is not None else 1.0)*SC*(wb > 1e-3)
    if gdef is not None:
        D = gdef[fi].astype(np.float64)
        B = np.zeros((N, 3, 3)); B[:, 0, 0] = 1 + D[:, 0]; B[:, 1, 1] = 1 + D[:, 1]; B[:, 2, 2] = 1 + D[:, 2]
        B[:, 0, 1] = B[:, 1, 0] = D[:, 3]; B[:, 0, 2] = B[:, 2, 0] = D[:, 4]; B[:, 1, 2] = B[:, 2, 1] = D[:, 5]
        Mx = np.einsum('nij,njk->nik', B, ROT)*s[:, None, None]
    else:
        Mx = ROT*s[:, None, None]
    X = np.zeros((N, 4, 4), np.float32); X[:, :3, :3] = Mx; X[:, :3, 3] = g*SC; X[:, 3, 3] = 1
    me_g.attributes['xf'].data.foreach_set('value', np.ascontiguousarray(X.transpose(0, 2, 1)).ravel())
    col = np.concatenate([base_rgb*dim(y)[:, None].astype(np.float32), (ALPHA*wb)[:, None].astype(np.float32)], axis=1)
    me_g.attributes['col'].data.foreach_set('color', col.ravel())
    me_g.update()
    # cells and their protrusions
    pc = cpos[fi]; act = pc[:, 2] > -10
    cy = pc[:, 1] - yn
    cw = band_weight(cy, band)*(cy >= Y_CUT)*act
    cs = cscale[fi] if cscale is not None else np.ones(C)
    rot = np.zeros((C, 3), np.float32); scl = np.zeros((C, 3), np.float32)
    for c in np.nonzero(cw > 1e-3)[0]:
        sp = cspread[fi, c]; br = cbr[fi, c]; el = min(float(np.linalg.norm(br)), 1.0)
        e = euler_z(cu[fi, c], br if el > 1e-3 else (1, 0, 0))
        rot[c] = (e.x, e.y, e.z)
        scl[c] = np.array((r_cell*(1 + 0.6*sp + 0.8*el), r_cell*(1 + 0.6*sp), r_cell*(1 - 0.4*sp)))*SC*cs[c]
    me_c.vertices.foreach_set('co', (pc*SC).astype(np.float32).ravel())
    me_c.attributes['rot'].data.foreach_set('vector', rot.ravel()); me_c.attributes['scl'].data.foreach_set('vector', scl.ravel())
    ccol = np.zeros((C, 4), np.float32); ccol[:, :3] = np.array(COL_CELL)*dim(cy)[:, None]; ccol[:, 3] = np.clip(0.85*cw, 0, 1)
    me_c.attributes['col'].data.foreach_set('color', ccol.ravel())
    me_c.update()
    pp = np.zeros((NP, 3), np.float32); pp[:, 2] = -1.0
    prot = np.zeros((NP, 3), np.float32); pscl = np.zeros((NP, 3), np.float32); pcol = np.zeros((NP, 4), np.float32)
    for c in np.nonzero(cw > 1e-3)[0]:
        for s_ in range(S):
            t = ptar[fi, c, s_]; gr = pgrow[fi, c, s_]
            if t < 0 or gr <= 0 or g[t, 2] < -10: continue
            v = g[t] - pc[c]; dist = float(np.linalg.norm(v))
            length = max(dist - 0.92*rad[t], 0.05)*gr
            i = c*S + s_
            pp[i] = pc[c]*SC; e = euler_z(v, (0, 0, 1)); prot[i] = (e.x, e.y, e.z)
            thick = r_cell*0.6*(0.6 + 0.4*cspread[fi, c])*cs[c]
            pscl[i] = (thick*SC, thick*SC, length*SC)
            pcol[i, :3] = np.array(COL_CELL)*dim(np.array([cy[c]]))[0]; pcol[i, 3] = min(0.85*cw[c], 1.0)
    me_p.vertices.foreach_set('co', pp.ravel())
    me_p.attributes['rot'].data.foreach_set('vector', prot.ravel()); me_p.attributes['scl'].data.foreach_set('vector', pscl.ravel())
    me_p.attributes['col'].data.foreach_set('color', pcol.ravel())
    me_p.update()
    # needle, camera, band settings
    nd.location = (xn*SC, yn*SC, 0)
    nd.is_holdout = band > 0
    for l in lights: l.location.x = l.location.x  # (lights ride with the camera below)
    camo.location = (xcam*SC, -0.5, Z_CENTER*SC)
    key.location = (xcam*SC - 0.25, -0.35, 0.30 + Z_CENTER*SC); rim.location = (xcam*SC + 0.30, 0.10, 0.20 + Z_CENTER*SC)
    for o in (key, rim): o.rotation_euler = (Vector((xn*SC, 0, Z_CENTER*SC)) - o.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.resolution_percentage = int(round(100*BAND_SCALE[band]))
    sc.eevee.taa_render_samples = SAMPLES.get(band, 16)

t0 = time.time()
frames = [STILL] if STILL is not None else list(range(*(FRAMES[0], FRAMES[1] + 1) if FRAMES else (0, NF)))
for b in BANDS: os.makedirs(os.path.join(OUT, f'b{b}'), exist_ok=True)
for k, fi in enumerate(frames):
    for b in BANDS:
        set_frame(fi, b)
        sc.render.filepath = os.path.join(OUT, f'b{b}', f'f_{fi + 1:04d}.png')
        bpy.ops.render.render(write_still=True)
    if k % 20 == 0:
        el = time.time() - t0
        print(f'frame {fi} done ({k + 1}/{len(frames)}, {el:.0f}s, {el/(k + 1):.2f}s/frame)', flush=True)
print(f'rendered {len(frames)} frames × {len(BANDS)} bands → {OUT}  ({time.time() - t0:.0f}s)')
