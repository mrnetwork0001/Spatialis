/**
 * Tests/stubs/SIK.js
 * -----------------------------------------------------------------------------
 * Controllable stand-in for SpectaclesInteractionKit's hand input, so the
 * gesture state machine can be driven deterministically from Node.
 *
 * On device SIK reports joint positions from the headset's hand tracking. Here
 * a test positions the joints directly, which is the only way to assert things
 * like "a pinch held at 4.0cm stays closed because it closed at 3.0cm" - a
 * distinction no amount of waving at a headset can reliably reproduce.
 *
 * The build step rewrites the bare "SpectaclesInteractionKit.lspkg/SIK"
 * specifier in the compiled output to point here. See Tools/patch-build.js.
 *
 * License: Apache-2.0
 */

const { vec3 } = require("../lens-runtime-stub");

class FakeHand {
  constructor(side) {
    this.side = side;
    this.tracked = true;
    this.thumbTip = { position: new vec3(0, 0, 0) };
    this.indexTip = { position: new vec3(0, 0, 0) };
    this.wrist = { position: new vec3(0, 0, 0) };
    this.middleTip = { position: new vec3(0, 0, 0) };
  }

  isTracked() {
    return this.tracked;
  }

  /**
   * Put the hand at `center` with the thumb and index `separation` cm apart,
   * split evenly either side so the pinch midpoint lands exactly on `center`.
   *
   * `span` is the wrist-to-middle-fingertip distance, i.e. how big this hand
   * is. It defaults to 18cm, the nominal adult hand the pinch thresholds are
   * authored against, so a test that does not care about hand size gets a
   * scale factor of exactly 1.
   */
  pinchAt(center, separation, span = 18) {
    const half = separation / 2;
    this.thumbTip.position = new vec3(center.x - half, center.y, center.z);
    this.indexTip.position = new vec3(center.x + half, center.y, center.z);
    this.middleTip.position = new vec3(center.x, center.y, center.z);
    this.wrist.position = new vec3(center.x, center.y - span, center.z);
    return this;
  }
}

const hands = { left: new FakeHand("left"), right: new FakeHand("right") };

const SIK = {
  HandInputData: {
    getHand(side) {
      return hands[side];
    },
  },
};

/** Return both hands to a neutral, tracked, wide-open pose. */
function reset() {
  for (const side of ["left", "right"]) {
    hands[side].tracked = true;
    hands[side].pinchAt(new vec3(0, 0, 0), 100);
  }
}

module.exports = { SIK, hands, reset, FakeHand };
