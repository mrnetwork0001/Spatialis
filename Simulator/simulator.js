/**
 * simulator.js
 * -----------------------------------------------------------------------------
 * A desk simulator for Spatialis: drives the REAL subsystem code from a browser
 * so the voice pipeline can be seen working without Lens Studio or Spectacles.
 *
 * Real, imported from the shipped Scripts/ compiled to ES modules:
 *   - VoiceCommandController.parse / normalize / parseWallAdjacent
 *   - FURNITURE_CATALOG, resolveFurniture, getFurnitureSpec
 *   - SpatialisRegistry (the actual registry, holding actual entries)
 *   - PBRMaterialSwapper material + colour presets and resolvers
 *   - SurfaceAnchorEngine.classify (surface kind from normal + floor height)
 *
 * Simulated here, because they need hardware:
 *   - the room itself, and ray hit tests against it (World Query on device)
 *   - rendering (the Spectacles display on device)
 *   - mouse drag and scroll standing in for pinch-drag and two-hand scale
 *     (SIK hand tracking on device)
 *
 * License: Apache-2.0
 */

import {
  FURNITURE_CATALOG,
  SpatialisRegistry,
  getFurnitureSpec,
} from "./build/Scripts/SpatialisCore.js";
import { PBRMaterialSwapper } from "./build/Scripts/PBRMaterialSwapper.js";
import { SurfaceAnchorEngine } from "./build/Scripts/SurfaceAnchorEngine.js";
import { VoiceCommandController } from "./build/Scripts/VoiceCommandController.js";
import { Room3D } from "./room3d.js";

// Bare prototype instances: parse() and classify() read only their arguments
// and pure helpers, so no Lens Studio component lifecycle is needed.
const parser = Object.create(VoiceCommandController.prototype);
const anchor = Object.create(SurfaceAnchorEngine.prototype);
anchor.floorHeight = 0; // the simulated room's floor sits at y = 0

// -----------------------------------------------------------------------------
// The simulated room — centimetres, matching Lens Studio world units
// -----------------------------------------------------------------------------

const ROOM = { w: 520, d: 430 };              // interior floor extents
const TABLE = { x: 315, z: 95, w: 150, d: 85, top: 75 };   // a physical table,
           // deliberately off the default gaze line so floor spawns stay on the floor
const WEARER = { x: ROOM.w / 2, z: ROOM.d - 22, yaw: -Math.PI / 2 }; // faces -Z

const canvas = document.getElementById("room");
const ctx = canvas.getContext("2d");
const canvas3d = document.getElementById("scene3d");
const PAD = 46;
const SCALE = Math.min((canvas.width - PAD * 2) / ROOM.w, (canvas.height - PAD * 2) / ROOM.d);
const OX = (canvas.width - ROOM.w * SCALE) / 2;
const OZ = (canvas.height - ROOM.d * SCALE) / 2;

const toPx = (x, z) => [OX + x * SCALE, OZ + z * SCALE];
const toRoom = (px, pz) => [(px - OX) / SCALE, (pz - OZ) / SCALE];

/**
 * Stand-ins for SceneObject and Transform so entries can go into the REAL
 * SpatialisRegistry — which is what makes "make the sofa velvet" resolve
 * through the same lastOfKind() the Lens uses.
 */
class SimTransform {
  constructor(x, y, z) { this.p = new vec3(x, y, z); this.s = new vec3(1, 1, 1); this.yaw = 0; }
  getWorldPosition() { return this.p; }
  setWorldPosition(p) { this.p = p; }
  getLocalScale() { return this.s; }
  setLocalScale(s) { this.s = s; }
  getWorldRotation() { return quat.quatIdentity(); }
  setWorldRotation() {}
}
class SimSceneObject {
  constructor(name) { this.name = name; this.destroyed = false; this.enabled = true; }
  destroy() { this.destroyed = true; }
}
// The registry checks isNull() before touching an entry; honour destruction.
const baseIsNull = window.isNull;
window.isNull = (v) => baseIsNull(v) || (v instanceof SimSceneObject && v.destroyed);

// -----------------------------------------------------------------------------
// Colour: presets are linear-space, the canvas is sRGB
// -----------------------------------------------------------------------------

const toSrgb = (c) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2));
function presetCss(color, alpha = 1) {
  return `rgba(${toSrgb(color.x)},${toSrgb(color.y)},${toSrgb(color.z)},${alpha})`;
}
function objectCss(entry, alpha = 1) {
  const preset = entry.materialKey ? PBRMaterialSwapper.getPreset(entry.materialKey) : null;
  if (preset) {
    const c = entry.tint || preset.baseColor;
    return presetCss(c, alpha * (preset.baseColor.w ?? 1));
  }
  if (entry.tint) return presetCss(entry.tint, alpha);
  return `rgba(150,156,168,${alpha})`;   // unstyled prefab default
}

// -----------------------------------------------------------------------------
// Placement — the simulator's stand-in for World Query hit tests
// -----------------------------------------------------------------------------

const gazeDir = () => [Math.cos(WEARER.yaw), Math.sin(WEARER.yaw)];

function overTable(x, z) {
  return x >= TABLE.x && x <= TABLE.x + TABLE.w && z >= TABLE.z && z <= TABLE.z + TABLE.d;
}

/**
 * Drawn silhouette, rendering only. FURNITURE_CATALOG carries a single
 * `footprint` radius because that is all overlap rejection needs; a plan view
 * also needs a shape, so the width:depth ratios live here rather than bloating
 * the shipped catalog with data the Lens never reads.
 */
const ASPECT = {
  sofa: [2.0, 0.86], chair: [1.9, 1.9], table: [2.0, 1.3], coffeeTable: [2.0, 1.25],
  lamp: [1.9, 1.9], tableLamp: [1.9, 1.9], shelf: [2.2, 0.7], plant: [1.9, 1.9],
  rug: [2.2, 1.5], artwork: [2.2, 0.34], vase: [1.9, 1.9], bed: [1.9, 2.1],
};
function silhouette(o) {
  const [aw, ad] = ASPECT[o.kind] || [2.0, 1.5];
  const r = o.spec.footprint * o.transform.s.x;
  return [r * aw * SCALE, r * ad * SCALE];
}

/** Surface kind at a point, decided by the REAL classify() from its normal + height. */
function classifyAt(x, z) {
  const y = overTable(x, z) ? TABLE.top : 0;
  return anchor.classify(new vec3(x, y, z), vec3.up());
}

/** Golden-angle spiral outward until clear of existing pieces — mirrors resolveOverlap(). */
function avoidOverlap(x, z, footprint) {
  const others = SpatialisRegistry.all();
  for (let attempt = 0; attempt <= 12; attempt++) {
    const r = attempt === 0 ? 0 : footprint * (0.9 + 0.35 * attempt);
    const a = attempt * 2.399;
    const cx = x + Math.cos(a) * r, cz = z + Math.sin(a) * r;
    let clear = true;
    for (const o of others) {
      const gap = (footprint + o.spec.footprint) * 0.75;
      if (Math.hypot(cx - o.transform.p.x, cz - o.transform.p.z) < gap) { clear = false; break; }
    }
    if (clear) return [clamp(cx, 20, ROOM.w - 20), clamp(cz, 20, ROOM.d - 20)];
  }
  return [x, z];
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Where a spawn lands. Returns { x, z, y, surface, anchored }. */
function place(spec, placement, wallAdjacent) {
  const desired = placement === "auto" ? spec.defaultPlacement : placement;
  const [dx, dz] = gazeDir();

  if (desired === "wall" || wallAdjacent) {
    // March along the gaze to the first wall, as the level probe would.
    let t = 0;
    while (t < 900) {
      const x = WEARER.x + dx * t, z = WEARER.z + dz * t;
      if (x < 4 || x > ROOM.w - 4 || z < 4 || z > ROOM.d - 4) break;
      t += 4;
    }
    const wx = clamp(WEARER.x + dx * t, 4, ROOM.w - 4);
    const wz = clamp(WEARER.z + dz * t, 4, ROOM.d - 4);
    if (desired === "wall") {
      return { x: wx, z: wz, y: 150, surface: "wall", anchored: true, onWall: true };
    }
    // "by the wall": step into the room by the piece's own footprint.
    const [ax, az] = avoidOverlap(wx - dx * spec.footprint, wz - dz * spec.footprint, spec.footprint);
    return { x: ax, z: az, y: 0, surface: "floor", anchored: true, wallAdjacent: true };
  }

  if (desired === "table") {
    const [ax, az] = avoidOverlap(TABLE.x + TABLE.w / 2, TABLE.z + TABLE.d / 2, spec.footprint);
    return { x: ax, z: az, y: TABLE.top, surface: classifyAt(ax, az), anchored: true };
  }

  // Far enough into the room that a 2.1m sofa does not fill the wearer's view.
  // Nobody places a couch at arm's length either.
  const reach = desired === "float" ? 195 : 270;
  const rx = clamp(WEARER.x + dx * reach, 25, ROOM.w - 25);
  const rz = clamp(WEARER.z + dz * reach, 25, ROOM.d - 25);
  if (desired === "float") {
    const [fx2, fz2] = avoidOverlap(rx, rz, spec.footprint);
    return { x: fx2, z: fz2, y: 95, surface: "unknown", anchored: false, floating: true };
  }
  const [ax, az] = avoidOverlap(rx, rz, spec.footprint);
  return { x: ax, z: az, y: overTable(ax, az) ? TABLE.top : 0, surface: classifyAt(ax, az), anchored: true };
}

// -----------------------------------------------------------------------------
// Command execution
// -----------------------------------------------------------------------------

let selectedId = null;
let lastIntent = null;

function runCommand(text) {
  const normalized = parser.normalize(text);
  const intent = parser.parse(normalized, text);
  const wallAdjacent = parser.parseWallAdjacent(" " + normalized + " ");
  lastIntent = intent;

  let note = "";
  switch (intent.action) {
    case "spawn":   note = doSpawn(intent, wallAdjacent); break;
    case "material":note = doRestyle(intent); break;
    case "scale":   note = doScale(intent); break;
    case "delete":  note = doDelete(intent); break;
    case "clear": {
      room3d.clear();
      const n = SpatialisRegistry.removeAll();
      selectedId = null;
      note = n ? `cleared ${n}` : "already empty";
      break;
    }
    default: note = "not understood";
  }
  showIntent(text, intent, wallAdjacent, note);
  render();
  renderList();
}

function doSpawn(intent, wallAdjacent) {
  const spec = getFurnitureSpec(intent.furniture);
  if (!spec) return "no such piece";
  const p = place(spec, intent.placement, wallAdjacent);

  const entry = SpatialisRegistry.register({
    sceneObject: new SimSceneObject("Spatialis_" + spec.key),
    transform: new SimTransform(p.x, p.y, p.z),
    kind: spec.key,
    spec,
    placement: intent.placement,
    surface: p.surface,
    surfaceNormal: vec3.up(),
    baseScale: new vec3(1, 1, 1),
    materialKey: "",
    spawnedAtSeconds: performance.now() / 1000,
    isGrabbed: false,
  });
  entry.floating = !!p.floating;
  entry.onWall = !!p.onWall;
  entry.wallAdjacent = !!p.wallAdjacent;
  entry.born = performance.now();
  if (intent.material) entry.materialKey = intent.material;
  if (intent.color) entry.tint = colorRgb(intent.color);

  // Yaw: floor pieces turn to face the wearer, wall pieces face into the room.
  // Mirrors yawTowards() / alignToNormal() in the shipped anchor engine.
  entry.yaw = Math.atan2(WEARER.x - p.x, WEARER.z - p.z);
  if (p.onWall) entry.wallYaw = Math.atan2(WEARER.x - p.x, WEARER.z - p.z);

  room3d.add(entry);
  selectedId = entry.id;
  return p.anchored ? `anchored to ${p.surface}` : "floating (no surface)";
}

// COLOR_PRESETS is module-private in PBRMaterialSwapper.ts, so the swatches are
// mirrored here for rendering only. resolveColor() — the part that decides which
// colour a sentence means — is still the real one.
function colorRgb(key) {
  const swatch = COLOR_SWATCHES[key];
  return swatch ? new vec3(swatch[0], swatch[1], swatch[2]) : null;
}
const COLOR_SWATCHES = {
  white: [.93,.93,.91], black: [.06,.06,.07], grey: [.48,.49,.50],
  sage: [.55,.62,.49], forest: [.13,.31,.21], navy: [.11,.17,.34],
  rust: [.62,.28,.15], blush: [.87,.71,.68], mustard: [.79,.61,.19],
  burgundy: [.36,.10,.15],
};

function targetOf(intent) {
  if (selectedId !== null && !intent.furniture) {
    const sel = SpatialisRegistry.byId(selectedId);
    if (sel) return sel;
  }
  return intent.furniture ? SpatialisRegistry.lastOfKind(intent.furniture) : SpatialisRegistry.last();
}

function doRestyle(intent) {
  const t = targetOf(intent);
  if (!t) return "nothing to restyle";
  if (intent.material) { t.materialKey = intent.material; t.tint = null; }
  if (intent.color) t.tint = colorRgb(intent.color);
  room3d.sync(t);
  selectedId = t.id;
  return `${t.spec.label} → ${intent.material ? PBRMaterialSwapper.getPresetLabel(intent.material) : intent.color}`;
}

function doScale(intent) {
  const t = targetOf(intent);
  if (!t) return "nothing to resize";
  const cur = t.transform.s.x;
  t.transform.setLocalScale(new vec3(1,1,1).uniformScale(clamp(cur * intent.scaleFactor, 0.3, 3.0)));
  room3d.sync(t);
  selectedId = t.id;
  return `${t.spec.label} ×${t.transform.s.x.toFixed(2)}`;
}

function doDelete(intent) {
  const t = targetOf(intent);
  if (!t) return "nothing to remove";
  const label = t.spec.label;
  room3d.remove(t.id);
  SpatialisRegistry.remove(t.id);
  if (selectedId === t.id) selectedId = null;
  return `removed ${label}`;
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function render() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0e1117"; ctx.fillRect(0, 0, W, H);

  // floor
  const [fx, fz] = toPx(0, 0);
  ctx.fillStyle = "#141922";
  ctx.fillRect(fx, fz, ROOM.w * SCALE, ROOM.d * SCALE);

  // 50cm grid
  ctx.strokeStyle = "#1b2130"; ctx.lineWidth = 1;
  for (let x = 0; x <= ROOM.w; x += 50) {
    const [px] = toPx(x, 0); ctx.beginPath();
    ctx.moveTo(px, fz); ctx.lineTo(px, fz + ROOM.d * SCALE); ctx.stroke();
  }
  for (let z = 0; z <= ROOM.d; z += 50) {
    const [, pz] = toPx(0, z); ctx.beginPath();
    ctx.moveTo(fx, pz); ctx.lineTo(fx + ROOM.w * SCALE, pz); ctx.stroke();
  }

  // walls
  ctx.strokeStyle = "#3a4356"; ctx.lineWidth = 7; ctx.lineJoin = "round";
  ctx.strokeRect(fx, fz, ROOM.w * SCALE, ROOM.d * SCALE);

  // physical table (a real "table" surface for `on the table` to find)
  const [tx, tz] = toPx(TABLE.x, TABLE.z);
  ctx.fillStyle = "#20283a"; ctx.strokeStyle = "#33405c"; ctx.lineWidth = 1.5;
  roundRect(tx, tz, TABLE.w * SCALE, TABLE.d * SCALE, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#66748f";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("table  ·  75cm", tx + 8, tz + 15);

  drawGaze();
  // Painter's order: what sits higher in the room draws over what is below it.
  for (const o of [...SpatialisRegistry.all()].sort((a, b) => a.transform.p.y - b.transform.p.y)) drawPiece(o);
  drawWearer();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGaze() {
  const [dx, dz] = gazeDir();
  const [ox, oz] = toPx(WEARER.x, WEARER.z);
  const spread = 0.42, len = 330 * SCALE;
  const g = ctx.createRadialGradient(ox, oz, 0, ox, oz, len);
  g.addColorStop(0, "rgba(255,216,77,.10)");
  g.addColorStop(1, "rgba(255,216,77,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(ox, oz);
  const a0 = Math.atan2(dz, dx);
  ctx.arc(ox, oz, len, a0 - spread, a0 + spread); ctx.closePath(); ctx.fill();
}

function drawWearer() {
  const [ox, oz] = toPx(WEARER.x, WEARER.z);
  const [dx, dz] = gazeDir();
  ctx.fillStyle = "#ffd84d";
  ctx.beginPath(); ctx.arc(ox, oz, 7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#ffd84d"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ox, oz); ctx.lineTo(ox + dx * 20, oz + dz * 20); ctx.stroke();
  ctx.fillStyle = "#8a7c3f"; ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("wearer", ox - 17, oz + 21);
}

function drawPiece(o) {
  const [cx, cz] = toPx(o.transform.p.x, o.transform.p.z);
  const [w, h] = silhouette(o);
  const x = cx - w / 2, y = cz - h / 2;

  // pop-in, standing in for the easeOutBack spawn tween
  const age = (performance.now() - (o.born || 0)) / 550;
  const pop = age < 1 ? 1 + 0.16 * Math.sin(Math.min(age, 1) * Math.PI) * (1 - age) : 1;

  ctx.save();
  ctx.translate(cx, cz); ctx.scale(pop, pop); ctx.translate(-cx, -cz);

  const preset = o.materialKey ? PBRMaterialSwapper.getPreset(o.materialKey) : null;

  if (o.floating) {                    // floating: shadow gap + dashed outline
    ctx.fillStyle = "rgba(0,0,0,.38)";
    roundRect(x + 7, y + 11, w, h, 7); ctx.fill();
  } else {
    ctx.fillStyle = "rgba(0,0,0,.30)";
    roundRect(x + 2, y + 3, w, h, 7); ctx.fill();
  }

  ctx.fillStyle = objectCss(o);
  roundRect(x, y, w, h, 7); ctx.fill();

  // specular sheen: sharper as roughness drops, tinted by base colour on metals
  if (preset) {
    const gloss = 1 - preset.roughness;
    if (gloss > 0.05) {
      const g = ctx.createLinearGradient(x, y, x, y + h);
      const tint = preset.metallic > 0.5 ? objectCss(o, gloss * 0.85) : `rgba(255,255,255,${gloss * 0.55})`;
      g.addColorStop(0, tint);
      g.addColorStop(0.42, "rgba(255,255,255,0)");
      ctx.fillStyle = g; roundRect(x, y, w, h, 7); ctx.fill();
    }
  }

  ctx.lineWidth = o.id === selectedId ? 2.5 : 1;
  ctx.strokeStyle = o.id === selectedId ? "#ffd84d" : "rgba(255,255,255,.20)";
  if (o.floating) { ctx.setLineDash([5, 4]); ctx.strokeStyle = o.id === selectedId ? "#ffd84d" : "#6fa8ff"; }
  roundRect(x, y, w, h, 7); ctx.stroke(); ctx.setLineDash([]);

  ctx.restore();

  const sub = o.floating ? "floating" : o.surface + (o.wallAdjacent ? " · by wall" : "");
  const showSub = o.surface !== "unknown" || o.floating;
  ctx.textAlign = "center";
  ctx.font = "11px -apple-system, sans-serif";
  const lw = Math.max(ctx.measureText(o.spec.label).width, showSub ? sub.length * 5.4 : 0) + 12;
  const lh = showSub ? 27 : 16;
  const ly = cz + h / 2 + 5;
  ctx.fillStyle = "rgba(10,13,18,.78)";
  roundRect(cx - lw / 2, ly, lw, lh, 4); ctx.fill();
  ctx.fillStyle = "#d6dcea";
  ctx.fillText(o.spec.label, cx, ly + 12);
  if (showSub) {
    ctx.fillStyle = o.floating ? "#6fa8ff" : "#68738a";
    ctx.font = "9.5px ui-monospace, monospace";
    ctx.fillText(sub, cx, ly + 23);
  }
  ctx.textAlign = "left";
}

// -----------------------------------------------------------------------------
// Panel
// -----------------------------------------------------------------------------

function setSlot(id, value) {
  const el = document.getElementById(id);
  el.textContent = value || "—";
  el.className = value ? "" : "empty";
}

function showIntent(text, intent, wallAdjacent, note) {
  const heard = document.getElementById("heard");
  heard.className = ""; heard.textContent = `“${text}”  →  ${note}`;
  setSlot("s-action", intent.action === "unknown" ? "" : intent.action);
  setSlot("s-furniture", intent.furniture);
  setSlot("s-material", intent.material && PBRMaterialSwapper.getPresetLabel(intent.material));
  setSlot("s-color", intent.color);
  setSlot("s-placement", intent.placement + (wallAdjacent ? " + by wall" : ""));
  setSlot("s-style", intent.style);
  const sel = selectedId !== null ? SpatialisRegistry.byId(selectedId) : null;
  setSlot("s-surface", sel ? (sel.floating ? "floating" : sel.surface) : "");
  document.getElementById("s-conf").style.width = Math.round(intent.confidence * 100) + "%";
}

function renderList() {
  const wrap = document.getElementById("objects");
  const all = SpatialisRegistry.all();
  document.getElementById("count").textContent = all.length ? `· ${all.length}` : "";
  if (!all.length) {
    wrap.innerHTML = `<div class="empty-note">Nothing placed yet. Try a chip above, or speak a command.</div>`;
    return;
  }
  wrap.innerHTML = all.map((o) => `
    <div class="obj ${o.id === selectedId ? "sel" : ""}" data-id="${o.id}">
      <div class="sw" style="background:${objectCss(o)}"></div>
      <div style="flex:1;min-width:0">
        <div class="nm">${o.spec.label}</div>
        <div class="meta">${o.materialKey || "default"} · ${o.floating ? "floating" : o.surface} · ×${o.transform.s.x.toFixed(2)}</div>
      </div>
    </div>`).join("");
  wrap.querySelectorAll(".obj").forEach((el) =>
    el.addEventListener("click", () => { selectedId = +el.dataset.id; render(); renderList(); }));
}

// -----------------------------------------------------------------------------
// Mouse as pinch — stands in for SIK hand tracking
// -----------------------------------------------------------------------------

let dragging = null, dragOff = [0, 0];

function pick(px, pz) {
  const [x, z] = toRoom(px, pz);
  let best = null, bestD = Infinity;
  for (const o of SpatialisRegistry.all()) {
    const d = Math.hypot(x - o.transform.p.x, z - o.transform.p.z);
    const reach = o.spec.footprint * o.transform.s.x + 12;
    if (d <= reach && d < bestD) { bestD = d; best = o; }
  }
  return best;
}

canvas.addEventListener("mousedown", (e) => {
  const r = canvas.getBoundingClientRect();
  const hit = pick(e.clientX - r.left, e.clientY - r.top);
  selectedId = hit ? hit.id : null;
  if (hit) {
    const [x, z] = toRoom(e.clientX - r.left, e.clientY - r.top);
    dragging = hit; dragOff = [hit.transform.p.x - x, hit.transform.p.z - z];
    hit.isGrabbed = true;
  }
  render(); renderList();
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const r = canvas.getBoundingClientRect();
  const [x, z] = toRoom(e.clientX - r.left, e.clientY - r.top);
  const nx = clamp(x + dragOff[0], 15, ROOM.w - 15);
  const nz = clamp(z + dragOff[1], 15, ROOM.d - 15);
  dragging.transform.setWorldPosition(new vec3(nx, dragging.transform.p.y, nz));
  room3d.sync(dragging);
  render();
});

window.addEventListener("mouseup", () => {
  if (!dragging) return;
  // Release → re-seat, exactly as SurfaceAnchorEngine.reseat() does on device:
  // keep the chosen X/Z, correct only height, reclassify the surface.
  const o = dragging;
  o.isGrabbed = false;
  if (!o.floating) {
    const surface = classifyAt(o.transform.p.x, o.transform.p.z);
    o.surface = surface;
    o.wallAdjacent = false;
    o.transform.setWorldPosition(new vec3(o.transform.p.x, surface === "table" ? TABLE.top : 0, o.transform.p.z));
  }
  room3d.sync(o);
  dragging = null;
  render(); renderList();
});

canvas.addEventListener("wheel", (e) => {
  const r = canvas.getBoundingClientRect();
  const hit = pick(e.clientX - r.left, e.clientY - r.top);
  if (!hit) return;
  e.preventDefault();
  // Same clamp the gesture controller applies against the piece's base size.
  const next = clamp(hit.transform.s.x * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 0.3, 3.0);
  hit.transform.setLocalScale(new vec3(1, 1, 1).uniformScale(next));
  room3d.sync(hit);
  selectedId = hit.id;
  render(); renderList();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.key === "Backspace" && selectedId !== null && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    room3d.remove(selectedId);
    SpatialisRegistry.remove(selectedId);
    selectedId = null; render(); renderList();
  }
});

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

const input = document.getElementById("cmd");
document.getElementById("run").addEventListener("click", submit);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
function submit() {
  const v = input.value.trim();
  if (!v) return;
  runCommand(v);
  input.value = "";
}

const EXAMPLES = [
  "Spawn a Scandinavian lounge chair by the wall",
  "Add a floating marble coffee table",
  "Give me a navy velvet sofa",
  "Put a table lamp on the table",
  "Hang a painting on the wall",
  "Make the sofa leather",
  "Make it twice as big",
  "Clear the room",
];
document.getElementById("chips").innerHTML =
  EXAMPLES.map((e) => `<span class="chip">${e}</span>`).join("");
document.querySelectorAll(".chip").forEach((c) =>
  c.addEventListener("click", () => runCommand(c.textContent)));

// Web Speech API — the browser's stand-in for VoiceML on device.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = document.getElementById("mic");
if (!SR) {
  mic.disabled = true;
  mic.textContent = "🎙 Speech recognition unavailable in this browser";
} else {
  const rec = new SR();
  rec.continuous = false; rec.interimResults = true; rec.lang = "en-US";
  let live = false;
  mic.addEventListener("click", () => { live ? rec.stop() : rec.start(); });
  rec.onstart = () => { live = true; mic.classList.add("live"); mic.textContent = "● Listening — speak now"; };
  rec.onend = () => { live = false; mic.classList.remove("live"); mic.textContent = "🎙 Hold to speak (Web Speech API)"; };
  rec.onerror = (e) => { mic.textContent = "🎙 Mic error: " + e.error; };
  rec.onresult = (e) => {
    const res = e.results[e.results.length - 1];
    const text = res[0].transcript.trim();
    if (res.isFinal) {
      // Interim text is shown but never acted on — same rule as the real
      // VoiceCommandController.onListeningUpdate().
      runCommand(text);
    } else {
      const heard = document.getElementById("heard");
      heard.className = "interim"; heard.textContent = "… " + text;
    }
  };
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

console.log(
  `[Spatialis simulator] real catalog: ${FURNITURE_CATALOG.length} pieces, ` +
  `keys: ${FURNITURE_CATALOG.map((f) => f.key).join(", ")}`
);
const room3d = new Room3D(canvas3d, ROOM, TABLE, WEARER);

function fitStage() {
  const stage = document.getElementById("stage");
  const w = Math.max(320, stage.clientWidth - 60);
  const h = Math.max(280, stage.clientHeight - 60);
  const side = Math.min(w, h * 1.4);
  canvas3d.style.width = side + "px";
  canvas3d.style.height = side / 1.4 + "px";
  room3d.resize(Math.round(side), Math.round(side / 1.4));
}
addEventListener("resize", fitStage);
fitStage();

// View toggle: the wearer's eye, or the plan the anchor engine reasons in.
const btnWearer = document.getElementById("v-wearer");
const btnPlan = document.getElementById("v-plan");
function setView(mode) {
  const wearer = mode === "wearer";
  canvas3d.hidden = !wearer;
  canvas.hidden = wearer;
  btnWearer.classList.toggle("on", wearer);
  btnPlan.classList.toggle("on", !wearer);
  document.getElementById("hud-sub").textContent = wearer
    ? "camera at the wearer's eye, 155cm · real .glb from Assets/Prefabs"
    : "floor — plan view, 1px = 1cm · grid 50cm";
  if (wearer) fitStage();
  render();
}
btnWearer.addEventListener("click", () => setView("wearer"));
btnPlan.addEventListener("click", () => setView("plan"));

render();
renderList();

// A scene can be driven from the URL, which makes the simulator scriptable for
// headless screenshots and lets an arranged room be shared as a link:
//   ?cmd=Give me a navy velvet sofa|Make it twice as big
const fromUrl = new URLSearchParams(location.search).get("cmd");
const BOOT = fromUrl
  ? fromUrl.split("|").map((c) => c.trim()).filter(Boolean)
  : ["Spawn a Scandinavian lounge chair by the wall", "Add a floating marble coffee table",
     "Put a brass table lamp on the table"];

const CATALOG_KEYS = FURNITURE_CATALOG.map((f) => f.key);
const loaded = await room3d.loadPrefabs(CATALOG_KEYS, "../Assets/Prefabs");
document.getElementById("loading").classList.add("done");
console.log(`[Spatialis simulator] ${loaded}/${CATALOG_KEYS.length} prefabs loaded`);
if (loaded < CATALOG_KEYS.length) {
  console.warn("[Spatialis simulator] some prefabs failed to load; those keys will not appear in 3D");
}

for (const c of BOOT) runCommand(c);

// One render loop drives the 3D view; the plan view redraws on demand.
(function tick() {
  requestAnimationFrame(tick);
  if (!canvas3d.hidden) room3d.render();
})();
