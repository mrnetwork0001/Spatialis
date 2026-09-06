/**
 * voice-parser.test.js
 * -----------------------------------------------------------------------------
 * Behavioural tests for the Spatialis voice intent parser.
 *
 * The parser is the one part of the system that cannot be verified by staring
 * at a headset - it either understands a sentence or it does not. These cases
 * are the demo script plus the phrasings most likely to be spoken instead.
 *
 * Run: npm test
 * License: Apache-2.0
 */

const path = require("path");
const assert = require("assert");
const { suite, test } = require("./harness");

const BUILD = path.join(__dirname, "..", ".build", "Scripts");
const { VoiceCommandController } = require(path.join(BUILD, "VoiceCommandController.js"));

// parse() only reads its arguments and pure private helpers, so a bare
// prototype instance is enough - no Lens Studio component lifecycle needed.
const parser = Object.create(VoiceCommandController.prototype);

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

  test("“" + utterance + "”", () => {
    assert.deepStrictEqual(actual, expected);
  });
}

suite("VoiceCommandController - spec demo commands");
check("Spawn a Scandinavian lounge chair by the wall", {
  action: "spawn", furniture: "chair", material: "", color: "",
  placement: "auto", style: "scandinavian", wallAdjacent: true,
});
check("Add a floating marble coffee table", {
  action: "spawn", furniture: "coffeeTable", material: "marble", color: "",
  placement: "float",
});

suite("VoiceCommandController - spawning");
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

suite("VoiceCommandController - restyling");
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

suite("VoiceCommandController - resizing");
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

suite("VoiceCommandController - removing");
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

suite("VoiceCommandController - ambiguity guards");
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

// ---------------------------------------------------------------------------
// "on the X" names the surface, not the piece.
//
// Longest-alias-wins used to read the whole sentence, so "put a vase on the
// table" resolved to the dining table - "table" is longer than "vase" - and
// spawned the wrong piece at full confidence. The noun is now resolved from
// what comes before the phrase, with a fallback to the whole sentence.
// ---------------------------------------------------------------------------
suite("VoiceCommandController - the object of \"on\" is a surface");
check("Put a ceramic vase on the table", {
  action: "spawn", furniture: "vase", material: "", color: "", placement: "table",
});
check("Put a vase on the shelf", {
  action: "spawn", furniture: "vase", material: "", color: "", placement: "auto",
});
check("Put the sofa on the rug", {
  action: "spawn", furniture: "sofa", material: "", color: "", placement: "floor",
});
check("Put a plant on the coffee table", {
  action: "spawn", furniture: "plant", material: "", color: "", placement: "auto",
});
// Regressions: the longer noun must still win when it is the piece itself.
check("Put a brass table lamp on the table", {
  action: "spawn", furniture: "tableLamp", material: "brass", color: "", placement: "table",
});
check("Hang a painting on the wall", {
  action: "spawn", furniture: "artwork", material: "", color: "", placement: "wall",
});
check("Add a dining table", {
  action: "spawn", furniture: "table", material: "", color: "", placement: "auto",
});
check("Put a rug on the floor", {
  action: "spawn", furniture: "rug", material: "", color: "", placement: "floor",
});
