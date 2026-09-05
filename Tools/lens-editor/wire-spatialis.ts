/**
 * Tools/lens-editor/wire-spatialis.ts
 * -----------------------------------------------------------------------------
 * EDITOR API script - runs inside Lens Studio, not inside the Lens.
 *
 * Builds the Spatialis scene the way a person would in the Inspector, but in
 * one pass and idempotently: run it twice and it finds what it made the first
 * time. Every step logs what it did, and the last step reads each component's
 * declared inputNames back and reports any that are still unset, so a wiring
 * mistake is visible in the output rather than discovered as a silent no-op
 * on device.
 *
 * How to run: from a Claude Code session opened inside LensProject/ (so the
 * project's .mcp.json loads Lens Studio's MCP server), hand this file's
 * contents to the `ExecuteEditorCode` tool, per Snap's AGENTS.md. Do not call
 * the editor over raw HTTP.
 *
 * What it creates under the scene root:
 *   Spatialis/
 *     Anchor Engine     SurfaceAnchorEngine     camera=mainCamera, worldQueryAsset
 *     Material Swapper  PBRMaterialSwapper
 *     Gesture           SpatialGestureController anchorEngine
 *     Voice             VoiceCommandController   asrModule, anchorEngine,
 *                                                materialSwapper, spawnParent,
 *                                                furnitureKeys, furniturePrefabs,
 *                                                feedbackText
 *     Spawn Root        (parent for spawned furniture)
 *     Feedback          Text component the controller writes into
 *   Assets/Modules/     ASR Module, World Query Module (native assets)
 *
 * License: Apache-2.0
 */

(() => {
  // ExecuteEditorCode wraps this file in a function body and injects
  // `pluginSystem` as a parameter of that function. A bare reference to an
  // undeclared name fails the tool's TypeScript compile and `declare` is not
  // legal inside a function body, so reach it through a direct eval, which
  // sees the enclosing scope and which TypeScript does not type-check.
  const pluginSys: any =
    (globalThis as any).pluginSystem ??
    // eslint-disable-next-line no-eval
    eval("typeof pluginSystem !== 'undefined' ? pluginSystem : undefined");
  if (!pluginSys) throw new Error("wire-spatialis: no pluginSystem in this context");
  const model = pluginSys.findInterface(Editor.Model.IModel) as Editor.Model.IModel;
  const log = (m: string) => console.log("[wire-spatialis] " + m);
  const warn = (m: string) => console.warn("[wire-spatialis] WARNING " + m);

  const project = model.project;
  const scene = project.scene;
  const am = project.assetManager;

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  const CATALOG_KEYS = [
    "sofa", "chair", "table", "coffeeTable", "lamp", "tableLamp",
    "shelf", "plant", "rug", "artwork", "vase", "bed",
  ];

  const scriptAsset = (name: string): Editor.Assets.ScriptAsset | null => {
    const hit = am.assets.find((a) => a.isOfType("TypeScriptAsset") && a.name === name);
    if (!hit) warn(`script asset '${name}' not found - was Assets/Scripts/${name}.ts imported?`);
    return (hit as Editor.Assets.ScriptAsset) || null;
  };

  /** The prefab produced by importing Assets/Prefabs/<key>.glb. */
  const prefabFor = (key: string): Editor.Assets.ObjectPrefab | null => {
    const candidates = am.assets.filter((a) => {
      try {
        const tree = a.fileMeta && a.fileMeta.assetTreePath ? a.fileMeta.assetTreePath.toString() : "";
        return tree.indexOf("Prefabs/" + key + ".glb") >= 0 && a.isOfType("ObjectPrefab");
      } catch (e) { return false; }
    });
    if (!candidates.length) warn(`no ObjectPrefab for '${key}' - the .glb import yields a Scene asset; see fallback below`);
    return (candidates[0] as Editor.Assets.ObjectPrefab) || null;
  };

  const rootByName = (name: string): Editor.Model.SceneObject | null =>
    scene.rootSceneObjects.find((o) => o.name === name) || null;

  const childByName = (parent: Editor.Model.SceneObject, name: string): Editor.Model.SceneObject | null =>
    parent.children.find((o) => o.name === name) || null;

  const ensureRoot = (name: string): Editor.Model.SceneObject => {
    const found = rootByName(name);
    if (found) return found;
    const o = scene.createSceneObject(name);
    log(`created root object '${name}'`);
    return o;
  };

  const ensureChild = (parent: Editor.Model.SceneObject, name: string): Editor.Model.SceneObject => {
    const found = childByName(parent, name);
    if (found) return found;
    const o = scene.addSceneObject(parent);
    o.name = name;
    log(`created '${parent.name}/${name}'`);
    return o;
  };

  const ensureScript = (obj: Editor.Model.SceneObject, asset: Editor.Assets.ScriptAsset | null): Editor.Components.ScriptComponent | null => {
    if (!asset) return null;
    // Read `components` ONCE. The editor hands out fresh proxy objects on every
    // access, so matches computed from one read never compare equal to entries
    // of another - identity only holds within a single array. Match by asset
    // name, keep the first, remove the rest by index from the end.
    const comps = obj.components;
    const matchIdx: number[] = [];
    comps.forEach((c, i) => {
      if (c.isOfType("ScriptComponent")) {
        const sc = c as Editor.Components.ScriptComponent;
        if (sc.scriptAsset && sc.scriptAsset.name === asset.name) matchIdx.push(i);
      }
    });
    for (const i of matchIdx.slice(1).sort((a, b) => b - a)) {
      try { obj.removeComponentAt(i); log(`removed duplicate ${asset.name} on '${obj.name}' (component #${i})`); }
      catch (e) { warn(`could not remove duplicate ${asset.name} on '${obj.name}': ${e}`); }
    }
    if (matchIdx.length) return comps[matchIdx[0]] as Editor.Components.ScriptComponent;
    const comp = obj.addComponent("ScriptComponent");
    comp.scriptAsset = asset;
    log(`attached ${asset.name} to '${obj.name}'`);
    return comp;
  };

  const ensureModule = (typeName: string, baseName: string): Editor.Assets.Asset => {
    const found = am.assets.find((a) => a.isOfType(typeName));
    if (found) return found;
    const dir = new Editor.Model.SourcePath(new Editor.Path("Modules"), Editor.Model.SourceRootDirectory.Assets);
    const created = am.createNativeAsset(typeName, baseName, dir);
    log(`created ${typeName} asset '${baseName}' in Assets/Modules`);
    return created;
  };

  /** Assign one script input, tolerating the two ways the editor exposes them. */
  const setInput = (comp: Editor.Components.ScriptComponent | null, name: string, value: any) => {
    if (!comp) return;
    const names = comp.inputNames || [];
    if (!names.length) {
      // No compiled input metadata: the script asset has not compiled cleanly
      // yet, and a property write would land on nothing. Say so instead.
      warn(`${comp.scriptAsset ? comp.scriptAsset.name : "?"} exposes no inputs - the TypeScript has not compiled; run RecompileTypeScript, fix any errors, re-run`);
      return;
    }
    if (names.indexOf(name) < 0) {
      warn(`${comp.scriptAsset.name} has no input named '${name}' (has: ${names.join(", ")})`);
      return;
    }
    try {
      (comp as any)[name] = value;
    } catch (e) {
      warn(`could not set ${name} on ${comp.scriptAsset.name}: ${e}`);
    }
  };

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  const root = ensureRoot("Spatialis");
  const anchorObj = ensureChild(root, "Anchor Engine");
  const materialObj = ensureChild(root, "Material Swapper");
  const gestureObj = ensureChild(root, "Gesture");
  const voiceObj = ensureChild(root, "Voice");
  const spawnRoot = ensureChild(root, "Spawn Root");
  const feedbackObj = ensureChild(root, "Feedback");

  const worldQuery = ensureModule("WorldQueryModule", "World Query Module");
  const asr = ensureModule("AsrModule", "ASR Module");

  let feedbackText = feedbackObj.components.find((c) => c.isOfType("Text")) as Editor.Components.Text | undefined;
  if (!feedbackText) {
    feedbackText = feedbackObj.addComponent("Text");
    (feedbackText as any).text = "Spatialis ready";
    log("added Text to 'Feedback'");
  }

  const anchor = ensureScript(anchorObj, scriptAsset("SurfaceAnchorEngine"));
  const material = ensureScript(materialObj, scriptAsset("PBRMaterialSwapper"));
  const gesture = ensureScript(gestureObj, scriptAsset("SpatialGestureController"));
  const voice = ensureScript(voiceObj, scriptAsset("VoiceCommandController"));

  // Inputs. Names must match the @input fields exactly.
  setInput(anchor, "camera", scene.mainCamera);
  setInput(anchor, "worldQueryAsset", worldQuery);

  setInput(gesture, "anchorEngine", anchor);
  setInput(gesture, "materialSwapper", material);

  const prefabs = CATALOG_KEYS.map(prefabFor);
  const wiredKeys = CATALOG_KEYS.filter((_, i) => prefabs[i]);
  setInput(voice, "asrModule", asr);
  setInput(voice, "anchorEngine", anchor);
  setInput(voice, "materialSwapper", material);
  setInput(voice, "spawnParent", spawnRoot);
  setInput(voice, "feedbackText", feedbackText);
  setInput(voice, "furnitureKeys", wiredKeys);
  setInput(voice, "furniturePrefabs", prefabs.filter(Boolean));
  log(`prefabs wired: ${wiredKeys.length}/${CATALOG_KEYS.length} (${wiredKeys.join(", ")})`);

  // ---------------------------------------------------------------------------
  // Verify by reading back
  // ---------------------------------------------------------------------------

  const report = (label: string, comp: Editor.Components.ScriptComponent | null) => {
    if (!comp) { warn(`${label}: component missing`); return; }
    const names = comp.inputNames || [];
    const unset = names.filter((n) => {
      const v = (comp as any)[n];
      return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
    });
    log(`${label}: ${names.length} inputs declared${unset.length ? ", UNSET: " + unset.join(", ") : ", all set"}`);
  };
  report("SurfaceAnchorEngine", anchor);
  report("PBRMaterialSwapper", material);
  report("SpatialGestureController", gesture);
  report("VoiceCommandController", voice);

  if (wiredKeys.length < CATALOG_KEYS.length) {
    log("FALLBACK for missing prefabs: instantiate each .glb Scene asset once, then");
    log("  am.saveAsPrefab(instance, new Editor.Model.SourcePath(new Editor.Path('Prefabs'), Editor.Model.SourceRootDirectory.Assets), key)");
    log("  and re-run this script; it will pick the saved ObjectPrefabs up.");
  }

  project.save();
  log("project saved");
})();
