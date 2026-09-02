/**
 * Tests/harness.js
 * -----------------------------------------------------------------------------
 * A ~60-line test harness. Spatialis has no test framework dependency on
 * purpose: the whole point of Tests/ is that a judge can clone the repo, run
 * `npm test`, and have it work with nothing but Node.
 *
 * License: Apache-2.0
 */

const results = { passed: 0, failed: [] };
let current = "";

function suite(name) {
  current = name;
  console.log("\n" + name);
}

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log("  ok   " + name);
  } catch (e) {
    results.failed.push({ suite: current, name, error: e });
    console.log("  FAIL " + name);
    const detail = e && e.message ? e.message : String(e);
    console.log("       " + detail.split("\n").slice(0, 6).join("\n       "));
  }
}

/** assert.deepStrictEqual with a readable diff for the shapes we compare. */
function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(
      (message ? message + "\n" : "") + "expected " + b + "\nactual   " + a
    );
  }
}

function ok(value, message) {
  if (!value) throw new Error(message || "expected a truthy value, got " + value);
}

/** Floating point comparison with an explicit tolerance. */
function near(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      (message ? message + "\n" : "") +
        "expected " + expected + " ±" + tolerance + ", got " + actual
    );
  }
}

function report() {
  const total = results.passed + results.failed.length;
  console.log(
    "\n" + results.passed + " passed, " + results.failed.length + " failed, " + total + " total\n"
  );
  return results.failed.length === 0 ? 0 : 1;
}

module.exports = { suite, test, eq, ok, near, report };
