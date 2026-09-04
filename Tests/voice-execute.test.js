/**
 * voice-execute.test.js — VoiceCommandController, the execution half.
 *
 * voice-parser.test.js proves that a sentence becomes the right intent. This
 * file proves the other half: that the intent actually produces a placed,
 * styled, animated piece of furniture. It wires the REAL VoiceCommandController
 * to a REAL SurfaceAnchorEngine (fed by a scripted room of hit tests) and a
 * REAL PBRMaterialSwapper, so the assertions cover the seams between the three
 * subsystems rather than each one in isolation.
 *
 * The only things faked are what Lens Studio itself would provide: prefabs,
 * scene objects, transforms, materials, the hit-test session, the clock.
 *
 * License: Apache-2.0
 */

const path = require("path");
const { suite, test, eq, ok, near } = require("./harness");
const B = path.join(__dirname, "..", ".build", "Scripts");
const { VoiceCommandController } = require(path.join(B, "VoiceCommandController.js"));
const { SurfaceAnchorEngine } = require(path.join(B, "SurfaceAnchorEngine.js"));
const { PBRMaterialSwapper } = require(path.join(B, "PBRMaterialSwapper.js"));
const { SpatialisRegistry } = require(path.join(B, "SpatialisCore.js"));

// ---------------------------------------------------------------------------
// Runtime overrides, scoped to this file and restored at the bottom
// ---------------------------------------------------------------------------

// The stub's getTime() is wall-clock, which makes the 2s ASR de-duplication
// window untestable (and would silently swallow any repeated command below).
// The compiled code calls the global at call time, so a scripted clock works.
const realGetTime = globalThis.getTime;
const realIsNull = globalThis.isNull;
const clock = { now: 0 };
globalThis.getTime = () => clock.now;

// On device, a reference to a destroyed SceneObject answers isNull() with
// true. The plain stub only knows null/undefined, so teach it the fakes'
// `destroyed` flag; otherwise the "deleted while in flight" guards can never
// be exercised.
globalThis.isNull = (v) => realIsNull(v) || (typeof v === "object" && v !== null && v.destroyed === true);

// ---------------------------------------------------------------------------
// Fakes — shaped by what the shipped code actually calls
// ---------------------------------------------------------------------------

/** Material: the swapper reads/writes mainPass and clones it once per object. */
function makeMaterial(name) {
  const m = {
    name,
    clones: 0,
    mainPass: { baseColor: new vec4(0.8, 0.8, 0.8, 1.0), metallic: 0.0, roughness: 0.5 },
    clone() {
      m.clones++;
      const c = makeMaterial(name + "_clone");
      c.mainPass.baseColor = m.mainPass.baseColor;
      c.mainPass.metallic = m.mainPass.metallic;
      c.mainPass.roughness = m.mainPass.roughness;
      return c;
    },
  };
  return m;
}

/** Transform: what executeSpawn / the tweens / the anchor's overlap check touch. */
function makeTransform(position, scale) {
  let pos = position;
  let scl = scale;
  let rot = quat.quatIdentity();
  const t = {
    positionWrites: 0,
    getWorldPosition: () => pos,
    setWorldPosition: (p) => { t.positionWrites++; pos = p; },
    getLocalScale: () => scl,
    setLocalScale: (s) => { scl = s; },
    getWorldRotation: () => rot,
    setWorldRotation: (r) => { rot = r; },
  };
  return t;
}

/**
 * SceneObject: the prefab root carries no mesh of its own; a child "Mesh"
 * holds the RenderMeshVisual, so the swapper's depth-first walk is exercised.
 */
function makeSceneObject(name, position, baseScale, sharedMaterial) {
  const visual = { mainMaterial: sharedMaterial };
  const child = {
    name: name + "_Mesh",
    getComponents: (type) => (type === "Component.RenderMeshVisual" ? [visual] : []),
    getChildrenCount: () => 0,
    getChild: () => null,
  };
  const transform = makeTransform(position, baseScale);
  const so = {
    name: "",
    destroyed: false,
    visual,
    getTransform: () => transform,
    getComponents: () => [], // no mesh on the root: the swapper must descend
    getChildrenCount: () => 1,
    getChild: (i) => (i === 0 ? child : null),
    destroy() { so.destroyed = true; },
  };
  return so;
}

/**
 * ObjectPrefab: instantiate(parent) drops the instance at the parent's origin,
 * as Lens Studio does. Every instance of one prefab shares the same Material
 * asset — exactly the situation the swapper must not repaint globally.
 */
function makePrefab(key, baseScale) {
  const shared = makeMaterial(key + "_material");
  const prefab = {
    key,
    shared,
    instances: [],
    instantiate(parent) {
      const at = parent.getTransform().getWorldPosition();
      const so = makeSceneObject(key, at, baseScale, shared);
      prefab.instances.push(so);
      return so;
    },
  };
  return prefab;
}

/**
 * A scripted room for the hit-test session: a floor at y=75 and a wall at
 * z=-500 facing into the room. Rays are resolved geometrically so the anchor
 * engine's own probe choices (tilted down, level, chained) decide what is hit.
 *
 * The floor is deliberately NOT at y=0. A fresh engine assumes its floor is at
 * 0, and a horizontal surface 75cm above that reads as a "table". Every
 * `surface === "floor"` assertion below therefore also proves that the engine
 * calibrated its floor estimate from the first hit it saw; a room at y=0
 * would let an engine that never calibrates pass unnoticed.
 */
const FLOOR_Y = 75;
const WALL_Z = -500;
function roomHit(start, end) {
  const d = end.sub(start);
  let best = null;
  if (d.y < 0 && start.y > FLOOR_Y) {
    const t = (FLOOR_Y - start.y) / d.y;
    if (t >= 0 && t <= 1) best = { t, position: start.add(d.uniformScale(t)), normal: vec3.up() };
  }
  if (d.z < 0 && start.z > WALL_Z) {
    const t = (WALL_Z - start.z) / d.z;
    if (t >= 0 && t <= 1 && (!best || t < best.t)) {
      best = { t, position: start.add(d.uniformScale(t)), normal: new vec3(0, 0, 1) };
    }
  }
  return best ? { position: best.position, normal: best.normal } : null;
}

function makeSession() {
  const session = {
    probes: [],
    hits: [],
    respond: null, // set to override the room, e.g. () => null for "no depth"
    hitTest(start, end, cb) {
      session.probes.push({ start, end });
      const hit = session.respond ? session.respond(start, end) : roomHit(start, end);
      session.hits.push(hit);
      cb(hit);
    },
  };
  return session;
}

// A standing user: eyes 160cm above the (raised) floor.
const EYE = () => new vec3(0, FLOOR_Y + 160, 0);
const BASE = 1.5; // a non-unit prefab scale, so "restored to base" ≠ "reset to 1"

/** The three real subsystems wired together, plus the driving helpers. */
function makeWorld(overrides = {}) {
  SpatialisRegistry.removeAll();
  clock.now = 0;

  const session = makeSession();
  const anchor = new SurfaceAnchorEngine();
  anchor.hitTestSession = session;
  anchor.ready = true;
  // Lens Studio reports `forward` as +Z while the camera looks down -Z; the
  // engine negates it, so this user is looking toward the wall at z=-500.
  anchor.cameraTransform = { getWorldPosition: EYE, forward: new vec3(0, 0, 1) };

  const swapper = new PBRMaterialSwapper();
  swapper.blendDuration = 0; // write finishes immediately so asserts are prompt

  const prefabs = {};
  const keys = ["sofa", "chair", "coffeeTable", "lamp", "artwork"];
  for (const k of keys) prefabs[k] = makePrefab(k, new vec3(BASE, BASE, BASE));
  // "bed" is in the catalog but deliberately NOT wired to a prefab.

  const voice = new VoiceCommandController();
  voice.anchorEngine = anchor;
  voice.materialSwapper = swapper;
  voice.spawnParent = { name: "SpawnRoot", getTransform: () => makeTransform(vec3.zero(), vec3.one()) };
  voice.feedbackText = { text: "" };
  voice.spawnDuration = 0.1;
  voice.furnitureKeys = keys;
  voice.furniturePrefabs = keys.map((k) => prefabs[k]);
  Object.assign(voice, overrides);

  const w = {
    voice, anchor, swapper, session, prefabs,
    say: (text) => voice.handleTranscript(text),
    feedback: () => voice.feedbackText.text,
    /** Advance the scripted clock past the ASR de-duplication window. */
    later: (seconds = 3) => { clock.now += seconds; },
    /** One simulated frame per call: drain the probe queue, step every tween. */
    pump: (n, dt = 0.05) => {
      for (let i = 0; i < n; i++) {
        anchor.pumpProbeQueue();
        voice.tweens.update(dt);
        swapper.tweens.update(dt);
      }
    },
  };
  return w;
}

const scaleOf = (entry) => entry.transform.getLocalScale();
const colorOf = (entry) => entry.sceneObject.visual.mainMaterial.mainPass.baseColor;
const passOf = (entry) => entry.sceneObject.visual.mainMaterial.mainPass;

// ---------------------------------------------------------------------------

suite("VoiceCommandController — a spoken sentence becomes a placed, styled object");

test("“give me a navy velvet sofa” places a velvet sofa on the floor, tinted navy", () => {
  // The end-to-end promise of the product. Nothing here is set by a fake:
  // the anchor chose the spot, the voice controller applied it, the swapper
  // restyled the mesh it found by walking the prefab.
  const w = makeWorld();
  w.say("give me a navy velvet sofa");
  w.pump(10);

  eq(SpatialisRegistry.count(), 1);
  const sofa = SpatialisRegistry.last();
  eq(sofa.kind, "sofa");
  eq(sofa.placement, "auto");
  eq(sofa.surface, "floor");
  eq(sofa.surfaceNormal.y, 1);
  eq(sofa.materialKey, "velvet");
  eq(sofa.sceneObject.name, "Spatialis_sofa_1");
  eq(sofa.sceneObject, w.prefabs.sofa.instances[0], "the registry entry is the instantiated prefab");

  // Position: exactly where the anchor's tilted gaze ray met the floor.
  eq(w.session.probes.length, 1, "a floor piece needs a single gaze probe");
  const hit = w.session.hits[0];
  ok(hit && hit.position.z < -300, "the gaze should have reached the floor well ahead of the user");
  const pos = sofa.transform.getWorldPosition();
  near(pos.x, hit.position.x, 1e-9);
  near(pos.y, FLOOR_Y, 1e-9, "must sit on the floor, not hover above it");
  near(pos.z, hit.position.z, 1e-9);

  // The room's floor is 75cm above the engine's default estimate, which is
  // squarely in "table" territory. Reading it as a floor proves the engine
  // learned the floor height from this very hit before classifying it.
  near(w.anchor.getFloorHeight(), FLOOR_Y, 1e-9, "the first floor hit calibrates the floor estimate");

  // Scale: fully popped in.
  near(scaleOf(sofa).x, BASE, 1e-12);

  // Material: velvet physics with a navy tint, on a private clone.
  const c = colorOf(sofa);
  ok(c.x < 0.2 && c.z > 0.3, "expected a navy-ish albedo, got " + JSON.stringify(c));
  near(passOf(sofa).roughness, 0.86, 1e-9, "velvet's roughness must survive the tint");
  near(passOf(sofa).metallic, 0, 1e-9);
  ok(sofa.sceneObject.visual.mainMaterial !== w.prefabs.sofa.shared, "must restyle a clone, not the shared asset");
  near(w.prefabs.sofa.shared.mainPass.baseColor.x, 0.8, 1e-9, "the shared prefab material is untouched");

  eq(w.feedback(), "Added a velvet sofa on the floor");
});

test("the registry entry exists before the hit test resolves, hidden at near-zero scale", () => {
  // Registering first is what lets "undo" or a grab target a piece whose
  // depth probe has not come back yet; hiding it is what stops the pop-in.
  const w = makeWorld();
  w.say("add a sofa");

  eq(SpatialisRegistry.count(), 1, "registered synchronously");
  const sofa = SpatialisRegistry.last();
  eq(sofa.surface, "unknown", "no surface is known until the probe answers");
  eq(w.session.probes.length, 0, "the probe is queued, not fired, until the engine updates");
  near(scaleOf(sofa).x, BASE * 0.001, 1e-12, "hidden at 0.1% of base scale");
  eq(sofa.baseScale.x, BASE, "baseScale remembers the prefab's real size");
  eq(w.feedback(), "", "no confirmation until it has actually landed");

  w.pump(1);
  eq(sofa.surface, "floor");
});

test("the spawn animation lifts the piece, then settles it at exactly the prefab's base scale", () => {
  const w = makeWorld();
  w.say("add a chair");
  w.pump(1, 0.02); // 20% through a 0.1s tween: still in the air, still growing
  const chair = SpatialisRegistry.last();
  ok(chair.transform.getWorldPosition().y > FLOOR_Y + 0.5, "should drop in from above the surface");
  const mid = scaleOf(chair).x;
  ok(mid > BASE * 0.01 && mid < BASE, "mid-animation scale should be between hidden and full, got " + mid);

  w.pump(20);
  // Not 0.999 — a gesture scale that later multiplies this must start from
  // the true base, or every "make it bigger" drifts.
  near(scaleOf(chair).x, BASE, 1e-12);
  near(scaleOf(chair).y, BASE, 1e-12);
  near(scaleOf(chair).z, BASE, 1e-12);
  near(chair.transform.getWorldPosition().y, FLOOR_Y, 1e-12, "settled onto the floor");
});

test("feedback names the surface: 'on the floor' when anchored, 'in front of you' when floating", () => {
  const w = makeWorld();
  w.say("add a sofa");
  w.pump(5);
  eq(w.feedback(), "Added a sofa on the floor");
  eq(w.session.probes.length, 1);

  // An explicit "floating" is a placement decision, not a question for the
  // depth system: the engine must answer without probing at all.
  w.later();
  w.say("add a floating lamp");
  w.pump(5);
  eq(w.session.probes.length, 1, "an explicit float never asks the depth system");
  eq(w.feedback(), "Added a floor lamp in front of you");
  eq(SpatialisRegistry.last().surface, "unknown");

  // No depth data yet (dark room, fresh start): the probe misses and the
  // piece is held in front of the user rather than being lost.
  w.later();
  w.session.respond = () => null;
  w.say("add a chair");
  w.pump(5);
  eq(w.session.probes.length, 2, "an auto placement does probe, and this one missed");
  eq(w.feedback(), "Added a lounge chair in front of you");
  const chair = SpatialisRegistry.last();
  eq(chair.surface, "unknown");
  near(chair.transform.getWorldPosition().z, -160, 1e-9, "held at the engine's floatDistance ahead");
});

test("hanging art reaches the wall path: level probe, eye height, surface 'wall'", () => {
  const w = makeWorld();
  w.say("hang a painting on the wall");
  w.pump(5);
  const probe = w.session.probes[0];
  near(probe.end.y, probe.start.y, 1e-9, "wall pieces probe level, not tilted down");
  const art = SpatialisRegistry.last();
  eq(art.kind, "artwork");
  eq(art.surface, "wall");
  near(art.transform.getWorldPosition().y, EYE().y - 10, 1e-9, "hung just below eye level");
  near(art.transform.getWorldPosition().z, WALL_Z + 3, 1e-9, "pushed 3cm off the wall so it does not z-fight");
  eq(w.feedback(), "Added a wall art on the wall");
});

test("“by the wall” chains a level wall probe with a downward floor probe", () => {
  // A chair "by the wall" is a floor piece, so the anchor must first find the
  // wall (level ray) and only then drop to the floor in front of it.
  const w = makeWorld();
  w.say("put a chair by the wall");
  w.pump(1);
  eq(w.session.probes.length, 1);
  const first = w.session.probes[0];
  near(first.end.y, first.start.y, 1e-9, "the FIRST probe must be level to find a wall");
  eq(SpatialisRegistry.last().surface, "unknown", "still waiting on the floor probe");

  w.pump(5);
  eq(w.session.probes.length, 2, "then exactly one floor probe");
  const second = w.session.probes[1];
  ok(second.end.y < second.start.y, "the second probe drops toward the floor");

  const chair = SpatialisRegistry.last();
  eq(chair.surface, "floor");
  const pos = chair.transform.getWorldPosition();
  near(pos.y, FLOOR_Y, 1e-9);
  near(pos.z, WALL_Z + chair.spec.footprint, 1e-9, "stood one footprint off the wall so it touches, not clips");
  eq(w.feedback(), "Added a lounge chair on the floor");
});

test("the first spawn lands exactly where the user looked; only OTHER furniture is dodged", () => {
  // Regression. executeSpawn registers the instance before the hit test
  // resolves, while it is still parked at the spawn parent's origin. The
  // anchor's overlap check used to count that unplaced instance as furniture,
  // so a first sofa aimed within ~1.5m of where the headset started was
  // shoved 131cm sideways for no visible reason.
  const w = makeWorld();
  const spot = new vec3(0, FLOOR_Y, -100); // 1m ahead of the origin, inside a sofa's overlap radius
  w.session.respond = () => ({ position: spot, normal: vec3.up() });

  w.say("add a sofa");
  w.pump(5);
  const first = SpatialisRegistry.last();
  near(first.transform.getWorldPosition().distance(spot), 0, 1e-9, "must not dodge its own instance");

  // A second sofa aimed at the same spot must still be nudged clear of the first.
  w.later();
  w.say("add a sofa");
  w.pump(5);
  const second = SpatialisRegistry.last();
  ok(second !== first);
  ok(second.transform.getWorldPosition().distance(spot) > 100, "overlap avoidance still works for real neighbours");
});

test("the same holds on the retry path, when the gaze first hits the wrong surface", () => {
  // The gaze lands on a partition wall; a sofa wants a floor, so the anchor
  // re-probes toward the ground. That second attempt is a separate code path
  // through the overlap check, and it must know which piece it is placing
  // just like the first — otherwise every sofa spawned while facing a wall
  // dodges itself.
  const w = makeWorld();
  const spot = new vec3(0, FLOOR_Y, -100);
  let n = 0;
  w.session.respond = () =>
    ++n === 1
      ? { position: new vec3(0, 149, -240), normal: new vec3(0, 0, 1) } // a wall, 2.4m out
      : { position: spot, normal: vec3.up() };

  w.say("add a sofa");
  w.pump(5);
  eq(w.session.probes.length, 2, "a wrong-surface hit costs exactly one retry probe");
  const retry = w.session.probes[1];
  ok(retry.end.y < retry.start.y, "the retry for a floor piece aims down");

  const sofa = SpatialisRegistry.last();
  eq(sofa.surface, "floor");
  near(sofa.transform.getWorldPosition().distance(spot), 0, 1e-9, "must not dodge its own instance on retry");
  eq(w.feedback(), "Added a sofa on the floor");
});

test("describe() reads back the style, finish and label in that order", () => {
  const w = makeWorld();
  w.say("add a scandinavian walnut coffee table");
  w.pump(5);
  eq(w.feedback(), "Added a scandinavian walnut coffee table on the floor");
  eq(SpatialisRegistry.last().materialKey, "walnut");

  w.later();
  w.say("add a brass lamp"); // preset LABEL, not the key
  w.pump(5);
  eq(w.feedback(), "Added a brushed brass floor lamp on the floor");

  w.later();
  w.say("add a sage chair"); // a bare tint is still worth confirming
  w.pump(5);
  eq(w.feedback(), "Added a sage lounge chair on the floor");
});

suite("VoiceCommandController — spawn failure modes");

test("a catalog noun with no prefab wired reports 'no model loaded' and places nothing", () => {
  const w = makeWorld();
  w.say("add a bed");
  w.pump(5);
  eq(SpatialisRegistry.count(), 0);
  eq(w.feedback(), "No model loaded for bed");
  eq(w.session.probes.length, 0, "must not even ask the anchor");
});

test("a spawn verb with an unknown noun is 'didn't catch that', not a guess", () => {
  const w = makeWorld();
  w.say("spawn a helicopter");
  w.pump(5);
  eq(SpatialisRegistry.count(), 0);
  ok(w.feedback().indexOf("catch that") >= 0, "got: " + w.feedback());
});

test("without an anchor engine a spawn still lands at the parent origin, animates and styles", () => {
  // The documented degraded mode for a scene with no World Query module.
  const w = makeWorld({ anchorEngine: null });
  w.say("add a walnut coffee table");
  eq(SpatialisRegistry.count(), 1);
  const table = SpatialisRegistry.last();
  near(scaleOf(table).x, BASE * 0.001, 1e-12, "still hidden until the tween runs");

  w.pump(10);
  near(scaleOf(table).x, BASE, 1e-12);
  const pos = table.transform.getWorldPosition();
  near(pos.x, 0, 1e-9); near(pos.y, 0, 1e-9); near(pos.z, 0, 1e-9);
  eq(table.surface, "unknown");
  eq(table.materialKey, "walnut");
  near(colorOf(table).x, 0.28, 1e-9);
  near(passOf(table).roughness, 0.48, 1e-9);
  eq(w.feedback(), "Added a coffee table");
});

test("a piece deleted while its hit test is in flight stays deleted", () => {
  // "add a sofa" ... "undo" inside one frame. When the probe answers, the
  // callback must notice the object is gone rather than reposition a
  // destroyed node and announce a sofa that is not there.
  const w = makeWorld();
  w.say("add a sofa");
  const sofa = SpatialisRegistry.last();
  const writesBefore = sofa.transform.positionWrites;
  SpatialisRegistry.remove(sofa.id);
  eq(sofa.sceneObject.destroyed, true);

  w.pump(10);
  eq(SpatialisRegistry.count(), 0, "must not be resurrected");
  eq(sofa.transform.positionWrites, writesBefore, "no placement written to a destroyed object");
  eq(sofa.surface, "unknown", "the stale entry must not be updated");
  eq(w.feedback(), "", "no 'Added a sofa' for something that no longer exists");
  eq(w.voice.tweens.tweens.length, 0, "no spawn animation for it either");
});

suite("VoiceCommandController — restyling what is already in the room");

test("“make the sofa leather” restyles the sofa by kind and leaves the chair alone", () => {
  const w = makeWorld();
  w.say("add a sofa"); w.pump(5); w.later();
  w.say("add a chair"); w.pump(5); w.later();
  const sofa = SpatialisRegistry.lastOfKind("sofa");
  const chair = SpatialisRegistry.lastOfKind("chair");

  w.say("make the sofa leather");
  w.pump(2);
  eq(sofa.materialKey, "leather");
  eq(chair.materialKey, "", "the more recent chair is not the target");
  near(colorOf(sofa).x, 0.45, 1e-9);
  near(passOf(sofa).roughness, 0.55, 1e-9);
  near(colorOf(chair).x, 0.8, 1e-9, "the chair keeps its prefab look");
  eq(w.feedback(), "sofa → tan leather");

  // A second restyle must reuse the private clone, not clone again.
  const cloneBefore = sofa.sceneObject.visual.mainMaterial;
  w.later();
  w.say("make the sofa marble");
  w.pump(2);
  eq(sofa.materialKey, "marble");
  ok(sofa.sceneObject.visual.mainMaterial === cloneBefore, "cloned exactly once per object");
  eq(w.prefabs.sofa.shared.clones, 1);
});

test("“make it oak” with no noun targets the last thing spawned", () => {
  const w = makeWorld();
  w.say("add a sofa"); w.pump(5); w.later();
  w.say("add a chair"); w.pump(5); w.later();

  w.say("make it oak");
  w.pump(2);
  eq(SpatialisRegistry.lastOfKind("chair").materialKey, "oak");
  eq(SpatialisRegistry.lastOfKind("sofa").materialKey, "");
  eq(w.feedback(), "lounge chair → white oak");
});

test("restyling an empty room says so instead of failing", () => {
  const w = makeWorld();
  w.say("make it velvet");
  eq(w.feedback(), "Nothing to restyle yet");
  eq(SpatialisRegistry.count(), 0);
});

test("“twice as big” doubles, doubles again, then clamps at 4x base; “smaller” backs off", () => {
  const w = makeWorld();
  w.say("add a sofa"); w.pump(5);
  const sofa = SpatialisRegistry.last();

  w.later(); w.say("make it twice as big"); w.pump(10);
  near(scaleOf(sofa).x, BASE * 2, 1e-9);
  eq(w.feedback(), "Enlarged the sofa");

  w.later(); w.say("make it twice as big"); w.pump(10);
  near(scaleOf(sofa).x, BASE * 4, 1e-9);

  // The clamp is against the piece's OWN base scale, not against 1.0 — a
  // prefab authored at 1.5 must still be allowed to reach 6.0.
  w.later(); w.say("make it twice as big"); w.pump(10);
  near(scaleOf(sofa).x, BASE * 4, 1e-9, "must not exceed 4x base");

  w.later(); w.say("make it smaller"); w.pump(10);
  near(scaleOf(sofa).x, (BASE * 4) / 1.3, 1e-9, "'smaller' is a 1.3x reduction from the clamped size");
  eq(w.feedback(), "Shrunk the sofa");
});

suite("VoiceCommandController — removing");

test("“remove the lamp” scales it out, destroys it, drops it from the registry and the swapper", () => {
  const w = makeWorld();
  w.say("add a brass lamp"); w.pump(5); // styled, so the swapper holds a clone for it
  w.later(); w.say("add a sofa"); w.pump(5);
  const lamp = SpatialisRegistry.lastOfKind("lamp");
  eq(w.swapper.styled.length, 1);
  const forgotten = [];
  const realForget = w.swapper.forget.bind(w.swapper);
  w.swapper.forget = (id) => { forgotten.push(id); realForget(id); };

  w.later();
  w.say("remove the lamp");
  eq(w.feedback(), "Removed the floor lamp");
  eq(lamp.sceneObject.destroyed, false, "must scale out before vanishing, not blink off mid-frame");
  eq(SpatialisRegistry.count(), 2, "still registered while the scale-out plays");

  w.pump(1);
  ok(scaleOf(lamp).x < BASE, "shrinking");
  eq(lamp.sceneObject.destroyed, false);

  w.pump(10);
  eq(lamp.sceneObject.destroyed, true);
  eq(SpatialisRegistry.count(), 1);
  eq(SpatialisRegistry.lastOfKind("lamp"), null);
  eq(SpatialisRegistry.last().kind, "sofa", "the wrong piece must not be removed");
  eq(forgotten, [lamp.id]);
  eq(w.swapper.styled.length, 0, "the material clone bookkeeping is released");
});

test("“undo” with nothing in the room says 'Nothing to remove'", () => {
  const w = makeWorld();
  w.say("undo");
  w.pump(5);
  eq(w.feedback(), "Nothing to remove");
});

test("“clear the room” destroys every piece and counts them; a second clear finds it empty", () => {
  const w = makeWorld();
  w.say("add a velvet sofa"); w.pump(5); w.later();
  w.say("add a chair"); w.pump(5); w.later();
  // Leave the last spawn mid-animation: "clear the room" shouted over a
  // landing lamp must take the animation down with the lamp, or the tween
  // keeps writing scale into a destroyed node every frame.
  w.say("add a lamp"); w.pump(1); w.later();
  const all = SpatialisRegistry.all().slice();
  eq(all.length, 3);
  eq(w.swapper.styled.length, 1);
  ok(w.voice.tweens.tweens.length > 0, "a spawn tween is still in flight");

  w.say("clear the room");
  eq(w.feedback(), "Cleared 3 pieces");
  eq(SpatialisRegistry.count(), 0);
  for (const entry of all) eq(entry.sceneObject.destroyed, true, entry.kind + " should be destroyed");
  eq(w.swapper.styled.length, 0);
  eq(w.voice.tweens.tweens.length, 0, "in-flight animations are dropped with their objects");

  w.later();
  w.say("clear the room");
  eq(w.feedback(), "Room is already empty");
});

suite("VoiceCommandController — transcript hygiene");

test("an identical transcript within 2s is ASR echo and runs once; after 2s it runs again", () => {
  const w = makeWorld();
  w.say("add a sofa");
  clock.now = 1.0;
  w.say("Add a sofa!"); // same words after normalization: case and punctuation differ
  eq(SpatialisRegistry.count(), 1, "the duplicate must be dropped");

  clock.now = 3.5;
  w.say("add a sofa");
  eq(SpatialisRegistry.count(), 2, "a deliberate repeat after the window is a second sofa");

  // Different commands back-to-back are not echoes.
  w.say("add a chair");
  w.say("add a lamp");
  eq(SpatialisRegistry.count(), 4);
  eq(SpatialisRegistry.all().map((e) => e.kind), ["sofa", "sofa", "chair", "lamp"]);
});

test("with the wake word required, only sentences carrying it are acted on, and it is stripped", () => {
  const w = makeWorld({ requireWakeWord: true });
  w.say("add a sofa");
  eq(SpatialisRegistry.count(), 0, "no wake word, no action");
  eq(w.feedback(), "", "and no feedback either — the user was talking to someone else");

  w.say("spatialis add a sofa");
  eq(SpatialisRegistry.count(), 1);
  eq(SpatialisRegistry.last().kind, "sofa");

  // Mid-sentence, capitalised, with a comma: what people actually say.
  w.say("Hey Spatialis, add a chair");
  eq(SpatialisRegistry.count(), 2);
  eq(SpatialisRegistry.last().kind, "chair");
  w.pump(5);
  eq(w.feedback(), "Added a lounge chair on the floor");

  // Everything BEFORE the wake word is chatter to someone else and must be
  // discarded: "chair" is a longer alias than "lamp", so if the prefix leaked
  // into the parser a chair would win.
  w.say("no leave the chair alone. Spatialis, add a lamp");
  eq(SpatialisRegistry.count(), 3);
  eq(SpatialisRegistry.last().kind, "lamp", "the parser saw only the words after the wake word");
});

test("interim transcripts only echo to the feedback text; the final one executes", () => {
  const w = makeWorld();
  w.voice.onListeningUpdate({ transcription: "add a", isFinalTranscription: false });
  eq(w.feedback(), "… add a");
  eq(SpatialisRegistry.count(), 0);

  w.voice.onListeningUpdate({ transcription: "add a sofa", isFinalTranscription: false });
  eq(w.feedback(), "… add a sofa");
  eq(SpatialisRegistry.count(), 0, "a partial that happens to parse must still not execute");

  w.voice.onListeningUpdate({ transcription: "", isFinalTranscription: true });
  eq(w.feedback(), "… add a sofa", "an empty final is ignored");

  w.voice.onListeningUpdate({ transcription: "add a sofa", isFinalTranscription: true });
  eq(SpatialisRegistry.count(), 1);
  eq(SpatialisRegistry.last().kind, "sofa");
});

// ---------------------------------------------------------------------------

SpatialisRegistry.removeAll();
globalThis.getTime = realGetTime;
globalThis.isNull = realIsNull;
