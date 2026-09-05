#!/usr/bin/env python3
"""
Tools/generate_furniture.py
------------------------------------------------------------------------------
Generates the Spatialis furniture catalog as valid binary glTF (.glb) files.

Why generate rather than source models: every entry in FURNITURE_CATALOG needs a
prefab or the voice engine answers "No model loaded" for it, and downloaded
models arrive at arbitrary scale with arbitrary pivots. Generating them means
the two things the anchor engine depends on are correct by construction:

  ORIGIN AT THE BASE   Anchoring places an object's ORIGIN on the surface. A
                       model whose pivot sits at its centre would sink halfway
                       into the floor. Every piece here is authored with y=0 at
                       its footprint, so it rests on whatever it is placed on.
                       The one exception is wall art, whose origin is at its
                       vertical centre because it hangs rather than stands.

  REAL-WORLD SIZE      Dimensions match FURNITURE_CATALOG's footprint/height in
                       centimetres, so overlap rejection and the "by the wall"
                       offset operate on the same numbers the meshes use.

  +Z FORWARD           Matches yawTowards(), so a piece turned to face the user
                       actually faces them.

Geometry is deliberately low-poly and untextured: flat-shaded boxes and prisms
with PBR material factors only. That keeps the Lens small, costs no texture
memory on device, and gives PBRMaterialSwapper a clean baseColorFactor to
override at runtime.

Usage:
    python3 Tools/generate_furniture.py [--units cm|m] [--out DIR]

    --units cm  (default) emit centimetre magnitudes. Lens Studio world units
                are centimetres and its glTF importer does NOT convert metres
                unless "Convert meters to centimeters" is ticked (Snap docs).
    --units m   emit metres per the glTF 2.0 specification, for import with
                that option ticked. See ASSETS.md.

License: Apache-2.0
"""

import argparse
import json
import math
import os
import struct

# -----------------------------------------------------------------------------
# Materials - linear-space factors matching PBRMaterialSwapper's presets
# -----------------------------------------------------------------------------

MATERIALS = [
    ("oak",        (0.72, 0.58, 0.39), 0.0, 0.62),
    ("walnut",     (0.28, 0.18, 0.11), 0.0, 0.48),
    ("linen",      (0.86, 0.83, 0.76), 0.0, 0.94),
    ("matteBlack", (0.06, 0.06, 0.07), 0.3, 0.78),
    ("brass",      (0.76, 0.60, 0.28), 1.0, 0.32),
    ("marble",     (0.90, 0.90, 0.88), 0.0, 0.18),
    ("foliage",    (0.24, 0.42, 0.26), 0.0, 0.85),
    ("terracotta", (0.62, 0.28, 0.15), 0.0, 0.70),
    ("linenShade", (0.94, 0.91, 0.84), 0.0, 0.90),
]
MAT = {name: i for i, (name, _, _, _) in enumerate(MATERIALS)}

# -----------------------------------------------------------------------------
# Primitive builders. Each returns (positions, normals, indices) with flat
# normals - every face gets its own vertices so edges stay crisp when shaded.
# -----------------------------------------------------------------------------

def box(cx, cy, cz, sx, sy, sz):
    """Axis-aligned box centred at (cx,cy,cz) with full extents (sx,sy,sz)."""
    hx, hy, hz = sx / 2.0, sy / 2.0, sz / 2.0
    x0, x1 = cx - hx, cx + hx
    y0, y1 = cy - hy, cy + hy
    z0, z1 = cz - hz, cz + hz
    faces = [
        ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1)),
        ([(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)], (0, 0, -1)),
        ([(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], (1, 0, 0)),
        ([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)], (-1, 0, 0)),
        ([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], (0, 1, 0)),
        ([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0, -1, 0)),
    ]
    pos, nrm, idx = [], [], []
    for quad, n in faces:
        base = len(pos)
        for v in quad:
            pos.append(v)
            nrm.append(n)
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return pos, nrm, idx


def prism(cx, cy, cz, r_bottom, r_top, height, segments=12):
    """Vertical prism/cone frustum, base at cy. Used for legs, poles, shades."""
    pos, nrm, idx = [], [], []
    y0, y1 = cy, cy + height
    slope = math.atan2(r_bottom - r_top, height)
    ny_side = math.sin(slope)
    for s in range(segments):
        a0 = 2 * math.pi * s / segments
        a1 = 2 * math.pi * (s + 1) / segments
        for (a_start, a_end) in ((a0, a1),):
            c0, s0 = math.cos(a_start), math.sin(a_start)
            c1, s1 = math.cos(a_end), math.sin(a_end)
            quad = [
                (cx + c0 * r_bottom, y0, cz + s0 * r_bottom),
                (cx + c1 * r_bottom, y0, cz + s1 * r_bottom),
                (cx + c1 * r_top,    y1, cz + s1 * r_top),
                (cx + c0 * r_top,    y1, cz + s0 * r_top),
            ]
            am = (a_start + a_end) / 2.0
            n = (math.cos(am) * math.cos(slope), ny_side, math.sin(am) * math.cos(slope))
            base = len(pos)
            for v in quad:
                pos.append(v)
                nrm.append(n)
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    # Caps as triangle fans.
    for (y, r, n, flip) in ((y1, r_top, (0, 1, 0), False), (y0, r_bottom, (0, -1, 0), True)):
        if r <= 1e-6:
            continue
        centre = len(pos)
        pos.append((cx, y, cz))
        nrm.append(n)
        ring = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            ring.append(len(pos))
            pos.append((cx + math.cos(a) * r, y, cz + math.sin(a) * r))
            nrm.append(n)
        for s in range(segments):
            a, b = ring[s], ring[(s + 1) % segments]
            idx += [centre, b, a] if flip else [centre, a, b]
    return pos, nrm, idx


def cylinder(cx, cy, cz, r, h, segments=12):
    return prism(cx, cy, cz, r, r, h, segments)


def lathe(cx, cy, cz, profile, segments=16):
    """
    Surface of revolution from a (radius, height) profile, base at cy.
    A stack of frusta cannot make a shape that bulges and narrows again, which
    is exactly what separates a vase from a bucket.
    """
    pos, nrm, idx = [], [], []
    rings = []
    for (r, y) in profile:
        ring = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            ring.append((cx + math.cos(a) * r, cy + y, cz + math.sin(a) * r))
        rings.append((ring, r, y))
    for i in range(len(rings) - 1):
        (r0, rad0, y0) = rings[i]
        (r1, rad1, y1) = rings[i + 1]
        slope = math.atan2(rad0 - rad1, max(y1 - y0, 1e-6))
        cs, sn = math.cos(slope), math.sin(slope)
        for s in range(segments):
            t = (s + 1) % segments
            quad = [r0[s], r0[t], r1[t], r1[s]]
            am = 2 * math.pi * (s + 0.5) / segments
            n = (math.cos(am) * cs, sn, math.sin(am) * cs)
            base = len(pos)
            for v in quad:
                pos.append(v)
                nrm.append(n)
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    # Close the bottom; the top is left open, as a vessel is.
    (r0, rad0, y0) = rings[0]
    if rad0 > 1e-6:
        c = len(pos)
        pos.append((cx, cy + y0, cz)); nrm.append((0, -1, 0))
        start = len(pos)
        for v in r0:
            pos.append(v); nrm.append((0, -1, 0))
        for s in range(segments):
            idx += [c, start + (s + 1) % segments, start + s]
    return pos, nrm, idx


def blob(cx, cy, cz, rx, ry, rz, rings=6, segments=10):
    """Low-poly ellipsoid, centred. Used for plant foliage."""
    pos, nrm, idx = [], [], []
    grid = []
    for i in range(rings + 1):
        phi = math.pi * i / rings
        row = []
        for j in range(segments):
            th = 2 * math.pi * j / segments
            nx = math.sin(phi) * math.cos(th)
            ny = math.cos(phi)
            nz = math.sin(phi) * math.sin(th)
            row.append(len(pos))
            pos.append((cx + nx * rx, cy + ny * ry, cz + nz * rz))
            m = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            nrm.append((nx / m, ny / m, nz / m))
        grid.append(row)
    for i in range(rings):
        for j in range(segments):
            a = grid[i][j]
            b = grid[i][(j + 1) % segments]
            c = grid[i + 1][(j + 1) % segments]
            d = grid[i + 1][j]
            idx += [a, b, c, a, c, d]
    return pos, nrm, idx


# -----------------------------------------------------------------------------
# The catalog. Dimensions in centimetres, y=0 at the footprint, +Z forward.
# Keys match FURNITURE_CATALOG in Scripts/SpatialisCore.ts.
# -----------------------------------------------------------------------------

def legs(w, d, h, inset=6, thick=7, mat="matteBlack"):
    out = []
    for sx in (-1, 1):
        for sz in (-1, 1):
            out.append((mat, box(sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset),
                                 thick, h, thick)))
    return out


def make_sofa():
    W, D = 210.0, 85.0
    parts = legs(W, D, 16, inset=10, thick=8)
    parts.append(("linen", box(0, 16 + 11, 0, W, 22, D)))                    # base
    parts.append(("linen", box(0, 16 + 22 + 7, 6, W - 30, 14, D - 22)))      # seat cushions
    parts.append(("linen", box(0, 16 + 22 + 20, -D / 2 + 11, W, 40, 22)))    # back
    for sx in (-1, 1):
        parts.append(("linen", box(sx * (W / 2 - 8), 16 + 27, 0, 16, 54, D)))  # arms
    return parts


def make_chair():
    W, D = 88.0, 86.0
    parts = legs(W, D, 18, inset=8, thick=6)
    parts.append(("linen", box(0, 18 + 11, 0, W, 22, D)))
    parts.append(("linen", box(0, 18 + 22 + 6, 4, W - 22, 12, D - 20)))
    parts.append(("linen", box(0, 18 + 22 + 20, -D / 2 + 9, W, 42, 18)))
    for sx in (-1, 1):
        parts.append(("oak", box(sx * (W / 2 - 5), 18 + 24, 0, 10, 40, D - 8)))
    return parts


def make_table():
    W, D, H = 160.0, 90.0, 75.0
    parts = legs(W, D, H - 5, inset=9, thick=8, mat="walnut")
    parts.append(("oak", box(0, H - 2.5, 0, W, 5, D)))
    return parts


def make_coffee_table():
    W, D, H = 110.0, 60.0, 42.0
    parts = legs(W, D, H - 4, inset=7, thick=6, mat="walnut")
    parts.append(("walnut", box(0, H - 2, 0, W, 4, D)))
    parts.append(("walnut", box(0, 14, 0, W - 26, 3, D - 18)))   # lower shelf
    return parts


def make_lamp():
    parts = [("matteBlack", cylinder(0, 0, 0, 18, 3, 20))]
    parts.append(("brass", cylinder(0, 3, 0, 2.4, 117, 10)))
    parts.append(("linenShade", prism(0, 120, 0, 16, 22, 30, 20)))
    return parts


def make_table_lamp():
    parts = [("marble", cylinder(0, 0, 0, 10, 2.5, 18))]
    parts.append(("brass", cylinder(0, 2.5, 0, 1.8, 27, 10)))
    parts.append(("linenShade", prism(0, 29.5, 0, 10, 14, 15, 18)))
    return parts


def make_shelf():
    W, D, H = 80.0, 32.0, 180.0
    parts = []
    for sx in (-1, 1):
        parts.append(("oak", box(sx * (W / 2 - 1.5), H / 2, 0, 3, H, D)))
    for i in range(5):
        y = 4 + i * (H - 10) / 4.0
        parts.append(("oak", box(0, y, 0, W - 6, 3, D)))
    parts.append(("oak", box(0, H / 2, -D / 2 + 0.6, W - 6, H - 8, 1.2)))
    return parts


def make_plant():
    parts = [("terracotta", lathe(0, 0, 0,
              [(10, 0), (12, 4), (15, 20), (16, 27), (17, 30)], 18))]
    parts.append(("walnut", cylinder(0, 30, 0, 3, 26, 8)))
    parts.append(("foliage", blob(0, 78, 0, 30, 26, 30)))
    parts.append(("foliage", blob(-16, 62, 8, 16, 13, 16)))
    parts.append(("foliage", blob(15, 66, -9, 18, 14, 18)))
    return parts


def make_rug():
    return [("linen", box(0, 1, 0, 220, 2, 160))]


def make_artwork():
    # Wall piece: origin at the VERTICAL CENTRE, since it hangs rather than stands.
    W, H = 70.0, 50.0
    parts = [("walnut", box(0, 0, 0, W, H, 4))]
    parts.append(("linen", box(0, 0, 2.2, W - 10, H - 10, 0.6)))
    return parts


def make_vase():
    # Narrow foot, belly at 40% height, drawn-in neck, slight lip.
    profile = [(4.5, 0), (7.0, 4), (10.5, 12), (11.0, 17), (8.5, 23), (6.0, 27), (6.8, 30)]
    return [("marble", lathe(0, 0, 0, profile, 20))]


def make_bed():
    W, D = 160.0, 210.0
    parts = legs(W, D, 14, inset=9, thick=8, mat="walnut")
    parts.append(("walnut", box(0, 14 + 8, 0, W, 16, D)))
    parts.append(("linen", box(0, 14 + 16 + 10, 4, W - 6, 20, D - 8)))
    parts.append(("walnut", box(0, 14 + 40, -D / 2 + 3, W, 62, 6)))    # headboard
    for sx in (-1, 1):
        parts.append(("linenShade", box(sx * 36, 14 + 30, -D / 2 + 26, 62, 14, 36)))
    return parts


CATALOG = {
    "sofa": make_sofa,
    "chair": make_chair,
    "table": make_table,
    "coffeeTable": make_coffee_table,
    "lamp": make_lamp,
    "tableLamp": make_table_lamp,
    "shelf": make_shelf,
    "plant": make_plant,
    "rug": make_rug,
    "artwork": make_artwork,
    "vase": make_vase,
    "bed": make_bed,
}


# -----------------------------------------------------------------------------
# glTF assembly
# -----------------------------------------------------------------------------

def pad4(b, fill=b"\x00"):
    while len(b) % 4:
        b += fill
    return b


def build_glb(name, parts, scale):
    """Group parts by material into primitives, pack into a single-node GLB."""
    by_mat = {}
    for mat_name, (pos, nrm, idx) in parts:
        p, n, i = by_mat.setdefault(mat_name, ([], [], []))
        offset = len(p)
        p.extend(pos)
        n.extend(nrm)
        i.extend(x + offset for x in idx)

    buf = bytearray()
    views, accessors, primitives = [], [], []

    for mat_name, (pos, nrm, idx) in by_mat.items():
        if not idx:
            continue
        scaled = [(x * scale, y * scale, z * scale) for (x, y, z) in pos]

        # POSITION
        data = b"".join(struct.pack("<3f", *v) for v in scaled)
        buf += pad4(b"")
        views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), "target": 34962})
        buf += data
        mins = [min(v[i] for v in scaled) for i in range(3)]
        maxs = [max(v[i] for v in scaled) for i in range(3)]
        accessors.append({"bufferView": len(views) - 1, "componentType": 5126,
                          "count": len(scaled), "type": "VEC3", "min": mins, "max": maxs})
        pos_acc = len(accessors) - 1

        # NORMAL
        data = b"".join(struct.pack("<3f", *v) for v in nrm)
        buf = bytearray(pad4(bytes(buf)))
        views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), "target": 34962})
        buf += data
        accessors.append({"bufferView": len(views) - 1, "componentType": 5126,
                          "count": len(nrm), "type": "VEC3"})
        nrm_acc = len(accessors) - 1

        # INDICES
        wide = len(pos) > 65535
        fmt, ctype = ("<I", 5125) if wide else ("<H", 5123)
        data = b"".join(struct.pack(fmt, v) for v in idx)
        buf = bytearray(pad4(bytes(buf)))
        views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), "target": 34963})
        buf += data
        accessors.append({"bufferView": len(views) - 1, "componentType": ctype,
                          "count": len(idx), "type": "SCALAR"})
        idx_acc = len(accessors) - 1

        primitives.append({"attributes": {"POSITION": pos_acc, "NORMAL": nrm_acc},
                           "indices": idx_acc, "material": MAT[mat_name], "mode": 4})

    buf = bytearray(pad4(bytes(buf)))

    gltf = {
        "asset": {"version": "2.0", "generator": "Spatialis Tools/generate_furniture.py"},
        "scene": 0,
        "scenes": [{"name": name, "nodes": [0]}],
        "nodes": [{"name": name, "mesh": 0}],
        "meshes": [{"name": name, "primitives": primitives}],
        "materials": [
            {"name": m, "doubleSided": False,
             "pbrMetallicRoughness": {"baseColorFactor": [c[0], c[1], c[2], 1.0],
                                      "metallicFactor": mt, "roughnessFactor": rg}}
            for (m, c, mt, rg) in MATERIALS
        ],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(buf)}],
    }

    js = pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    bn = bytes(buf)
    total = 12 + 8 + len(js) + 8 + len(bn)
    out = struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(bn), 0x004E4942) + bn
    return out, len(primitives), gltf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--units", choices=["m", "cm"], default="cm")
    ap.add_argument("--out", default="Assets/Prefabs")
    a = ap.parse_args()

    scale = 0.01 if a.units == "m" else 1.0
    os.makedirs(a.out, exist_ok=True)

    print(f"units={a.units}  (geometry scale factor {scale})")
    total_tris = 0
    for key, fn in CATALOG.items():
        parts = fn()
        glb, prim_count, gltf = build_glb(key, parts, scale)
        tris = sum(acc["count"] for acc in gltf["accessors"]
                   if acc.get("type") == "SCALAR") // 3
        total_tris += tris
        path = os.path.join(a.out, f"{key}.glb")
        with open(path, "wb") as f:
            f.write(glb)
        print(f"  {key:<13} {len(glb):>7,} bytes  {tris:>5} tris  {prim_count} material group(s)")
    print(f"\n{len(CATALOG)} models, {total_tris:,} triangles total")


if __name__ == "__main__":
    main()
