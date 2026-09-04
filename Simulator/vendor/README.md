# Vendored dependencies

three.js r160 — MIT licensed — from https://github.com/mrdoob/three.js

```
three.module.js                    the core library
jsm/loaders/GLTFLoader.js          loads the .glb furniture
jsm/utils/BufferGeometryUtils.js   GLTFLoader imports this as a sibling
```

Vendored rather than loaded from a CDN on purpose. The simulator is the only
way to see Spatialis without Lens Studio and a headset, so it must not depend
on a 1.4 MB network fetch completing. A demo that shows "loading furniture…"
forever because a CDN is slow, blocked by an extension, or unreachable on
conference wifi is worse than no demo.

**The directory layout matters.** `GLTFLoader.js` imports
`../utils/BufferGeometryUtils.js` relative to its own URL, so it has to sit in
a `loaders/` folder with a sibling `utils/`. The import map maps the *prefix*
`three/addons/` to `./vendor/jsm/` for exactly this reason — an exact-specifier
map for GLTFLoader alone leaves that sibling import resolving to a 404, which
takes down the whole module graph and leaves the app stuck on "loading
furniture…" with no error.

Updating: re-download the same three paths at the pinned version, keep the
layout, and re-check that every relative import still resolves.
