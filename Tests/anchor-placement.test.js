/**
 * anchor-placement.test.js - SurfaceAnchorEngine placement, retry, overlap,
 * wall-adjacent placement, re-seating and the probe queue.
 *
 * classify() is covered in anchor.test.js. Everything downstream of it runs
 * only through World Query on a headset, so these drive the shipped engine with
 * a scripted hit-test source: tests pre-load the answers and then assert both
 * WHERE the engine chose to look (the ray log) and WHAT it did with the answer.
 *
 * Rays are asserted by intent - where they cross the floor, whether they point
 * down, whether they are level - rather than by their exact direction vector,
 * so a legitimate change to how a ray is aimed does not break the suite while
 * a ray that lands in the wrong place still does.
 *
 * Geometry convention used throughout: the eye sits at (0, 155, 0) and the
 * camera looks down -Z, which in Lens Studio terms means transform.forward is
 * +Z (the engine negates it). Floor is at y = 0 unless a test says otherwise.
 *
 * License: Apache-2.0
 */

const path = require("path");
const { suite, test, eq, ok, near } = require("./harness");
const B = path.join(__dirname, "..", ".build", "Scripts");
const { SurfaceAnchorEngine } = require(path.join(B, "SurfaceAnchorEngine.js"));
const core = require(path.join(B, "SpatialisCore.js"));
const { SpatialisRegistry, getFurnitureSpec, yawTowards, alignToNormal } = core;

const EYE_HEIGHT = 155;
const PROBE_DISTANCE = 700;
const FLOAT_DISTANCE = 160;
/**
 * Where a piece floats when nothing can be hit: floatDistance, or further for
 * big furniture so a 2.1m sofa does not fill the wearer's view with one face.
 */
const floatRange = (spec) => Math.max(FLOAT_DISTANCE, spec.footprint * 2.5);
const FLOOR = (x, y, z) => ({ position: new vec3(x, y, z), normal: vec3.up() });
const WALL = (x, y, z, nx, ny, nz) => ({
  position: new vec3(x, y, z),
  normal: new vec3(nx, ny, nz),
});
const xyz = (v) => ({ x: v.x, y: v.y, z: v.z });

/**
 * A scripted stand-in for the World Query hit-test session. Answers are taken
 * in order from `answers`; a missing answer is a miss (null). Every request is
 * logged so tests can assert the ray the engine actually cast.
 *
 * hitTest(start, end, cb) is the only method the engine calls; answer/hold/
 * respond are test-side controls. `hold = true` makes it behave like the real
 * thing - the answer arrives on a later frame - so the one-in-flight rule can
 * be observed.
 */
function scriptedSession() {
  const s = {
    answers: [],
    log: [],
    hold: false,
    pending: null,
    answer(...hits) {
      s.answers.push(...hits);
      return s;
    },
    hitTest(start, end, cb) {
      s.log.push({ start, end });
      if (s.hold) {
        s.pending = cb;
        return;
      }
      cb(s.answers.length > 0 ? s.answers.shift() : null);
    },
    /** Deliver the answer to the probe that is being held in flight. */
    respond(hit) {
      const cb = s.pending;
      s.pending = null;
      cb(hit === undefined ? null : hit);
    },
  };
  return s;
}

/**
 * An engine attached to a scripted session, with the floor-calibration probe
 * already answered (floor at y = 0 by default). `calibration: null` makes the
 * calibration probe miss so the eye-height fallback is exercised.
 */
function makeEngine(opts = {}) {
  SpatialisRegistry.removeAll();
  const eye = opts.eye || new vec3(0, EYE_HEIGHT, 0);
  const forward = opts.forward || new vec3(0, 0, 1); // +Z forward == looking down -Z
  // The engine reads exactly getWorldPosition() and forward from the camera.
  const camera = { getWorldPosition: () => eye, forward };
  const session = scriptedSession();

  const engine = new SurfaceAnchorEngine();
  engine.probeDistance = PROBE_DISTANCE;
  engine.floatDistance = FLOAT_DISTANCE;
  engine.avoidOverlap = opts.avoidOverlap === undefined ? true : opts.avoidOverlap;
  engine.attachHitTestSource(session, camera);

  const calibration = "calibration" in opts ? opts.calibration : FLOOR(eye.x, 0, eye.z);
  session.answer(calibration);
  engine.tick();
  return { engine, session, eye };
}

/** Tick until a placement callback has fired, with a cap so a broken chain fails loudly. */
function settle(engine, start, cap = 6) {
  let result = null;
  start((r) => {
    result = r;
  });
  for (let i = 0; i < cap && result === null; i++) {
    engine.tick();
  }
  ok(result !== null, "placement callback never fired within " + cap + " ticks");
  return result;
}

/**
 * A registry entry shaped as resolveOverlap() and reseat() read it: the engine
 * touches transform.getWorldPosition(), transform.getWorldRotation(), spec,
 * placement, surface, surfaceNormal and sceneObject (through isNull). The
 * remaining fields only complete the SpatialisObject shape.
 */
function place(kind, x, y, z, extra = {}) {
  const spec = getFurnitureSpec(kind);
  const pos = new vec3(x, y, z);
  const rot = extra.rotation || quat.quatIdentity();
  return SpatialisRegistry.register(
    Object.assign(
      {
        sceneObject: { name: kind, destroyed: false, destroy() { this.destroyed = true; } },
        transform: {
          getWorldPosition: () => pos,
          getWorldRotation: () => rot,
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
      },
      extra
    )
  );
}

const planarDistance = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);

/**
 * Where the segment start->end crosses the horizontal plane y = planeY. This is
 * the question that matters about a downward probe: not which way it points,
 * but where on the floor it will land.
 */
function floorCrossing(probe, planeY) {
  const { start, end } = probe;
  ok(end.y < start.y, "a probe that does not descend cannot cross the floor");
  const t = (planeY - start.y) / (end.y - start.y);
  ok(t >= 0 && t <= 1, "the probe ends before reaching y=" + planeY + " (t=" + t + ")");
  return new vec3(
    start.x + t * (end.x - start.x),
    planeY,
    start.z + t * (end.z - start.z)
  );
}

suite("SurfaceAnchorEngine - floor calibration");

test("attaching fires a downward probe and a floor hit becomes the floor estimate", () => {
  // Without a calibrated floor the first horizontal hit - which may be a
  // tabletop - would define "floor", and tables would vanish for the session.
  // The depth normal is deliberately NOT unit length: World Query does not
  // promise one, and noteFloorSample compares the raw dot product against the
  // horizontal threshold, so the pump must normalize before sampling or this
  // perfectly flat floor would be ignored and the estimate left at 0.
  const { engine, session, eye } = makeEngine({
    calibration: { position: new vec3(0, -150, 0), normal: new vec3(0, 0.5, 0) },
  });
  eq(session.log.length, 1, "exactly one probe on attach");
  eq(xyz(session.log[0].start), xyz(eye), "probe starts at the headset");
  ok(session.log[0].end.y < session.log[0].start.y, "probe must point down");
  eq(session.log[0].end.x, eye.x);
  eq(session.log[0].end.z, eye.z);
  near(engine.getFloorHeight(), -150, 1e-9);

  // 75cm above that floor is a table, even though it is below world zero.
  session.answer(FLOOR(0, -75, -200));
  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("tableLamp"), "auto", false, cb));
  eq(r.surface, "table");
  eq(r.anchored, true);
});

test("a missed calibration probe falls back to eye height minus 155", () => {
  // Eye at 170 so the fallback (15) is distinguishable from the initial 0.
  const { engine } = makeEngine({ eye: new vec3(0, 170, 0), calibration: null });
  near(engine.getFloorHeight(), 15, 1e-9);
});

test("a lower horizontal reading eases the floor down rather than snapping", () => {
  // One bad depth sample must not drop the floor through the ground; damp()
  // with 0.02 over 1s leaves 2% of the gap.
  const { engine, session } = makeEngine();
  session.answer(FLOOR(0, -100, -300));
  settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));
  near(engine.getFloorHeight(), -98, 1e-6);
});

suite("SurfaceAnchorEngine - gaze placement");

/** The direction a piece faces: its local +Z forward, rotated by `q`. */
function facing(q) {
  return q.multiplyVec3(vec3.forward());
}
/** Unit XZ direction from `from` to `to`. */
function towardsXZ(from, to) {
  const d = new vec3(to.x - from.x, 0, to.z - from.z);
  return d.normalize();
}

test("a sofa on a floor hit is seated at the hit, facing the user", () => {
  const { engine, session, eye } = makeEngine();
  const hit = new vec3(100, 0, -300);
  session.answer(FLOOR(hit.x, hit.y, hit.z));

  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));
  eq(r.anchored, true);
  eq(r.surface, "floor");
  eq(xyz(r.position), xyz(hit), "sits exactly on the hit point");
  eq(xyz(r.normal), xyz(vec3.up()));
  // The piece faces you: its forward, rotated, points from the hit to the eye
  // on the ground plane, and it has not been tipped - its up stays world up.
  eq(r.rotation, yawTowards(hit, eye));
  const f = facing(r.rotation);
  const want = towardsXZ(hit, eye);
  near(f.x, want.x, 1e-9, "faces the eye (x)");
  near(f.z, want.z, 1e-9, "faces the eye (z)");
  near(f.y, 0, 1e-9, "a yaw only: forward stays level");
  near(r.rotation.multiplyVec3(vec3.up()).y, 1, 1e-9, "up stays world up");
});

test("a sofa on a sloped floor is tilted to the slope instead of yawed flat", () => {
  // A ramp or an uneven rug: a yaw-only rotation would leave two legs in the
  // air. The tell is where the piece's local up ends up after rotation - on
  // the slope's normal, not on world up.
  const { engine, session } = makeEngine();
  const rawNormal = new vec3(0.3, 0.954, 0); // ~17.5 degrees off vertical
  const unit = rawNormal.normalize();
  session.answer({ position: new vec3(0, 0, -300), normal: rawNormal });

  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));
  eq(r.surface, "floor", "still the floor: a slope is not a table");
  near(r.normal.y, unit.y, 1e-12, "the reported normal is the pump-normalized one");
  ok(r.normal.y !== rawNormal.y, "…not the raw depth normal");
  eq(r.rotation, alignToNormal(unit, vec3.forward()));
  const up = r.rotation.multiplyVec3(vec3.up());
  near(up.x, unit.x, 1e-9, "local up follows the slope (x)");
  near(up.y, unit.y, 1e-9, "local up follows the slope (y)");
  near(up.z, unit.z, 1e-9, "local up follows the slope (z)");
  ok(up.y < 0.999, "…so this is a tilt, not a yaw about world up");
});

test("the first probe for a floor piece is tilted below a level gaze", () => {
  // A person looks at the room, not at their feet; a level ray would sail
  // over the floor and hit the far wall every time.
  const { engine, session, eye } = makeEngine();
  session.answer(FLOOR(0, 0, -400));
  settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));
  const probe = session.log[1];
  eq(xyz(probe.start), xyz(eye));
  ok(probe.end.y < probe.start.y, "end must be below start");
  ok(probe.end.z < probe.start.z, "still travels along the gaze (-Z)");
  // gaze (0,0,-1) + (0,-0.36,0), normalized, times probeDistance.
  const scale = PROBE_DISTANCE / Math.sqrt(1 + 0.36 * 0.36);
  near(probe.end.y, eye.y - 0.36 * scale, 1e-6);
  near(probe.end.z, -scale, 1e-6);
  // ~20 degrees down from eye height lands about 4.3m out: a room-scale spot.
  const crossing = floorCrossing(probe, engine.getFloorHeight());
  near(crossing.z, -EYE_HEIGHT / 0.36, 1e-6);
});

test("the first probe for a wall piece follows the gaze without tilt", () => {
  const { engine, session, eye } = makeEngine();
  session.answer(WALL(0, 120, -500, 0, 0, 1));
  settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("artwork"), "auto", false, cb));
  const probe = session.log[1];
  near(probe.end.y, probe.start.y, 1e-9, "level ray");
  near(probe.end.z, eye.z - PROBE_DISTANCE, 1e-6, "full probe distance straight ahead");
  eq(session.log.length, 2, "a wall hit for a wall piece needs no retry");
});

test("a sofa whose gaze ray hits a wall is re-probed to the floor a pace ahead", () => {
  // The retry has one job: find the ground "a comfortable pace ahead" -
  // floatDistance, the same spot the piece would float at if nothing is found.
  // Aiming probeDistance BELOW that spot instead made the ray so steep that it
  // met the floor 35cm out, at the wearer's feet.
  const { engine, session, eye } = makeEngine();
  const crossingZ = eye.z - FLOAT_DISTANCE;
  session.answer(WALL(0, 100, -300, 0, 0, 1), FLOOR(0, 0, crossingZ));
  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));

  eq(session.log.length, 3, "calibration + gaze + one retry");
  const retry = session.log[2];
  eq(xyz(retry.start), xyz(eye), "retry starts at the eye");
  ok(retry.end.y < retry.start.y, "retry aims at the ground");
  const crossing = floorCrossing(retry, engine.getFloorHeight());
  near(crossing.x, eye.x, 1e-6, "straight ahead, no sideways drift");
  near(crossing.z, crossingZ, 1, "meets the floor floatDistance ahead of the wearer");
  eq(r.surface, "floor");
  eq(r.anchored, true);
  eq(xyz(r.position), { x: 0, y: 0, z: crossingZ });
});

test("art whose gaze ray hits the floor is re-probed level and hung at eye height", () => {
  const { engine, session, eye } = makeEngine();
  session.answer(FLOOR(0, 0, -400), WALL(0, 120, -500, 0, 0, 1));
  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("artwork"), "auto", false, cb));

  eq(session.log.length, 3);
  const retry = session.log[2];
  near(retry.end.y, retry.start.y, 1e-9, "the retry for a wall is level");
  eq(r.surface, "wall");
  eq(r.anchored, true);
  // Eye height minus 10, pushed 3cm off the wall along its normal (+Z here).
  near(r.position.x, 0, 1e-9);
  near(r.position.y, eye.y - 10, 1e-9);
  near(r.position.z, -500 + 3, 1e-9);
  eq(xyz(r.normal), { x: 0, y: 0, z: 1 });
  // Hung flush: local up is world up, local forward points into the wall.
  eq(r.rotation, alignToNormal(vec3.up(), new vec3(0, 0, -1)));
});

test("the retry is final - a second wrong surface is accepted, never a third probe", () => {
  // Looping would leave the user staring at nothing while rays go unanswered.
  const { engine, session } = makeEngine();
  session.answer(WALL(0, 100, -300, 0, 0, 1), WALL(0, 100, -200, 0, 0, 1));
  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));
  eq(r.anchored, true);
  eq(r.surface, "wall", "whatever the second probe found is taken as-is");
  eq(session.log.length, 3);
  engine.tick();
  engine.tick();
  eq(session.log.length, 3, "nothing left queued");
});

test("a retry that finds nothing floats the piece rather than going silent", () => {
  // "Add a sofa" while looking at a wall with no depth on the floor below:
  // the voice pipeline still needs an answer, or the command does nothing.
  const { engine, session, eye } = makeEngine();
  const sofa = getFurnitureSpec("sofa");
  session.answer(WALL(0, 100, -300, 0, 0, 1), null);
  const r = settle(engine, (cb) => engine.requestPlacement(sofa, "auto", false, cb));

  eq(session.log.length, 3, "gaze probe, one retry, and nothing more");
  eq(r.anchored, false);
  eq(r.surface, "unknown");
  near(r.position.x, 0, 1e-9);
  near(r.position.y, eye.y - sofa.height * 0.35, 1e-9);
  near(r.position.z, eye.z - floatRange(getFurnitureSpec("sofa")), 1e-9);
});

test("no surface at all floats the piece in front of the eye, lowered by 35% of its height", () => {
  const { engine, session, eye } = makeEngine();
  session.answer(null);
  const sofa = getFurnitureSpec("sofa");
  const r = settle(engine, (cb) => engine.requestPlacement(sofa, "auto", false, cb));
  eq(r.anchored, false);
  eq(r.surface, "unknown");
  near(r.position.x, 0, 1e-9);
  near(r.position.y, eye.y - sofa.height * 0.35, 1e-9);
  near(r.position.z, -floatRange(getFurnitureSpec("sofa")), 1e-9, "floatRange along the gaze (a sofa floats further than floatDistance)");
  eq(r.rotation, yawTowards(r.position, eye), "still turned to face the user");
  eq(session.log.length, 2, "a miss on the initial probe is not retried");
});

test("a 'float' hint answers immediately and casts no ray", () => {
  const { engine, session, eye } = makeEngine();
  let r = null;
  engine.requestPlacement(getFurnitureSpec("sofa"), "float", false, (res) => {
    r = res;
  });
  ok(r !== null, "callback fires synchronously - no tick needed");
  eq(r.anchored, false);
  eq(session.log.length, 1, "only the calibration probe was ever cast");
  near(r.position.z, eye.z - floatRange(getFurnitureSpec("sofa")), 1e-9);
});

test("hints tolerate near-equivalent surfaces but a wall hint rejects the floor", () => {
  // A lamp on the floor and a sofa on a table are odd but not wrong; art on
  // the carpet is wrong.
  // An explicit "on the table" does not settle for the floor at once: it
  // sweeps twelve probes for a table first, then takes the floor via the
  // retry. Gaze probe (floor), twelve misses, one retry hit.
  let { engine, session } = makeEngine();
  session.answer(FLOOR(0, 0, -300), ...Array(12).fill(null), FLOOR(0, 0, -300));
  let r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("tableLamp"), "table", false, cb), 24);
  eq(r.surface, "floor", "'table' hint takes the floor only after the sweep finds no table");
  eq(session.log.length, 1 + 1 + 12 + 1, "calibration, gaze, twelve sweep probes, one retry");

  ({ engine, session } = makeEngine());
  session.answer(FLOOR(0, 75, -200));
  r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "floor", false, cb));
  eq(r.surface, "table", "'floor' hint accepts a table hit");
  eq(session.log.length, 2);

  ({ engine, session } = makeEngine());
  session.answer(FLOOR(0, 0, -300), WALL(0, 120, -500, 0, 0, 1));
  r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("artwork"), "wall", false, cb));
  eq(session.log.length, 3, "'wall' hint rejects a floor hit and retries");
  eq(r.surface, "wall");
});

suite("SurfaceAnchorEngine - overlap");

test("a sofa dropped onto an existing sofa is nudged clear on the ground plane", () => {
  const { engine, session } = makeEngine();
  const hit = new vec3(100, 0, -300);
  place("sofa", hit.x, hit.y, hit.z);
  session.answer(FLOOR(hit.x, hit.y, hit.z));

  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));
  eq(r.anchored, true);
  eq(r.surface, "floor");
  const gap = planarDistance(r.position, hit);
  ok(gap >= 0.75 * (105 + 105), "must clear 0.75 x combined footprints, got " + gap);
  // Spiral radii are footprint * (0.9 + 0.35n): 131.25 is still inside, 168 clears.
  near(gap, 168, 1e-6);
  near(r.position.y, hit.y, 1e-9, "stays on the surface while sliding");
});

test("avoidOverlap off leaves the piece exactly at the hit even inside another", () => {
  const { engine, session } = makeEngine({ avoidOverlap: false });
  const hit = new vec3(100, 0, -300);
  place("sofa", hit.x, hit.y, hit.z);
  session.answer(FLOOR(hit.x, hit.y, hit.z));
  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));
  eq(xyz(r.position), xyz(hit));
});

suite("SurfaceAnchorEngine - wall-adjacent placement");

test("'by the wall': a level probe finds the wall, a downward one finds the floor a footprint in", () => {
  const { engine, session, eye } = makeEngine();
  const chair = getFurnitureSpec("chair"); // footprint 45, height 85
  // The wall hit is off to the side so "faces the room" and "faces the user"
  // are different yaws and the test can tell them apart.
  const wallHit = new vec3(150, 120, -300);
  const floorHit = new vec3(157, 3, -260);
  session.answer(WALL(wallHit.x, wallHit.y, wallHit.z, 0, 0, 1), FLOOR(floorHit.x, floorHit.y, floorHit.z));
  const r = settle(engine, (cb) => engine.requestPlacement(chair, "auto", true, cb));

  eq(session.log.length, 3);
  const wallProbe = session.log[1];
  eq(xyz(wallProbe.start), xyz(eye));
  near(wallProbe.end.y, wallProbe.start.y, 1e-9, "wall probe is level");

  const floorProbe = session.log[2];
  const standZ = wallHit.z + chair.footprint;
  near(floorProbe.start.z, standZ, 1e-9, "stepped into the room by the footprint");
  near(floorProbe.start.x, wallHit.x, 1e-9);
  ok(
    floorProbe.start.y >= floorHit.y + chair.height,
    "starts above where the chair's top will be, so the ray cannot begin inside it"
  );
  const crossing = floorCrossing(floorProbe, floorHit.y);
  near(crossing.x, wallHit.x, 1e-9, "drops straight down onto the standing spot");
  near(crossing.z, standZ, 1e-9);

  eq(r.anchored, true);
  eq(r.surface, "floor");
  near(r.position.x, wallHit.x, 1e-9, "x from the stepped-in point, not the floor hit");
  near(r.position.z, standZ, 1e-9);
  near(r.position.y, floorHit.y, 1e-9, "y from the floor hit");
  eq(xyz(r.normal), xyz(vec3.up()));
  // Back to the wall: faces +Z (the wall normal), into the room.
  const standAt = new vec3(wallHit.x, wallHit.y, standZ);
  eq(r.rotation, yawTowards(standAt, standAt.add(new vec3(0, 0, 1))));
  const f = facing(r.rotation);
  near(f.z, 1, 1e-9, "faces +Z, away from the wall");
  near(f.x, 0, 1e-9);
  const toEye = towardsXZ(standAt, eye);
  ok(f.x * toEye.x + f.z * toEye.z < 0.99, "and that is not simply 'face the user'");
});

test("'by the wall' onto a raised platform reports the platform, not a generic floor", () => {
  // A chair pushed against the wall on a low stage or window ledge must say
  // so: the gesture controller re-seats by surface kind, and a hard-coded
  // 'floor'/up() here would later drop it through the platform.
  const { engine, session } = makeEngine();
  const chair = getFurnitureSpec("chair");
  const rawNormal = new vec3(0.05, 1, 0); // horizontal, but not exactly up
  const unit = rawNormal.normalize();
  session.answer(WALL(0, 120, -300, 0, 0, 1), { position: new vec3(0, 75, -255), normal: rawNormal });
  const r = settle(engine, (cb) => engine.requestPlacement(chair, "auto", true, cb));

  eq(r.anchored, true);
  eq(r.surface, "table", "75cm above the calibrated floor is a table");
  near(r.position.y, 75, 1e-9);
  near(r.position.z, -300 + chair.footprint, 1e-9);
  near(r.normal.x, unit.x, 1e-12, "normal is the platform's, normalized");
  near(r.normal.y, unit.y, 1e-12);
  ok(r.normal.y < 1, "not a hard-coded world up");
});

test("'hang the painting by the wall' is one level probe, not a floor placement", () => {
  // A wall piece already wants the wall, so "by the wall" must not push it
  // through the two-probe floor path and stand a picture on the carpet.
  const { engine, session, eye } = makeEngine();
  session.answer(WALL(0, 120, -500, 0, 0, 1));
  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("artwork"), "auto", true, cb));

  eq(session.log.length, 2, "calibration + one gaze probe; no downward probe follows");
  const probe = session.log[1];
  eq(xyz(probe.start), xyz(eye));
  near(probe.end.y, probe.start.y, 1e-9, "untilted, level gaze");
  engine.tick();
  eq(session.log.length, 2, "nothing left queued");

  eq(r.anchored, true);
  eq(r.surface, "wall");
  near(r.position.y, eye.y - 10, 1e-9, "hung at eye height, not stood on the floor");
  near(r.position.z, -500 + 3, 1e-9);
  eq(r.rotation, alignToNormal(vec3.up(), new vec3(0, 0, -1)), "flush to the wall");
});

test("'by the wall' with no wall in view degrades to a normal floor placement", () => {
  // First probe hits the floor.
  let { engine, session, eye } = makeEngine();
  const crossingZ = eye.z - FLOAT_DISTANCE;
  session.answer(FLOOR(0, 0, -400), FLOOR(0, 0, crossingZ));
  let r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("chair"), "auto", true, cb));
  eq(session.log.length, 3);
  ok(session.log[2].end.y < session.log[2].start.y, "a downward probe follows");
  eq(xyz(session.log[2].start), xyz(eye), "cast from the eye, not from a wall");
  near(floorCrossing(session.log[2], 0).z, crossingZ, 1, "aimed at the floor a pace ahead");
  eq(r.surface, "floor");
  eq(r.anchored, true);
  eq(xyz(r.position), { x: 0, y: 0, z: crossingZ });
  eq(r.rotation, yawTowards(r.position, eye), "faces the user like any floor spawn");

  // First probe misses entirely.
  ({ engine, session } = makeEngine());
  session.answer(null, FLOOR(0, 0, crossingZ));
  r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("chair"), "auto", true, cb));
  eq(session.log.length, 3);
  ok(session.log[2].end.y < session.log[2].start.y);
  eq(r.surface, "floor");
});

test("'by the wall' with a wall but no floor reading uses the running floor estimate", () => {
  // Looking down -X at a wall whose normal is +X, floor calibrated at -20 so
  // the estimate is distinguishable from the default 0.
  const { engine, session } = makeEngine({
    forward: new vec3(1, 0, 0),
    calibration: FLOOR(0, -20, 0),
  });
  const chair = getFurnitureSpec("chair");
  session.answer(WALL(-300, 100, 0, 1, 0, 0), null);
  const r = settle(engine, (cb) => engine.requestPlacement(chair, "auto", true, cb));

  eq(r.anchored, true, "a wall plus a floor estimate is still a real anchor");
  eq(r.surface, "floor");
  near(r.position.x, -300 + chair.footprint, 1e-9);
  near(r.position.y, -20, 1e-9, "getFloorHeight() stands in for the missing hit");
  near(r.position.z, 0, 1e-9);
  eq(xyz(r.normal), xyz(vec3.up()));
  // Faces +X, away from the wall.
  const f = facing(r.rotation);
  near(f.x, 1, 1e-9, "faces +X, away from the wall");
  near(f.z, 0, 1e-9);
});

suite("SurfaceAnchorEngine - reseat");

test("a released sofa keeps its X/Z and drops onto the floor beneath it", () => {
  const { engine, session } = makeEngine();
  const rot = quat.angleAxis(0.7, vec3.up());
  const sofa = place("sofa", 100, 40, 200, { rotation: rot });
  // The hit is deliberately off-centre: only its height may be used.
  session.answer(FLOOR(103, 0, 197));

  const r = settle(engine, (cb) => engine.reseat(sofa, cb));
  const probe = session.log[1];
  near(probe.start.y, 40 + sofa.spec.height + 20, 1e-9, "cast from just above the piece");
  near(probe.start.x, 100, 1e-9);
  near(probe.start.z, 200, 1e-9);
  ok(probe.end.y < probe.start.y);

  eq(r.anchored, true);
  eq(xyz(r.position), { x: 100, y: 0, z: 200 });
  eq(r.surface, "floor");
  eq(r.rotation, rot, "the user's rotation is not touched");
});

test("a piece released over a tabletop settles at table height as 'table'", () => {
  const { engine, session } = makeEngine();
  const vase = place("vase", 100, 90, 200);
  session.answer(FLOOR(100, 75, 200));
  const r = settle(engine, (cb) => engine.reseat(vase, cb));
  eq(xyz(r.position), { x: 100, y: 75, z: 200 });
  eq(r.surface, "table");
  eq(r.anchored, true);
});

test("a release over nothing leaves the piece where the hand let go", () => {
  const { engine, session } = makeEngine();
  const sofa = place("sofa", 100, 40, 200, { surface: "table", surfaceNormal: vec3.up() });
  session.answer(null);
  const r = settle(engine, (cb) => engine.reseat(sofa, cb));
  eq(r.anchored, false);
  eq(xyz(r.position), { x: 100, y: 40, z: 200 });
  eq(r.surface, "table", "keeps the surface it was on");
});

test("wall art does not fall to the floor when released", () => {
  const { engine, session } = makeEngine();
  const rot = quat.angleAxis(1.2, vec3.up());
  const art = place("artwork", 0, 145, -297, {
    placement: "wall",
    surface: "wall",
    surfaceNormal: new vec3(0, 0, 1),
    rotation: rot,
  });
  // The ray straight down from the frame finds the floor; that must be ignored.
  session.answer(FLOOR(0, 0, -297));
  const r = settle(engine, (cb) => engine.reseat(art, cb));
  eq(r.anchored, true);
  eq(xyz(r.position), { x: 0, y: 145, z: -297 });
  eq(r.surface, "wall", "classify's 'floor' answer must not leak through");
  eq(xyz(r.normal), { x: 0, y: 0, z: 1 });
  eq(r.rotation, rot);
});

suite("SurfaceAnchorEngine - probe queue");

test("probes are serial: one hit test in flight at a time, answered in order", () => {
  // World Query rejects overlapping requests, so a second placement must wait
  // for the first answer even across several frames.
  const { engine, session } = makeEngine();
  session.hold = true;
  const results = [];
  engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, (r) => results.push(["sofa", r]));
  engine.requestPlacement(getFurnitureSpec("chair"), "auto", false, (r) => results.push(["chair", r]));
  eq(session.log.length, 1, "nothing cast before a tick");

  engine.tick();
  eq(session.log.length, 2, "one probe after one tick");
  engine.tick();
  engine.tick();
  eq(session.log.length, 2, "no second probe while the first is unanswered");
  eq(results.length, 0);

  session.respond(FLOOR(0, 0, -300));
  eq(results.length, 1);
  eq(results[0][0], "sofa");
  engine.tick();
  eq(session.log.length, 3, "the chair's probe goes out only now");
  session.respond(FLOOR(50, 0, -300));
  eq(results.map((r) => r[0]), ["sofa", "chair"]);
  eq(results[1][1].surface, "floor");
});

test("an engine that never got a hit-test session floats requests instead of hanging", () => {
  // Without World Query (no depth on this device) the voice pipeline still
  // needs an answer, otherwise "add a sofa" would silently do nothing.
  SpatialisRegistry.removeAll();
  const engine = new SurfaceAnchorEngine();
  engine.probeDistance = PROBE_DISTANCE;
  engine.floatDistance = FLOAT_DISTANCE;
  const session = scriptedSession();
  engine.hitTestSession = session; // present but never started: ready stays false
  eq(engine.isReady(), false);

  const sofa = getFurnitureSpec("sofa");
  let r = null;
  engine.requestPlacement(sofa, "auto", false, (res) => {
    r = res;
  });
  eq(r, null, "queued, not answered, until the next frame");
  engine.tick();
  ok(r !== null, "drained on the next tick");
  eq(r.anchored, false);
  eq(r.surface, "unknown");
  // No camera: origin is the world origin, gaze is -Z.
  eq(xyz(r.position), { x: 0, y: -sofa.height * 0.35, z: -floatRange(getFurnitureSpec("sofa")) });
  eq(session.log.length, 0, "hitTest is never called on an unready session");
});

suite("SurfaceAnchorEngine - floating distance and spacing");

test("small pieces float at floatDistance; large ones float further so they do not fill the view", () => {
  const lamp = getFurnitureSpec("lamp");       // footprint 22 -> 55 < 160
  const sofa = getFurnitureSpec("sofa");       // footprint 105 -> 262.5
  const a = makeEngine();
  a.session.answer(null);
  const rl = settle(a.engine, (cb) => a.engine.requestPlacement(lamp, "float", false, cb));
  near(rl.position.z, a.eye.z - FLOAT_DISTANCE, 1e-9, "a lamp floats at floatDistance");
  const b = makeEngine();
  b.session.answer(null);
  const rs = settle(b.engine, (cb) => b.engine.requestPlacement(sofa, "float", false, cb));
  near(rs.position.z, b.eye.z - sofa.footprint * 2.5, 1e-9, "a sofa floats at 2.5 x its footprint");
});

test("two floated pieces do not share a spot", () => {
  const { engine, session, eye } = makeEngine();
  const lamp = getFurnitureSpec("lamp");
  session.answer(null, null);
  const first = settle(engine, (cb) => engine.requestPlacement(lamp, "float", false, cb));
  // Register the first as if it had been spawned, then float a second lamp.
  const spec = lamp;
  const pos = first.position;
  SpatialisRegistry.register({
    sceneObject: { name: "lamp", destroyed: false, destroy() { this.destroyed = true; } },
    transform: { getWorldPosition: () => pos, setWorldPosition: () => {}, getLocalScale: () => new vec3(1,1,1),
                 setLocalScale: () => {}, getWorldRotation: () => quat.quatIdentity(), setWorldRotation: () => {} },
    kind: "lamp", spec, placement: "float", surface: "unknown", surfaceNormal: vec3.up(),
    baseScale: new vec3(1,1,1), materialKey: "", spawnedAtSeconds: 0, isGrabbed: false,
  });
  const second = settle(engine, (cb) => engine.requestPlacement(lamp, "float", false, cb));
  const dx = second.position.x - first.position.x, dz = second.position.z - first.position.z;
  ok(Math.hypot(dx, dz) >= (spec.footprint * 2) * 0.75 - 1e-9, "the second lamp is nudged clear of the first");
  void eye;
});

suite("SurfaceAnchorEngine - sweeping for a table");

test("an explicit table hint finds a table off the gaze line and lands on it", () => {
  // The wearer says "on the table" while looking at the floor. The table is
  // off to one side: the third sweep probe reaches a horizontal surface 75cm
  // above the calibrated floor, which classifies as a table.
  const { engine, session } = makeEngine();
  const tableHit = FLOOR(120, 75, -260);
  session.answer(FLOOR(0, 0, -300), null, null, tableHit);
  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("tableLamp"), "table", false, cb), 24);
  eq(r.anchored, true);
  eq(r.surface, "table", "the sweep's hit is a table");
  eq(xyz(r.position), xyz(tableHit.position), "seated on the swept hit");
  eq(session.log.length, 1 + 1 + 3, "calibration, gaze, and three sweep probes - it stops at the first table");
  const sweep = session.log[2];
  ok(sweep.end.y < sweep.start.y, "sweep probes aim downward");
  ok(Math.abs(sweep.end.x - sweep.start.x) > 50, "and off the gaze line");
});

test("a floor piece never pays for a sweep", () => {
  const { engine, session } = makeEngine();
  session.answer(FLOOR(0, 0, -300));
  const r = settle(engine, (cb) => engine.requestPlacement(getFurnitureSpec("sofa"), "auto", false, cb));
  eq(r.surface, "floor");
  eq(session.log.length, 2, "calibration and the gaze probe only");
});
