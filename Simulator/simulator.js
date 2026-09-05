/**
 * simulator.js
 * -----------------------------------------------------------------------------
 * The Spatialis desk simulator: a HOST for the shipped subsystems.
 *
 * Lens Studio provides a scene graph, a hit-test module, a voice module, hand
 * tracking, a display and a frame loop. This file provides stand-ins for the
 * first three and the last two, and runs the real code on top of them:
 *
 *   VoiceCommandController  - instantiated here, wired exactly as it would be
 *                             in the Inspector, fed transcripts. Its parse(),
 *                             handleTranscript(), execute paths, spawn
 *                             animation, debounce and feedback all run.
 *   SurfaceAnchorEngine     - instantiated here and attached to a hit-test
 *                             source that raycasts the simulated room. Its
 *                             probe queue, floor calibration, classify(),
 *                             retry, overlap resolution, wall-adjacent
 *                             placement and reseat all run.
 *   PBRMaterialSwapper      - instantiated here and given SceneObjects whose
 *                             RenderMeshVisual/Material adapters write through
 *                             to three.js. Its clone-once, cross-fade and
 *                             guarded uniform writes all run.
 *   SpatialisRegistry, FURNITURE_CATALOG, the tween system - the shipped ones.
 *
 * What is SIMULATED, because it needs hardware, and how faithfully:
 *
 *   The room and hit tests.  A 520x430cm box with one table, raycast
 *                             analytically. On device: World Query against
 *                             the real room mesh.
 *   Voice input.             Web Speech API. On device: VoiceML. The
 *                             interim/final rule is the shipped one.
 *   Hand tracking.           Mouse drag and scroll stand in for pinch-drag
 *                             and two-hand scale. SpatialGestureController is
 *                             NOT exercised here - it needs SIK hand joints.
 *                             Its state machine is covered by Tests/gesture.
 *                             Release does hand the piece to the real
 *                             anchor engine's reseat(), as the controller
 *                             would.
 *   The display.             three.js, in room3d.js.
 *
 * License: Apache-2.0
 */

import { FURNITURE_CATALOG, SpatialisRegistry } from "./build/Scripts/SpatialisCore.js";
import { PBRMaterialSwapper } from "./build/Scripts/PBRMaterialSwapper.js";
import { SurfaceAnchorEngine } from "./build/Scripts/SurfaceAnchorEngine.js";
import { VoiceCommandController } from "./build/Scripts/VoiceCommandController.js";
import { Room3D } from "./room3d.js";
import { BUILD } from "./build/build-id.js";

// -----------------------------------------------------------------------------
// The simulated room - centimetres, matching Lens Studio world units
// -----------------------------------------------------------------------------

const ROOM = { w: 520, d: 430, h: 260 };
// A physical table, off the default gaze line so floor spawns stay on the floor.
const TABLE = { x: 315, z: 95, w: 150, d: 85, top: 75 };
// The wearer stands at the back, facing -Z, eyes at 155cm, glancing slightly
// down the way someone surveying a room does. Yaw and pitch are the head pose
// - on device the headset's own tracking; here the arrow keys.
const WEARER = { x: ROOM.w / 2, z: ROOM.d - 22, yaw: -Math.PI / 2, pitch: -8 * Math.PI / 180, eye: 155 };
const gaze = () => [Math.cos(WEARER.yaw), Math.sin(WEARER.yaw)];
const gaze3 = () => {
  const cp = Math.cos(WEARER.pitch);
  return new vec3(cp * Math.cos(WEARER.yaw), Math.sin(WEARER.pitch), cp * Math.sin(WEARER.yaw));
};

const canvas = document.getElementById("room");
const ctx = canvas.getContext("2d");
const canvas3d = document.getElementById("scene3d");
const PAD = 46;
const SCALE = Math.min((canvas.width - PAD * 2) / ROOM.w, (canvas.height - PAD * 2) / ROOM.d);
const OX = (canvas.width - ROOM.w * SCALE) / 2;
const OZ = (canvas.height - ROOM.d * SCALE) / 2;
const toPx = (x, z) => [OX + x * SCALE, OZ + z * SCALE];
const toRoom = (px, pz) => [(px - OX) / SCALE, (pz - OZ) / SCALE];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const room3d = new Room3D(canvas3d, ROOM, TABLE, WEARER);

// =============================================================================
// HOST SHIMS - what Lens Studio would provide
// =============================================================================

// ---- Scene graph ------------------------------------------------------------

/** Transform. The anchor engine writes real quaternions into it. */
class SimTransform {
  constructor() {
    this.p = new vec3(0, 0, 0);
    this.s = new vec3(1, 1, 1);
    this.q = quat.quatIdentity();
  }
  getWorldPosition() { return this.p; }
  setWorldPosition(p) { this.p = p; }
  getLocalScale() { return this.s; }
  setLocalScale(s) { this.s = s; }
  getWorldRotation() { return this.q; }
  setWorldRotation(q) { this.q = q; }
}

/**
 * Material.mainPass adapter. PBRMaterialSwapper writes baseColor (a linear
 * vec4), metallic and roughness through this onto a three.js material. It
 * deliberately has no baseTex property: the swapper's guarded trySet() skips
 * uniforms a pass does not expose, and these prefabs carry no textures.
 */
class SimPass {
  constructor(three) { this.three = three; }
  get baseColor() {
    const c = this.three.color;
    return new vec4(c.r, c.g, c.b, this.three.transparent ? this.three.opacity : 1);
  }
  set baseColor(v) {
    this.three.color.setRGB(v.x, v.y, v.z);
    const a = typeof v.w === "number" ? v.w : 1;
    this.three.transparent = a < 0.999;
    this.three.opacity = a;
    this.three.needsUpdate = true;
  }
  get metallic() { return this.three.metalness; }
  set metallic(v) { this.three.metalness = v; }
  get roughness() { return this.three.roughness; }
  set roughness(v) { this.three.roughness = v; }
}

/** Material. clone() is what makes the swapper's clone-once observable. */
class SimMaterial {
  constructor(three) { this.three = three; this.pass = new SimPass(three); }
  get mainPass() { return this.pass; }
  clone() { return new SimMaterial(this.three.clone()); }
}

/** RenderMeshVisual over a three.js Mesh. */
class SimVisual {
  constructor(mesh) { this.mesh = mesh; }
  get mainMaterial() { return new SimMaterial(this.mesh.material); }
  set mainMaterial(m) { this.mesh.material = m.three; }
}

/**
 * SceneObject over a three.js node. The swapper walks getChildrenCount() /
 * getChild() / getComponents() exactly as it walks a Lens prefab, so it
 * exercises its real hierarchy traversal on the real .glb structure.
 */
class SimSceneObject {
  constructor(name, obj3d) {
    this.name = name;
    this.obj3d = obj3d || null;
    this.destroyed = false;
    this.transform = new SimTransform();
  }
  getTransform() { return this.transform; }
  getComponents(type) {
    if (type === "Component.RenderMeshVisual" && this.obj3d && this.obj3d.isMesh) {
      return [new SimVisual(this.obj3d)];
    }
    return [];
  }
  getChildrenCount() { return this.obj3d ? this.obj3d.children.length : 0; }
  getChild(i) { return new SimSceneObject(this.name + "/" + i, this.obj3d.children[i]); }
  destroy() {
    this.destroyed = true;
    room3d.release(this.obj3d);
  }
  /** For the plan view: the first mesh's current three.js material, if any. */
  firstMaterial() {
    let found = null;
    if (this.obj3d) this.obj3d.traverse((n) => { if (!found && n.isMesh) found = n.material; });
    return found;
  }
}

// The registry and the swapper check isNull() before touching a SceneObject.
const baseIsNull = window.isNull;
window.isNull = (v) => baseIsNull(v) || (v instanceof SimSceneObject && v.destroyed);

/** ObjectPrefab. instantiate() is the only method the voice controller calls. */
class SimPrefab {
  constructor(key) { this.key = key; }
  instantiate(_parent) {
    return new SimSceneObject("Spatialis_" + this.key, room3d.instantiate(this.key));
  }
}

// ---- Hit testing ------------------------------------------------------------

/**
 * World Query stand-in: analytic raycast against the room's planes. The
 * anchor engine treats this exactly as it treats a HitTestSession - one
 * probe in flight, answered through a callback with {position, normal} or
 * null - so every placement decision downstream is the shipped code's.
 */
class RoomHitTest {
  hitTest(start, end, cb) {
    const d = end.sub(start);
    let best = null;
    const consider = (t, normal) => {
      if (t <= 1e-6 || t > 1) return;
      const p = start.add(d.uniformScale(t));
      if (p.y < -0.5 || p.y > ROOM.h + 0.5) return;
      if (p.x < -0.5 || p.x > ROOM.w + 0.5 || p.z < -0.5 || p.z > ROOM.d + 0.5) return;
      if (!best || t < best.t) best = { t, position: p, normal };
    };
    const planeY = (y0, ny, within) => {
      if (Math.abs(d.y) < 1e-9) return;
      const t = (y0 - start.y) / d.y;
      const p = start.add(d.uniformScale(t));
      if (within && !within(p)) return;
      consider(t, new vec3(0, ny, 0));
    };
    const planeX = (x0, nx) => {
      if (Math.abs(d.x) < 1e-9) return;
      consider((x0 - start.x) / d.x, new vec3(nx, 0, 0));
    };
    const planeZ = (z0, nz) => {
      if (Math.abs(d.z) < 1e-9) return;
      consider((z0 - start.z) / d.z, new vec3(0, 0, nz));
    };

    planeY(0, 1);                                  // floor
    planeY(ROOM.h, -1);                            // ceiling
    planeY(TABLE.top, 1, (p) =>                    // table top, only over the table
      p.x >= TABLE.x && p.x <= TABLE.x + TABLE.w && p.z >= TABLE.z && p.z <= TABLE.z + TABLE.d);
    planeX(0, 1); planeX(ROOM.w, -1);              // side walls
    planeZ(0, 1); planeZ(ROOM.d, -1);              // far wall, wall behind the wearer

    cb(best ? { position: best.position, normal: best.normal } : null);
  }
}

/**
 * The camera transform the anchor engine reads. Lens Studio's transform
 * reports forward as +Z while the camera looks down -Z, and the engine
 * negates it, so forward here is the gaze reversed.
 */
class SimCameraTransform {
  getWorldPosition() { return new vec3(WEARER.x, WEARER.eye, WEARER.z); }
  get forward() { return gaze3().uniformScale(-1); }
}

// =============================================================================
// THE REAL COMPONENTS, HOSTED
// =============================================================================

const CATALOG_KEYS = FURNITURE_CATALOG.map((f) => f.key);

const anchor = new SurfaceAnchorEngine();
anchor.probeDistance = 700;
anchor.floatDistance = 190;
anchor.avoidOverlap = true;
anchor.attachHitTestSource(new RoomHitTest(), new SimCameraTransform());

const swapper = new PBRMaterialSwapper();
swapper.blendDuration = 0.45;

const voice = new VoiceCommandController();
voice.anchorEngine = anchor;
voice.materialSwapper = swapper;
voice.spawnParent = {};
voice.furnitureKeys = CATALOG_KEYS;
voice.furniturePrefabs = CATALOG_KEYS.map((k) => new SimPrefab(k));
voice.spawnDuration = 0.55;
voice.requireWakeWord = false;

// The Text component the controller writes feedback into.
const heardEl = document.getElementById("heard");
voice.feedbackText = {
  _t: "",
  get text() { return this._t; },
  set text(v) {
    this._t = v;
    const interim = v.startsWith("… ");
    heardEl.className = interim ? "interim" : "";
    heardEl.textContent = v;
  },
};

// =============================================================================
// Commands
// =============================================================================

let selectedId = null;

/** Head pose in degrees: yaw right of straight ahead, pitch up. */
function lookAt(yawDeg, pitchDeg) {
  WEARER.yaw = -Math.PI / 2 + (yawDeg * Math.PI) / 180;
  WEARER.pitch = clamp((pitchDeg * Math.PI) / 180, -60 * Math.PI / 180, 30 * Math.PI / 180);
  room3d.placeCamera();
}

function runCommand(text) {
  // "look:26,-15" turns the wearer's head; it is host input, like the arrow
  // keys, and never reaches the parser. Lets a shared scene link say where
  // the wearer was looking when each sentence was spoken.
  const look = /^look:\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?$/i.exec(text.trim());
  if (look) {
    lookAt(parseFloat(look[1]), look[2] !== undefined ? parseFloat(look[2]) : (WEARER.pitch * 180) / Math.PI);
    return;
  }
  // Display the parsed intent. parse() is pure; the controller runs it again
  // inside handleTranscript, which is the call that actually acts.
  const normalized = voice.normalize(text);
  const intent = voice.parse(normalized, text);
  const wallAdjacent = voice.parseWallAdjacent(" " + normalized + " ");
  showIntent(intent, wallAdjacent);

  // handleTranscript advances lastTranscriptTime only when it acts; an
  // identical sentence within two seconds leaves it untouched. That is the
  // debounce - ASR emits the same final line twice, and the Lens must not
  // spawn two sofas for it - and it is the only path that gives no feedback.
  const stamp = voice.lastTranscriptTime;
  voice.handleTranscript(text);
  if (voice.lastTranscriptTime === stamp) {
    heardEl.className = "interim";
    heardEl.textContent = "(identical transcript within 2s — dropped, as the Lens does for duplicate ASR output)";
  }
}

// =============================================================================
// Frame loop - the UpdateEvent Lens Studio would fire
// =============================================================================

let lastFrame = performance.now();
let lastListSig = "";

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // World Query answers a probe between frames; this hit-test source answers
  // synchronously, so several probes can complete per frame. Three keeps a
  // chained placement (calibrate, gaze, retry) inside a single frame without
  // pretending the queue is not serial.
  anchor.tick(); anchor.tick(); anchor.tick();
  voice.tweens.update(dt);
  swapper.tweens.update(dt);

  const all = SpatialisRegistry.all();
  for (const e of all) room3d.sync(e);

  if (selectedId !== null && !SpatialisRegistry.byId(selectedId)) {
    selectedId = null;
    room3d.setSelected(null);
  }

  if (canvas3d.hidden) render(); else room3d.render();

  const sig = all.map((o) =>
    `${o.id}:${o.materialKey}:${o.surface}:${o.transform.s.x.toFixed(2)}:${selectedId === o.id ? 1 : 0}`).join("|");
  if (sig !== lastListSig) { lastListSig = sig; renderList(); }

  requestAnimationFrame(frame);
}

// =============================================================================
// Plan view
// =============================================================================

const toSrgb = (c) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2));

/** What the piece currently looks like: read back from its real material. */
function look(entry) {
  const m = entry.sceneObject.firstMaterial && entry.sceneObject.firstMaterial();
  if (m) {
    return { r: m.color.r, g: m.color.g, b: m.color.b,
             a: m.transparent ? m.opacity : 1, metallic: m.metalness, roughness: m.roughness };
  }
  const preset = entry.materialKey ? PBRMaterialSwapper.getPreset(entry.materialKey) : null;
  if (preset) {
    const c = preset.baseColor;
    return { r: c.x, g: c.y, b: c.z, a: c.w ?? 1, metallic: preset.metallic, roughness: preset.roughness };
  }
  return { r: 0.31, g: 0.33, b: 0.37, a: 1, metallic: 0, roughness: 0.7 };
}
const cssOf = (l, alpha = 1) => `rgba(${toSrgb(l.r)},${toSrgb(l.g)},${toSrgb(l.b)},${alpha * l.a})`;

/**
 * Drawn silhouette, rendering only. FURNITURE_CATALOG carries a single
 * footprint radius because that is all overlap rejection needs; a plan view
 * also needs a shape, so the width:depth ratios live here rather than in the
 * shipped catalog as data the Lens never reads.
 */
const ASPECT = {
  sofa: [2.0, 0.86], chair: [1.9, 1.9], table: [2.0, 1.3], coffeeTable: [2.0, 1.25],
  lamp: [1.9, 1.9], tableLamp: [1.9, 1.9], shelf: [2.2, 0.7], plant: [1.9, 1.9],
  rug: [2.2, 1.5], artwork: [2.2, 0.34], vase: [1.9, 1.9], bed: [1.9, 2.1],
};

function render() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0e1117"; ctx.fillRect(0, 0, W, H);

  const [fx, fz] = toPx(0, 0);
  ctx.fillStyle = "#141922";
  ctx.fillRect(fx, fz, ROOM.w * SCALE, ROOM.d * SCALE);
  ctx.strokeStyle = "#1b2130"; ctx.lineWidth = 1;
  for (let x = 0; x <= ROOM.w; x += 50) {
    const [px] = toPx(x, 0); ctx.beginPath(); ctx.moveTo(px, fz); ctx.lineTo(px, fz + ROOM.d * SCALE); ctx.stroke();
  }
  for (let z = 0; z <= ROOM.d; z += 50) {
    const [, pz] = toPx(0, z); ctx.beginPath(); ctx.moveTo(fx, pz); ctx.lineTo(fx + ROOM.w * SCALE, pz); ctx.stroke();
  }
  ctx.strokeStyle = "#3a4356"; ctx.lineWidth = 7; ctx.lineJoin = "round";
  ctx.strokeRect(fx, fz, ROOM.w * SCALE, ROOM.d * SCALE);

  const [tx, tz] = toPx(TABLE.x, TABLE.z);
  ctx.fillStyle = "#20283a"; ctx.strokeStyle = "#33405c"; ctx.lineWidth = 1.5;
  roundRect(tx, tz, TABLE.w * SCALE, TABLE.d * SCALE, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#66748f"; ctx.font = "10px ui-monospace, monospace";
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
  const [dx, dz] = gaze();
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
  const [dx, dz] = gaze();
  ctx.fillStyle = "#ffd84d";
  ctx.beginPath(); ctx.arc(ox, oz, 7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#ffd84d"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ox, oz); ctx.lineTo(ox + dx * 20, oz + dz * 20); ctx.stroke();
  ctx.fillStyle = "#8a7c3f"; ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("wearer", ox - 17, oz + 21);
}

/** A piece's status word for the plan view, from what the Lens actually records. */
function statusOf(o) {
  if (o.transform.s.x <= 0.0011) return "placing…";     // hidden until the anchor answers
  if (o.surface === "unknown") return "no surface";     // the floating fallback
  return o.surface;
}

function drawPiece(o) {
  const [cx, cz] = toPx(o.transform.p.x, o.transform.p.z);
  const [aw, ad] = ASPECT[o.kind] || [2.0, 1.5];
  const r = o.spec.footprint * Math.max(o.transform.s.x, 0.15);
  const w = r * aw * SCALE, h = r * ad * SCALE;
  const x = cx - w / 2, y = cz - h / 2;
  const l = look(o);
  const floating = o.surface === "unknown" && o.transform.s.x > 0.0011;

  ctx.fillStyle = floating ? "rgba(0,0,0,.38)" : "rgba(0,0,0,.30)";
  roundRect(x + (floating ? 7 : 2), y + (floating ? 11 : 3), w, h, 7); ctx.fill();

  ctx.fillStyle = cssOf(l);
  roundRect(x, y, w, h, 7); ctx.fill();

  const gloss = 1 - l.roughness;
  if (gloss > 0.05) {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, l.metallic > 0.5 ? cssOf(l, gloss * 0.85) : `rgba(255,255,255,${gloss * 0.55})`);
    g.addColorStop(0.42, "rgba(255,255,255,0)");
    ctx.fillStyle = g; roundRect(x, y, w, h, 7); ctx.fill();
  }

  ctx.lineWidth = o.id === selectedId ? 2.5 : 1;
  ctx.strokeStyle = o.id === selectedId ? "#ffd84d" : "rgba(255,255,255,.20)";
  if (floating) { ctx.setLineDash([5, 4]); if (o.id !== selectedId) ctx.strokeStyle = "#6fa8ff"; }
  roundRect(x, y, w, h, 7); ctx.stroke(); ctx.setLineDash([]);

  const sub = statusOf(o);
  ctx.textAlign = "center";
  ctx.font = "11px -apple-system, sans-serif";
  const lw = Math.max(ctx.measureText(o.spec.label).width, sub.length * 5.4) + 12;
  const ly = cz + h / 2 + 5;
  ctx.fillStyle = "rgba(10,13,18,.78)";
  roundRect(cx - lw / 2, ly, lw, 27, 4); ctx.fill();
  ctx.fillStyle = "#d6dcea";
  ctx.fillText(o.spec.label, cx, ly + 12);
  ctx.fillStyle = floating ? "#6fa8ff" : "#68738a";
  ctx.font = "9.5px ui-monospace, monospace";
  ctx.fillText(sub, cx, ly + 23);
  ctx.textAlign = "left";
}

// =============================================================================
// Panel
// =============================================================================

function setSlot(id, value) {
  const el = document.getElementById(id);
  el.textContent = value || "—";
  el.className = value ? "" : "empty";
}

function showIntent(intent, wallAdjacent) {
  setSlot("s-action", intent.action === "unknown" ? "" : intent.action);
  setSlot("s-furniture", intent.furniture);
  setSlot("s-material", intent.material && PBRMaterialSwapper.getPresetLabel(intent.material));
  setSlot("s-color", intent.color);
  setSlot("s-placement", intent.placement + (wallAdjacent ? " + by wall" : ""));
  setSlot("s-style", intent.style);
  const last = SpatialisRegistry.last();
  setSlot("s-surface", last ? statusOf(last) : "");
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
      <div class="sw" style="background:${cssOf(look(o))}"></div>
      <div style="flex:1;min-width:0">
        <div class="nm">${o.spec.label}</div>
        <div class="meta">${o.materialKey || "default"} · ${statusOf(o)} · ×${o.transform.s.x.toFixed(2)}</div>
      </div>
    </div>`).join("");
  wrap.querySelectorAll(".obj").forEach((el) =>
    el.addEventListener("click", () => select(+el.dataset.id)));
}

function select(id) {
  selectedId = id;
  const e = id === null ? null : SpatialisRegistry.byId(id);
  room3d.setSelected(e ? e.sceneObject.obj3d : null);
  lastListSig = "";
}

// =============================================================================
// Mouse as pinch - the one thing here that stands in for a subsystem
// =============================================================================
// SpatialGestureController needs SIK hand joints, which a browser does not
// have, so grab/drag/scale are simulated. Release is not: it hands the piece
// to the real anchor engine's reseat(), exactly as the controller does.

let dragging = null, dragOff = [0, 0], dragSurface = null;

function pickPlan(px, pz) {
  const [x, z] = toRoom(px, pz);
  let best = null, bestD = Infinity;
  for (const o of SpatialisRegistry.all()) {
    const d = Math.hypot(x - o.transform.p.x, z - o.transform.p.z);
    const reach = o.spec.footprint * o.transform.s.x + 12;
    if (d <= reach && d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function beginDrag(entry, x, z) {
  dragging = entry;
  dragOff = [entry.transform.p.x - x, entry.transform.p.z - z];
  entry.isGrabbed = true;
  select(entry.id);
}

function moveDrag(x, z, y) {
  const nx = clamp(x + dragOff[0], 15, ROOM.w - 15);
  const nz = clamp(z + dragOff[1], 15, ROOM.d - 15);
  // While held, ride at the height of the surface under the mouse so a piece
  // visibly lifts onto the table; the real reseat() confirms on release.
  const ny = typeof y === "number" ? y : dragging.transform.p.y;
  dragging.transform.setWorldPosition(new vec3(nx, ny, nz));
}

function endDrag() {
  const o = dragging;
  dragging = null;
  o.isGrabbed = false;
  // The real reseat: a probe from above the piece, keep X/Z, correct height,
  // reclassify. Answers on a later frame through the anchor's probe queue.
  anchor.reseat(o, (result) => {
    if (isNull(o.sceneObject)) return;
    o.transform.setWorldPosition(result.position);
    o.transform.setWorldRotation(result.rotation);
    o.surface = result.surface;
    o.surfaceNormal = result.normal;
    lastListSig = "";
  });
}

canvas.addEventListener("mousedown", (e) => {
  const r = canvas.getBoundingClientRect();
  const hit = pickPlan(e.clientX - r.left, e.clientY - r.top);
  if (!hit) { select(null); return; }
  const [x, z] = toRoom(e.clientX - r.left, e.clientY - r.top);
  beginDrag(hit, x, z);
  dragSurface = "plan";
});

canvas3d.addEventListener("mousedown", (e) => {
  const r = canvas3d.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
  const entries = SpatialisRegistry.all().filter((o) => o.sceneObject.obj3d);
  const root = room3d.pickObject(nx, ny, entries.map((o) => o.sceneObject.obj3d));
  const hit = entries.find((o) => o.sceneObject.obj3d === root);
  if (!hit) { select(null); return; }
  const f = room3d.pickSurface(nx, ny);
  beginDrag(hit, f ? f.x : hit.transform.p.x, f ? f.z : hit.transform.p.z);
  dragSurface = "3d";
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  if (dragSurface === "plan") {
    const r = canvas.getBoundingClientRect();
    const [x, z] = toRoom(e.clientX - r.left, e.clientY - r.top);
    moveDrag(x, z);
  } else {
    const r = canvas3d.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    const f = room3d.pickSurface(nx, ny);
    if (f) moveDrag(f.x, f.z, f.y);
  }
});

window.addEventListener("mouseup", () => { if (dragging) endDrag(); });

// A mouse has no second hand, so the two-hand "crush to delete" gesture is
// stood in for by scrolling past the minimum: three more notches once a piece
// is as small as it goes removes it, the way the controller does.
let crushNotches = 0, crushTarget = null;
function wheelScale(e, hit) {
  if (!hit) return;
  e.preventDefault();
  const cur = hit.transform.s.x;
  const shrinking = e.deltaY > 0;
  if (shrinking && cur <= 0.3 + 1e-6) {
    if (crushTarget !== hit.id) { crushTarget = hit.id; crushNotches = 0; }
    crushNotches++;
    heardEl.className = "interim";
    heardEl.textContent = crushNotches >= 3
      ? `Crushed the ${hit.spec.label} — removed`
      : `Squeezing the ${hit.spec.label} — ${3 - crushNotches} more to remove (crush-to-delete)`;
    if (crushNotches >= 3) {
      swapper.forget(hit.id);
      SpatialisRegistry.remove(hit.id);   // -> SceneObject.destroy() -> room3d.release()
      crushTarget = null; crushNotches = 0;
      select(null);
    }
    return;
  }
  crushTarget = null; crushNotches = 0;
  // The same clamp SpatialGestureController applies against the piece's base size.
  const next = clamp(cur * (shrinking ? 1 / 1.08 : 1.08), 0.3, 3.0);
  hit.transform.setLocalScale(new vec3(1, 1, 1).uniformScale(next));
  select(hit.id);
}
canvas.addEventListener("wheel", (e) => {
  const r = canvas.getBoundingClientRect();
  wheelScale(e, pickPlan(e.clientX - r.left, e.clientY - r.top));
}, { passive: false });
canvas3d.addEventListener("wheel", (e) => {
  wheelScale(e, selectedId !== null ? SpatialisRegistry.byId(selectedId) : null);
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (document.activeElement.tagName === "INPUT") return;
  const step = 5;
  const yawDeg = ((WEARER.yaw + Math.PI / 2) * 180) / Math.PI;
  const pitchDeg = (WEARER.pitch * 180) / Math.PI;
  if (e.key === "ArrowLeft")  { e.preventDefault(); lookAt(yawDeg - step, pitchDeg); return; }
  if (e.key === "ArrowRight") { e.preventDefault(); lookAt(yawDeg + step, pitchDeg); return; }
  if (e.key === "ArrowUp")    { e.preventDefault(); lookAt(yawDeg, pitchDeg + step); return; }
  if (e.key === "ArrowDown")  { e.preventDefault(); lookAt(yawDeg, pitchDeg - step); return; }
  if (e.key === "Backspace" && selectedId !== null) {
    e.preventDefault();
    swapper.forget(selectedId);
    SpatialisRegistry.remove(selectedId);   // -> SceneObject.destroy() -> room3d.release()
    select(null);
  }
});

// =============================================================================
// Input
// =============================================================================

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

// Web Speech API stands in for VoiceML. The interim/final rule is the
// controller's own: onTranscriptionUpdate shows partials and acts only on finals.
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
    if (res.isFinal) runCommand(text);
    else voice.onTranscriptionUpdate({ text: text, isFinal: false });
  };
}

// =============================================================================
// Boot
// =============================================================================

const buildEl = document.getElementById("build");
if (buildEl) buildEl.textContent = "build " + BUILD;

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
}
btnWearer.addEventListener("click", () => setView("wearer"));
btnPlan.addEventListener("click", () => setView("plan"));

// A scene can be driven from the URL, which makes the simulator scriptable for
// headless screenshots and lets an arranged room be shared as a link:
//   ?cmd=Give me a navy velvet sofa|Make it twice as big
const fromUrl = new URLSearchParams(location.search).get("cmd");
const BOOT = fromUrl
  ? fromUrl.split("|").map((c) => c.trim()).filter(Boolean)
  : ["Spawn a Scandinavian lounge chair by the wall", "Add a floating marble coffee table",
     "Put a brass table lamp on the table"];

const loadingEl = document.getElementById("loading");
let report = { loaded: [], failed: CATALOG_KEYS.slice() };
try {
  report = await room3d.loadPrefabs(CATALOG_KEYS, "../Assets/Prefabs");
} catch (e) {
  console.error("[Spatialis simulator] prefab loading failed outright:", e);
}
loadingEl.classList.add("done");
console.log(`[Spatialis simulator] ${report.loaded.length}/${CATALOG_KEYS.length} prefabs loaded`);
if (report.failed.length) {
  console.warn("[Spatialis simulator] missing in 3D:", report.failed.join(", "));
  const hud = document.getElementById("hud-sub");
  hud.innerHTML = report.loaded.length
    ? `⚠ ${report.failed.length} model(s) unavailable — switch to Floor plan to see them`
    : `⚠ no models loaded — the Floor plan view still works`;
  hud.style.color = "#fbbf24";
  if (!report.loaded.length) setView("plan");
}

requestAnimationFrame(frame);
for (const c of BOOT) runCommand(c);
