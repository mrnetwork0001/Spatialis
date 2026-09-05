/**
 * VoiceCommandController.ts
 * -----------------------------------------------------------------------------
 * Subsystem 1 of 4 — natural-language intent parsing and 3D instantiation.
 *
 * Listens through the ASR module, turns a spoken sentence into a SpatialisIntent, then
 * drives the other three subsystems: the Anchor engine decides where the piece
 * goes, the Material swapper decides how it looks, and the Gesture controller
 * takes over once it exists.
 *
 * Design note on parsing: this is a slot filler, not a grammar. Real speech is
 * "uh, put a like, dark wood coffee table over there" — so we scan the whole
 * transcript for a verb, a catalog noun, a finish, a colour and a placement,
 * and act on whatever we found. Longest-alias matching means "coffee table"
 * beats "table" regardless of word order.
 *
 * Target: Lens Studio 5.22+ / Spectacles (SPECS) Project Mode.
 * Copyright 2026 Ifeanyichukwu Onwo
 * License: Apache-2.0
 */

import {
  FurnitureSpec,
  PlacementHint,
  SpatialisIntent,
  SpatialisObject,
  SpatialisRegistry,
  Tween,
  TweenPool,
  clamp,
  easeOutBack,
  getFurnitureSpec,
  log,
  makeEmptyIntent,
  resolveFurniture,
  warn,
} from "./SpatialisCore";
import { AnchorResult, SurfaceAnchorEngine } from "./SurfaceAnchorEngine";
import { PBRMaterialSwapper } from "./PBRMaterialSwapper";

// Verb vocabularies. Order within a list does not matter; the first list that
// matches wins, so the more specific actions are checked before "spawn".
const CLEAR_PHRASES = [
  "clear the room",
  "clear everything",
  "remove everything",
  "delete everything",
  "start over",
  "reset the room",
  "empty the room",
  "clear all",
];
const DELETE_VERBS = ["delete", "remove", "get rid of", "take away", "throw away", "undo"];
const SCALE_UP_WORDS = ["bigger", "larger", "grow", "scale up", "enlarge", "big", "huge"];
const SCALE_DOWN_WORDS = ["smaller", "tinier", "shrink", "scale down", "reduce", "tiny"];
const RESTYLE_VERBS = ["make", "change", "turn", "swap", "restyle", "recolour", "recolor", "paint"];
const SPAWN_VERBS = [
  "spawn",
  "add",
  "place",
  "put",
  "create",
  "give me",
  "i want",
  "i need",
  "drop",
  "bring",
  "show me",
  "insert",
];

// Style adjectives are not acted on mechanically, but they are logged and
// surfaced in the confirmation so the demo reads as intentional.
const STYLE_WORDS = [
  "scandinavian",
  "mid century",
  "midcentury",
  "modern",
  "minimalist",
  "industrial",
  "bohemian",
  "boho",
  "rustic",
  "brutalist",
  "art deco",
  "japandi",
  "coastal",
  "vintage",
  "contemporary",
];

@component
export class VoiceCommandController extends BaseScriptComponent {
  @input
  @hint("ASR Module asset (speech-to-text). Asset Browser > Add > ASR Module.")
  asrModule: AsrModule;

  @input
  @hint("Surface Anchor Engine that decides where spawned furniture lands.")
  anchorEngine: SurfaceAnchorEngine;

  @input
  @hint("PBR Material Swapper that applies finishes and tints.")
  materialSwapper: PBRMaterialSwapper;

  @input
  @hint("Parent for all spawned furniture. Defaults to this SceneObject.")
  @allowUndefined
  spawnParent: SceneObject;

  @input
  @hint("Catalog keys, parallel to Furniture Prefabs: sofa, chair, table, ...")
  furnitureKeys: string[] = [];

  @input
  @hint("Prefabs to instantiate, parallel to Furniture Keys.")
  furniturePrefabs: ObjectPrefab[] = [];

  @input
  @hint("Seconds for the scale-in animation on a newly spawned piece.")
  @widget(new SliderWidget(0.1, 2.0, 0.05))
  spawnDuration: number = 0.55;

  @input
  @hint("Require the wake word 'Spatialis' before acting on a command.")
  requireWakeWord: boolean = false;

  @input
  @hint("Wake word, only used when Require Wake Word is on.")
  wakeWord: string = "spatialis";

  @input
  @hint("Optional Text component for on-screen command feedback.")
  @allowUndefined
  feedbackText: Text;

  private tweens: TweenPool = new TweenPool();
  private isListening: boolean = false;
  private lastTranscript: string = "";
  private lastTranscriptTime: number = -10;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => {
      this.tweens.update(getDeltaTime());
    });
  }

  private onStart(): void {
    if (!this.asrModule) {
      warn("Voice", "No ASR module assigned — voice commands are disabled.");
      return;
    }
    if (!this.anchorEngine) {
      warn("Voice", "No Surface Anchor Engine assigned — spawns will not snap to surfaces.");
    }
    if (this.furnitureKeys.length !== this.furniturePrefabs.length) {
      warn(
        "Voice",
        "Furniture Keys (" +
          this.furnitureKeys.length +
          ") and Furniture Prefabs (" +
          this.furniturePrefabs.length +
          ") differ in length; extra entries are ignored."
      );
    }

    this.startTranscribing();
  }

  private startTranscribing(): void {
    // AsrModule replaces the deprecated VoiceML listening API (Lens Scripting
    // 309+): higher-quality transcription, many more languages, and the
    // update event carries `isFinal`, which is the one bit the pipeline
    // depends on - interim text is shown, only the final line is acted on.
    const options = AsrModule.AsrTranscriptionOptions.create();
    options.mode = AsrModule.AsrMode.Balanced;
    // A pause this long ends the utterance and produces the final transcript.
    options.silenceUntilTerminationMs = 1200;
    options.onTranscriptionUpdateEvent.add((e: AsrModule.TranscriptionUpdateEvent) => {
      this.onTranscriptionUpdate(e);
    });

    options.onTranscriptionErrorEvent.add((code: AsrModule.AsrStatusCode) => {
      this.isListening = false;
      warn("Voice", "ASR error: " + code + (code === AsrModule.AsrStatusCode.Unauthenticated
        ? " (Preview needs a My Lenses login for speech)" : ""));
    });

    this.asrModule.startTranscribing(options);
    this.isListening = true;
    log("Voice", "Transcribing.");
    this.showFeedback("Listening — try “add a walnut coffee table”");
  }

  /** ASR update: interim text is echoed to the feedback line; only a final one executes. */
  onTranscriptionUpdate(e: { text: string; isFinal: boolean }): void {
    const transcript = e.text;
    if (!transcript || transcript.length === 0) {
      return;
    }
    if (!e.isFinal) {
      this.showFeedback("… " + transcript);
      return;
    }
    this.handleTranscript(transcript);
  }

  /**
   * Public entry point. Exposed separately from the VoiceML callback so the
   * command pipeline can be exercised from a test button in Lens Studio's
   * preview, where there is no microphone.
   */
  handleTranscript(rawTranscript: string): void {
    const now = getTime();
    const normalized = this.normalize(rawTranscript);

    // ASR often emits the same final transcript twice in quick succession.
    if (normalized === this.lastTranscript && now - this.lastTranscriptTime < 2.0) {
      return;
    }
    this.lastTranscript = normalized;
    this.lastTranscriptTime = now;

    let command = normalized;
    if (this.requireWakeWord) {
      const wake = this.wakeWord.toLowerCase();
      const at = command.indexOf(wake);
      if (at < 0) {
        return;
      }
      command = command.substring(at + wake.length).trim();
    }

    const intent = this.parse(command, rawTranscript);
    log(
      "Voice",
      'heard "' +
        rawTranscript +
        '" → ' +
        intent.action +
        (intent.furniture ? " " + intent.furniture : "") +
        (intent.material ? " [" + intent.material + "]" : "") +
        (intent.color ? " {" + intent.color + "}" : "") +
        " @" +
        intent.placement +
        " (confidence " +
        intent.confidence.toFixed(2) +
        ")"
    );
    this.execute(intent);
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  /** Lowercase, strip punctuation, collapse whitespace, pad with spaces. */
  private normalize(text: string): string {
    let out = text.toLowerCase();
    let cleaned = "";
    for (let i = 0; i < out.length; i++) {
      const ch = out.charAt(i);
      const isLetter = ch >= "a" && ch <= "z";
      const isDigit = ch >= "0" && ch <= "9";
      cleaned += isLetter || isDigit ? ch : " ";
    }
    // Collapse runs of spaces.
    const parts = cleaned.split(" ");
    const words: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].length > 0) {
        words.push(parts[i]);
      }
    }
    return words.join(" ");
  }

  /** Slot-fill a normalized command into a SpatialisIntent. */
  parse(command: string, rawTranscript: string): SpatialisIntent {
    const intent = makeEmptyIntent(rawTranscript);
    const padded = " " + command + " ";
    let slots = 0;

    intent.furniture = resolveFurniture(command);
    intent.material = PBRMaterialSwapper.resolveMaterial(command);
    intent.color = PBRMaterialSwapper.resolveColor(command);
    intent.style = this.findFirst(padded, STYLE_WORDS);
    intent.placement = this.parsePlacement(padded);

    if (intent.furniture) slots++;
    if (intent.material) slots++;
    if (intent.color) slots++;
    if (intent.placement !== "auto") slots++;

    // Order matters. An explicit spawn verb plus a noun is checked before the
    // size words, so "add a big sofa" spawns rather than resizing; and the size
    // words are checked before the restyle verbs, so "make it bigger" scales.
    const hasSpawnVerb = this.containsAny(padded, SPAWN_VERBS);
    const hasRestyleVerb = this.containsAny(padded, RESTYLE_VERBS);

    // A size word only means "resize" when it is not just describing a piece
    // being spawned: "make the sofa bigger" resizes, "a big sofa" does not.
    const sizeIsCommand = !intent.furniture || hasRestyleVerb;

    if (this.containsAny(padded, CLEAR_PHRASES)) {
      intent.action = "clear";
      slots++;
    } else if (hasSpawnVerb && intent.furniture) {
      intent.action = "spawn";
      slots++;
    } else if (sizeIsCommand && this.containsAny(padded, SCALE_UP_WORDS)) {
      intent.action = "scale";
      intent.scaleFactor = this.parseScaleMagnitude(padded, true);
      slots++;
    } else if (sizeIsCommand && this.containsAny(padded, SCALE_DOWN_WORDS)) {
      intent.action = "scale";
      intent.scaleFactor = this.parseScaleMagnitude(padded, false);
      slots++;
    } else if (this.containsAny(padded, DELETE_VERBS)) {
      intent.action = "delete";
      slots++;
    } else if ((intent.material || intent.color) && hasRestyleVerb) {
      intent.action = "material";
      slots++;
    } else if (intent.furniture) {
      // A bare noun ("a walnut side table") is a spawn — the common shorthand.
      intent.action = "spawn";
    } else if (intent.material || intent.color) {
      // A bare finish ("velvet") restyles whatever was last touched.
      intent.action = "material";
    }

    intent.confidence = clamp(slots / 3.0, 0, 1);
    return intent;
  }

  private parsePlacement(padded: string): PlacementHint {
    // "on the wall" / "hang" mounts to a wall. "by the wall" does not — it is a
    // floor piece pushed back against one, which is a different placement.
    if (
      this.containsAny(padded, ["on the wall", "onto the wall", "hang", "mount", "wall mounted"])
    ) {
      return "wall";
    }
    if (this.containsAny(padded, ["on the table", "on the desk", "on the counter", "on top of the table"])) {
      return "table";
    }
    if (this.containsAny(padded, ["on the floor", "on the ground", "on the rug"])) {
      return "floor";
    }
    if (this.containsAny(padded, ["floating", "in the air", "mid air", "midair", "hover", "float"])) {
      return "float";
    }
    return "auto";
  }

  /** True when the user wants a floor piece pushed back against a wall. */
  private parseWallAdjacent(padded: string): boolean {
    return this.containsAny(padded, [
      "by the wall",
      "against the wall",
      "next to the wall",
      "near the wall",
      "along the wall",
      "up against the wall",
    ]);
  }

  private parseScaleMagnitude(padded: string, up: boolean): number {
    let factor = 1.3;
    if (this.containsAny(padded, ["a bit", "a little", "slightly", "a touch"])) {
      factor = 1.15;
    } else if (this.containsAny(padded, ["much", "way", "a lot", "far"])) {
      factor = 1.6;
    } else if (this.containsAny(padded, ["twice", "double", "two times"])) {
      factor = 2.0;
    } else if (this.containsAny(padded, ["half"])) {
      factor = 2.0;
      up = false;
    }
    return up ? factor : 1.0 / factor;
  }

  private containsAny(padded: string, needles: string[]): boolean {
    for (let i = 0; i < needles.length; i++) {
      if (padded.indexOf(" " + needles[i] + " ") >= 0) {
        return true;
      }
    }
    return false;
  }

  private findFirst(padded: string, needles: string[]): string {
    for (let i = 0; i < needles.length; i++) {
      if (padded.indexOf(" " + needles[i] + " ") >= 0) {
        return needles[i];
      }
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  private execute(intent: SpatialisIntent): void {
    switch (intent.action) {
      case "spawn":
        this.executeSpawn(intent);
        break;
      case "material":
        this.executeRestyle(intent);
        break;
      case "scale":
        this.executeScale(intent);
        break;
      case "delete":
        this.executeDelete(intent);
        break;
      case "clear":
        this.executeClear();
        break;
      default:
        this.showFeedback("Didn’t catch that — try “add a velvet armchair”");
        break;
    }
  }

  private executeSpawn(intent: SpatialisIntent): void {
    const spec = getFurnitureSpec(intent.furniture);
    if (!spec) {
      this.showFeedback("No “" + intent.furniture + "” in the catalog");
      return;
    }
    const prefab = this.findPrefab(intent.furniture);
    if (!prefab) {
      warn("Voice", "No prefab wired up for '" + intent.furniture + "'.");
      this.showFeedback("No model loaded for " + spec.label);
      return;
    }

    const parent = this.spawnParent ? this.spawnParent : this.getSceneObject();
    const instance = prefab.instantiate(parent);
    instance.name = "Spatialis_" + spec.key + "_" + (SpatialisRegistry.count() + 1);
    const transform = instance.getTransform();
    const baseScale = transform.getLocalScale();

    const entry = SpatialisRegistry.register({
      sceneObject: instance,
      transform: transform,
      kind: spec.key,
      spec: spec,
      placement: intent.placement,
      surface: "unknown",
      surfaceNormal: vec3.up(),
      baseScale: baseScale,
      materialKey: "",
      spawnedAtSeconds: getTime(),
      isGrabbed: false,
    });

    // Hide the pop-in: start at zero scale until we know where it belongs.
    transform.setLocalScale(baseScale.uniformScale(0.001));

    const wallAdjacent = this.parseWallAdjacent(" " + this.normalize(intent.rawTranscript) + " ");

    if (!this.anchorEngine) {
      // No anchor engine — drop it at the parent origin and still animate in.
      this.playSpawnAnimation(entry, baseScale);
      this.applyStyleFromIntent(entry, intent);
      this.showFeedback("Added a " + spec.label);
      return;
    }

    // Pass the entry so overlap resolution does not treat this piece - already
    // registered, parked at the prefab origin - as furniture to step around.
    this.anchorEngine.requestPlacement(spec, intent.placement, wallAdjacent, (result: AnchorResult) => {
      if (isNull(entry.sceneObject)) {
        return; // Deleted while the hit test was in flight.
      }
      transform.setWorldPosition(result.position);
      transform.setWorldRotation(result.rotation);
      entry.surface = result.surface;
      entry.surfaceNormal = result.normal;

      this.playSpawnAnimation(entry, baseScale);
      this.applyStyleFromIntent(entry, intent);

      const where = result.anchored ? " on the " + result.surface : " in front of you";
      this.showFeedback("Added a " + this.describe(intent, spec) + where);
    }, entry);
  }

  /**
   * Scale-in with a slight overshoot, plus a short drop so the piece appears to
   * settle onto the surface rather than blink into existence.
   */
  private playSpawnAnimation(entry: SpatialisObject, targetScale: vec3): void {
    const transform = entry.transform;
    const landed = transform.getWorldPosition();
    const liftOff = landed.add(vec3.up().uniformScale(entry.spec.height * 0.25));

    this.tweens.add(
      new Tween(this.spawnDuration, easeOutBack, (t: number) => {
        if (isNull(entry.sceneObject)) {
          return;
        }
        transform.setLocalScale(targetScale.uniformScale(clamp(t, 0.001, 2.0)));
        transform.setWorldPosition(vec3.lerp(liftOff, landed, clamp(t, 0, 1)));
      })
    );
  }

  private applyStyleFromIntent(entry: SpatialisObject, intent: SpatialisIntent): void {
    if (!this.materialSwapper) {
      return;
    }
    if (intent.material) {
      this.materialSwapper.applyMaterial(entry, intent.material);
    }
    if (intent.color) {
      this.materialSwapper.applyColor(entry, intent.color);
    }
  }

  private executeRestyle(intent: SpatialisIntent): void {
    if (!this.materialSwapper) {
      warn("Voice", "No PBR Material Swapper assigned.");
      return;
    }

    // "make the sofa velvet" targets the sofa; "make it velvet" targets the
    // last thing spawned or grabbed.
    const target = intent.furniture
      ? SpatialisRegistry.lastOfKind(intent.furniture)
      : SpatialisRegistry.last();

    if (!target) {
      this.showFeedback("Nothing to restyle yet");
      return;
    }

    let ok = false;
    if (intent.material) {
      ok = this.materialSwapper.applyMaterial(target, intent.material);
    }
    if (intent.color) {
      ok = this.materialSwapper.applyColor(target, intent.color) || ok;
    }

    if (ok) {
      const finish = intent.material
        ? PBRMaterialSwapper.getPresetLabel(intent.material)
        : intent.color;
      this.showFeedback(target.spec.label + " → " + finish);
    } else {
      this.showFeedback("Couldn’t restyle the " + target.spec.label);
    }
  }

  private executeScale(intent: SpatialisIntent): void {
    const target = intent.furniture
      ? SpatialisRegistry.lastOfKind(intent.furniture)
      : SpatialisRegistry.last();
    if (!target) {
      this.showFeedback("Nothing to resize yet");
      return;
    }

    const from = target.transform.getLocalScale();
    // Clamp against the piece's own base scale so repeated commands cannot
    // grow a lamp to the size of the room or shrink it out of existence.
    const ratio = from.x / Math.max(target.baseScale.x, 0.0001);
    const clampedFactor = clamp(ratio * intent.scaleFactor, 0.25, 4.0) / Math.max(ratio, 0.0001);
    const to = from.uniformScale(clampedFactor);

    this.tweens.add(
      new Tween(0.35, easeOutBack, (t: number) => {
        if (isNull(target.sceneObject)) {
          return;
        }
        target.transform.setLocalScale(vec3.lerp(from, to, t));
      })
    );
    this.showFeedback(
      (intent.scaleFactor > 1 ? "Enlarged " : "Shrunk ") + "the " + target.spec.label
    );
  }

  private executeDelete(intent: SpatialisIntent): void {
    const target = intent.furniture
      ? SpatialisRegistry.lastOfKind(intent.furniture)
      : SpatialisRegistry.last();
    if (!target) {
      this.showFeedback("Nothing to remove");
      return;
    }
    const label = target.spec.label;
    const id = target.id;
    const transform = target.transform;
    const from = transform.getLocalScale();

    // Scale out first, then destroy, so pieces do not vanish mid-frame.
    this.tweens.add(
      new Tween(
        0.28,
        easeOutBack,
        (t: number) => {
          if (!isNull(target.sceneObject)) {
            transform.setLocalScale(vec3.lerp(from, vec3.zero(), t));
          }
        },
        () => {
          if (this.materialSwapper) {
            this.materialSwapper.forget(id);
          }
          SpatialisRegistry.remove(id);
        }
      )
    );
    this.showFeedback("Removed the " + label);
  }

  private executeClear(): void {
    const count = SpatialisRegistry.removeAll();
    if (this.materialSwapper) {
      this.materialSwapper.forgetAll();
    }
    this.tweens.clear();
    this.showFeedback(count > 0 ? "Cleared " + count + " pieces" : "Room is already empty");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private findPrefab(key: string): ObjectPrefab | null {
    const limit = Math.min(this.furnitureKeys.length, this.furniturePrefabs.length);
    for (let i = 0; i < limit; i++) {
      if (this.furnitureKeys[i] === key && this.furniturePrefabs[i]) {
        return this.furniturePrefabs[i];
      }
    }
    return null;
  }

  private describe(intent: SpatialisIntent, spec: FurnitureSpec): string {
    let out = "";
    if (intent.style) {
      out += intent.style + " ";
    }
    if (intent.material) {
      out += PBRMaterialSwapper.getPresetLabel(intent.material) + " ";
    } else if (intent.color) {
      out += intent.color + " ";
    }
    return out + spec.label;
  }

  private showFeedback(message: string): void {
    if (this.feedbackText && !isNull(this.feedbackText)) {
      this.feedbackText.text = message;
    }
  }

  isActive(): boolean {
    return this.isListening;
  }
}
