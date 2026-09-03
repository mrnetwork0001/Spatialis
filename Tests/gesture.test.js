/**
 * gesture.test.js — SpatialGestureController state machine.
 *
 * Pinch, grab and two-hand transforms are the part of Spatialis most likely to
 * break silently: a wrong threshold does not throw, it just makes furniture
 * flicker or stick. These drive the joints directly through the SIK stub so the
 * exact distances that open and close a pinch can be asserted.
 *
 * License: Apache-2.0
 */

const path = require("path");
const { suite, test, eq, ok, near } = require("./harness");
const B = path.join(__dirname, "..", ".build", "Scripts");
const { SpatialGestureController } = require(path.join(B, "SpatialGestureController.js"));
const { SpatialisRegistry, getFurnitureSpec } = require(path.join(B, "SpatialisCore.js"));
const sik = require("./stubs/SIK");

/** A controller wired to the stub hands, with a recording anchor engine. */
function makeController(overrides = {}) {
  sik.reset();
  SpatialisRegistry.removeAll();

  const g = Object.create(SpatialGestureController.prototype);
  Object.assign(g, {
    pinchDownDistance: 3.0,
    pinchUpDistance: 4.5,
    adaptToHandSize: true,
    grabRadius: 45,
    dragSmoothing: 0,           // follow the hand exactly, so asserts are exact
    minScaleFactor: 0.3,
    maxScaleFactor: 3.0,
    singleHandRotate: false,
    grabIndicator: null,
    hands: [],
    twoHand: null,
    handsAvailable: false,
    singleHandStartYaw: 0,
    singleHandStartRotation: quat.quatIdentity(),
  }, overrides);

  g.reseatCalls = [];
  g.anchorEngine = {
    reseat(obj, cb) {
      g.reseatCalls.push(obj.id);
      cb({
        anchored: true,
        position: obj.transform.getWorldPosition(),
        rotation: quat.quatIdentity(),
        surface: "floor",
        normal: vec3.up(),
      });
    },
  };

  g.getSceneObject = () => ({ getTransform: () => null });
  g.onStart();
  return g;
}

/** A registry entry with a mutable transform, positioned in world space. */
function place(kind, x, y, z, scale = 1) {
  const spec = getFurnitureSpec(kind);
  let pos = new vec3(x, y, z);
  let scl = new vec3(scale, scale, scale);
  let rot = quat.quatIdentity();
  return SpatialisRegistry.register({
    sceneObject: { name: kind, destroyed: false, destroy() { this.destroyed = true; } },
    transform: {
      getWorldPosition: () => pos,
      setWorldPosition: (p) => { pos = p; },
      getLocalScale: () => scl,
      setLocalScale: (s) => { scl = s; },
      getWorldRotation: () => rot,
      setWorldRotation: (r) => { rot = r; },
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

const RIGHT = (center, separation, span) => sik.hands.right.pinchAt(center, separation, span);
const LEFT = (center, separation, span) => sik.hands.left.pinchAt(center, separation, span);

/** Settle the running span average by holding a pose for a while. */
function settleSpan(g, span, frames = 90) {
  for (let i = 0; i < frames; i++) {
    RIGHT(new vec3(0, 0, 0), 20, span);
    g.onUpdate();
  }
}

suite("SpatialGestureController — pinch hysteresis");

test("a pinch closes at the down distance", () => {
  const g = makeController();
  RIGHT(new vec3(0, 0, 0), 6.0);
  g.onUpdate();
  eq(g.isPinching("right"), false, "6cm apart is open");

  RIGHT(new vec3(0, 0, 0), 3.0);
  g.onUpdate();
  eq(g.isPinching("right"), true, "3.0cm should close it");
});

test("a closed pinch survives jitter between the two thresholds", () => {
  // This is the whole reason hysteresis exists: joints jitter by millimetres
  // at arm's length, and a single threshold makes a grab chatter.
  const g = makeController();
  RIGHT(new vec3(0, 0, 0), 2.5);
  g.onUpdate();
  eq(g.isPinching("right"), true);

  for (const jitter of [3.2, 4.0, 4.4, 3.6]) {
    RIGHT(new vec3(0, 0, 0), jitter);
    g.onUpdate();
    eq(g.isPinching("right"), true, jitter + "cm should not open the pinch");
  }
});

test("a pinch opens only at the up distance", () => {
  const g = makeController();
  RIGHT(new vec3(0, 0, 0), 2.0);
  g.onUpdate();
  RIGHT(new vec3(0, 0, 0), 4.5);
  g.onUpdate();
  eq(g.isPinching("right"), false, "4.5cm should open it");
});

test("an inverted threshold pair is corrected rather than obeyed", () => {
  // Without a gap there is no hysteresis at all, so onStart repairs it.
  const g = makeController({ pinchDownDistance: 4.0, pinchUpDistance: 2.0 });
  ok(g.pinchUpDistance > g.pinchDownDistance, "up must exceed down after repair");
});

suite("SpatialGestureController — grabbing");

test("pinching near a piece grabs it", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  RIGHT(new vec3(10, 0, 0), 2.0);
  g.onUpdate();
  ok(g.heldObject() !== null, "should have grabbed something");
  eq(g.heldObject().id, sofa.id);
  eq(sofa.isGrabbed, true);
});

test("pinching in empty space grabs nothing", () => {
  const g = makeController();
  place("vase", 0, 0, 0);           // footprint 12, reach 45+12 = 57
  RIGHT(new vec3(400, 0, 0), 2.0);
  g.onUpdate();
  eq(g.heldObject(), null);
});

test("the nearest piece wins when several are in reach", () => {
  const g = makeController();
  place("vase", 0, 0, 0);
  const near2 = place("vase", 30, 0, 0);
  RIGHT(new vec3(34, 0, 0), 2.0);
  g.onUpdate();
  eq(g.heldObject().id, near2.id);
});

test("grab reach grows with how large a piece is drawn", () => {
  // A sofa scaled to 2x should be grabbable from further out than at 1x.
  const g1 = makeController();
  place("chair", 0, 0, 0, 1);        // footprint 45 -> reach 45 + 45 = 90
  RIGHT(new vec3(120, 0, 0), 2.0);
  g1.onUpdate();
  eq(g1.heldObject(), null, "out of reach at 1x");

  const g2 = makeController();
  place("chair", 0, 0, 0, 2);        // reach 45 + 90 = 135
  RIGHT(new vec3(120, 0, 0), 2.0);
  g2.onUpdate();
  ok(g2.heldObject() !== null, "in reach at 2x");
});

test("dragging carries the piece with the hand, preserving the offset", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  RIGHT(new vec3(20, 0, 0), 2.0);   // grab from 20cm off-centre
  g.onUpdate();
  RIGHT(new vec3(120, 0, 0), 2.0);  // hand moves +100
  g.onUpdate();
  near(sofa.transform.getWorldPosition().x, 100, 0.001, "piece should move by the same 100cm");
});

suite("SpatialGestureController — release");

test("releasing hands the piece to the anchor engine to settle", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  RIGHT(new vec3(0, 0, 0), 2.0);
  g.onUpdate();
  RIGHT(new vec3(0, 0, 0), 6.0);
  g.onUpdate();
  eq(g.reseatCalls, [sofa.id], "reseat should be called exactly once");
  eq(sofa.isGrabbed, false);
});

test("losing hand tracking mid-grab settles the piece instead of freezing it", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  RIGHT(new vec3(0, 0, 0), 2.0);
  g.onUpdate();
  eq(g.heldObject().id, sofa.id);

  sik.hands.right.tracked = false;   // hand leaves the camera frame
  g.onUpdate();
  eq(g.reseatCalls, [sofa.id], "a lost hand must count as a release");
  eq(g.heldObject(), null);
});

test("releaseAll clears every grab", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  RIGHT(new vec3(0, 0, 0), 2.0);
  g.onUpdate();
  g.releaseAll();
  eq(g.heldObject(), null);
  eq(sofa.isGrabbed, false);
});

suite("SpatialGestureController — two-hand transform");

test("spreading both hands scales the piece up", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  LEFT(new vec3(-20, 0, 0), 2.0);
  RIGHT(new vec3(20, 0, 0), 2.0);
  g.onUpdate();                       // both hands on the same piece
  ok(g.twoHand !== null, "two-hand transform should have engaged");

  LEFT(new vec3(-40, 0, 0), 2.0);     // separation 40 -> 80, ratio 2
  RIGHT(new vec3(40, 0, 0), 2.0);
  g.onUpdate();
  near(sofa.transform.getLocalScale().x, 2.0, 0.01);
});

test("scale is clamped against the piece's own base size", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  LEFT(new vec3(-5, 0, 0), 2.0);
  RIGHT(new vec3(5, 0, 0), 2.0);
  g.onUpdate();

  LEFT(new vec3(-500, 0, 0), 2.0);    // an absurd spread
  RIGHT(new vec3(500, 0, 0), 2.0);
  g.onUpdate();
  near(sofa.transform.getLocalScale().x, 3.0, 0.001, "must not exceed maxScaleFactor");

  LEFT(new vec3(-0.5, 0, 0), 2.0);    // hands almost touching
  RIGHT(new vec3(0.5, 0, 0), 2.0);
  g.onUpdate();
  near(sofa.transform.getLocalScale().x, 0.3, 0.001, "must not fall below minScaleFactor");
});

test("lifting one hand continues the drag rather than dropping the piece", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  LEFT(new vec3(-20, 0, 0), 2.0);
  RIGHT(new vec3(20, 0, 0), 2.0);
  g.onUpdate();
  ok(g.twoHand !== null);

  LEFT(new vec3(-20, 0, 0), 6.0);     // left hand opens
  g.onUpdate();
  eq(g.reseatCalls, [], "the piece was never released, so it must not be re-seated");
  ok(g.heldObject() !== null, "the right hand should still be holding it");
  eq(g.twoHand, null, "the two-hand transform should have ended");
  eq(sofa.isGrabbed, true);
});

test("lifting the second hand finally releases the piece", () => {
  const g = makeController();
  const sofa = place("sofa", 0, 0, 0);
  LEFT(new vec3(-20, 0, 0), 2.0);
  RIGHT(new vec3(20, 0, 0), 2.0);
  g.onUpdate();
  LEFT(new vec3(-20, 0, 0), 6.0);
  g.onUpdate();
  RIGHT(new vec3(20, 0, 0), 6.0);
  g.onUpdate();
  eq(g.reseatCalls, [sofa.id]);
  eq(sofa.isGrabbed, false);
});

suite("SpatialGestureController — hand-relative thresholds");

test("a nominal hand gets exactly the authored thresholds", () => {
  const g = makeController();
  settleSpan(g, 18);
  near(g.effectivePinchDown("right"), 3.0, 0.05);
  near(g.effectivePinchUp("right"), 4.5, 0.05);
});

test("a smaller hand closes its pinch at a proportionally smaller gap", () => {
  // A 3cm gap is a firm pinch on a large hand and an open grip on a small one.
  const g = makeController();
  settleSpan(g, 12);                       // 12/18 = 0.667
  near(g.effectivePinchDown("right"), 3.0 * (12 / 18), 0.08);

  // 2.4cm would NOT close a nominal hand's pinch... it is below 3.0, so it
  // would. Use a gap between the two thresholds to show the difference.
  const gap = 2.6;                          // above 12cm-hand's 2.0 close
  RIGHT(new vec3(0, 0, 0), gap, 12);
  g.onUpdate();
  eq(g.isPinching("right"), false, "2.6cm should not close a small hand's pinch");

  const g2 = makeController();
  settleSpan(g2, 18);
  RIGHT(new vec3(0, 0, 0), gap, 18);
  g2.onUpdate();
  eq(g2.isPinching("right"), true, "the same 2.6cm closes a nominal hand's pinch");
});

test("a larger hand closes its pinch at a proportionally larger gap", () => {
  const g = makeController();
  settleSpan(g, 24);                       // 24/18 = 1.333
  near(g.effectivePinchDown("right"), 3.0 * (24 / 18), 0.1);
  RIGHT(new vec3(0, 0, 0), 3.6, 24);
  g.onUpdate();
  eq(g.isPinching("right"), true, "3.6cm closes a large hand's pinch");
});

test("scaling is clamped so one bad tracking frame cannot distort the feel", () => {
  const g = makeController();
  settleSpan(g, 200);                      // absurd span from bad tracking
  const scaled = g.effectivePinchDown("right");
  ok(scaled <= 3.0 * 1.6 + 0.01, "must not exceed the max span scale, got " + scaled);
});

test("adaptToHandSize=false restores exact absolute thresholds", () => {
  const g = makeController({ adaptToHandSize: false });
  settleSpan(g, 30);
  near(g.effectivePinchDown("right"), 3.0, 0.001);
  near(g.effectivePinchUp("right"), 4.5, 0.001);
});

test("hysteresis still holds once thresholds are scaled", () => {
  const g = makeController();
  settleSpan(g, 24);                       // close 4.0, open 6.0
  RIGHT(new vec3(0, 0, 0), 3.5, 24);
  g.onUpdate();
  eq(g.isPinching("right"), true);
  RIGHT(new vec3(0, 0, 0), 5.2, 24);       // between the scaled thresholds
  g.onUpdate();
  eq(g.isPinching("right"), true, "must not open between scaled thresholds");
  RIGHT(new vec3(0, 0, 0), 6.1, 24);
  g.onUpdate();
  eq(g.isPinching("right"), false, "must open at the scaled up-threshold");
});
