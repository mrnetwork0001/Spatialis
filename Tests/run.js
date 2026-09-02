/**
 * Tests/run.js
 * -----------------------------------------------------------------------------
 * Entry point for `npm test`. Installs the Lens Studio runtime stub onto the
 * global scope BEFORE loading any suite, because the compiled subsystems
 * reference vec3/quat/decorators at module-evaluation time.
 *
 * License: Apache-2.0
 */

const path = require("path");
const { install } = require("./lens-runtime-stub");

install(globalThis);

// Keep the compiled subsystems' own print() output from drowning the results.
const realLog = console.log;
globalThis.print = () => {};

const { report } = require("./harness");

const SUITES = [
  "./core.test.js",
  "./voice-parser.test.js",
  "./anchor.test.js",
  "./gesture.test.js",
];

realLog("\nSpatialis test suite");
realLog("─".repeat(52));
for (const suite of SUITES) {
  require(suite);
}

process.exit(report());
