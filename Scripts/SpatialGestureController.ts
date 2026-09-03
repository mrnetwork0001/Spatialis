/**
 * SpatialGestureController.ts
 * -----------------------------------------------------------------------------
 * Subsystem 2 of 4 — SPECS hand tracking for direct spatial manipulation.
 *
 * Gesture grammar:
 *   one hand pinched   → grab and drag a piece through the room
 *   two hands pinched  → scale by hand separation, rotate by the yaw between them
 *   release            → hand back to SurfaceAnchorEngine, which re-seats it
 *
 * Pinch state is derived from the thumb/index joint distance with hysteresis
 * rather than from a single threshold: at arm's length the tracked joints
 * jitter by a few millimetres, and a bare threshold makes furniture flicker
 * between grabbed and dropped. A separate release distance costs nothing and
 * removes the whole class of problem.
 *
 * Target: Lens Studio 5.22+ / Spectacles (SPECS) Project Mode.
 * License: Apache-2.0
 */

import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";
import {
  SpatialisObject,
  SpatialisRegistry,
  clamp,
  dampVec3,
  log,
  warn,
} from "./SpatialisCore";
import { AnchorResult, SurfaceAnchorEngine } from "./SurfaceAnchorEngine";

type HandSide = "left" | "right";

/** Per-hand pinch and grab bookkeeping. */
interface HandState {
  side: HandSide;
  hand: any;
  tracked: boolean;
  isPinching: boolean;
  /** This hand's size relative to REFERENCE_HAND_SPAN, smoothed over frames. */
  spanScale: number;
  spanSamples: number;
  /** Midpoint of thumb and index tips — the point the user thinks they hold. */
  pinchPoint: vec3;
  grabbed: SpatialisObject | null;
  /** Object position minus pinch point at grab time, so it does not snap. */
  grabOffset: vec3;
}

/** Snapshot taken when the second hand joins, to derive relative changes. */
interface TwoHandAnchor {
  object: SpatialisObject;
  startSeparation: number;
  startScale: vec3;
  startYaw: number;
  startRotation: quat;
  startMidpoint: vec3;
  startPosition: vec3;
}

/**
 * Wrist-to-middle-fingertip distance of a nominal adult hand, cm. Pinch
 * distances are authored against this hand and scaled to the wearer's.
 */
const REFERENCE_HAND_SPAN = 18.0;

/** Bounds on that scaling, so one bad tracking frame cannot distort the feel. */
const MIN_SPAN_SCALE = 0.6;
const MAX_SPAN_SCALE = 1.6;

/** Frames the running span average converges over. */
const SPAN_SAMPLE_WINDOW = 60;

@component
export class SpatialGestureController extends BaseScriptComponent {
  @input
  @hint("Surface Anchor Engine used to re-seat a piece when it is released.")
  @allowUndefined
  anchorEngine: SurfaceAnchorEngine;

  @input
  @hint("Thumb-to-index distance that closes a pinch, cm.")
  @widget(new SliderWidget(1.0, 6.0, 0.1))
  pinchDownDistance: number = 3.0;

  @input
  @hint("Thumb-to-index distance that opens it again, cm. Keep above Pinch Down.")
  @widget(new SliderWidget(1.5, 9.0, 0.1))
  pinchUpDistance: number = 4.5;

  @input
  @hint(
    "Scale the pinch distances by the wearer's own hand size. " +
    "The two distances above then describe a nominal adult hand."
  )
  adaptToHandSize: boolean = true;

  @input
  @hint("How far from a piece a pinch still counts as grabbing it, cm.")
  @widget(new SliderWidget(10, 120, 5))
  grabRadius: number = 45;

  @input
  @hint("Drag smoothing. 0 = rigidly follow the hand, 0.9 = heavy and damped.")
  @widget(new SliderWidget(0.0, 0.95, 0.01))
  dragSmoothing: number = 0.35;

  @input
  @hint("Smallest and largest scale allowed, as a multiple of the piece's own size.")
  @widget(new SliderWidget(0.1, 1.0, 0.05))
  minScaleFactor: number = 0.3;

  @input
  @widget(new SliderWidget(1.0, 6.0, 0.1))
  maxScaleFactor: number = 3.0;

  @input
  @hint("Also yaw a piece to follow a single hand's twist while dragging.")
  singleHandRotate: boolean = false;

  @input
  @hint("Optional marker moved onto whichever piece is currently held.")
  @allowUndefined
  grabIndicator: SceneObject;

  private hands: HandState[] = [];
  private twoHand: TwoHandAnchor | null = null;
  private handsAvailable: boolean = false;

  /** Yaw of the hand at grab time, for single-hand rotation. */
  private singleHandStartYaw: number = 0;
  private singleHandStartRotation: quat = quat.quatIdentity();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (this.pinchUpDistance <= this.pinchDownDistance) {
      // Without a gap there is no hysteresis and grabs chatter on jitter.
      this.pinchUpDistance = this.pinchDownDistance + 1.5;
      warn("Gesture", "Pinch Up must exceed Pinch Down; raised it to " + this.pinchUpDistance + "cm.");
    }

    const left = this.acquireHand("left");
    const right = this.acquireHand("right");
    if (!left && !right) {
      warn(
        "Gesture",
        "Hand tracking unavailable — check that SpectaclesInteractionKit is in the project."
      );
      this.handsAvailable = false;
      return;
    }

    if (left) {
      this.hands.push(this.newHandState("left", left));
    }
    if (right) {
      this.hands.push(this.newHandState("right", right));
    }
    this.handsAvailable = true;
    this.setIndicatorVisible(false);
    log("Gesture", "Tracking " + this.hands.length + " hand(s).");
  }

  private acquireHand(side: HandSide): any {
    try {
      return SIK.HandInputData.getHand(side);
    } catch (e) {
      warn("Gesture", "Could not acquire " + side + " hand: " + e);
      return null;
    }
  }

  private newHandState(side: HandSide, hand: any): HandState {
    return {
      side: side,
      hand: hand,
      tracked: false,
      isPinching: false,
      spanScale: 1.0,
      spanSamples: 0,
      pinchPoint: vec3.zero(),
      grabbed: null,
      grabOffset: vec3.zero(),
    };
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  private onUpdate(): void {
    if (!this.handsAvailable) {
      return;
    }
    const dt = getDeltaTime();

    for (let i = 0; i < this.hands.length; i++) {
      this.updateHandState(this.hands[i]);
    }

    // Two-hand transform takes precedence: once both hands hold the same
    // piece, dragging it from either hand alone would fight the gesture.
    if (this.tryUpdateTwoHand(dt)) {
      this.updateIndicator();
      return;
    }

    for (let i = 0; i < this.hands.length; i++) {
      this.updateSingleHandDrag(this.hands[i], dt);
    }
    this.updateIndicator();
  }

  /** Read joint positions, recompute pinch with hysteresis, fire transitions. */
  private updateHandState(state: HandState): void {
    const hand = state.hand;
    if (!hand) {
      state.tracked = false;
      return;
    }

    const tracked = this.isHandTracked(hand);
    if (!tracked) {
      if (state.isPinching) {
        // Hand left the frame mid-grab; treat it as a release so the piece
        // settles onto a surface instead of freezing in the air.
        this.endPinch(state);
      }
      state.tracked = false;
      return;
    }
    state.tracked = true;

    const thumb = this.jointPosition(hand, "thumbTip");
    const index = this.jointPosition(hand, "indexTip");
    if (!thumb || !index) {
      return;
    }

    state.pinchPoint = vec3.lerp(thumb, index, 0.5);
    const separation = thumb.distance(index);

    this.updateSpanScale(state, hand);
    const down = this.pinchDownDistance * state.spanScale;
    const up = this.pinchUpDistance * state.spanScale;

    if (!state.isPinching && separation <= down) {
      this.beginPinch(state);
    } else if (state.isPinching && separation >= up) {
      this.endPinch(state);
    }
  }

  /**
   * Track how large this wearer's hand is, so the pinch thresholds mean the
   * same GESTURE rather than the same number of centimetres.
   *
   * A 3cm gap is a firm pinch on a large hand and an open grip on a small one.
   * Authoring the thresholds against a nominal hand and scaling to the wearer
   * is what keeps the feel consistent without a per-user tuning pass — which
   * matters here because the defaults have never been tuned on hardware.
   *
   * The scale is a running mean rather than an instantaneous ratio: hand
   * tracking drops and jitters, and a threshold that moved every frame would
   * be worse than a wrong constant.
   */
  private updateSpanScale(state: HandState, hand: any): void {
    if (!this.adaptToHandSize) {
      state.spanScale = 1.0;
      return;
    }
    const span = this.measureHandSpan(hand);
    if (span === null || span <= 0.001) {
      return; // Keep the last good estimate rather than snapping to 1.
    }
    const ratio = clamp(span / REFERENCE_HAND_SPAN, MIN_SPAN_SCALE, MAX_SPAN_SCALE);
    state.spanSamples = Math.min(state.spanSamples + 1, SPAN_SAMPLE_WINDOW);
    state.spanScale += (ratio - state.spanScale) / state.spanSamples;
  }

  /** Wrist to middle fingertip, the most stable single measure of hand size. */
  private measureHandSpan(hand: any): number | null {
    const wrist = this.jointPosition(hand, "wrist");
    if (!wrist) {
      return null;
    }
    const middle = this.jointPosition(hand, "middleTip");
    if (middle) {
      return wrist.distance(middle);
    }
    const index = this.jointPosition(hand, "indexTip");
    if (index) {
      // An index fingertip sits at roughly 92% of the middle fingertip's reach.
      return wrist.distance(index) / 0.92;
    }
    return null;
  }

  /** The distance that actually closes a pinch for this hand, cm. */
  effectivePinchDown(side: HandSide): number {
    for (let i = 0; i < this.hands.length; i++) {
      if (this.hands[i].side === side) {
        return this.pinchDownDistance * this.hands[i].spanScale;
      }
    }
    return this.pinchDownDistance;
  }

  /** The distance that actually opens it again for this hand, cm. */
  effectivePinchUp(side: HandSide): number {
    for (let i = 0; i < this.hands.length; i++) {
      if (this.hands[i].side === side) {
        return this.pinchUpDistance * this.hands[i].spanScale;
      }
    }
    return this.pinchUpDistance;
  }

  private isHandTracked(hand: any): boolean {
    try {
      if (typeof hand.isTracked === "function") {
        return hand.isTracked();
      }
      if (typeof hand.isTracked === "boolean") {
        return hand.isTracked;
      }
    } catch (e) {
      // fall through
    }
    // No tracking flag on this SIK version — infer it from joint availability.
    return this.jointPosition(hand, "indexTip") !== null;
  }

  private jointPosition(hand: any, jointName: string): vec3 | null {
    try {
      const joint = hand[jointName];
      if (joint && joint.position) {
        return joint.position as vec3;
      }
    } catch (e) {
      // fall through
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Pinch transitions
  // ---------------------------------------------------------------------------

  private beginPinch(state: HandState): void {
    state.isPinching = true;

    SpatialisRegistry.compact();
    const target = this.pickTarget(state.pinchPoint);
    if (!target) {
      return;
    }

    // A piece already held by the other hand starts a two-hand transform.
    const other = this.otherHand(state);
    if (other && other.grabbed && other.grabbed.id === target.id) {
      state.grabbed = target;
      state.grabOffset = target.transform.getWorldPosition().sub(state.pinchPoint);
      this.beginTwoHand(target, other, state);
      return;
    }

    state.grabbed = target;
    state.grabOffset = target.transform.getWorldPosition().sub(state.pinchPoint);
    target.isGrabbed = true;

    if (this.singleHandRotate) {
      this.singleHandStartYaw = this.handYaw(state);
      this.singleHandStartRotation = target.transform.getWorldRotation();
    }

    log("Gesture", state.side + " hand grabbed " + target.spec.label + " #" + target.id + ".");
  }

  private endPinch(state: HandState): void {
    state.isPinching = false;
    const released = state.grabbed;
    state.grabbed = null;
    if (!released) {
      return;
    }

    // If the other hand still holds it, this is a two-hand gesture collapsing
    // back to a one-hand drag — not a release.
    const other = this.otherHand(state);
    if (other && other.isPinching && other.grabbed && other.grabbed.id === released.id) {
      this.twoHand = null;
      other.grabOffset = released.transform.getWorldPosition().sub(other.pinchPoint);
      if (this.singleHandRotate) {
        this.singleHandStartYaw = this.handYaw(other);
        this.singleHandStartRotation = released.transform.getWorldRotation();
      }
      log("Gesture", state.side + " hand let go; " + other.side + " hand still holding.");
      return;
    }

    this.twoHand = null;
    released.isGrabbed = false;
    this.settle(released);
  }

  /** Hand a released piece back to the anchor engine to drop onto a surface. */
  private settle(obj: SpatialisObject): void {
    if (!this.anchorEngine) {
      log("Gesture", "Released " + obj.spec.label + " (no anchor engine; left in place).");
      return;
    }
    this.anchorEngine.reseat(obj, (result: AnchorResult) => {
      if (isNull(obj.sceneObject) || obj.isGrabbed) {
        // Re-grabbed while the hit test was in flight — do not yank it back.
        return;
      }
      obj.transform.setWorldPosition(result.position);
      obj.transform.setWorldRotation(result.rotation);
      obj.surface = result.surface;
      obj.surfaceNormal = result.normal;
      log("Gesture", "Settled " + obj.spec.label + " on the " + result.surface + ".");
    });
  }

  /** Nearest piece within grab range, scaled by how large the piece is drawn. */
  private pickTarget(pinchPoint: vec3): SpatialisObject | null {
    const all = SpatialisRegistry.all();
    let best: SpatialisObject | null = null;
    let bestDistance = Number.MAX_VALUE;

    for (let i = 0; i < all.length; i++) {
      const obj = all[i];
      if (isNull(obj.sceneObject)) {
        continue;
      }
      const distance = obj.transform.getWorldPosition().distance(pinchPoint);
      // A scaled-up sofa should be grabbable from further out than a vase.
      const drawnScale = obj.transform.getLocalScale().x / Math.max(obj.baseScale.x, 0.0001);
      const reach = this.grabRadius + obj.spec.footprint * drawnScale;
      if (distance <= reach && distance < bestDistance) {
        bestDistance = distance;
        best = obj;
      }
    }
    return best;
  }

  private otherHand(state: HandState): HandState | null {
    for (let i = 0; i < this.hands.length; i++) {
      if (this.hands[i].side !== state.side) {
        return this.hands[i];
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // One-hand drag
  // ---------------------------------------------------------------------------

  private updateSingleHandDrag(state: HandState, dt: number): void {
    const obj = state.grabbed;
    if (!state.isPinching || !obj || isNull(obj.sceneObject)) {
      return;
    }

    const target = state.pinchPoint.add(state.grabOffset);
    const current = obj.transform.getWorldPosition();
    // Smoothing is expressed as "fraction of error left after one second", so
    // the feel is identical at 30fps and 60fps.
    const next =
      this.dragSmoothing <= 0.001
        ? target
        : dampVec3(current, target, this.dragSmoothing, dt);
    obj.transform.setWorldPosition(next);

    if (this.singleHandRotate) {
      const deltaYaw = this.handYaw(state) - this.singleHandStartYaw;
      obj.transform.setWorldRotation(
        quat.angleAxis(deltaYaw, vec3.up()).multiply(this.singleHandStartRotation)
      );
    }
  }

  /** Yaw of the vector from wrist to index tip, used for wrist-twist rotation. */
  private handYaw(state: HandState): number {
    const index = this.jointPosition(state.hand, "indexTip");
    const wrist =
      this.jointPosition(state.hand, "wrist") || this.jointPosition(state.hand, "thumbTip");
    if (!index || !wrist) {
      return 0;
    }
    const flat = new vec3(index.x - wrist.x, 0, index.z - wrist.z);
    if (flat.lengthSquared < 0.0001) {
      return 0;
    }
    return Math.atan2(flat.x, flat.z);
  }

  // ---------------------------------------------------------------------------
  // Two-hand scale and rotate
  // ---------------------------------------------------------------------------

  private beginTwoHand(obj: SpatialisObject, first: HandState, second: HandState): void {
    const separation = first.pinchPoint.distance(second.pinchPoint);
    if (separation < 1.0) {
      // Hands effectively coincident; the ratio would blow up.
      return;
    }
    this.twoHand = {
      object: obj,
      startSeparation: separation,
      startScale: obj.transform.getLocalScale(),
      startYaw: this.pairYaw(first.pinchPoint, second.pinchPoint),
      startRotation: obj.transform.getWorldRotation(),
      startMidpoint: vec3.lerp(first.pinchPoint, second.pinchPoint, 0.5),
      startPosition: obj.transform.getWorldPosition(),
    };
    obj.isGrabbed = true;
    log("Gesture", "Two-hand transform on " + obj.spec.label + " #" + obj.id + ".");
  }

  /** Returns true when a two-hand transform is active and was applied. */
  private tryUpdateTwoHand(dt: number): boolean {
    if (!this.twoHand) {
      return false;
    }
    const obj = this.twoHand.object;
    if (isNull(obj.sceneObject)) {
      this.twoHand = null;
      return false;
    }

    let a: HandState | null = null;
    let b: HandState | null = null;
    for (let i = 0; i < this.hands.length; i++) {
      const h = this.hands[i];
      if (h.isPinching && h.grabbed && h.grabbed.id === obj.id) {
        if (!a) {
          a = h;
        } else {
          b = h;
        }
      }
    }
    if (!a || !b) {
      this.twoHand = null;
      return false;
    }

    const separation = a.pinchPoint.distance(b.pinchPoint);
    const midpoint = vec3.lerp(a.pinchPoint, b.pinchPoint, 0.5);

    // Scale by how much the hands spread, clamped against the piece's own size
    // so a piece can never be scaled away to nothing or past room-filling.
    const ratio = separation / Math.max(this.twoHand.startSeparation, 0.0001);
    const rawScale = this.twoHand.startScale.uniformScale(ratio);
    const factor = rawScale.x / Math.max(obj.baseScale.x, 0.0001);
    const clampedFactor = clamp(factor, this.minScaleFactor, this.maxScaleFactor);
    obj.transform.setLocalScale(obj.baseScale.uniformScale(clampedFactor));

    // Rotate about world up by how far the hand-to-hand line has swept.
    const deltaYaw = this.pairYaw(a.pinchPoint, b.pinchPoint) - this.twoHand.startYaw;
    obj.transform.setWorldRotation(
      quat.angleAxis(deltaYaw, vec3.up()).multiply(this.twoHand.startRotation)
    );

    // Translate with the midpoint so the piece stays between the hands.
    const target = this.twoHand.startPosition.add(midpoint.sub(this.twoHand.startMidpoint));
    const current = obj.transform.getWorldPosition();
    obj.transform.setWorldPosition(
      this.dragSmoothing <= 0.001 ? target : dampVec3(current, target, this.dragSmoothing, dt)
    );

    return true;
  }

  private pairYaw(a: vec3, b: vec3): number {
    const flat = new vec3(b.x - a.x, 0, b.z - a.z);
    if (flat.lengthSquared < 0.0001) {
      return 0;
    }
    return Math.atan2(flat.x, flat.z);
  }

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------

  private updateIndicator(): void {
    if (!this.grabIndicator || isNull(this.grabIndicator)) {
      return;
    }
    const held = this.heldObject();
    if (!held || isNull(held.sceneObject)) {
      this.setIndicatorVisible(false);
      return;
    }
    this.setIndicatorVisible(true);
    this.grabIndicator
      .getTransform()
      .setWorldPosition(
        held.transform.getWorldPosition().add(vec3.up().uniformScale(held.spec.height * 0.6))
      );
  }

  private setIndicatorVisible(visible: boolean): void {
    if (this.grabIndicator && !isNull(this.grabIndicator)) {
      this.grabIndicator.enabled = visible;
    }
  }

  // ---------------------------------------------------------------------------
  // Public state — read by the voice layer for "make it bigger" style commands
  // ---------------------------------------------------------------------------

  /** The piece currently under a hand, or null. */
  heldObject(): SpatialisObject | null {
    for (let i = 0; i < this.hands.length; i++) {
      if (this.hands[i].isPinching && this.hands[i].grabbed) {
        return this.hands[i].grabbed;
      }
    }
    return null;
  }

  isPinching(side: HandSide): boolean {
    for (let i = 0; i < this.hands.length; i++) {
      if (this.hands[i].side === side) {
        return this.hands[i].isPinching;
      }
    }
    return false;
  }

  /** Force-release everything — used when the voice layer clears the room. */
  releaseAll(): void {
    for (let i = 0; i < this.hands.length; i++) {
      const state = this.hands[i];
      if (state.grabbed) {
        state.grabbed.isGrabbed = false;
      }
      state.grabbed = null;
      state.isPinching = false;
    }
    this.twoHand = null;
    this.setIndicatorVisible(false);
  }
}
