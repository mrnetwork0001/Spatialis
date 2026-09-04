/**
 * room3d.js
 * -----------------------------------------------------------------------------
 * First-person 3D room view for the Spatialis simulator.
 *
 * The plan view answers "where did it go". This answers the question that
 * actually matters for an AR tool: what does the WEARER see. The camera sits at
 * eye height in the simulated room and the real furniture .glb files are loaded
 * and placed by the same command pipeline that drives the plan view.
 *
 * Everything decision-making is still the shipped code: the parser chooses the
 * piece, FURNITURE_CATALOG gives its size, SpatialisRegistry holds it, the
 * PBRMaterialSwapper presets supply its finish. This module only draws.
 *
 * License: Apache-2.0
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PBRMaterialSwapper } from './build/Scripts/PBRMaterialSwapper.js';

const CM = 0.01; // models are authored in metres; the sim thinks in centimetres

export class Room3D {
  constructor(canvas, room, table, wearer) {
    this.room = room;
    this.table = table;
    this.wearer = wearer;
    this.prefabs = new Map();
    this.instances = new Map(); // registry id -> THREE.Object3D
    this.ready = false;

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
  // Static room
  // ---------------------------------------------------------------------------

  buildRoom() {
    const W = this.room.w * CM;
    const D = this.room.d * CM;
    const H = 2.6;

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
      return m;
    };
    wall(W, H, W / 2, H / 2, 0, 0);              // far wall (-Z)
    wall(D, H, 0, H / 2, D / 2, Math.PI / 2);    // left wall
    wall(D, H, W, H / 2, D / 2, -Math.PI / 2);   // right wall

    // The physical table the anchor engine can classify as a table surface.
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
    const eye = 1.55;
    const x = this.wearer.x * CM;
    const z = this.wearer.z * CM;
    this.camera.position.set(x, eye, z);
    const [dx, dz] = [Math.cos(this.wearer.yaw), Math.sin(this.wearer.yaw)];
    // Look slightly down, the way someone surveying a room does.
    this.camera.lookAt(x + dx * 3, eye - 0.55, z + dz * 3);
  }

  // ---------------------------------------------------------------------------
  // Prefab loading
  // ---------------------------------------------------------------------------

  /** Load every catalog .glb once; spawns clone from these. */
  async loadPrefabs(keys, baseUrl) {
    const loader = new GLTFLoader();
    const load = (key) =>
      new Promise((resolve) => {
        loader.load(
          `${baseUrl}/${key}.glb`,
          (gltf) => {
            const root = gltf.scene;
            root.traverse((n) => {
              if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
            });
            this.prefabs.set(key, root);
            resolve(true);
          },
          undefined,
          () => resolve(false)
        );
      });
    const results = await Promise.all(keys.map(load));
    this.ready = true;
    return results.filter(Boolean).length;
  }

  hasPrefab(key) {
    return this.prefabs.has(key);
  }

  // ---------------------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------------------

  add(entry) {
    const src = this.prefabs.get(entry.kind);
    if (!src) return null;
    const obj = src.clone(true);
    // Clone materials too, or restyling one sofa restyles them all — the same
    // hazard PBRMaterialSwapper guards against on device.
    obj.traverse((n) => {
      if (n.isMesh) n.material = n.material.clone();
    });
    this.scene.add(obj);
    this.instances.set(entry.id, obj);
    this.sync(entry);
    return obj;
  }

  remove(id) {
    const obj = this.instances.get(id);
    if (!obj) return;
    obj.traverse((n) => {
      if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); }
    });
    this.scene.remove(obj);
    this.instances.delete(id);
  }

  clear() {
    for (const id of Array.from(this.instances.keys())) this.remove(id);
  }

  /** Push a registry entry's transform and finish onto its 3D instance. */
  sync(entry) {
    const obj = this.instances.get(entry.id);
    if (!obj) return;
    const p = entry.transform.getWorldPosition();
    obj.position.set(p.x * CM, p.y * CM, p.z * CM);
    const s = entry.transform.getLocalScale().x;
    obj.scale.setScalar(s);
    obj.rotation.y = entry.yaw || 0;

    if (entry.onWall) {
      // Wall art faces into the room and hangs at the height the anchor set.
      obj.rotation.y = entry.wallYaw || 0;
    }

    const preset = entry.materialKey ? PBRMaterialSwapper.getPreset(entry.materialKey) : null;
    const tint = entry.tint;
    if (!preset && !tint) return;
    obj.traverse((n) => {
      if (!n.isMesh) return;
      const c = tint || (preset && preset.baseColor);
      if (c) n.material.color.setRGB(c.x, c.y, c.z);
      if (preset) {
        n.material.metalness = preset.metallic;
        n.material.roughness = preset.roughness;
        const alpha = preset.baseColor.w === undefined ? 1 : preset.baseColor.w;
        if (alpha < 1) { n.material.transparent = true; n.material.opacity = alpha; }
      }
      n.material.needsUpdate = true;
    });
  }

  /** Soft highlight on the selected piece. */
  setSelected(id) {
    for (const [oid, obj] of this.instances) {
      obj.traverse((n) => {
        if (n.isMesh) n.material.emissive
          ? n.material.emissive.setHex(oid === id ? 0x3a2f00 : 0x000000)
          : null;
      });
    }
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
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

  /** Nearest instance under a screen point, or null. */
  pickObject(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hits = ray.intersectObjects(Array.from(this.instances.values()), true);
    if (!hits.length) return null;
    let node = hits[0].object;
    while (node && !this.idOf(node)) node = node.parent;
    return node ? this.idOf(node) : null;
  }

  idOf(obj) {
    for (const [id, o] of this.instances) if (o === obj) return id;
    return null;
  }
}
