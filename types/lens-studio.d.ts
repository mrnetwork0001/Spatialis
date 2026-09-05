/**
 * lens-studio.d.ts
 * -----------------------------------------------------------------------------
 * Local ambient declarations for the subset of the Lens Studio 5.22+ scripting
 * API that Spatialis uses.
 *
 * Lens Studio ships its own types and injects them at build time inside the
 * editor; this file exists purely so `npm run typecheck` can verify Spatialis
 * logic in CI, on a machine with no Lens Studio install. It is NOT a complete
 * or authoritative API surface — extend it as the project uses more of the API.
 *
 * License: Apache-2.0
 */

// -----------------------------------------------------------------------------
// Math
// -----------------------------------------------------------------------------

declare class vec2 {
  constructor(x: number, y: number);
  x: number;
  y: number;
}

declare class vec3 {
  constructor(x: number, y: number, z: number);
  x: number;
  y: number;
  z: number;
  readonly length: number;
  readonly lengthSquared: number;

  add(other: vec3): vec3;
  sub(other: vec3): vec3;
  mult(other: vec3): vec3;
  uniformScale(scalar: number): vec3;
  normalize(): vec3;
  dot(other: vec3): number;
  cross(other: vec3): vec3;
  distance(other: vec3): number;
  equal(other: vec3): boolean;

  static zero(): vec3;
  static one(): vec3;
  static up(): vec3;
  static down(): vec3;
  static left(): vec3;
  static right(): vec3;
  static forward(): vec3;
  static back(): vec3;
  static lerp(a: vec3, b: vec3, t: number): vec3;
}

declare class vec4 {
  constructor(x: number, y: number, z: number, w: number);
  x: number;
  y: number;
  z: number;
  w: number;
}

declare class quat {
  x: number;
  y: number;
  z: number;
  w: number;

  multiply(other: quat): quat;
  multiplyVec3(v: vec3): vec3;
  invert(): quat;
  normalize(): quat;

  static quatIdentity(): quat;
  static angleAxis(radians: number, axis: vec3): quat;
  static lookAt(forward: vec3, up: vec3): quat;
  static slerp(a: quat, b: quat, t: number): quat;
  static fromEulerAngles(x: number, y: number, z: number): quat;
}

declare class mat4 {}

// -----------------------------------------------------------------------------
// Scene graph
// -----------------------------------------------------------------------------

declare class Transform {
  getWorldPosition(): vec3;
  setWorldPosition(position: vec3): void;
  getLocalPosition(): vec3;
  setLocalPosition(position: vec3): void;
  getWorldRotation(): quat;
  setWorldRotation(rotation: quat): void;
  getLocalRotation(): quat;
  setLocalRotation(rotation: quat): void;
  getWorldScale(): vec3;
  setWorldScale(scale: vec3): void;
  getLocalScale(): vec3;
  setLocalScale(scale: vec3): void;

  readonly forward: vec3;
  readonly back: vec3;
  readonly up: vec3;
  readonly down: vec3;
  readonly right: vec3;
  readonly left: vec3;
}

declare class SceneObject {
  name: string;
  enabled: boolean;

  getTransform(): Transform;
  getParent(): SceneObject;
  getChild(index: number): SceneObject;
  getChildrenCount(): number;
  destroy(): void;

  getComponent(typeName: string): Component;
  getComponents(typeName: string): Component[];
  createComponent(typeName: string): Component;
}

declare class Component {
  enabled: boolean;
  getSceneObject(): SceneObject;
  getTransform(): Transform;
  destroy(): void;
}

declare class Camera extends Component {}

// -----------------------------------------------------------------------------
// Assets and rendering
// -----------------------------------------------------------------------------

declare class Asset {
  name: string;
}

declare class Texture extends Asset {}

/** Shader uniform block. Indexed access is how custom uniforms are reached. */
declare class Pass {
  baseColor: vec4;
  baseTex: Texture;
  normalTex: Texture;
  metallic: number;
  roughness: number;
  [uniform: string]: any;
}

declare class Material extends Asset {
  mainPass: Pass;
  clone(): Material;
}

declare class RenderMeshVisual extends Component {
  mainMaterial: Material;
  materials: Material[];
}

declare class Text extends Component {
  text: string;
}

declare class ObjectPrefab extends Asset {
  instantiate(parent: SceneObject | null): SceneObject;
}

// -----------------------------------------------------------------------------
// Events and script components
// -----------------------------------------------------------------------------

declare class SceneEvent {
  bind(callback: (args?: any) => void): void;
  enabled: boolean;
}

declare class BaseScriptComponent extends Component {
  createEvent(eventType: string): SceneEvent;
  onAwake?(): void;
}

/** Lens Studio's event emitters expose add/remove rather than DOM listeners. */
declare interface LensEvent<T> {
  add(callback: (args: T) => void): void;
  remove(callback: (args: T) => void): void;
}

// -----------------------------------------------------------------------------
// World Query (surface hit testing)
// -----------------------------------------------------------------------------

declare class HitTestSessionOptions {
  /** Reject low-confidence depth samples. */
  filter: boolean;
  static create(): HitTestSessionOptions;
}

declare interface WorldQueryHitTestResult {
  position: vec3;
  normal: vec3;
}

declare class HitTestSession {
  start(): void;
  stop(): void;
  hitTest(
    rayStart: vec3,
    rayEnd: vec3,
    callback: (result: WorldQueryHitTestResult | null) => void
  ): void;
}

declare class WorldQueryModule extends Asset {
  createHitTestSessionWithOptions(options: HitTestSessionOptions): HitTestSession;
}

// -----------------------------------------------------------------------------
// VoiceML
// -----------------------------------------------------------------------------



// -----------------------------------------------------------------------------
// Inspector decorators
// -----------------------------------------------------------------------------

declare const component: ClassDecorator;
declare const input: PropertyDecorator;
declare const allowUndefined: PropertyDecorator;
declare const showIf: (property: string, value?: any) => PropertyDecorator;
declare const hint: (text: string) => PropertyDecorator;
declare const label: (text: string) => PropertyDecorator;
declare const widget: (w: any) => PropertyDecorator;
declare const typeName: (name: string) => ClassDecorator;

declare class SliderWidget {
  constructor(min: number, max: number, step: number);
}
declare class ComboBoxWidget {
  constructor(...items: any[]);
}

// -----------------------------------------------------------------------------
// Globals
// -----------------------------------------------------------------------------

declare interface Scene {
  getRootObject(index: number): SceneObject;
  getRootObjectsCount(): number;
  createSceneObject(name: string): SceneObject;
}

declare const global: {
  scene: Scene;
  [key: string]: any;
};

/** Lens Studio's console output. */
declare function print(message: string): void;
/** Seconds since the Lens started. */
declare function getTime(): number;
/** Seconds since the previous frame. */
declare function getDeltaTime(): number;
/** True when a SceneObject/Component has been destroyed or was never set. */
declare function isNull(value: any): boolean;
/** Lens Studio module loader, e.g. require("LensStudio:WorldQueryModule"). */
declare function require(moduleName: string): any;

// -----------------------------------------------------------------------------
// Spectacles Interaction Kit
// -----------------------------------------------------------------------------

declare module "SpectaclesInteractionKit.lspkg/SIK" {
  interface TrackedJoint {
    position: vec3;
    rotation: quat;
  }

  interface TrackedHand {
    thumbTip: TrackedJoint;
    indexTip: TrackedJoint;
    middleTip: TrackedJoint;
    wrist: TrackedJoint;
    isTracked(): boolean;
    [joint: string]: any;
  }

  interface HandInputDataProvider {
    getHand(side: "left" | "right"): TrackedHand;
  }

  export const SIK: {
    HandInputData: HandInputDataProvider;
    [key: string]: any;
  };
}

/** Speech-to-text (Lens Scripting 309+). Replaces the deprecated VoiceML listening API. */
declare class AsrModule extends Asset {
  startTranscribing(options: AsrModule.AsrTranscriptionOptions): void;
  stopTranscribing(streamType?: number | null): Promise<void>;
}
declare namespace AsrModule {
  enum AsrMode { HighAccuracy, Balanced, HighSpeed }
  enum AsrStatusCode { Success, InternalError, Unauthenticated, NoInternet }
  class TranscriptionUpdateEvent {
    text: string;
    isFinal: boolean;
  }
  class AsrTranscriptionOptions {
    static create(): AsrTranscriptionOptions;
    mode: AsrMode;
    silenceUntilTerminationMs: number;
    readonly onTranscriptionUpdateEvent: EventRegistration<TranscriptionUpdateEvent>;
    readonly onTranscriptionErrorEvent: EventRegistration<AsrStatusCode>;
  }
}
