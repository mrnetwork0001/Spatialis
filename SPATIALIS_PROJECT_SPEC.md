# 👓 SPATIALIS — Voice & Gesture 3D Spatial Interior Design Tool for SPECS

> **CLAD Summer Hackathon Blueprint (Week 4: CREATE — $1,000 1st Place Target)**  
> **Host:** Snap Inc. / SPECS / Lenslist (`lenslist.co/clad-summer-hackathon`)  
> **Target:** 1st Place ($1,000 Cash Prize)  
> **Submission Deadline:** September 6, 2026 @ 23:59 PT  
> **AI Coding Agent:** Claude Code + CLAD (Closed Loop Agentic Development)  
> **Environment:** Lens Studio 5.22+ + SPECS Project Mode + TypeScript  
> **License:** Apache 2.0 Open Source  
> **Author:** Ifeanyichukwu Onwo (`mrnetwork`)  

---

## 📌 Executive Summary & Core Innovation

**Spatialis** is a spatial creation tool for Snap's **SPECS** glasses that enables users to design, decorate, and style physical rooms in 3D using voice prompts and hand gestures.

Instead of navigating complex 3D software on a desktop, the user stands in their physical room and speaks *"Spawn a Scandinavian lounge chair by the wall"* or *"Add a floating marble coffee table"*, and Spatialis dynamically instantiates 3D objects, snaps them to real-world surfaces, and applies customizable PBR materials via pinch gestures.

---

## 🏗️ Technical Architecture & Subsystems

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 USER SPATIAL EXPERIENCE                │
                  │       (Voice Prompt + Hand Pinch & Grab Gestures)      │
                  └───────────────┬────────────────────────┬───────────────┘
                                  │                        │
            1. Speech-to-Text     │                        │ 1. Hand Tracking &
               Voice Intent       │                        │    Surface Mesh Anchor
                                  ▼                        ▼
                  ┌────────────────────────────────────────────────────────┐
                  │           LENS STUDIO TYPESCRIPT LOGIC ENGINE          │
                  │   (Generated & Iterated by CLAD via Claude Code)       │
                  └───────────────┬────────────────────────┬───────────────┘
                                  │                        │
            2. Instantiate 3D     │                        │ 2. Dynamic PBR Shaders
               Furniture Prefabs  │                        │    & Particle Effects
                                  ▼                        ▼
                  ┌────────────────────────────────────────────────────────┐
                  │               SPECS SPATIAL AR DISPLAY                 │
                  └────────────────────────────────────────────────────────┘
```

---

## 🌟 4 Key Subsystems Built via CLAD Prompts

### 1. Voice Intent Engine (`Scripts/VoiceCommandController.ts`)
- Parses natural language voice commands (e.g. "sofa", "chair", "table", "lamp", "leather", "velvet") and triggers 3D asset instantiation with scale-in animations.

### 2. Hand Gesture Controller (`Scripts/SpatialGestureController.ts`)
- Leverages SPECS hand-tracking to enable pinch, drag, rotate, and scale operations for spatial 3D furniture placement.

### 3. Surface Anchor Engine (`Scripts/SurfaceAnchorEngine.ts`)
- Detects physical floors, tables, and walls, snapping 3D objects cleanly to real-world surfaces.

### 4. PBR Material Swapper (`Scripts/PBRMaterialSwapper.ts`)
- Dynamically updates materials, wood grains, fabric colors, and metalness on spatial objects via voice or gesture selection.

---

## 📋 Required Submission Package Checklist

- [x] `CLAD_PROMPT_LOG.txt` (Claude Code prompt transcript proving CLAD execution).
- [x] Project description & source (`Scripts/` — all four subsystems, type-checked under `strict`).
- [x] Test suite — 155 behavioural cases across all four subsystems, runnable from a clone.
- [x] Type-checked against Snap's real API (Lens Studio 5.23.2 `StudioLib.d.ts`) — 0 errors; mutation-verified.
- [x] Desk simulator — runs the real subsystem code in a browser, no headset required.
- [x] Apache-2.0 licence (complete text; the earlier file was truncated and GitHub read the repo as unlicensed).
- [x] CI — typecheck, test and simulator build on every push.
- [ ] **GitHub repository set to public** (currently private; the checklist requires public).
- [ ] Lens Studio scene wiring — prefabs imported and assigned (see `SETUP_LENS_STUDIO.md`).
- [ ] On-device pass on Spectacles — tune pinch distances and grab radius.
- [ ] Demo video walkthrough link (Google Drive / Dropbox).
- [ ] Submission form filed on `lenslist.co/clad-summer-hackathon`.

---

## 📄 License
Apache 2.0 Open Source
