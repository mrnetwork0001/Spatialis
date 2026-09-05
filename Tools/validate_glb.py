#!/usr/bin/env python3
"""
Tools/validate_glb.py
------------------------------------------------------------------------------
Independent validator for the generated furniture. Parses each .glb from raw
bytes without reusing the generator's code or assumptions, then checks the
things Spatialis actually depends on.

Structural checks catch a malformed container. The dimension and origin checks
catch the failure that would be invisible until a sofa is floating a metre off
the floor in a headset.

Usage: python3 Tools/validate_glb.py [--dir Assets/Prefabs] [--units m|cm]
License: Apache-2.0
"""

import argparse, json, os, struct, sys

# key -> (width_cm, depth_cm, height_cm, origin_mode)
# Tolerances are generous; the point is catching a 100x error, not a 2cm one.
EXPECTED = {
    # key -> (width_cm, depth_cm, height_cm, origin_mode)
    # Values are the true authored dimensions, so a geometry change that shifts
    # a piece's size shows up here rather than passing on a loose tolerance.
    "sofa":        (210, 85,  78,  "base"),
    "chair":       (88,  86,  81,  "base"),
    "table":       (160, 90,  75,  "base"),
    "coffeeTable": (110, 60,  42,  "base"),
    "lamp":        (44,  44,  150, "base"),
    "tableLamp":   (28,  28,  44,  "base"),
    "shelf":       (80,  32,  180, "base"),
    "plant":       (65,  57,  104, "base"),
    "rug":         (220, 160, 2,   "base"),
    # Wall art is thin in DEPTH and tall in HEIGHT - a picture frame, not a slab.
    "artwork":     (70,  4,   50,  "center"),
    "vase":        (22,  22,  30,  "base"),
    "bed":         (160, 210, 85,  "base"),
}

COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
             5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def parse_glb(raw):
    if len(raw) < 12:
        raise ValueError("shorter than a GLB header")
    magic, version, length = struct.unpack("<III", raw[:12])
    if magic != 0x46546C67:
        raise ValueError(f"bad magic 0x{magic:08X}, expected 0x46546C67 ('glTF')")
    if version != 2:
        raise ValueError(f"glTF version {version}, expected 2")
    if length != len(raw):
        raise ValueError(f"header length {length} != actual {len(raw)}")
    off, js, bn = 12, None, b""
    while off < len(raw):
        clen, ctype = struct.unpack("<II", raw[off:off + 8])
        body = raw[off + 8: off + 8 + clen]
        if len(body) != clen:
            raise ValueError("chunk truncated")
        if ctype == 0x4E4F534A:
            js = json.loads(body.decode("utf-8"))
        elif ctype == 0x004E4942:
            bn = body
        off += 8 + clen
        if off % 4:
            raise ValueError("chunk not 4-byte aligned")
    if js is None:
        raise ValueError("no JSON chunk")
    return js, bn


def read_accessor(g, bn, i):
    acc = g["accessors"][i]
    fmt, size = COMPONENT[acc["componentType"]]
    n = NCOMP[acc["type"]]
    bv = g["bufferViews"][acc["bufferView"]]
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    if start % size:
        raise ValueError(f"accessor {i} offset {start} not aligned to {size}")
    if start + acc["count"] * n * size > len(bn) :
        raise ValueError(f"accessor {i} reads past the buffer")
    out = []
    for e in range(acc["count"]):
        base = start + e * n * size
        out.append(struct.unpack_from("<" + fmt * n, bn, base))
    return out


def check(path, key, scale_to_cm):
    raw = open(path, "rb").read()
    g, bn = parse_glb(raw)
    errs, warns = [], []

    if g.get("asset", {}).get("version") != "2.0":
        errs.append("asset.version is not 2.0")
    if len(g.get("buffers", [])) != 1 or g["buffers"][0]["byteLength"] != len(bn):
        errs.append("buffer byteLength disagrees with the BIN chunk")

    verts = []
    tri_total = 0
    for mesh in g.get("meshes", []):
        for p in mesh["primitives"]:
            if p.get("mode", 4) != 4:
                errs.append("primitive mode is not TRIANGLES")
            pos = read_accessor(g, bn, p["attributes"]["POSITION"])
            verts.extend(pos)
            if "NORMAL" in p["attributes"]:
                nrm = read_accessor(g, bn, p["attributes"]["NORMAL"])
                if len(nrm) != len(pos):
                    errs.append("NORMAL count != POSITION count")
                for v in nrm[:40]:
                    m = sum(c * c for c in v) ** 0.5
                    if abs(m - 1.0) > 0.02:
                        errs.append(f"normal not unit length ({m:.3f})")
                        break
            idx = [t[0] for t in read_accessor(g, bn, p["indices"])]
            if len(idx) % 3:
                errs.append("index count not a multiple of 3")
            tri_total += len(idx) // 3
            if idx and max(idx) >= len(pos):
                errs.append(f"index {max(idx)} out of range for {len(pos)} vertices")
            mi = p.get("material")
            if mi is None or mi >= len(g.get("materials", [])):
                errs.append("primitive references a missing material")
            # POSITION accessors are required by spec to carry min/max.
            acc = g["accessors"][p["attributes"]["POSITION"]]
            if "min" not in acc or "max" not in acc:
                errs.append("POSITION accessor missing min/max")

    if not verts:
        errs.append("no geometry")
        return errs, warns, None

    xs = [v[0] for v in verts]; ys = [v[1] for v in verts]; zs = [v[2] for v in verts]
    w = (max(xs) - min(xs)) * scale_to_cm
    h = (max(ys) - min(ys)) * scale_to_cm
    d = (max(zs) - min(zs)) * scale_to_cm
    y_min = min(ys) * scale_to_cm
    x_c = (max(xs) + min(xs)) / 2 * scale_to_cm
    z_c = (max(zs) + min(zs)) / 2 * scale_to_cm

    ew, ed, eh, origin = EXPECTED[key]
    for label, actual, expect in (("width", w, ew), ("depth", d, ed), ("height", h, eh)):
        if expect > 0 and abs(actual - expect) > max(1.5, expect * 0.03):
            errs.append(f"{label} {actual:.1f}cm, expected ~{expect}cm")

    if origin == "base":
        if abs(y_min) > 1.0:
            errs.append(f"origin not at base: lowest vertex at y={y_min:.2f}cm, expected 0")
    else:
        y_c = (max(ys) + min(ys)) / 2 * scale_to_cm
        if abs(y_c) > 1.0:
            errs.append(f"origin not centred: centre at y={y_c:.2f}cm, expected 0")
    if abs(x_c) > 1.5 or abs(z_c) > 1.5:
        warns.append(f"not centred on X/Z (x={x_c:.1f} z={z_c:.1f})")

    return errs, warns, (w, d, h, tri_total, len(raw))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="Assets/Prefabs")
    ap.add_argument("--units", choices=["m", "cm"], default="cm")
    a = ap.parse_args()
    scale_to_cm = 100.0 if a.units == "m" else 1.0

    print(f"validating {a.dir} (authored in {a.units})\n")
    print(f"  {'model':<13} {'W':>7} {'D':>7} {'H':>7} {'tris':>6} {'bytes':>8}  status")
    print("  " + "-" * 62)
    bad = 0
    for key in EXPECTED:
        path = os.path.join(a.dir, f"{key}.glb")
        if not os.path.exists(path):
            print(f"  {key:<13} {'':>7} {'':>7} {'':>7} {'':>6} {'':>8}  MISSING")
            bad += 1
            continue
        try:
            errs, warns, dims = check(path, key, scale_to_cm)
        except Exception as e:
            print(f"  {key:<13} {'':>7} {'':>7} {'':>7} {'':>6} {'':>8}  PARSE FAIL: {e}")
            bad += 1
            continue
        w, d, h, tris, size = dims
        status = "ok" if not errs else "FAIL"
        if errs:
            bad += 1
        print(f"  {key:<13} {w:>6.0f}c {d:>6.0f}c {h:>6.0f}c {tris:>6} {size:>8,}  {status}")
        for e in errs:
            print(f"       ERROR: {e}")
        for wn in warns:
            print(f"       warn:  {wn}")
    print()
    if bad:
        print(f"{bad} model(s) FAILED validation")
        sys.exit(1)
    print(f"all {len(EXPECTED)} models valid")


if __name__ == "__main__":
    main()
