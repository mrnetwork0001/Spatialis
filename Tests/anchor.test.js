/**
 * anchor.test.js — SurfaceAnchorEngine surface classification.
 *
 * classify() is the decision the whole placement system rests on: it is what
 * separates a tabletop from the floor, and it cannot be checked by looking
 * through a headset — a wrong answer just puts a lamp on the carpet.
 *
 * License: Apache-2.0
 */

const path = require("path");
const { suite, test, eq } = require("./harness");
const { SurfaceAnchorEngine } = require(
  path.join(__dirname, "..", ".build", "Scripts", "SurfaceAnchorEngine.js")
);

// classify() reads only its arguments and this.floorHeight, so a bare
// prototype instance is enough — no hit test session required.
function engineWithFloorAt(y) {
  const e = Object.create(SurfaceAnchorEngine.prototype);
  e.floorHeight = y;
  return e;
}

const UP = () => vec3.up();
const DOWN = () => new vec3(0, -1, 0);
const SIDE = () => new vec3(1, 0, 0);
const at = (y) => new vec3(0, y, 0);

suite("SurfaceAnchorEngine — horizontal surfaces");

test("a horizontal surface at floor level is the floor", () => {
  eq(engineWithFloorAt(0).classify(at(0), UP()), "floor");
});

test("a horizontal surface at desk height is a table", () => {
  eq(engineWithFloorAt(0).classify(at(75), UP()), "table");
});

test("table detection is relative to the floor, not to world zero", () => {
  // A room whose floor is 300cm up (upper storey) must still see its own
  // tables. Absolute height would call this the floor.
  eq(engineWithFloorAt(300).classify(at(375), UP()), "table");
  eq(engineWithFloorAt(300).classify(at(300), UP()), "floor");
});

test("the table band has both an upper and a lower bound", () => {
  const e = engineWithFloorAt(0);
  eq(e.classify(at(29), UP()), "floor", "below 30cm is a step, not a table");
  eq(e.classify(at(30), UP()), "table", "30cm is the lower bound");
  eq(e.classify(at(130), UP()), "table", "130cm is the upper bound");
  eq(e.classify(at(131), UP()), "floor", "above 130cm is not a working surface");
});

suite("SurfaceAnchorEngine — vertical and inverted surfaces");

test("a downward-facing surface is the ceiling", () => {
  eq(engineWithFloorAt(0).classify(at(240), DOWN()), "ceiling");
});

test("a vertical surface is a wall at any height", () => {
  const e = engineWithFloorAt(0);
  eq(e.classify(at(0), SIDE()), "wall");
  eq(e.classify(at(150), SIDE()), "wall");
  eq(e.classify(at(75), new vec3(0, 0, 1)), "wall");
});

test("a wall tilted within tolerance still reads as a wall", () => {
  // 0.29 vertical component is inside the 0.3 threshold.
  eq(engineWithFloorAt(0).classify(at(100), new vec3(0.957, 0.29, 0).normalize()), "wall");
});

test("a surface between wall and floor is unknown, not guessed", () => {
  // A 45-degree ramp is neither. Guessing here would seat furniture at an
  // angle on something that cannot support it.
  eq(engineWithFloorAt(0).classify(at(50), new vec3(0.707, 0.707, 0)), "unknown");
});

test("classification uses the normal's direction, not its magnitude", () => {
  // Regression: classify() took the raw dot product, so scaling a normal
  // scaled the comparison. A 45-degree ramp with an unnormalized normal was
  // read as a table — the same direction gave two different answers.
  const e = engineWithFloorAt(0);
  eq(e.classify(at(50), new vec3(0.707, 0.707, 0)), "unknown");
  eq(e.classify(at(50), new vec3(3, 3, 0)), "unknown", "magnitude must not change the verdict");
  eq(e.classify(at(0), new vec3(0, 5, 0)), "floor", "an unnormalized up vector still reads up");
});
