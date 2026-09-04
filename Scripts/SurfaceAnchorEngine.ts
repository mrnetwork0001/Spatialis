/**
 * SurfaceAnchorEngine.ts
 * -----------------------------------------------------------------------------
 * Subsystem 3 of 4 — physical surface detection and snapping.
 *
 * Casts world-query rays into the room mesh, classifies each hit as floor /
 * table / wall / ceiling, and seats furniture flush against it. Also owns the
 * running estimate of floor height, which is what lets us tell a table top
 * ("horizontal, but 75cm up") apart from the floor itself.
 *
 * Consumed by VoiceCommandController (where does a new spawn go?) and by
 * SpatialGestureController (where does a released object settle?).
 *
 * Target: Lens Studio 5.22+ / Spectacles (SPECS) Project Mode.
 * License: Apache-2.0
 */

import {
  FurnitureSpec,
  PlacementHint,
  SpatialisObject,
  SpatialisRegistry,
  SurfaceKind,
  alignToNormal,
  damp,
  log,
  warn,
  yawTowards,
} from "./SpatialisCore";

/** Outcome of a placement request. */
export interface AnchorResult {
  /** True when a real surface was found; false means we fell back to floating. */
  anchored: boolean;
  position: vec3;
  rotation: quat;
  surface: SurfaceKind;
  normal: vec3;
}

type AnchorCallback = (result: AnchorResult) => void;

interface PendingProbe {
  rayStart: vec3;
  rayEnd: vec3;
  resolve: (position: vec3 | null, normal: vec3 | null) => void;
}

// A horizontal plane has a normal within ~32 degrees of world up.
const HORIZONTAL_DOT = 0.85;
// A vertical plane has a normal within ~17 degrees of the horizon.
const VERTICAL_DOT = 0.3;
// A horizontal surface this far above the floor is furniture, not the floor.
const TABLE_MIN_HEIGHT = 30;
const TABLE_MAX_HEIGHT = 130;

@component
export class SurfaceAnchorEngine extends BaseScriptComponent {
  @input
  @hint("Camera the user is looking through. Leave empty to auto-find 'Camera'.")
  camera: Camera;

  @input
  @hint("World Query module asset. Add via Asset Browser > Add > World Query.")
  @allowUndefined
  worldQueryAsset: Asset;

  @input
  @hint("Metres of ray to cast when searching for a surface, in cm.")
  @widget(new SliderWidget(100, 1500, 10))
  probeDistance: number = 700;

  @input
  @hint("Fallback distance in front of the user when no surface is found, cm.")
  @widget(new SliderWidget(60, 400, 5))
  floatDistance: number = 160;

  @input
  @hint("Nudge new furniture aside if it lands inside an existing piece.")
  avoidOverlap: boolean = true;

  private hitTestSession: any = null;
  private probeQueue: PendingProbe[] = [];
  private probeInFlight: boolean = false;

  /** Running estimate of the room floor, world Y in cm. */
  private floorHeight: number = 0;
  private floorSampleCount: number = 0;

  private cameraTransform: Transform | null = null;
  private ready: boolean = false;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (!this.camera) {
      warn(
        "Anchor",
        "No camera assigned — gaze rays will originate from this SceneObject instead."
      );
    }
    this.cameraTransform = this.camera
      ? this.camera.getSceneObject().getTransform()
      : this.getSceneObject().getTransform();

    const module = this.resolveWorldQueryModule();
    if (!module) {
      warn(
        "Anchor",
        "World Query module unavailable — running in float-only mode. " +
          "Add the World Query asset in the Asset Browser and assign it."
      );
      this.ready = false;
      return;
    }

    try {
      const options = HitTestSessionOptions.create();
      // Filtered results reject spurious low-confidence depth points.
      options.filter = true;
      this.hitTestSession = module.createHitTestSessionWithOptions(options);
      this.hitTestSession.start();
      this.ready = true;
      log("Anchor", "Hit test session started (filtered).");
    } catch (e) {
      warn("Anchor", "Could not start hit test session: " + e);
      this.ready = false;
    }

    // Seed the floor estimate by looking straight down from the headset.
    this.calibrateFloor();
  }

  /**
   * Attach a hit-test source directly, bypassing World Query.
   *
   * The desk simulator and the test suite have no Lens Studio runtime, so they
   * supply their own — anything with `hitTest(start, end, cb)` where `cb`
   * receives `{ position, normal }` or `null`. Everything downstream of the
   * probe (classification, retry, overlap, wall-adjacent, reseat) then runs
   * unchanged, which is the point: it is the shipped placement logic being
   * exercised, not a stand-in for it.
   */
  attachHitTestSource(
    session: { hitTest(start: vec3, end: vec3, cb: (hit: any) => void): void },
    cameraTransform: Transform
  ): void {
    this.hitTestSession = session;
    this.cameraTransform = cameraTransform;
    this.ready = true;
    // Same as onStart: seed the floor from a downward probe. Without it the
    // first horizontal hit sets the floor, and if that hit is a tabletop the
    // table and the floor become indistinguishable for the rest of the session.
    this.calibrateFloor();
  }

  /** Step the probe queue. Lens Studio calls this via UpdateEvent; hosts without one call it directly. */
  tick(): void {
    this.pumpProbeQueue();
  }

  private resolveWorldQueryModule(): any {
    if (this.worldQueryAsset) {
      return this.worldQueryAsset as any;
    }
    try {
      return require("LensStudio:WorldQueryModule");
    } catch (e) {
      return null;
    }
  }

  private onUpdate(): void {
    this.pumpProbeQueue();
  }

  // ---------------------------------------------------------------------------
  // Ray probing
  // ---------------------------------------------------------------------------

  /**
   * World Query allows one hit test in flight at a time and answers on a later
   * frame, so requests are queued and drained here rather than issued directly.
   */
  private pumpProbeQueue(): void {
    if (this.probeInFlight || this.probeQueue.length === 0) {
      return;
    }
    if (!this.ready) {
      // Drain with null results so callers still get their fallback.
      const dropped = this.probeQueue;
      this.probeQueue = [];
      for (let i = 0; i < dropped.length; i++) {
        dropped[i].resolve(null, null);
      }
      return;
    }

    const probe = this.probeQueue.shift() as PendingProbe;
    this.probeInFlight = true;
    this.hitTestSession.hitTest(probe.rayStart, probe.rayEnd, (hit: any) => {
      this.probeInFlight = false;
      if (hit === null || hit === undefined) {
        probe.resolve(null, null);
        return;
      }
      const position = hit.position as vec3;
      const normal = (hit.normal as vec3).normalize();
      this.noteFloorSample(position, normal);
      probe.resolve(position, normal);
    });
  }

  private enqueueProbe(
    rayStart: vec3,
    rayEnd: vec3,
    resolve: (position: vec3 | null, normal: vec3 | null) => void
  ): void {
    this.probeQueue.push({ rayStart: rayStart, rayEnd: rayEnd, resolve: resolve });
  }

  /**
   * The headset's own height is a poor floor estimate, so we take the lowest
   * horizontal hit we have seen and ease toward it. Easing (rather than a hard
   * min) keeps one bad depth sample from dropping the floor through the ground.
   */
  private noteFloorSample(position: vec3, normal: vec3): void {
    if (normal.dot(vec3.up()) < HORIZONTAL_DOT) {
      return;
    }
    if (this.floorSampleCount === 0) {
      this.floorHeight = position.y;
      this.floorSampleCount = 1;
      return;
    }
    if (position.y < this.floorHeight) {
      this.floorHeight = damp(this.floorHeight, position.y, 0.02, 1.0);
      this.floorSampleCount++;
    }
  }

  /** Fire a downward ray from the headset to establish floor height early. */
  private calibrateFloor(): void {
    if (!this.cameraTransform) {
      return;
    }
    const origin = this.cameraTransform.getWorldPosition();
    const below = origin.add(vec3.up().uniformScale(-this.probeDistance));
    this.enqueueProbe(origin, below, (position, normal) => {
      if (position && normal) {
        log("Anchor", "Floor calibrated at y=" + position.y.toFixed(1) + "cm.");
      } else {
        // No depth yet — assume a standing user, eye height ~155cm.
        this.floorHeight = origin.y - 155;
        log("Anchor", "Floor estimated from eye height at y=" + this.floorHeight.toFixed(1) + "cm.");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------------

  /**
   * Decide what a hit surface is from its normal and its height above the floor.
   * A table is simply "horizontal, but at sitting-to-standing working height".
   */
  classify(position: vec3, normal: vec3): SurfaceKind {
    // Normalize defensively. The internal probe path already hands us a unit
    // normal, but this method is public: an unnormalized vector would scale
    // the dot product and misread a 45-degree ramp as a horizontal surface.
    const up = normal.normalize().dot(vec3.up());
    if (up >= HORIZONTAL_DOT) {
      const heightAboveFloor = position.y - this.floorHeight;
      if (heightAboveFloor >= TABLE_MIN_HEIGHT && heightAboveFloor <= TABLE_MAX_HEIGHT) {
        return "table";
      }
      return "floor";
    }
    if (up <= -HORIZONTAL_DOT) {
      return "ceiling";
    }
    if (Math.abs(up) <= VERTICAL_DOT) {
      return "wall";
    }
    return "unknown";
  }

  /** Current floor estimate in world cm. */
  getFloorHeight(): number {
    return this.floorHeight;
  }

  isReady(): boolean {
    return this.ready;
  }

  // ---------------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------------

  /**
   * Find where a newly spawned piece of furniture should sit.
   *
   * Casts along the user's gaze. If the hit surface disagrees with what the
   * piece needs (art wants a wall, a sofa wants a floor), we re-probe in the
   * direction that surface is likely to be rather than accepting a bad anchor.
   *
   * `wallAdjacent` handles "by the wall" / "against the wall": the piece still
   * stands on the floor, but backed up to a wall and turned to face the room.
   */
  requestPlacement(
    spec: FurnitureSpec,
    hint: PlacementHint,
    wallAdjacent: boolean,
    callback: AnchorCallback
  ): void {
    const desired: PlacementHint = hint === "auto" ? spec.defaultPlacement : hint;

    if (desired === "float") {
      callback(this.floatingResult(spec));
      return;
    }

    // "by the wall" is a floor placement backed up against a wall, which needs
    // two chained probes rather than the single gaze ray below.
    if (wallAdjacent && desired !== "wall") {
      this.requestWallAdjacentPlacement(spec, callback);
      return;
    }

    const origin = this.eyePosition();
    const direction = this.probeDirectionFor(desired);
    const rayEnd = origin.add(direction.uniformScale(this.probeDistance));

    this.enqueueProbe(origin, rayEnd, (position, normal) => {
      if (!position || !normal) {
        log("Anchor", "No surface for " + spec.label + "; floating it instead.");
        callback(this.floatingResult(spec));
        return;
      }

      const kind = this.classify(position, normal);
      const acceptable = this.surfaceSatisfies(kind, desired);
      if (!acceptable) {
        log(
          "Anchor",
          "Gaze hit a " + kind + " but " + spec.label + " wants a " + desired + "; retrying."
        );
        this.retryForSurface(spec, desired, callback);
        return;
      }

      callback(this.seat(spec, position, normal, kind));
    });
  }

  /**
   * Two chained probes for "put the chair by the wall":
   *   1. A level ray along the gaze finds the wall plane and its normal.
   *   2. A downward ray, stepped off the wall by the piece's own footprint,
   *      finds the floor at that spot.
   * The piece is then turned so its back is to the wall and it faces the room.
   */
  private requestWallAdjacentPlacement(spec: FurnitureSpec, callback: AnchorCallback): void {
    const origin = this.eyePosition();
    const fwd = this.gazeForward();
    const level = new vec3(fwd.x, 0, fwd.z);
    if (level.lengthSquared < 0.0001) {
      callback(this.floatingResult(spec));
      return;
    }
    const direction = level.normalize();
    const wallRayEnd = origin.add(direction.uniformScale(this.probeDistance));

    this.enqueueProbe(origin, wallRayEnd, (wallPos, wallNormal) => {
      if (!wallPos || !wallNormal || this.classify(wallPos, wallNormal) !== "wall") {
        // No wall in view — fall back to an ordinary floor placement.
        log("Anchor", "No wall found for " + spec.label + "; placing on the floor instead.");
        this.retryForSurface(spec, "floor", callback);
        return;
      }

      // Step into the room by the piece's radius so it touches, not clips.
      const inward = new vec3(wallNormal.x, 0, wallNormal.z);
      const offset =
        inward.lengthSquared < 0.0001
          ? direction.uniformScale(-spec.footprint)
          : inward.normalize().uniformScale(spec.footprint);
      const standAt = wallPos.add(offset);

      const floorRayStart = standAt.add(vec3.up().uniformScale(spec.height + 40));
      const floorRayEnd = standAt.add(vec3.up().uniformScale(-this.probeDistance));

      this.enqueueProbe(floorRayStart, floorRayEnd, (floorPos, floorNormal) => {
        // Face away from the wall, into the room.
        const facing = standAt.add(offset);
        const rotation = yawTowards(standAt, facing);

        if (!floorPos || !floorNormal) {
          // Wall found but no floor reading — use the running floor estimate.
          const fallback = new vec3(standAt.x, this.floorHeight, standAt.z);
          callback({
            anchored: true,
            position: this.avoidOverlap
              ? this.resolveOverlap(fallback, spec.footprint, vec3.up())
              : fallback,
            rotation: rotation,
            surface: "floor",
            normal: vec3.up(),
          });
          return;
        }

        const seated = new vec3(standAt.x, floorPos.y, standAt.z);
        callback({
          anchored: true,
          position: this.avoidOverlap
            ? this.resolveOverlap(seated, spec.footprint, floorNormal)
            : seated,
          rotation: rotation,
          surface: this.classify(floorPos, floorNormal),
          normal: floorNormal,
        });
      });
    });
  }

  /**
   * Second attempt when the gaze ray landed on the wrong kind of surface: aim
   * down for floor/table pieces, and level for wall pieces.
   */
  private retryForSurface(
    spec: FurnitureSpec,
    desired: PlacementHint,
    callback: AnchorCallback
  ): void {
    const origin = this.eyePosition();
    let direction: vec3;
    if (desired === "wall") {
      // Look straight ahead at eye level — walls are vertical and in front.
      const fwd = this.gazeForward();
      direction = new vec3(fwd.x, 0, fwd.z).normalize();
    } else {
      // Aim at the point on the floor a comfortable pace ahead of the user.
      // The target must sit AT floor height: aiming probeDistance below it
      // instead made the ray so steep that it met the floor at
      // floatDistance * eyeHeight / probeDistance - about a fifth of the way -
      // and seated a sofa at the wearer's feet.
      const fwd = this.gazeForward();
      const ahead = new vec3(fwd.x, 0, fwd.z).normalize().uniformScale(this.floatDistance);
      const target = new vec3(origin.x + ahead.x, this.floorHeight, origin.z + ahead.z);
      direction = target.sub(origin).normalize();
    }

    const rayEnd = origin.add(direction.uniformScale(this.probeDistance));
    this.enqueueProbe(origin, rayEnd, (position, normal) => {
      if (!position || !normal) {
        callback(this.floatingResult(spec));
        return;
      }
      const kind = this.classify(position, normal);
      // Second attempt is final — take whatever we got rather than loop.
      callback(this.seat(spec, position, normal, kind));
    });
  }

  private surfaceSatisfies(kind: SurfaceKind, desired: PlacementHint): boolean {
    if (desired === "wall") {
      return kind === "wall";
    }
    if (desired === "table") {
      // A tabletop is ideal, but the floor is a reasonable stand-in.
      return kind === "table" || kind === "floor";
    }
    if (desired === "floor") {
      return kind === "floor" || kind === "table";
    }
    return kind !== "unknown";
  }

  /**
   * Turn a raw hit into a final transform: sit the piece on the surface, face
   * it sensibly, and step it aside if it would intersect existing furniture.
   */
  private seat(
    spec: FurnitureSpec,
    hitPosition: vec3,
    normal: vec3,
    kind: SurfaceKind
  ): AnchorResult {
    let position = hitPosition;
    let rotation: quat;

    if (kind === "wall") {
      // Hang art at eye level, flush to the wall, pushed out by half its depth.
      const eye = this.eyePosition();
      position = new vec3(hitPosition.x, eye.y - 10, hitPosition.z);
      position = position.add(normal.uniformScale(3));
      rotation = alignToNormal(vec3.up(), normal.uniformScale(-1));
    } else {
      // Horizontal: rest on the surface and turn to face the user.
      rotation = yawTowards(hitPosition, this.eyePosition());
      if (Math.abs(normal.dot(vec3.up())) < 0.995) {
        // Sloped floor — tilt with it so legs stay in contact.
        rotation = alignToNormal(normal, rotation.multiplyVec3(vec3.forward()));
      }
      if (this.avoidOverlap) {
        position = this.resolveOverlap(position, spec.footprint, normal);
      }
    }

    return {
      anchored: true,
      position: position,
      rotation: rotation,
      surface: kind,
      normal: normal,
    };
  }

  /**
   * Walk outward along an expanding spiral on the surface plane until the piece
   * no longer overlaps anything already placed. Gives up after a full turn and
   * accepts the crowded spot rather than flinging furniture across the room.
   */
  private resolveOverlap(position: vec3, footprint: number, normal: vec3): vec3 {
    const existing = SpatialisRegistry.all();
    if (existing.length === 0) {
      return position;
    }

    const tangent = alignToNormal(normal, vec3.forward()).multiplyVec3(vec3.right());
    const bitangent = normal.cross(tangent).normalize();
    const steps = 12;

    for (let attempt = 0; attempt <= steps; attempt++) {
      const radius = attempt === 0 ? 0 : footprint * (0.9 + 0.35 * attempt);
      const angle = attempt * 2.399; // golden angle, avoids re-testing a lane
      const candidate =
        attempt === 0
          ? position
          : position
              .add(tangent.uniformScale(Math.cos(angle) * radius))
              .add(bitangent.uniformScale(Math.sin(angle) * radius));

      if (this.isClear(candidate, footprint, existing)) {
        if (attempt > 0) {
          log("Anchor", "Nudged placement " + radius.toFixed(0) + "cm to clear existing furniture.");
        }
        return candidate;
      }
    }
    return position;
  }

  private isClear(candidate: vec3, footprint: number, existing: SpatialisObject[]): boolean {
    for (let i = 0; i < existing.length; i++) {
      const other = existing[i];
      if (isNull(other.sceneObject)) {
        continue;
      }
      const otherPos = other.transform.getWorldPosition();
      // Compare on the ground plane; stacking heights is the caller's business.
      const dx = candidate.x - otherPos.x;
      const dz = candidate.z - otherPos.z;
      const planar = Math.sqrt(dx * dx + dz * dz);
      const minGap = (footprint + other.spec.footprint) * 0.75;
      if (planar < minGap) {
        return false;
      }
    }
    return true;
  }

  /** No surface available — hold the piece in front of the user at eye level. */
  private floatingResult(spec: FurnitureSpec): AnchorResult {
    const origin = this.eyePosition();
    const fwd = this.gazeForward();
    const flat = new vec3(fwd.x, 0, fwd.z).normalize();
    const position = origin
      .add(flat.uniformScale(this.floatDistance))
      .add(vec3.up().uniformScale(-spec.height * 0.35));
    return {
      anchored: false,
      position: position,
      rotation: yawTowards(position, origin),
      surface: "unknown",
      normal: vec3.up(),
    };
  }

  // ---------------------------------------------------------------------------
  // Re-seating after a gesture
  // ---------------------------------------------------------------------------

  /**
   * Called by SpatialGestureController when the user lets go of a piece.
   * Drops a short ray straight down from just above the object to find whatever
   * it was released over — the floor, or a tabletop it was dragged onto.
   */
  reseat(obj: SpatialisObject, callback: AnchorCallback): void {
    const current = obj.transform.getWorldPosition();
    const rayStart = current.add(vec3.up().uniformScale(obj.spec.height + 20));
    const rayEnd = current.add(vec3.up().uniformScale(-this.probeDistance));

    this.enqueueProbe(rayStart, rayEnd, (position, normal) => {
      if (!position || !normal) {
        // Nothing underneath — leave it exactly where the hand let go.
        callback({
          anchored: false,
          position: current,
          rotation: obj.transform.getWorldRotation(),
          surface: obj.surface,
          normal: obj.surfaceNormal,
        });
        return;
      }

      const kind = this.classify(position, normal);
      if (obj.placement === "wall" || obj.spec.defaultPlacement === "wall") {
        // Wall pieces do not fall to the floor; keep the released pose.
        callback({
          anchored: true,
          position: current,
          rotation: obj.transform.getWorldRotation(),
          surface: obj.surface,
          normal: obj.surfaceNormal,
        });
        return;
      }

      // Keep the user's chosen X/Z, correct only the height onto the surface.
      const settled = new vec3(current.x, position.y, current.z);
      callback({
        anchored: true,
        position: settled,
        rotation: obj.transform.getWorldRotation(),
        surface: kind,
        normal: normal,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Camera helpers
  // ---------------------------------------------------------------------------

  private eyePosition(): vec3 {
    if (!this.cameraTransform) {
      return vec3.zero();
    }
    return this.cameraTransform.getWorldPosition();
  }

  /**
   * Direction the user is looking. Lens Studio transforms report `forward` as
   * the +Z axis while the camera looks down -Z, hence the negation.
   */
  private gazeForward(): vec3 {
    if (!this.cameraTransform) {
      return vec3.forward().uniformScale(-1);
    }
    return this.cameraTransform.forward.uniformScale(-1).normalize();
  }

  /** Bias the initial probe downward for things that live on the ground. */
  private probeDirectionFor(desired: PlacementHint): vec3 {
    const fwd = this.gazeForward();
    if (desired === "wall") {
      return fwd;
    }
    // Tilt ~20 degrees below the gaze so a level glance still finds the floor.
    const tilted = fwd.add(vec3.up().uniformScale(-0.36));
    return tilted.normalize();
  }
}
