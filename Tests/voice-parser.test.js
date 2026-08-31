/**
 * voice-parser.test.js
 * -----------------------------------------------------------------------------
 * Behavioural tests for the Spatialis voice intent parser.
 *
 * The parser is the one part of the system that cannot be verified by staring
 * at a headset — it either understands a sentence or it does not. These cases
 * are the demo script plus the phrasings most likely to be spoken instead.
 *
 * Run: npm test
 * License: Apache-2.0
 */

const path = require("path");
const assert = require("assert");
const { install } = require("./lens-runtime-stub");

install(globalThis);

const BUILD = path.join(__dirname, "..", ".build", "Scripts");
const { VoiceCommandController } = require(path.join(BUILD, "VoiceCommandController.js"));

// parse() only reads its arguments and pure private helpers, so a bare
// prototype instance is enough — no Lens Studio component lifecycle needed.
const parser = Object.create(VoiceCommandController.prototype);

let passed = 0;
const failures = [];

function check(utterance, expected) {
  const normalized = parser.normalize(utterance);
  const intent = parser.parse(normalized, utterance);
  const actual = {
    action: intent.action,
    furniture: intent.furniture,
    material: intent.material,
    color: intent.color,
    placement: intent.placement,
  };
  if (expected.scaleFactor !== undefined) {
    actual.scaleFactor = Number(intent.scaleFactor.toFixed(3));
  }
  if (expected.style !== undefined) {
    actual.style = intent.style;
  }
  if (expected.wallAdjacent !== undefined) {
    actual.wallAdjacent = parser.parseWallAdjacent(" " + normalized + " ");
  }

  try {
    assert.deepStrictEqual(actual, expected);
    passed++;
    console.log("  ok   “" + utterance + "”");
  } catch (e) {
    failures.push({ utterance, expected, actual });
    console.log("  FAIL “" + utterance + "”");
    console.log("       expected " + JSON.stringify(expected));
    console.log("       actual   " + JSON.stringify(actual));
  }
}

console.log("\nSpatialis — voice intent parser\n");

console.log("Spec demo commands");
check("Spawn a Scandinavian lounge chair by the wall", {
  action: "spawn", furniture: "chair", material: "", color: "",
  placement: "auto", style: "scandinavian", wallAdjacent: true,
});
check("Add a floating marble coffee table", {
  action: "spawn", furniture: "coffeeTable", material: "marble", color: "",
  placement: "float",
});

console.log("\nSpawning");
check("put a dark wood side table on the table", {
  action: "spawn", furniture: "coffeeTable", material: "walnut", color: "",
  placement: "table",
});
check("a walnut side table", {
  action: "spawn", furniture: "coffeeTable", material: "walnut", color: "", placement: "auto",
});
check("hang a painting on the wall", {
  action: "spawn", furniture: "artwork", material: "", color: "", placement: "wall",
});
check("give me a navy velvet sofa", {
  action: "spawn", furniture: "sofa", material: "velvet", color: "navy", placement: "auto",
});
check("I want a big potted plant on the floor", {
  action: "spawn", furniture: "plant", material: "", color: "", placement: "floor",
});
check("drop a brass floor lamp against the wall", {
  action: "spawn", furniture: "lamp", material: "brass", color: "",
  placement: "auto", wallAdjacent: true,
});

console.log("\nRestyling");
check("make the sofa velvet", {
  action: "material", furniture: "sofa", material: "velvet", color: "", placement: "auto",
});
check("make the chairs navy", {
  action: "material", furniture: "chair", material: "", color: "navy", placement: "auto",
});
check("change it to smoked glass", {
  action: "material", furniture: "", material: "glass", color: "", placement: "auto",
});
check("velvet", {
  action: "material", furniture: "", material: "velvet", color: "", placement: "auto",
});
check("turn the coffee table into carrara marble", {
  action: "material", furniture: "coffeeTable", material: "marble", color: "", placement: "auto",
});

console.log("\nResizing");
check("make it a bit bigger", {
  action: "scale", furniture: "", material: "", color: "", placement: "auto", scaleFactor: 1.15,
});
check("make it much bigger", {
  action: "scale", furniture: "", material: "", color: "", placement: "auto", scaleFactor: 1.6,
});
check("make it twice as big", {
  action: "scale", furniture: "", material: "", color: "", placement: "auto", scaleFactor: 2,
});
check("make the sofa smaller", {
  action: "scale", furniture: "sofa", material: "", color: "", placement: "auto",
  scaleFactor: Number((1 / 1.3).toFixed(3)),
});

console.log("\nRemoving");
check("remove the lamp", {
  action: "delete", furniture: "lamp", material: "", color: "", placement: "auto",
});
check("undo", {
  action: "delete", furniture: "", material: "", color: "", placement: "auto",
});
check("clear the room", {
  action: "clear", furniture: "", material: "", color: "", placement: "auto",
});
check("remove everything", {
  action: "clear", furniture: "", material: "", color: "", placement: "auto",
});

console.log("\nAmbiguity guards");
// "big" describes the sofa here, so this must spawn rather than resize.
check("add a big sofa", {
  action: "spawn", furniture: "sofa", material: "", color: "", placement: "auto",
});
// "coffee table" must beat the shorter alias "table".
check("a coffee table", {
  action: "spawn", furniture: "coffeeTable", material: "", color: "", placement: "auto",
});
// "by the wall" is a floor piece against a wall, NOT a wall mount.
check("put the chair by the wall", {
  action: "spawn", furniture: "chair", material: "", color: "",
  placement: "auto", wallAdjacent: true,
});
// Disfluent speech should still fill its slots.
check("uh put a like dark wood coffee table over there", {
  action: "spawn", furniture: "coffeeTable", material: "walnut", color: "", placement: "auto",
});
check("nonsense words with no intent", {
  action: "unknown", furniture: "", material: "", color: "", placement: "auto",
});

console.log(
  "\n" + passed + " passed, " + failures.length + " failed, " + (passed + failures.length) + " total\n"
);
process.exit(failures.length === 0 ? 0 : 1);
