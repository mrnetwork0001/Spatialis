/**
 * core.test.js — SpatialisCore: catalog resolution, registry, math helpers.
 * License: Apache-2.0
 */

const path = require("path");
const { suite, test, eq, ok, near } = require("./harness");
const core = require(path.join(__dirname, "..", ".build", "Scripts", "SpatialisCore.js"));
const { resolveFurniture, getFurnitureSpec, SpatialisRegistry, FURNITURE_CATALOG } = core;

function makeEntry(kind, x, z) {
  const spec = getFurnitureSpec(kind);
  const pos = new vec3(x, 0, z);
  return SpatialisRegistry.register({
    sceneObject: { name: kind, destroyed: false, destroy() { this.destroyed = true; } },
    transform: {
      getWorldPosition: () => pos,
      setWorldPosition: () => {},
      getLocalScale: () => new vec3(1, 1, 1),
      setLocalScale: () => {},
      getWorldRotation: () => quat.quatIdentity(),
      setWorldRotation: () => {},
    },
    kind,
    spec,
    placement: "auto",
    surface: "floor",
    surfaceNormal: vec3.up(),
    baseScale: new vec3(1, 1, 1),
    materialKey: "",
    spawnedAtSeconds: 0,
    isGrabbed: false,
  });
}

suite("SpatialisCore — catalog resolution");

test("longest alias wins: 'coffee table' does not resolve as 'table'", () => {
  eq(resolveFurniture("a coffee table"), "coffeeTable");
  eq(resolveFurniture("a dining table"), "table");
});

test("multi-word aliases resolve regardless of surrounding words", () => {
  eq(resolveFurniture("put the standing lamp over there"), "lamp");
  eq(resolveFurniture("a bedside lamp please"), "tableLamp");
});

test("plurals resolve — speech is often plural", () => {
  eq(resolveFurniture("make the chairs navy"), "chair");
  eq(resolveFurniture("move the sofas"), "sofa");
});

test("unknown nouns resolve to empty, not to a wrong guess", () => {
  eq(resolveFurniture("a helicopter"), "");
  eq(resolveFurniture(""), "");
});

test("every catalog entry is reachable by its own key", () => {
  for (const spec of FURNITURE_CATALOG) {
    ok(getFurnitureSpec(spec.key) !== null, "missing spec for " + spec.key);
  }
});

test("catalog metadata is physically sane", () => {
  for (const spec of FURNITURE_CATALOG) {
    ok(spec.footprint > 0 && spec.footprint < 200, spec.key + " footprint out of range");
    ok(spec.height > 0 && spec.height < 250, spec.key + " height out of range");
    ok(spec.aliases.length > 0, spec.key + " has no aliases");
  }
});

suite("SpatialisCore — object registry");

test("register assigns increasing ids and counts", () => {
  SpatialisRegistry.removeAll();
  const a = makeEntry("sofa", 0, 0);
  const b = makeEntry("chair", 100, 0);
  ok(b.id > a.id, "ids should increase");
  eq(SpatialisRegistry.count(), 2);
});

test("last() returns the most recent spawn — the target of 'make it bigger'", () => {
  SpatialisRegistry.removeAll();
  makeEntry("sofa", 0, 0);
  const chair = makeEntry("chair", 100, 0);
  eq(SpatialisRegistry.last().id, chair.id);
});

test("lastOfKind() targets the named piece, not the most recent one", () => {
  SpatialisRegistry.removeAll();
  const sofa = makeEntry("sofa", 0, 0);
  makeEntry("chair", 100, 0);
  eq(SpatialisRegistry.lastOfKind("sofa").id, sofa.id);
  eq(SpatialisRegistry.lastOfKind("lamp"), null);
});

test("nearest() respects its radius", () => {
  SpatialisRegistry.removeAll();
  const near1 = makeEntry("sofa", 10, 10);
  makeEntry("chair", 400, 400);
  eq(SpatialisRegistry.nearest(new vec3(0, 0, 0), 50).id, near1.id);
  eq(SpatialisRegistry.nearest(new vec3(0, 0, 0), 5), null);
});

test("remove() destroys the SceneObject, not just the entry", () => {
  SpatialisRegistry.removeAll();
  const sofa = makeEntry("sofa", 0, 0);
  const obj = sofa.sceneObject;
  ok(SpatialisRegistry.remove(sofa.id), "remove should report success");
  ok(obj.destroyed, "SceneObject should have been destroyed");
  eq(SpatialisRegistry.remove(sofa.id), false, "second remove should be a no-op");
});

test("removeAll() reports how many it cleared and empties the room", () => {
  SpatialisRegistry.removeAll();
  makeEntry("sofa", 0, 0);
  makeEntry("chair", 50, 0);
  eq(SpatialisRegistry.removeAll(), 2);
  eq(SpatialisRegistry.count(), 0);
});

suite("SpatialisCore — math helpers");

test("clamp bounds in both directions", () => {
  eq(core.clamp(5, 0, 1), 1);
  eq(core.clamp(-5, 0, 1), 0);
  eq(core.clamp(0.5, 0, 1), 0.5);
});

test("damp is framerate independent — this is why it exists", () => {
  // One second of smoothing must land in the same place whether it was
  // reached in 60 steps or in 30.
  let at60 = 0;
  for (let i = 0; i < 60; i++) at60 = core.damp(at60, 100, 0.1, 1 / 60);
  let at30 = 0;
  for (let i = 0; i < 30; i++) at30 = core.damp(at30, 100, 0.1, 1 / 30);
  near(at60, at30, 0.5, "60fps and 30fps should converge alike");
  near(at60, 90, 1.5, "0.1 smoothing should leave ~10% of the error after 1s");
});

test("easeOutBack overshoots then settles on 1", () => {
  // The endpoints are exact in real arithmetic but land within 1e-15 in
  // floating point, which is far below anything a scale animation can show.
  near(core.easeOutBack(0), 0, 1e-9);
  near(core.easeOutBack(1), 1, 1e-9);
  ok(core.easeOutBack(0.75) > 1, "should overshoot before settling");
});

test("easeOutCubic is monotonic and bounded", () => {
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const v = core.easeOutCubic(t);
    ok(v >= prev, "should not decrease");
    ok(v >= 0 && v <= 1, "should stay in [0,1]");
    prev = v;
  }
});

test("yawTowards ignores height — furniture faces you without tipping over", () => {
  const flat = core.yawTowards(new vec3(0, 0, 0), new vec3(100, 0, 0));
  const raised = core.yawTowards(new vec3(0, 0, 0), new vec3(100, 500, 0));
  eq(flat.w, raised.w, "a target overhead should yaw the same as one at eye level");
});
