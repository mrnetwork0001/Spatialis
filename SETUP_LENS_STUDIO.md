# 🔧 Spatialis - Lens Studio Scene Wiring

Everything in `Scripts/` is complete and type-checked, but four things can only
be done inside Lens Studio: importing the project modules, importing furniture
prefabs, assigning them to the components' `@input` fields, and tuning the
pinch feel on a real wearer. This document covers all four.

**Requires:** Lens Studio 5.22+, a project created in **Spectacles** mode.

---

## 1. Project modules

Add these from **Asset Browser → + → …**:

| Asset | Used by | Why |
|---|---|---|
| **ASR Module** | `VoiceCommandController` | Speech-to-text |
| **World Query Module** | `SurfaceAnchorEngine` | Surface hit testing against the room mesh |
| **Spectacles Interaction Kit** (`SpectaclesInteractionKit.lspkg`) | `SpatialGestureController` | Hand joint tracking |

Then enable, under **Project Settings → Extensions / Permissions**:

- **Microphone** - required, VoiceML fails silently without it.
- **Depth / World Mesh** - required, `SurfaceAnchorEngine` reports
  `"World Query module unavailable - running in float-only mode"` without it
  and every piece will hover in front of you instead of snapping.
- **Hand Tracking** - required for gestures.

---

## 2. Scene hierarchy

Create this under the scene root:

```
Camera
Spatialis                       ← empty SceneObject, holds the four components
  ├── VoiceCommandController    (Script → Scripts/VoiceCommandController.ts)
  ├── SpatialGestureController  (Script → Scripts/SpatialGestureController.ts)
  ├── SurfaceAnchorEngine       (Script → Scripts/SurfaceAnchorEngine.ts)
  └── PBRMaterialSwapper        (Script → Scripts/PBRMaterialSwapper.ts)
SpatialisRoot                   ← empty SceneObject, parent for spawned furniture
FeedbackText                    ← optional Text component for command feedback
GrabIndicator                   ← optional marker shown over a held piece
```

Keep `SpatialisRoot` separate from `Spatialis`: spawned furniture is destroyed
by voice commands, and you do not want the controllers destroyed with it.

---

## 3. Inspector wiring

### SurfaceAnchorEngine
| Field | Set to |
|---|---|
| `Camera` | the scene **Camera** |
| `World Query Asset` | the **World Query Module** asset |
| `Probe Distance` | `700` (cm) - how far to search for a surface |
| `Float Distance` | `160` (cm) - fallback distance when nothing is found |
| `Avoid Overlap` | ✔ on |

### PBRMaterialSwapper
| Field | Set to |
|---|---|
| `Blend Duration` | `0.45` s |
| `Preset Texture Keys` | *(optional)* e.g. `oak`, `walnut`, `marble` |
| `Preset Textures` | *(optional)* albedo textures, **index-matched to the keys above** |

Textures are optional - every preset already carries a plausible base colour,
metallic and roughness, so the system works with untextured prefabs. Where a
key has a texture assigned, it is applied on top.

### VoiceCommandController
| Field | Set to |
|---|---|
| `Voice ML Module` | the **ASR Module** asset |
| `Anchor Engine` | the `SurfaceAnchorEngine` component |
| `Material Swapper` | the `PBRMaterialSwapper` component |
| `Spawn Parent` | **SpatialisRoot** |
| `Furniture Keys` | catalog keys - see table below |
| `Furniture Prefabs` | your prefabs, **index-matched to the keys** |
| `Spawn Duration` | `0.55` s |
| `Require Wake Word` | off for the demo; on in a noisy room |
| `Feedback Text` | **FeedbackText** (optional) |

> ⚠️ `Furniture Keys` and `Furniture Prefabs` are parallel arrays. Index 0 of
> one must describe index 0 of the other. A mismatch is logged at start:
> `Furniture Keys (n) and Furniture Prefabs (m) differ in length`.

**Catalog keys** (from `Scripts/SpatialisCore.ts` - these strings exactly):

| Key | Spoken as | Default placement |
|---|---|---|
| `sofa` | sofa, couch, settee, loveseat, sectional | floor |
| `chair` | chair, armchair, lounge chair, stool, recliner | floor |
| `table` | table, dining table, desk | floor |
| `coffeeTable` | coffee table, low table, side table, end table | floor |
| `lamp` | lamp, floor lamp, standing lamp | floor |
| `tableLamp` | table lamp, desk lamp, bedside lamp | table |
| `shelf` | shelf, bookshelf, bookcase | wall |
| `plant` | plant, fern, palm, monstera | floor |
| `rug` | rug, carpet, mat | floor |
| `artwork` | art, painting, picture, poster, canvas | wall |
| `vase` | vase, pot, bowl, centerpiece | table |
| `bed` | bed, mattress, daybed | floor |

You do not need all twelve. Wire the ones you have; an unwired key answers
"No model loaded for …" instead of failing silently.

### SpatialGestureController
| Field | Set to |
|---|---|
| `Anchor Engine` | the `SurfaceAnchorEngine` component |
| `Pinch Down Distance` | `3.0` cm |
| `Pinch Up Distance` | `4.5` cm - **must exceed Pinch Down** |
| `Grab Radius` | `45` cm |
| `Drag Smoothing` | `0.35` |
| `Min / Max Scale Factor` | `0.3` / `3.0` |
| `Single Hand Rotate` | off (two-hand rotate is steadier) |
| `Grab Indicator` | **GrabIndicator** (optional) |

---

## 4. Prefab requirements

Each furniture prefab must:

1. Have its **origin at the base**, centred on its footprint. The anchor engine
   places the origin *on* the surface, so an origin at the mesh centre buries
   the piece halfway into the floor.
2. Face **+Z**. Pieces are yawed to face the user, and to face away from a wall
   for "by the wall" placements.
3. Be modelled **at real-world scale in centimetres** (a sofa ≈ 200 wide). The
   footprint values in `FURNITURE_CATALOG` drive overlap avoidance and grab
   radius, and they assume real scale.
4. Use the **PBR shader** on its `RenderMeshVisual` if you want material swaps.
   Custom shaders still work - they degrade to colour-only.

---

## 5. Tuning on device

The default pinch distances suit an average adult hand. On a real wearer:

- Furniture **flickers between grabbed and dropped** → widen the gap between
  `Pinch Down Distance` and `Pinch Up Distance`.
- Pinching **grabs the wrong piece** in a busy room → lower `Grab Radius`.
- Dragging feels **laggy** → lower `Drag Smoothing` toward `0`.
- Pieces **hover instead of snapping** → the World Query module is missing or
  depth permission is off. Check the log for the float-only warning.

---

## 6. Verifying without a headset

The parser runs under plain Node, no Lens Studio required:

```bash
npm install
npm run typecheck   # strict type check of all four subsystems
npm test            # 161 tests
```

Inside Lens Studio's Preview (where there is no microphone), call
`handleTranscript()` directly from a test button to exercise the whole
spawn → anchor → material pipeline:

```ts
voiceCommandController.handleTranscript("Add a floating marble coffee table");
```


## Project format (Lens Studio 5.x)

A Lens Studio 5 project is **`<Name>.esproj`** - a small YAML metadata file -
plus `Assets/` (the scene graph lives in `Assets/Scene.scene`), `Packages/`,
`Workspaces/` and generated `.meta` sidecars carrying the GUID every reference
uses. `.lsproj` is the Lens Studio 4 format and LS5 will not open it. Snap's
docs make hand-authoring a project non-viable: only the editor's importers
generate `.meta` files and GUIDs, so create the project in Lens Studio and add
`Scripts/*.ts` and `Assets/Prefabs/*.glb` through it.

## Desk simulator

Everything except the Lens Studio project can be exercised without a headset:
`npm run sim` serves a landing page and simulator on `http://localhost:8777/`
that hosts the real `VoiceCommandController`, `SurfaceAnchorEngine` and
`PBRMaterialSwapper` against a simulated room. See the README.


## The project in this repository

`LensProject/` is the Lens Studio 5.23.2 project (SPECS target). Scripts and
models are import copies of `Scripts/` and `Assets/Prefabs/` - `npm run sync:lens`
refreshes them and `npm run sync:lens:check` fails on drift. The editor has
compiled all five scripts. Scene wiring is scripted: see
[`Tools/lens-editor/README.md`](Tools/lens-editor/README.md).
