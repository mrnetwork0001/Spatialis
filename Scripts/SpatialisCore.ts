/**
 * SpatialisCore.ts
 * -----------------------------------------------------------------------------
 * Shared vocabulary, object registry, and math/tween utilities for Spatialis.
 *
 * Every one of the four subsystems (Voice, Gesture, Anchor, Material) imports
 * from here so they agree on what a "sofa", a "floor", or a "velvet" is without
 * holding direct references to each other.
 *
 * Units note: Lens Studio world space is centimetres. A sofa is ~200 units wide,
 * a coffee table ~110. All footprint/height constants below are in cm.
 *
 * Target: Lens Studio 5.22+ / Spectacles (SPECS) Project Mode.
 * Copyright 2026 Ifeanyichukwu Onwo
 * License: Apache-2.0
 */

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

/** What kind of real-world plane a hit test landed on. */
export type SurfaceKind = "floor" | "table" | "wall" | "ceiling" | "unknown";

/** Where the user asked a piece of furniture to end up. */
export type PlacementHint = "auto" | "floor" | "table" | "wall" | "float";

/** The verb extracted from a voice command. */
export type IntentAction =
  | "spawn"
  | "material"
  | "color"
  | "scale"
  | "move"
  | "delete"
  | "clear"
  | "unknown";

/** A parsed voice command, produced by VoiceCommandController. */
export interface SpatialisIntent {
  action: IntentAction;
  /** Catalog key, e.g. "sofa" / "coffeeTable". Empty when not a spawn. */
  furniture: string;
  /** Material preset key, e.g. "velvet" / "walnut". Empty when not a restyle. */
  material: string;
  /** Named colour tint, e.g. "sage". Empty when the command carried no colour. */
  color: string;
  placement: PlacementHint;
  /** Multiplier for "scale" intents (1.25 = "a bit bigger"). */
  scaleFactor: number;
  /** Free-form style adjective ("scandinavian", "brutalist") kept for logging. */
  style: string;
  rawTranscript: string;
  /** 0..1 heuristic - how many distinct slots the parser actually filled. */
  confidence: number;
}

export function makeEmptyIntent(transcript: string): SpatialisIntent {
  return {
    action: "unknown",
    furniture: "",
    material: "",
    color: "",
    placement: "auto",
    scaleFactor: 1.0,
    style: "",
    rawTranscript: transcript,
    confidence: 0,
  };
}

// -----------------------------------------------------------------------------
// Furniture catalog metadata
// -----------------------------------------------------------------------------

/**
 * Physical description of a catalog entry. The Anchor engine uses `footprint`
 * to keep pieces from overlapping and `defaultPlacement` to decide whether a
 * thing belongs on the floor, on a table, or hung on a wall.
 */
export interface FurnitureSpec {
  key: string;
  /** Human label used in confirmation speech / debug text. */
  label: string;
  /** Approximate radius on the ground plane, cm. Used for overlap rejection. */
  footprint: number;
  /** Approximate height, cm. Used to seat wall art at eye level. */
  height: number;
  defaultPlacement: PlacementHint;
  /** Words that should resolve to this entry. Lowercase, singular preferred. */
  aliases: string[];
}

export const FURNITURE_CATALOG: FurnitureSpec[] = [
  {
    key: "sofa",
    label: "sofa",
    footprint: 105,
    height: 80,
    defaultPlacement: "floor",
    aliases: ["sofa", "couch", "settee", "loveseat", "sectional"],
  },
  {
    key: "chair",
    label: "lounge chair",
    footprint: 45,
    height: 85,
    defaultPlacement: "floor",
    aliases: ["chair", "armchair", "lounge chair", "seat", "stool", "recliner"],
  },
  {
    key: "table",
    label: "dining table",
    footprint: 80,
    height: 75,
    defaultPlacement: "floor",
    aliases: ["table", "dining table", "desk", "worktable"],
  },
  {
    key: "coffeeTable",
    label: "coffee table",
    footprint: 55,
    height: 42,
    defaultPlacement: "floor",
    aliases: ["coffee table", "low table", "side table", "end table"],
  },
  {
    key: "lamp",
    label: "floor lamp",
    footprint: 22,
    height: 150,
    defaultPlacement: "floor",
    aliases: ["lamp", "floor lamp", "standing lamp", "light", "torchiere"],
  },
  {
    key: "tableLamp",
    label: "table lamp",
    footprint: 14,
    height: 45,
    defaultPlacement: "table",
    aliases: ["table lamp", "desk lamp", "bedside lamp"],
  },
  {
    key: "shelf",
    label: "shelf",
    footprint: 40,
    height: 180,
    defaultPlacement: "wall",
    aliases: ["shelf", "shelving", "bookshelf", "bookcase"],
  },
  {
    key: "plant",
    label: "potted plant",
    footprint: 30,
    height: 120,
    defaultPlacement: "floor",
    aliases: ["plant", "potted plant", "fern", "palm", "monstera", "tree"],
  },
  {
    key: "rug",
    label: "rug",
    footprint: 110,
    height: 2,
    defaultPlacement: "floor",
    aliases: ["rug", "carpet", "mat"],
  },
  {
    key: "artwork",
    label: "wall art",
    footprint: 35,
    height: 60,
    defaultPlacement: "wall",
    aliases: ["art", "artwork", "painting", "picture", "poster", "canvas", "frame"],
  },
  {
    key: "vase",
    label: "vase",
    footprint: 12,
    height: 30,
    defaultPlacement: "table",
    aliases: ["vase", "pot", "bowl", "centerpiece"],
  },
  {
    key: "bed",
    label: "bed",
    footprint: 120,
    height: 60,
    defaultPlacement: "floor",
    aliases: ["bed", "mattress", "daybed"],
  },
];

/** Resolve a spoken phrase to a catalog key, or "" when nothing matches. */
export function resolveFurniture(phrase: string): string {
  const text = " " + phrase.toLowerCase() + " ";
  let bestKey = "";
  let bestLen = 0;
  for (let i = 0; i < FURNITURE_CATALOG.length; i++) {
    const spec = FURNITURE_CATALOG[i];
    for (let a = 0; a < spec.aliases.length; a++) {
      const alias = spec.aliases[a];
      // Longest alias wins so "coffee table" beats "table". Speech is often
      // plural ("make the chairs navy"), so the naive plural is matched too.
      const hit =
        text.indexOf(" " + alias + " ") >= 0 || text.indexOf(" " + alias + "s ") >= 0;
      if (alias.length > bestLen && hit) {
        bestKey = spec.key;
        bestLen = alias.length;
      }
    }
  }
  return bestKey;
}

export function getFurnitureSpec(key: string): FurnitureSpec | null {
  for (let i = 0; i < FURNITURE_CATALOG.length; i++) {
    if (FURNITURE_CATALOG[i].key === key) {
      return FURNITURE_CATALOG[i];
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Spawned-object registry
// -----------------------------------------------------------------------------

/** A live piece of furniture in the user's room. */
export interface SpatialisObject {
  id: number;
  sceneObject: SceneObject;
  transform: Transform;
  /** Catalog key this was spawned from. */
  kind: string;
  spec: FurnitureSpec;
  placement: PlacementHint;
  /** Which real surface it is currently resting on. */
  surface: SurfaceKind;
  /** World-space normal of the surface it is anchored to. */
  surfaceNormal: vec3;
  /** Scale at rest, before any gesture scaling. Restored on "reset". */
  baseScale: vec3;
  /** Material preset key currently applied, or "" for the prefab default. */
  materialKey: string;
  spawnedAtSeconds: number;
  /** True while a hand is dragging it - the anchor engine leaves it alone. */
  isGrabbed: boolean;
}

/**
 * Process-wide registry of everything Spatialis has placed in the room.
 *
 * The four subsystems are separate ScriptComponents that may live on different
 * SceneObjects, so routing through a module singleton keeps them decoupled:
 * Voice adds, Gesture mutates, Anchor re-seats, Material restyles.
 */
class SpatialisObjectRegistry {
  private objects: SpatialisObject[] = [];
  private nextId: number = 1;

  register(entry: Omit<SpatialisObject, "id">): SpatialisObject {
    const full = entry as SpatialisObject;
    full.id = this.nextId++;
    this.objects.push(full);
    return full;
  }

  /** Drop an entry and destroy its SceneObject. Safe to call twice. */
  remove(id: number): boolean {
    for (let i = 0; i < this.objects.length; i++) {
      if (this.objects[i].id === id) {
        const obj = this.objects[i];
        this.objects.splice(i, 1);
        if (obj.sceneObject && !isNull(obj.sceneObject)) {
          obj.sceneObject.destroy();
        }
        return true;
      }
    }
    return false;
  }

  removeAll(): number {
    const count = this.objects.length;
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const obj = this.objects[i];
      if (obj.sceneObject && !isNull(obj.sceneObject)) {
        obj.sceneObject.destroy();
      }
    }
    this.objects = [];
    return count;
  }

  /** Live view - callers must not mutate the returned array. */
  all(): SpatialisObject[] {
    return this.objects;
  }

  count(): number {
    return this.objects.length;
  }

  /** Most recently spawned object, the implicit target of "make it bigger". */
  last(): SpatialisObject | null {
    if (this.objects.length === 0) {
      return null;
    }
    return this.objects[this.objects.length - 1];
  }

  byId(id: number): SpatialisObject | null {
    for (let i = 0; i < this.objects.length; i++) {
      if (this.objects[i].id === id) {
        return this.objects[i];
      }
    }
    return null;
  }

  /** Closest object to `point` within `maxDistance` cm, or null. */
  nearest(point: vec3, maxDistance: number): SpatialisObject | null {
    let best: SpatialisObject | null = null;
    let bestDist = maxDistance;
    for (let i = 0; i < this.objects.length; i++) {
      const obj = this.objects[i];
      if (isNull(obj.sceneObject)) {
        continue;
      }
      const d = obj.transform.getWorldPosition().distance(point);
      if (d < bestDist) {
        bestDist = d;
        best = obj;
      }
    }
    return best;
  }

  /** Most recent object matching a catalog key - "make the sofa velvet". */
  lastOfKind(kind: string): SpatialisObject | null {
    for (let i = this.objects.length - 1; i >= 0; i--) {
      if (this.objects[i].kind === kind) {
        return this.objects[i];
      }
    }
    return null;
  }

  /** Purge entries whose SceneObject was destroyed elsewhere. */
  compact(): void {
    const alive: SpatialisObject[] = [];
    for (let i = 0; i < this.objects.length; i++) {
      if (!isNull(this.objects[i].sceneObject)) {
        alive.push(this.objects[i]);
      }
    }
    this.objects = alive;
  }
}

export const SpatialisRegistry = new SpatialisObjectRegistry();

// -----------------------------------------------------------------------------
// Math helpers
// -----------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Framerate-independent exponential smoothing.
 * `smoothing` is the fraction of remaining error left after one second.
 */
export function damp(current: number, target: number, smoothing: number, dt: number): number {
  return lerp(target, current, Math.pow(clamp(smoothing, 0.0001, 0.9999), dt));
}

export function dampVec3(current: vec3, target: vec3, smoothing: number, dt: number): vec3 {
  const t = 1 - Math.pow(clamp(smoothing, 0.0001, 0.9999), dt);
  return vec3.lerp(current, target, t);
}

/** Cubic ease-out - the spawn "pop" curve. */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

/** Slight overshoot, so spawned furniture lands with a bit of weight. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = clamp(t, 0, 1) - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/**
 * Yaw-only look rotation. Furniture should face the user without tipping over,
 * so we discard pitch/roll and rotate about world up.
 */
export function yawTowards(from: vec3, to: vec3): quat {
  const flat = new vec3(to.x - from.x, 0, to.z - from.z);
  if (flat.lengthSquared < 0.0001) {
    return quat.quatIdentity();
  }
  const angle = Math.atan2(flat.x, flat.z);
  return quat.angleAxis(angle, vec3.up());
}

/**
 * Build a rotation whose local up matches `normal` and whose local forward
 * points as close to `preferredForward` as the normal allows. Used to lay rugs
 * flat on sloped floors and to hang art flush against walls.
 */
export function alignToNormal(normal: vec3, preferredForward: vec3): quat {
  const up = normal.normalize();
  let fwd = preferredForward.sub(up.uniformScale(preferredForward.dot(up)));
  if (fwd.lengthSquared < 0.0001) {
    // preferredForward was parallel to the normal - pick any orthogonal axis.
    fwd = Math.abs(up.y) < 0.9 ? vec3.up().cross(up) : vec3.forward().cross(up);
  }
  return quat.lookAt(fwd.normalize(), up);
}

// -----------------------------------------------------------------------------
// Tweening
// -----------------------------------------------------------------------------

export type TweenStep = (t: number) => void;

/**
 * Minimal time-based tween. Each subsystem owns a TweenPool and steps it from
 * its own UpdateEvent - no hidden global update ordering between subsystems.
 */
export class Tween {
  private elapsed: number = 0;
  public done: boolean = false;

  constructor(
    private duration: number,
    private ease: (t: number) => number,
    private step: TweenStep,
    private onComplete: (() => void) | null = null
  ) {}

  advance(dt: number): void {
    if (this.done) {
      return;
    }
    this.elapsed += dt;
    const raw = this.duration <= 0 ? 1 : clamp(this.elapsed / this.duration, 0, 1);
    this.step(this.ease(raw));
    if (raw >= 1) {
      this.done = true;
      if (this.onComplete) {
        this.onComplete();
      }
    }
  }
}

export class TweenPool {
  private tweens: Tween[] = [];

  add(tween: Tween): Tween {
    this.tweens.push(tween);
    return tween;
  }

  /** Step every tween and drop finished ones. Call once per frame. */
  update(dt: number): void {
    if (this.tweens.length === 0) {
      return;
    }
    const alive: Tween[] = [];
    for (let i = 0; i < this.tweens.length; i++) {
      this.tweens[i].advance(dt);
      if (!this.tweens[i].done) {
        alive.push(this.tweens[i]);
      }
    }
    this.tweens = alive;
  }

  clear(): void {
    this.tweens = [];
  }
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

/** Flip to false before shipping to keep the SPECS log quiet. */
export const SPATIALIS_VERBOSE: boolean = true;

export function log(tag: string, message: string): void {
  if (SPATIALIS_VERBOSE) {
    print("[Spatialis:" + tag + "] " + message);
  }
}

export function warn(tag: string, message: string): void {
  print("[Spatialis:" + tag + "] WARNING - " + message);
}
