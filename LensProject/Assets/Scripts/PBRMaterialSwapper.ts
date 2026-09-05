/**
 * PBRMaterialSwapper.ts
 * -----------------------------------------------------------------------------
 * Subsystem 4 of 4 — dynamic material restyling.
 *
 * Holds a catalog of physically-plausible presets (oak, walnut, leather,
 * velvet, marble, brushed brass, chrome, glass...) and blends a spatial object
 * from its current look into a new one over a short cross-fade.
 *
 * Two details matter for correctness on device:
 *  1. Materials in Lens Studio are shared assets. Writing to `mainMaterial`
 *     directly would restyle every sofa in the room at once, so each object
 *     gets a one-time private clone the first time it is restyled.
 *  2. Not every prefab uses the standard PBR shader. Every parameter write is
 *     guarded, so a custom-shader prop degrades to "colour only" instead of
 *     throwing mid-frame.
 *
 * Target: Lens Studio 5.22+ / Spectacles (SPECS) Project Mode.
 * Copyright 2026 Ifeanyichukwu Onwo
 * License: Apache-2.0
 */

import {
  SpatialisObject,
  SpatialisRegistry,
  Tween,
  TweenPool,
  clamp,
  easeOutCubic,
  log,
  warn,
} from "./SpatialisCore";

/** A physically-plausible surface finish. */
export interface MaterialPreset {
  key: string;
  label: string;
  /** Linear-space albedo. Alpha below 1 marks a transparent finish. */
  baseColor: vec4;
  /** 0 = dielectric, 1 = raw metal. */
  metallic: number;
  /** 0 = mirror, 1 = fully diffuse. */
  roughness: number;
  aliases: string[];
}

/** A named tint that recolours a finish without changing its physics. */
interface ColorPreset {
  key: string;
  rgb: vec3;
  aliases: string[];
}

const MATERIAL_PRESETS: MaterialPreset[] = [
  // --- Woods --------------------------------------------------------------
  {
    key: "oak",
    label: "white oak",
    baseColor: new vec4(0.72, 0.58, 0.39, 1.0),
    metallic: 0.0,
    roughness: 0.62,
    aliases: ["oak", "white oak", "light wood", "birch", "ash", "pine", "wood"],
  },
  {
    key: "walnut",
    label: "walnut",
    baseColor: new vec4(0.28, 0.18, 0.11, 1.0),
    metallic: 0.0,
    roughness: 0.48,
    aliases: ["walnut", "dark wood", "mahogany", "teak", "espresso"],
  },
  // --- Fabrics ------------------------------------------------------------
  {
    key: "velvet",
    label: "velvet",
    baseColor: new vec4(0.24, 0.11, 0.30, 1.0),
    metallic: 0.0,
    // Velvet is matte but its sheen reads best a touch below fully diffuse.
    roughness: 0.86,
    aliases: ["velvet", "plush", "mohair"],
  },
  {
    key: "linen",
    label: "linen",
    baseColor: new vec4(0.86, 0.83, 0.76, 1.0),
    metallic: 0.0,
    roughness: 0.94,
    aliases: ["linen", "cotton", "canvas", "fabric", "cloth", "boucle", "wool"],
  },
  {
    key: "leather",
    label: "tan leather",
    baseColor: new vec4(0.45, 0.27, 0.16, 1.0),
    metallic: 0.0,
    roughness: 0.55,
    aliases: ["leather", "hide", "suede"],
  },
  // --- Stone --------------------------------------------------------------
  {
    key: "marble",
    label: "carrara marble",
    baseColor: new vec4(0.90, 0.90, 0.88, 1.0),
    metallic: 0.0,
    roughness: 0.18,
    aliases: ["marble", "stone", "granite", "carrara", "travertine"],
  },
  {
    key: "concrete",
    label: "concrete",
    baseColor: new vec4(0.55, 0.55, 0.53, 1.0),
    metallic: 0.0,
    roughness: 0.88,
    aliases: ["concrete", "cement", "plaster", "terrazzo"],
  },
  // --- Metals -------------------------------------------------------------
  {
    key: "brass",
    label: "brushed brass",
    baseColor: new vec4(0.76, 0.60, 0.28, 1.0),
    metallic: 1.0,
    roughness: 0.32,
    aliases: ["brass", "gold", "bronze", "copper"],
  },
  {
    key: "chrome",
    label: "polished chrome",
    baseColor: new vec4(0.86, 0.87, 0.89, 1.0),
    metallic: 1.0,
    roughness: 0.06,
    aliases: ["chrome", "steel", "silver", "metal", "metallic", "aluminium", "aluminum"],
  },
  {
    key: "matteBlack",
    label: "matte black",
    baseColor: new vec4(0.06, 0.06, 0.07, 1.0),
    metallic: 0.3,
    roughness: 0.78,
    aliases: ["matte black", "black metal", "charcoal", "graphite", "noir"],
  },
  // --- Glass --------------------------------------------------------------
  {
    key: "glass",
    label: "smoked glass",
    baseColor: new vec4(0.62, 0.68, 0.70, 0.35),
    metallic: 0.0,
    roughness: 0.05,
    aliases: ["glass", "smoked glass", "acrylic", "perspex", "transparent"],
  },
];

const COLOR_PRESETS: ColorPreset[] = [
  { key: "white", rgb: new vec3(0.93, 0.93, 0.91), aliases: ["white", "ivory", "cream", "off white"] },
  { key: "black", rgb: new vec3(0.06, 0.06, 0.07), aliases: ["black", "jet"] },
  { key: "grey", rgb: new vec3(0.48, 0.49, 0.50), aliases: ["grey", "gray", "slate", "ash grey"] },
  { key: "sage", rgb: new vec3(0.55, 0.62, 0.49), aliases: ["sage", "olive", "moss"] },
  { key: "forest", rgb: new vec3(0.13, 0.31, 0.21), aliases: ["forest", "emerald", "dark green", "green"] },
  { key: "navy", rgb: new vec3(0.11, 0.17, 0.34), aliases: ["navy", "midnight", "indigo", "blue"] },
  { key: "rust", rgb: new vec3(0.62, 0.28, 0.15), aliases: ["rust", "terracotta", "burnt orange", "orange"] },
  { key: "blush", rgb: new vec3(0.87, 0.71, 0.68), aliases: ["blush", "pink", "rose", "dusty pink"] },
  { key: "mustard", rgb: new vec3(0.79, 0.61, 0.19), aliases: ["mustard", "ochre", "yellow", "amber"] },
  { key: "burgundy", rgb: new vec3(0.36, 0.10, 0.15), aliases: ["burgundy", "wine", "maroon", "red"] },
];

/** Per-object bookkeeping so we clone a material exactly once. */
interface StyledObject {
  objectId: number;
  visuals: RenderMeshVisual[];
  materials: Material[];
  /** Values currently on screen, so a new swap blends from where we are. */
  currentColor: vec4;
  currentMetallic: number;
  currentRoughness: number;
}

@component
export class PBRMaterialSwapper extends BaseScriptComponent {
  @input
  @hint("Seconds to cross-fade between two finishes.")
  @widget(new SliderWidget(0.0, 2.0, 0.05))
  blendDuration: number = 0.45;

  @input
  @hint("Optional albedo textures, parallel to Texture Preset Keys below.")
  @allowUndefined
  presetTextures: Texture[] = [];

  @input
  @hint("Preset keys matching Preset Textures, e.g. oak, walnut, marble.")
  @allowUndefined
  presetTextureKeys: string[] = [];

  private styled: StyledObject[] = [];
  private tweens: TweenPool = new TweenPool();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onAwake(): void {
    this.createEvent("UpdateEvent").bind(() => {
      this.tweens.update(getDeltaTime());
    });
    log("Material", MATERIAL_PRESETS.length + " finishes, " + COLOR_PRESETS.length + " tints loaded.");
  }

  // ---------------------------------------------------------------------------
  // Vocabulary lookup — called by VoiceCommandController while parsing
  // ---------------------------------------------------------------------------

  /** Resolve a spoken phrase to a material key, longest alias wins. */
  static resolveMaterial(phrase: string): string {
    const text = " " + phrase.toLowerCase() + " ";
    let bestKey = "";
    let bestLen = 0;
    for (let i = 0; i < MATERIAL_PRESETS.length; i++) {
      const preset = MATERIAL_PRESETS[i];
      for (let a = 0; a < preset.aliases.length; a++) {
        const alias = preset.aliases[a];
        if (alias.length > bestLen && text.indexOf(" " + alias + " ") >= 0) {
          bestKey = preset.key;
          bestLen = alias.length;
        }
      }
    }
    return bestKey;
  }

  /** Resolve a spoken phrase to a colour key, longest alias wins. */
  static resolveColor(phrase: string): string {
    const text = " " + phrase.toLowerCase() + " ";
    let bestKey = "";
    let bestLen = 0;
    for (let i = 0; i < COLOR_PRESETS.length; i++) {
      const preset = COLOR_PRESETS[i];
      for (let a = 0; a < preset.aliases.length; a++) {
        const alias = preset.aliases[a];
        if (alias.length > bestLen && text.indexOf(" " + alias + " ") >= 0) {
          bestKey = preset.key;
          bestLen = alias.length;
        }
      }
    }
    return bestKey;
  }

  static getPreset(key: string): MaterialPreset | null {
    for (let i = 0; i < MATERIAL_PRESETS.length; i++) {
      if (MATERIAL_PRESETS[i].key === key) {
        return MATERIAL_PRESETS[i];
      }
    }
    return null;
  }

  static getPresetLabel(key: string): string {
    const preset = PBRMaterialSwapper.getPreset(key);
    return preset ? preset.label : key;
  }

  // ---------------------------------------------------------------------------
  // Applying a finish
  // ---------------------------------------------------------------------------

  /**
   * Cross-fade `obj` into the named finish. Returns false when the key is not
   * in the catalog so the caller can tell the user rather than fail silently.
   */
  applyMaterial(obj: SpatialisObject, materialKey: string): boolean {
    const preset = PBRMaterialSwapper.getPreset(materialKey);
    if (!preset) {
      warn("Material", "Unknown finish '" + materialKey + "'.");
      return false;
    }

    const styled = this.ensureStyled(obj);
    if (!styled || styled.materials.length === 0) {
      warn("Material", "No renderable meshes on " + obj.spec.label + "; nothing to restyle.");
      return false;
    }

    this.applyTexture(styled, materialKey);
    this.blendTo(styled, preset.baseColor, preset.metallic, preset.roughness);

    obj.materialKey = materialKey;
    log("Material", obj.spec.label + " → " + preset.label + ".");
    return true;
  }

  /**
   * Recolour without changing the physical finish, so "make the sofa navy"
   * keeps its velvet roughness and just shifts hue.
   */
  applyColor(obj: SpatialisObject, colorKey: string): boolean {
    let preset: ColorPreset | null = null;
    for (let i = 0; i < COLOR_PRESETS.length; i++) {
      if (COLOR_PRESETS[i].key === colorKey) {
        preset = COLOR_PRESETS[i];
        break;
      }
    }
    if (!preset) {
      warn("Material", "Unknown colour '" + colorKey + "'.");
      return false;
    }

    const styled = this.ensureStyled(obj);
    if (!styled || styled.materials.length === 0) {
      return false;
    }

    const target = new vec4(preset.rgb.x, preset.rgb.y, preset.rgb.z, styled.currentColor.w);
    this.blendTo(styled, target, styled.currentMetallic, styled.currentRoughness);
    log("Material", obj.spec.label + " tinted " + preset.key + ".");
    return true;
  }

  /** Apply a finish to every object of a kind — "make all the chairs oak". */
  applyMaterialToKind(kind: string, materialKey: string): number {
    const all = SpatialisRegistry.all();
    let applied = 0;
    for (let i = 0; i < all.length; i++) {
      if (all[i].kind === kind && this.applyMaterial(all[i], materialKey)) {
        applied++;
      }
    }
    return applied;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Give an object its own material instances the first time it is restyled.
   * Without this, every prefab spawned from the same asset shares one Material
   * and a single voice command would repaint the whole room.
   */
  private ensureStyled(obj: SpatialisObject): StyledObject | null {
    for (let i = 0; i < this.styled.length; i++) {
      if (this.styled[i].objectId === obj.id) {
        return this.styled[i];
      }
    }

    if (isNull(obj.sceneObject)) {
      return null;
    }

    const visuals = this.collectVisuals(obj.sceneObject);
    const materials: Material[] = [];
    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i];
      const source = visual.mainMaterial;
      if (!source) {
        continue;
      }
      const clone = source.clone();
      visual.mainMaterial = clone;
      materials.push(clone);
    }

    const seedColor = materials.length > 0 ? this.readColor(materials[0]) : new vec4(1, 1, 1, 1);
    const entry: StyledObject = {
      objectId: obj.id,
      visuals: visuals,
      materials: materials,
      currentColor: seedColor,
      currentMetallic: materials.length > 0 ? this.readNumber(materials[0], "metallic", 0.0) : 0.0,
      currentRoughness: materials.length > 0 ? this.readNumber(materials[0], "roughness", 0.6) : 0.6,
    };
    this.styled.push(entry);
    return entry;
  }

  /** Depth-first walk for every RenderMeshVisual under a spawned prefab. */
  private collectVisuals(root: SceneObject): RenderMeshVisual[] {
    const found: RenderMeshVisual[] = [];
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as SceneObject;
      const visuals = node.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[];
      for (let i = 0; i < visuals.length; i++) {
        found.push(visuals[i]);
      }
      const childCount = node.getChildrenCount();
      for (let c = 0; c < childCount; c++) {
        stack.push(node.getChild(c));
      }
    }
    return found;
  }

  private blendTo(styled: StyledObject, color: vec4, metallic: number, roughness: number): void {
    const fromColor = styled.currentColor;
    const fromMetallic = styled.currentMetallic;
    const fromRoughness = styled.currentRoughness;

    if (this.blendDuration <= 0) {
      this.writeAll(styled, color, metallic, roughness);
      return;
    }

    this.tweens.add(
      new Tween(this.blendDuration, easeOutCubic, (t: number) => {
        const c = new vec4(
          fromColor.x + (color.x - fromColor.x) * t,
          fromColor.y + (color.y - fromColor.y) * t,
          fromColor.z + (color.z - fromColor.z) * t,
          fromColor.w + (color.w - fromColor.w) * t
        );
        const m = fromMetallic + (metallic - fromMetallic) * t;
        const r = fromRoughness + (roughness - fromRoughness) * t;
        this.writeAll(styled, c, m, r);
      })
    );
  }

  private writeAll(styled: StyledObject, color: vec4, metallic: number, roughness: number): void {
    for (let i = 0; i < styled.materials.length; i++) {
      const pass = styled.materials[i].mainPass as any;
      if (!pass) {
        continue;
      }
      // Custom shaders may expose none of these; each write is independent.
      this.trySet(pass, "baseColor", color);
      this.trySet(pass, "metallic", clamp(metallic, 0, 1));
      this.trySet(pass, "roughness", clamp(roughness, 0, 1));
    }
    styled.currentColor = color;
    styled.currentMetallic = metallic;
    styled.currentRoughness = roughness;
  }

  /** Swap in an artist-supplied albedo texture when one is wired up for a key. */
  private applyTexture(styled: StyledObject, materialKey: string): void {
    if (!this.presetTextureKeys || !this.presetTextures) {
      return;
    }
    let texture: Texture | null = null;
    for (let i = 0; i < this.presetTextureKeys.length; i++) {
      if (this.presetTextureKeys[i] === materialKey && i < this.presetTextures.length) {
        texture = this.presetTextures[i];
        break;
      }
    }
    if (!texture) {
      return;
    }
    for (let i = 0; i < styled.materials.length; i++) {
      const pass = styled.materials[i].mainPass as any;
      if (pass) {
        this.trySet(pass, "baseTex", texture);
      }
    }
  }

  private trySet(pass: any, property: string, value: any): void {
    try {
      if (pass[property] !== undefined) {
        pass[property] = value;
      }
    } catch (e) {
      // Shader does not expose this uniform — skip it silently.
    }
  }

  private readColor(material: Material): vec4 {
    try {
      const pass = material.mainPass as any;
      if (pass && pass.baseColor) {
        return pass.baseColor as vec4;
      }
    } catch (e) {
      // fall through
    }
    return new vec4(1, 1, 1, 1);
  }

  private readNumber(material: Material, property: string, fallback: number): number {
    try {
      const pass = material.mainPass as any;
      if (pass && typeof pass[property] === "number") {
        return pass[property] as number;
      }
    } catch (e) {
      // fall through
    }
    return fallback;
  }

  /** Drop cached clones for objects that have been destroyed. */
  forget(objectId: number): void {
    const kept: StyledObject[] = [];
    for (let i = 0; i < this.styled.length; i++) {
      if (this.styled[i].objectId !== objectId) {
        kept.push(this.styled[i]);
      }
    }
    this.styled = kept;
  }

  forgetAll(): void {
    this.styled = [];
    this.tweens.clear();
  }
}
