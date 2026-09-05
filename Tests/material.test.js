/**
 * material.test.js — PBRMaterialSwapper: private clones, guarded writes, fades.
 *
 * Materials in Lens Studio are shared assets: every sofa spawned from one
 * prefab points at the same Material. The swapper's central promise is that
 * "make the sofa velvet" restyles THAT sofa and nothing else, which it keeps
 * by giving each object a private clone exactly once. These tests count the
 * clones and read the numbers actually written to the material pass, so a
 * regression that quietly repaints the whole room cannot hide behind "it
 * didn't throw".
 *
 * License: Apache-2.0
 */

const path = require("path");
const { suite, test, eq, ok, near } = require("./harness");
const B = path.join(__dirname, "..", ".build", "Scripts");
const { PBRMaterialSwapper } = require(path.join(B, "PBRMaterialSwapper.js"));
const { SpatialisRegistry, getFurnitureSpec, easeOutCubic } = require(path.join(B, "SpatialisCore.js"));

// -----------------------------------------------------------------------------
// Fakes — shaped exactly like what PBRMaterialSwapper touches.
// -----------------------------------------------------------------------------

/**
 * A Material with a mainPass. `props` lists which uniforms the shader exposes;
 * a "custom shader" fake simply omits metallic/roughness/baseTex, which is how
 * the real pass behaves (reading an unknown uniform yields undefined).
 */
function makeMaterial(props = {}) {
  const pass = {};
  for (const k of ["baseColor", "metallic", "roughness", "baseTex", "baseColorFactor", "metallicFactor", "roughnessFactor"]) {
    if (props[k] !== undefined) pass[k] = props[k];
  }

  const material = {
    name: props.name || "material",
    mainPass: pass,
    cloneCount: 0,
    clone() {
      // A clone is a NEW asset with its own pass values — writes to the clone
      // must never reach the source, so copy the vec4 rather than share it.
      this.cloneCount++;
      const cp = (v) => (v && typeof v.x === "number" ? new vec4(v.x, v.y, v.z, v.w) : v);
      const copy = makeMaterial({
        name: this.name + "-clone",
        baseColor: cp(pass.baseColor), metallic: pass.metallic, roughness: pass.roughness, baseTex: pass.baseTex,
        baseColorFactor: cp(pass.baseColorFactor), metallicFactor: pass.metallicFactor, roughnessFactor: pass.roughnessFactor,
      });
      copy.clonedFrom = this;
      return copy;
    },
  };
  return material;
}

/** The standard PBR pass most prefabs ship with, at a neutral white albedo. */
function pbrMaterial(name) {
  return makeMaterial({
    name,
    baseColor: new vec4(1, 1, 1, 1),
    metallic: 0.0,
    roughness: 0.5,
  });
}

function makeVisual(material) {
  return { mainMaterial: material };
}

/**
 * A SceneObject node with RenderMeshVisual components and children. The
 * swapper only ever calls getComponents/getChildrenCount/getChild; the
 * destroyed flag and destroy() exist solely so SpatialisRegistry.removeAll()
 * (called by makeSwapper) can tear the node down without throwing.
 */
function makeNode(visuals = [], children = []) {
  return {
    visuals,
    children,
    destroyed: false,
    getComponents(type) {
      return type === "Component.RenderMeshVisual" ? this.visuals : [];
    },
    getChildrenCount() {
      return this.children.length;
    },
    getChild(i) {
      return this.children[i];
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

/** A registry entry whose prefab root is `sceneObject`. */
function place(kind, sceneObject) {
  const spec = getFurnitureSpec(kind);
  return SpatialisRegistry.register({
    sceneObject,
    transform: {
      getWorldPosition: () => new vec3(0, 0, 0),
      setWorldPosition: () => {},
      getLocalScale: () => new vec3(1, 1, 1),
      setLocalScale: () => {},
      getWorldRotation: () => quat.quatIdentity(),
      setWorldRotation: () => {},
    },
    kind,
    spec,
    placement: "auto",
    surface: "floor",
    surfaceNormal: vec3.up(),
    baseScale: new vec3(1, 1, 1),
    materialKey: "",
    spawnedAtSeconds: 0,
    isGrabbed: false,
  });
}

/** A swapper with a fresh registry. blendDuration 0 writes immediately. */
function makeSwapper(overrides = {}) {
  SpatialisRegistry.removeAll();
  const s = new PBRMaterialSwapper();
  Object.assign(s, { blendDuration: 0, presetTextures: [], presetTextureKeys: [] }, overrides);
  return s;
}

function passOf(visual) {
  return visual.mainMaterial.mainPass;
}

const BRASS = PBRMaterialSwapper.getPreset("brass");
const VELVET = PBRMaterialSwapper.getPreset("velvet");
const OAK = PBRMaterialSwapper.getPreset("oak");
const GLASS = PBRMaterialSwapper.getPreset("glass");

// -----------------------------------------------------------------------------

suite("PBRMaterialSwapper — private clones");

test("an object's material is cloned exactly once across repeated restyles", () => {
  const s = makeSwapper();
  const source = pbrMaterial("sofa-fabric");
  const visual = makeVisual(source);
  const sofa = place("sofa", makeNode([visual]));

  ok(s.applyMaterial(sofa, "velvet"));
  const firstClone = visual.mainMaterial;
  ok(firstClone !== source, "the visual must be re-pointed at a private clone");
  eq(source.cloneCount, 1);

  ok(s.applyMaterial(sofa, "leather"));
  eq(source.cloneCount, 1, "a second restyle must reuse the cached clone, not clone again");
  ok(visual.mainMaterial === firstClone, "the visual should still hold the same clone object");
  eq(firstClone.cloneCount, 0, "the clone itself must never be cloned");
});

test("restyling one sofa leaves a sibling spawned from the same prefab untouched", () => {
  // Two prefab instances share ONE Material asset. This is the bug the clone
  // exists to prevent: without it, "make the sofa velvet" would repaint both.
  const s = makeSwapper();
  const shared = pbrMaterial("shared-sofa-material");
  const visualA = makeVisual(shared);
  const visualB = makeVisual(shared);
  const sofaA = place("sofa", makeNode([visualA]));
  place("sofa", makeNode([visualB]));

  ok(s.applyMaterial(sofaA, "velvet"));

  ok(visualB.mainMaterial === shared, "B must still point at the original source asset");
  eq(shared.mainPass.baseColor, new vec4(1, 1, 1, 1), "the shared source colour must be unchanged");
  eq(shared.mainPass.roughness, 0.5, "the shared source roughness must be unchanged");
  eq(shared.mainPass.metallic, 0.0);
  eq(passOf(visualA).baseColor, VELVET.baseColor, "A's private clone carries velvet");
});

test("forget() drops the cache so a re-spawned id is cloned afresh", () => {
  const s = makeSwapper();
  const source = pbrMaterial("chair-material");
  const visual = makeVisual(source);
  const chair = place("chair", makeNode([visual]));

  ok(s.applyMaterial(chair, "oak"));
  eq(source.cloneCount, 1);

  s.forget(chair.id);
  // After forget the visual holds the old clone, which becomes the new source.
  const oldClone = visual.mainMaterial;
  ok(s.applyMaterial(chair, "walnut"));
  eq(oldClone.cloneCount, 1, "forgetting must force a fresh clone on the next apply");
  ok(visual.mainMaterial !== oldClone);
  eq(s.styled.length, 1, "exactly one cache entry should exist for the object");
});

test("forget() of one id keeps every other object's cache intact", () => {
  const s = makeSwapper();
  const srcA = pbrMaterial("a");
  const srcB = pbrMaterial("b");
  const a = place("sofa", makeNode([makeVisual(srcA)]));
  const b = place("chair", makeNode([makeVisual(srcB)]));
  s.applyMaterial(a, "oak");
  s.applyMaterial(b, "oak");

  s.forget(a.id);
  s.applyMaterial(b, "walnut");
  eq(srcB.cloneCount, 1, "b was never forgotten, so it must not re-clone");
  eq(s.styled.map((e) => e.objectId), [b.id]);
});

test("forgetAll() clears every cache entry and abandons in-flight fades", () => {
  const s = makeSwapper({ blendDuration: 0.45 });
  const source = pbrMaterial("lamp-material");
  const visual = makeVisual(source);
  const lamp = place("lamp", makeNode([visual]));
  s.applyMaterial(lamp, "brass");

  s.forgetAll();
  eq(s.styled.length, 0);

  // A "clear room" mid-fade must not keep writing to materials of objects
  // that no longer exist — the tween is gone, so nothing moves.
  s.tweens.update(1.0);
  eq(passOf(visual).baseColor, new vec4(1, 1, 1, 1), "no fade step should run after forgetAll");
});

suite("PBRMaterialSwapper — writing a finish");

test("applyMaterial writes the preset's albedo, metallic and roughness to the clone", () => {
  const s = makeSwapper();
  const visual = makeVisual(pbrMaterial("table"));
  const table = place("table", makeNode([visual]));

  ok(s.applyMaterial(table, "brass"));
  const pass = passOf(visual);
  eq(pass.baseColor, new vec4(0.76, 0.60, 0.28, 1.0));
  eq(pass.metallic, 1.0, "brass is a raw metal");
  eq(pass.roughness, 0.32, "brushed, not mirror-polished");
});

test("the glass preset writes a transparent alpha", () => {
  const s = makeSwapper();
  const visual = makeVisual(pbrMaterial("vase"));
  const vase = place("vase", makeNode([visual]));

  ok(s.applyMaterial(vase, "glass"));
  near(passOf(visual).baseColor.w, 0.35, 1e-9, "smoked glass must be see-through");
  eq(passOf(visual).roughness, GLASS.roughness);
});

test("applyColor keeps the current finish and only shifts hue", () => {
  // "make the sofa navy" after "make it velvet" must still look like velvet:
  // same roughness, same metallic, same alpha — just a different colour.
  const s = makeSwapper();
  const visual = makeVisual(pbrMaterial("sofa"));
  const sofa = place("sofa", makeNode([visual]));

  ok(s.applyMaterial(sofa, "velvet"));
  ok(s.applyColor(sofa, "navy"));
  const pass = passOf(visual);
  near(pass.baseColor.x, 0.11, 1e-9);
  near(pass.baseColor.y, 0.17, 1e-9);
  near(pass.baseColor.z, 0.34, 1e-9);
  eq(pass.baseColor.w, VELVET.baseColor.w, "alpha must carry over from the finish");
  eq(pass.roughness, VELVET.roughness, "velvet's roughness must survive a recolour");
  eq(pass.metallic, VELVET.metallic);
  eq(sofa.materialKey, "velvet", "a tint does not change the finish on record");
});

test("applyColor on a transparent finish keeps it transparent", () => {
  const s = makeSwapper();
  const visual = makeVisual(pbrMaterial("vase"));
  const vase = place("vase", makeNode([visual]));
  s.applyMaterial(vase, "glass");
  s.applyColor(vase, "sage");
  near(passOf(visual).baseColor.w, 0.35, 1e-9, "tinting glass must not make it opaque");
  near(passOf(visual).baseColor.x, 0.55, 1e-9);
});

test("a custom shader exposing only baseColor gets its colour and nothing throws", () => {
  const s = makeSwapper();
  const custom = makeMaterial({ name: "custom", baseColor: new vec4(0.2, 0.2, 0.2, 1) });
  const visual = makeVisual(custom);
  const rug = place("rug", makeNode([visual]));

  ok(s.applyMaterial(rug, "brass"));
  const pass = passOf(visual);
  eq(pass.baseColor, BRASS.baseColor, "colour is the one thing this shader supports");
  eq(Object.prototype.hasOwnProperty.call(pass, "metallic"), false, "must not invent a metallic uniform");
  eq(Object.prototype.hasOwnProperty.call(pass, "roughness"), false, "must not invent a roughness uniform");
});

test("every RenderMeshVisual in a nested prefab hierarchy is restyled", () => {
  // A sofa prefab is root > frame > [cushion, cushion]; each has a mesh.
  const s = makeSwapper();
  const rootVisual = makeVisual(pbrMaterial("root"));
  const frameVisual = makeVisual(pbrMaterial("frame"));
  const cushionA = makeVisual(pbrMaterial("cushionA"));
  const cushionB = makeVisual(pbrMaterial("cushionB"));
  const tree = makeNode([rootVisual], [
    makeNode([frameVisual], [makeNode([cushionA]), makeNode([cushionB])]),
    makeNode([], []),
  ]);
  const sofa = place("sofa", tree);

  ok(s.applyMaterial(sofa, "leather"));
  const all = [rootVisual, frameVisual, cushionA, cushionB];
  for (const v of all) {
    eq(passOf(v).baseColor, new vec4(0.45, 0.27, 0.16, 1.0), v.mainMaterial.name + " must be leather");
    eq(passOf(v).roughness, 0.55);
  }
  eq(s.styled[0].materials.length, 4, "one private clone per visual");
});

test("a visual with no material is skipped while its siblings are restyled", () => {
  const s = makeSwapper();
  const bare = makeVisual(null);
  const real = makeVisual(pbrMaterial("real"));
  const shelf = place("shelf", makeNode([bare, real]));

  ok(s.applyMaterial(shelf, "walnut"), "one restylable mesh is enough to succeed");
  eq(bare.mainMaterial, null, "must not fabricate a material for the bare visual");
  eq(passOf(real).baseColor, new vec4(0.28, 0.18, 0.11, 1.0));
  eq(s.styled[0].materials.length, 1);
});

test("an object with no restylable mesh reports failure and leaves materialKey alone", () => {
  const s = makeSwapper();
  const shelf = place("shelf", makeNode([makeVisual(null)]));
  eq(s.applyMaterial(shelf, "walnut"), false);
  eq(shelf.materialKey, "");
  eq(s.applyColor(shelf, "navy"), false);
});

test("an object whose SceneObject is gone is refused rather than crashed on", () => {
  const s = makeSwapper();
  const sofa = place("sofa", makeNode([makeVisual(pbrMaterial("sofa"))]));
  // Once Lens Studio destroys a SceneObject, isNull() reports it as null. The
  // stub's isNull() only recognises null/undefined, so the closest faithful
  // stand-in is to null the reference outright.
  sofa.sceneObject = null;
  eq(s.applyMaterial(sofa, "oak"), false);
  eq(sofa.materialKey, "");
  eq(s.styled.length, 0, "nothing should be cached for a dead object");
});

suite("PBRMaterialSwapper — unknown keys");

test("an unknown material key returns false and writes nothing", () => {
  const s = makeSwapper();
  const source = pbrMaterial("sofa");
  const visual = makeVisual(source);
  const sofa = place("sofa", makeNode([visual]));

  eq(s.applyMaterial(sofa, "unobtainium"), false);
  eq(source.cloneCount, 0, "must not clone before validating the key");
  ok(visual.mainMaterial === source);
  eq(source.mainPass.baseColor, new vec4(1, 1, 1, 1));
  eq(sofa.materialKey, "", "materialKey must be left alone on failure");
});

test("an unknown colour key returns false and writes nothing", () => {
  const s = makeSwapper();
  const source = pbrMaterial("sofa");
  const visual = makeVisual(source);
  const sofa = place("sofa", makeNode([visual]));

  eq(s.applyColor(sofa, "chartreuse"), false);
  eq(source.cloneCount, 0);
  eq(source.mainPass.baseColor, new vec4(1, 1, 1, 1));
});

test("materialKey on the registry entry records the finish on success", () => {
  const s = makeSwapper();
  const sofa = place("sofa", makeNode([makeVisual(pbrMaterial("sofa"))]));
  ok(s.applyMaterial(sofa, "marble"));
  eq(sofa.materialKey, "marble");
  eq(s.applyMaterial(sofa, "nope"), false);
  eq(sofa.materialKey, "marble", "a failed apply must not clobber the recorded finish");
  ok(s.applyMaterial(sofa, "chrome"));
  eq(sofa.materialKey, "chrome");
});

suite("PBRMaterialSwapper — by kind");

test("applyMaterialToKind restyles every object of that kind and no others", () => {
  const s = makeSwapper();
  const chairVisuals = [makeVisual(pbrMaterial("c1")), makeVisual(pbrMaterial("c2")), makeVisual(pbrMaterial("c3"))];
  const chairs = chairVisuals.map((v) => place("chair", makeNode([v])));
  const sofaSource = pbrMaterial("sofa");
  const sofaVisual = makeVisual(sofaSource);
  const sofa = place("sofa", makeNode([sofaVisual]));

  eq(s.applyMaterialToKind("chair", "oak"), 3);
  for (let i = 0; i < chairs.length; i++) {
    eq(passOf(chairVisuals[i]).baseColor, OAK.baseColor, "chair " + i + " must be oak");
    eq(chairs[i].materialKey, "oak");
  }
  eq(sofaSource.cloneCount, 0, "the sofa is not a chair and must be left alone");
  eq(passOf(sofaVisual).baseColor, new vec4(1, 1, 1, 1));
  eq(sofa.materialKey, "");
});

test("applyMaterialToKind counts only the objects it could restyle", () => {
  const s = makeSwapper();
  place("chair", makeNode([makeVisual(pbrMaterial("c1"))]));
  place("chair", makeNode([makeVisual(null)]));   // custom prop with no material
  eq(s.applyMaterialToKind("chair", "oak"), 1);
  eq(s.applyMaterialToKind("lamp", "oak"), 0, "no lamps in the room");
  eq(s.applyMaterialToKind("chair", "nope"), 0, "unknown finish restyles nothing");
});

suite("PBRMaterialSwapper — cross-fade");

test("a finish fades in over blendDuration rather than snapping", () => {
  const s = makeSwapper({ blendDuration: 0.45 });
  const visual = makeVisual(pbrMaterial("sofa"));
  const sofa = place("sofa", makeNode([visual]));

  ok(s.applyMaterial(sofa, "oak"));
  eq(passOf(visual).baseColor, new vec4(1, 1, 1, 1), "nothing changes until a frame is stepped");

  s.tweens.update(0.1);
  const mid = passOf(visual).baseColor;
  ok(mid.x < 1 && mid.x > OAK.baseColor.x, "red channel should be strictly between start and target");
  ok(mid.z < 1 && mid.z > OAK.baseColor.z, "blue channel should be strictly between start and target");
  // The curve is eased, so 22% of the time is well past 22% of the distance.
  const expectedT = easeOutCubic(0.1 / 0.45);
  near(mid.x, 1 + (OAK.baseColor.x - 1) * expectedT, 1e-9, "should follow easeOutCubic");
  near(passOf(visual).roughness, 0.5 + (OAK.roughness - 0.5) * expectedT, 1e-9);

  s.tweens.update(0.2);
  s.tweens.update(0.2);   // total 0.5s >= 0.45s
  const end = passOf(visual).baseColor;
  near(end.x, OAK.baseColor.x, 1e-9);
  near(end.y, OAK.baseColor.y, 1e-9);
  near(end.z, OAK.baseColor.z, 1e-9);
  near(end.w, 1.0, 1e-9);
  near(passOf(visual).roughness, OAK.roughness, 1e-9);
});

test("the first fade starts from the prefab's own colour and metallic, not from white", () => {
  // A dark, metallic prefab (think a chrome-legged stool) must darken smoothly
  // into oak. If the swapper seeded its "current" values from the fallbacks
  // (white, non-metallic) instead of reading the source pass, the first frame
  // of every fade would flash to white and lose the metal sheen.
  const s = makeSwapper({ blendDuration: 0.45 });
  const dark = makeMaterial({
    name: "dark-metal",
    baseColor: new vec4(0.2, 0.3, 0.4, 1),
    metallic: 1.0,
    roughness: 0.5,
  });
  const visual = makeVisual(dark);
  const chair = place("chair", makeNode([visual]));

  ok(s.applyMaterial(chair, "oak"));
  s.tweens.update(0.1);
  const t = easeOutCubic(0.1 / 0.45);
  const pass = passOf(visual);
  near(pass.baseColor.x, 0.2 + (OAK.baseColor.x - 0.2) * t, 1e-9, "red must start from 0.2, not 1.0");
  near(pass.baseColor.y, 0.3 + (OAK.baseColor.y - 0.3) * t, 1e-9, "green must start from 0.3, not 1.0");
  near(pass.baseColor.z, 0.4 + (OAK.baseColor.z - 0.4) * t, 1e-9, "blue must start from 0.4, not 1.0");
  near(pass.metallic, 1.0 + (OAK.metallic - 1.0) * t, 1e-9, "metallic must fade down from 1.0, not sit at 0");
  ok(pass.metallic > 0 && pass.metallic < 1, "metallic should be mid-fade");
});

test("a new finish requested mid-fade starts from what is on screen", () => {
  // Saying "walnut" halfway through an oak fade must not jump back to white.
  const s = makeSwapper({ blendDuration: 0.45 });
  const visual = makeVisual(pbrMaterial("sofa"));
  const sofa = place("sofa", makeNode([visual]));
  s.applyMaterial(sofa, "oak");
  s.tweens.update(0.1);
  const onScreen = passOf(visual).baseColor.x;

  s.applyMaterial(sofa, "walnut");
  s.tweens.update(0.001);
  const justAfter = passOf(visual).baseColor.x;
  // The oak tween is not cancelled, so two tweens write this pass each frame;
  // the walnut one was added last and so wins the frame. Walnut is darker
  // than the interrupted oak value, so one tiny step must move strictly down.
  ok(justAfter < onScreen, "should continue darkening from the interrupted value, not restart at white");
  ok(justAfter > 0.28, "should not have reached walnut yet");
});

suite("PBRMaterialSwapper — textures");

test("a wired-up albedo texture is assigned only to passes that expose baseTex", () => {
  const T = { name: "oak-albedo" };
  const s = makeSwapper({ presetTextureKeys: ["oak"], presetTextures: [T] });
  const withTex = makeVisual(makeMaterial({
    name: "textured", baseColor: new vec4(1, 1, 1, 1), roughness: 0.5, baseTex: { name: "default" },
  }));
  const withoutTex = makeVisual(pbrMaterial("plain"));
  const table = place("table", makeNode([withTex, withoutTex]));

  ok(s.applyMaterial(table, "oak"));
  ok(passOf(withTex).baseTex === T, "the oak albedo should be on the textured pass");
  eq(Object.prototype.hasOwnProperty.call(passOf(withoutTex), "baseTex"), false, "must not invent baseTex");
  eq(passOf(withTex).baseColor, OAK.baseColor, "the colour write still happens alongside the texture");
});

test("a finish with no wired texture leaves the existing albedo alone", () => {
  const original = { name: "default" };
  const s = makeSwapper({ presetTextureKeys: ["oak"], presetTextures: [{ name: "oak-albedo" }] });
  const visual = makeVisual(makeMaterial({ baseColor: new vec4(1, 1, 1, 1), baseTex: original }));
  const table = place("table", makeNode([visual]));
  ok(s.applyMaterial(table, "walnut"));
  ok(passOf(visual).baseTex === original, "walnut has no texture, so the prefab's stays");
});

suite("PBRMaterialSwapper — spoken vocabulary");

test("resolveMaterial picks the longest alias so 'dark wood' is walnut, not oak", () => {
  eq(PBRMaterialSwapper.resolveMaterial("make it smoked glass"), "glass");
  eq(PBRMaterialSwapper.resolveMaterial("dark wood please"), "walnut", "'dark wood' beats 'wood'");
  eq(PBRMaterialSwapper.resolveMaterial("make the table wood"), "oak", "plain 'wood' defaults to oak");
  // The longer alias belongs to an EARLIER preset than the shorter one here,
  // so a "last listed alias wins" loop would answer brass / chrome instead.
  eq(PBRMaterialSwapper.resolveMaterial("light wood and brass"), "oak", "'light wood' outranks the later 'brass'");
  eq(PBRMaterialSwapper.resolveMaterial("dark wood or steel"), "walnut", "'dark wood' outranks the later 'steel'");
  eq(PBRMaterialSwapper.resolveMaterial("matte black"), "matteBlack");
  eq(PBRMaterialSwapper.resolveMaterial("Brushed BRASS"), "brass", "case-insensitive");
  eq(PBRMaterialSwapper.resolveMaterial("a helicopter"), "", "unknown finishes resolve to nothing");
  eq(PBRMaterialSwapper.resolveMaterial("oaken"), "", "aliases match whole words only");
});

test("resolveColor picks the longest alias and ignores case", () => {
  eq(PBRMaterialSwapper.resolveColor("make it Navy"), "navy");
  eq(PBRMaterialSwapper.resolveColor("a dark green sofa"), "forest");
  // 'dark green' (forest) is longer than 'red' (burgundy) but listed earlier,
  // so a last-listed-alias loop would wrongly answer burgundy.
  eq(PBRMaterialSwapper.resolveColor("dark green and red"), "forest", "'dark green' outranks the later 'red'");
  eq(PBRMaterialSwapper.resolveColor("burnt orange"), "rust");
  eq(PBRMaterialSwapper.resolveColor("off white"), "white");
  eq(PBRMaterialSwapper.resolveColor("ash grey"), "grey", "the two-word alias resolves as a whole");
  eq(PBRMaterialSwapper.resolveColor("purple"), "");
});

test("getPresetLabel falls back to the key for unknown finishes", () => {
  eq(PBRMaterialSwapper.getPresetLabel("brass"), "brushed brass");
  eq(PBRMaterialSwapper.getPresetLabel("nope"), "nope");
});

suite("PBRMaterialSwapper — glTF-imported materials");

test("a pass exposing only glTF's *Factor names is written, not skipped", () => {
  // Every spawned prefab is a glTF import, whose materials expose
  // baseColorFactor/metallicFactor/roughnessFactor rather than the built-in
  // PBR names. The first Preview run reported 'sofa -> velvet' while the sofa
  // stayed linen-white: the guarded write found no 'baseColor' and skipped.
  const s = makeSwapper();
  const source = makeMaterial({ baseColorFactor: new vec4(0.86, 0.83, 0.76, 1), metallicFactor: 0, roughnessFactor: 0.94 });
  const visual = makeVisual(source);
  const sofa = place("sofa", makeNode([visual]));
  ok(s.applyMaterial(sofa, "brass"));
  const pass = passOf(visual);
  near(pass.baseColorFactor.x, BRASS.baseColor.x, 1e-9, "colour written to baseColorFactor");
  near(pass.metallicFactor, 1.0, 1e-9, "metallic written to metallicFactor");
  near(pass.roughnessFactor, BRASS.roughness, 1e-9, "roughness written to roughnessFactor");
  eq(pass.baseColor, undefined, "no built-in-named uniform was invented on the pass");
});

test("the first fade on a glTF material starts from its own baseColorFactor", () => {
  const s = makeSwapper({ blendDuration: 0.5 });
  const source = makeMaterial({ baseColorFactor: new vec4(0.2, 0.3, 0.4, 1), metallicFactor: 0, roughnessFactor: 0.5 });
  const visual = makeVisual(source);
  const sofa = place("sofa", makeNode([visual]));
  ok(s.applyMaterial(sofa, "velvet"));
  s.tweens.update(0.001);
  const c = passOf(visual).baseColorFactor;
  ok(c.x < 0.25 && c.x > 0.19, "fade begins near the prefab's own colour, not white");
});
