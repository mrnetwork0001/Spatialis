/**
 * room3d.js
 * -----------------------------------------------------------------------------
 * First-person 3D view for the Spatialis desk simulator. Rendering only.
 *
 * This module knows nothing about furniture semantics, materials, placement or
 * commands. It loads the .glb prefabs, hands out clones on request, pushes a
 * registry entry's transform onto its clone each frame, and draws. Every
 * decision about WHERE a piece goes and WHAT it looks like is made by the
 * shipped subsystems and arrives here as a position, a quaternion, a scale,
 * and three.js material properties that PBRMaterialSwapper wrote through the
 * host's Material adapter.
 *
 * Two deliberate choices that mirror the Lens:
 *
 *   Clones SHARE their source prefab's materials. On device, materials are
 *   shared assets until something clones them; PBRMaterialSwapper clones
 *   exactly once per object the first time it restyles it. If this module
 *   cloned materials itself, that behaviour - and its failure mode, where one
 *   command repaints every sofa - could never be observed here.
 *
 *   Rotation is taken from the entry's quaternion, not from a yaw the
 *   simulator computed. The anchor engine's yawTowards() and alignToNormal()
 *   produce it; this module just applies it.
 *
 * License: Apache-2.0
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const CM = 0.01; // the Lens and the sim think in centimetres; the three.js scene is metres
// The .glb files are authored in CENTIMETRES (Lens Studio's unit), so a clone is
// scaled by CM to sit in the metre-based scene.

export class Room3D {
  constructor(canvas, room, table, wearer) {
    this.room = room;
    this.table = table;
    this.wearer = wearer;
    this.prefabs = new Map();
    this.selection = null; // THREE.BoxHelper around the selected root, or null

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1017);
    this.scene.fog = new THREE.Fog(0x0d1017, 4, 14);

    // A wide-ish FOV keeps the room legible from a standing position; SPECS'
    // own field of view is narrower, so this errs toward showing more.
    this.camera = new THREE.PerspectiveCamera(66, 1, 0.05, 60);
    this.buildRoom();
    this.buildLights();
    this.placeCamera();
  }

  // ---------------------------------------------------------------------------
  // Static room — the geometry RoomHitTest in simulator.js raycasts against
  // ---------------------------------------------------------------------------

  buildRoom() {
    const W = this.room.w * CM;
    const D = this.room.d * CM;
    const H = this.room.h * CM;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.95, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, D / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // A faint grid keeps the sense of scale the plan view gives for free.
    const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D) / 0.5),
                                      0x3a4152, 0x2f353f);
    grid.position.set(W / 2, 0.002, D / 2);
    this.scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x3c424e, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
    });
    const wall = (w, h, x, y, z, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      this.scene.add(m);
    };
    wall(W, H, W / 2, H / 2, 0, 0);              // far wall (-Z)
    wall(D, H, 0, H / 2, D / 2, Math.PI / 2);    // left wall
    wall(D, H, W, H / 2, D / 2, -Math.PI / 2);   // right wall

    // The physical table: a horizontal surface 75cm up, which is exactly what
    // the anchor engine's classify() calls a "table".
    const t = this.table;
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(t.w * CM, 0.04, t.d * CM),
      new THREE.MeshStandardMaterial({ color: 0x6b5844, roughness: 0.6, metalness: 0 })
    );
    top.position.set((t.x + t.w / 2) * CM, t.top * CM, (t.z + t.d / 2) * CM);
    top.castShadow = true;
    top.receiveShadow = true;
    this.scene.add(top);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x4a3d30, roughness: 0.7 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, t.top * CM, 0.06), legMat);
        leg.position.set(
          (t.x + t.w / 2) * CM + sx * (t.w * CM / 2 - 0.08),
          (t.top * CM) / 2,
          (t.z + t.d / 2) * CM + sz * (t.d * CM / 2 - 0.08)
        );
        leg.castShadow = true;
        this.scene.add(leg);
      }
    }
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xc9d8ff, 0x1a1d24, 1.1));
    const key = new THREE.DirectionalLight(0xfff2dd, 2.0);
    key.position.set(this.room.w * CM * 0.8, 3.2, this.room.d * CM * 0.15);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const s = 4;
    key.shadow.camera.left = -s; key.shadow.camera.right = s;
    key.shadow.camera.top = s; key.shadow.camera.bottom = -s;
    key.shadow.camera.far = 14;
    key.shadow.bias = -0.0012;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88a8ff, 0.5);
    fill.position.set(-2, 2, this.room.d * CM);
    this.scene.add(fill);
  }

  /** Camera at the wearer's eye, looking the way they are looking. */
  placeCamera() {
    const eye = this.wearer.eye * CM;
    const x = this.wearer.x * CM;
    const z = this.wearer.z * CM;
    this.camera.position.set(x, eye, z);
    const cp = Math.cos(this.wearer.pitch), sp = Math.sin(this.wearer.pitch);
    const dx = cp * Math.cos(this.wearer.yaw), dz = cp * Math.sin(this.wearer.yaw);
    this.camera.lookAt(x + dx * 3, eye + sp * 3, z + dz * 3);
  }

  // ---------------------------------------------------------------------------
  // Prefabs
  // ---------------------------------------------------------------------------

  /**
   * Load every catalog .glb once; instantiate() clones from these.
   *
   * Every path out of this settles. A loader that never calls back, or a throw
   * inside the success callback, would otherwise leave the promise pending and
   * the app stuck on "loading furniture..." with nothing on screen and no
   * error - which is exactly what happened before the timeout was added.
   */
  async loadPrefabs(keys, baseUrl, timeoutMs = 8000) {
    const loader = new GLTFLoader();
    const load = (key) =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          resolve(ok ? key : null);
        };
        const timer = setTimeout(() => {
          console.warn(`[Spatialis] ${key}.glb timed out after ${timeoutMs}ms`);
          finish(false);
        }, timeoutMs);

        loader.load(
          `${baseUrl}/${key}.glb`,
          (gltf) => {
            clearTimeout(timer);
            try {
              const root = gltf.scene;
              root.traverse((n) => {
                if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
              });
              this.prefabs.set(key, root);
              finish(true);
            } catch (e) {
              console.warn(`[Spatialis] ${key}.glb loaded but could not be prepared:`, e);
              finish(false);
            }
          },
          undefined,
          (err) => {
            clearTimeout(timer);
            console.warn(`[Spatialis] ${key}.glb failed to load:`, err && err.message);
            finish(false);
          }
        );
      });

    const results = await Promise.all(keys.map(load));
    return { loaded: results.filter(Boolean), failed: keys.filter((k) => !this.prefabs.has(k)) };
  }

  hasPrefab(key) {
    return this.prefabs.has(key);
  }

  /**
   * A fresh instance of a prefab, added to the scene at the origin, or null if
   * that model never loaded. Geometry and materials are SHARED with the source
   * - see the module comment for why that is the faithful choice.
   */
  instantiate(key) {
    const src = this.prefabs.get(key);
    if (!src) return null;
    const obj = src.clone(true);
    this.scene.add(obj);
    return obj;
  }

  /** Remove an instance. Nothing is disposed: geometry is shared with the prefab. */
  release(obj) {
    if (!obj) return;
    if (this.selection && this.selection.object === obj) this.setSelected(null);
    this.scene.remove(obj);
  }

  /** Push a registry entry's transform onto its instance. Called every frame. */
  sync(entry) {
    const obj = entry.sceneObject && entry.sceneObject.obj3d;
    if (!obj) return;
    const p = entry.transform.getWorldPosition();
    obj.position.set(p.x * CM, p.y * CM, p.z * CM);
    const s = entry.transform.getLocalScale();
    obj.scale.set(s.x * CM, s.y * CM, s.z * CM);
    const q = entry.transform.getWorldRotation();
    if (q && typeof q.w === 'number') obj.quaternion.set(q.x, q.y, q.z, q.w);
  }

  // ---------------------------------------------------------------------------
  // Selection and picking
  // ---------------------------------------------------------------------------

  /**
   * Outline the selected root. A box helper rather than an emissive tint,
   * because instances share materials until the swapper clones them, and
   * tinting a shared material would highlight every sibling at once.
   */
  setSelected(obj) {
    if (this.selection) {
      this.scene.remove(this.selection);
      this.selection.geometry.dispose();
      this.selection = null;
    }
    if (obj) {
      this.selection = new THREE.BoxHelper(obj, 0xffd84d);
      this.scene.add(this.selection);
    }
  }

  /** Ray from a screen point onto the floor plane, in centimetres. */
  pickFloor(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x / CM, z: hit.z / CM };
  }

  /**
   * Ray from a screen point onto the nearest horizontal surface: the tabletop
   * when the ray meets it inside the table's footprint, else the floor. Floor
   * only would resolve a mouse over the tabletop to a floor point hidden
   * behind the table, so a piece could never be dropped ON the table.
   * Returns centimetres plus the surface height.
   */
  pickSurface(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const t = this.table;
    const top = new THREE.Plane(new THREE.Vector3(0, 1, 0), -t.top * CM);
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(top, hit)) {
      const x = hit.x / CM, z = hit.z / CM;
      if (x >= t.x && x <= t.x + t.w && z >= t.z && z <= t.z + t.d) {
        return { x, z, y: t.top, surface: "table" };
      }
    }
    const f = this.pickFloor(nx, ny);
    return f ? { x: f.x, z: f.z, y: 0, surface: "floor" } : null;
  }

  /** Which of `roots` is under a screen point, or null. */
  pickObject(nx, ny, roots) {
    if (!roots.length) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hits = ray.intersectObjects(roots, true);
    if (!hits.length) return null;
    let node = hits[0].object;
    while (node && !roots.includes(node)) node = node.parent;
    return node || null;
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    if (this.selection) this.selection.update();
    this.renderer.render(this.scene, this.camera);
  }
}
