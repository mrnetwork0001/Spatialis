/**
 * lens-runtime-stub.js
 * -----------------------------------------------------------------------------
 * Minimal stand-in for the Lens Studio runtime so Spatialis logic can be run
 * with no Lens Studio install and no headset.
 *
 * Dual use, deliberately one file so the two harnesses cannot drift apart:
 *   - Node  (Tests/voice-parser.test.js) requires it and calls install().
 *   - Browser (Simulator/) loads it as a classic script; it self-installs on
 *     window before the ES modules that need those globals are evaluated.
 *
 * Covers the globals the scripts touch at module-eval and parse time: the math
 * types, the Inspector decorators, and the handful of free functions.
 * License: Apache-2.0
 */

class vec3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  get lengthSquared() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  get length() { return Math.sqrt(this.lengthSquared); }
  add(o) { return new vec3(this.x + o.x, this.y + o.y, this.z + o.z); }
  sub(o) { return new vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  mult(o) { return new vec3(this.x * o.x, this.y * o.y, this.z * o.z); }
  uniformScale(s) { return new vec3(this.x * s, this.y * s, this.z * s); }
  normalize() { const l = this.length || 1; return this.uniformScale(1 / l); }
  dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
  cross(o) {
    return new vec3(
      this.y * o.z - this.z * o.y,
      this.z * o.x - this.x * o.z,
      this.x * o.y - this.y * o.x
    );
  }
  distance(o) { return this.sub(o).length; }
  equal(o) { return this.x === o.x && this.y === o.y && this.z === o.z; }
  static zero() { return new vec3(0, 0, 0); }
  static one() { return new vec3(1, 1, 1); }
  static up() { return new vec3(0, 1, 0); }
  static down() { return new vec3(0, -1, 0); }
  static left() { return new vec3(-1, 0, 0); }
  static right() { return new vec3(1, 0, 0); }
  static forward() { return new vec3(0, 0, 1); }
  static back() { return new vec3(0, 0, -1); }
  static lerp(a, b, t) {
    return new vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }
}

class vec4 {
  constructor(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; }
}

/**
 * A real quaternion, (x, y, z, w) with w the scalar part.
 *
 * This used to be a placeholder that stored angleAxis's arguments verbatim and
 * returned vectors unrotated. That let the parser and gesture suites run, but
 * it meant every rotation assertion in the tree was vacuous, and it meant the
 * desk simulator could not apply the rotations the anchor engine actually
 * produces. The maths below is the standard formulation (the same one three.js
 * uses), so a rotation asserted here is a rotation the Lens performs.
 *
 * Convention, matching how the codebase uses it: a model's forward is +Z, so
 * angleAxis(theta, up) turns +Z toward (sin theta, 0, cos theta) - which is why
 * yawTowards() computes atan2(x, z). lookAt(forward, up) builds the rotation
 * whose local +Z is `forward` and local +Y is as close to `up` as possible.
 */
class quat {
  constructor(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; }

  static quatIdentity() { return new quat(0, 0, 0, 1); }

  static angleAxis(radians, axis) {
    const a = axis.normalize();
    const h = radians / 2;
    const s = Math.sin(h);
    return new quat(a.x * s, a.y * s, a.z * s, Math.cos(h));
  }

  /** this * o : apply o first, then this. */
  multiply(o) {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = o.x, by = o.y, bz = o.z, bw = o.w;
    return new quat(
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz
    );
  }

  /** Rotate a vector by this quaternion. */
  multiplyVec3(v) {
    const qx = this.x, qy = this.y, qz = this.z, qw = this.w;
    const ix = qw * v.x + qy * v.z - qz * v.y;
    const iy = qw * v.y + qz * v.x - qx * v.z;
    const iz = qw * v.z + qx * v.y - qy * v.x;
    const iw = -qx * v.x - qy * v.y - qz * v.z;
    return new vec3(
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx
    );
  }

  /** Inverse of a unit quaternion is its conjugate. */
  invert() { return new quat(-this.x, -this.y, -this.z, this.w); }

  normalize() {
    const m = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    return new quat(this.x / m, this.y / m, this.z / m, this.w / m);
  }

  /** Rotation whose local +Z is `forward` and local +Y is nearest `up`. */
  static lookAt(forward, up) {
    const z = forward.normalize();
    let x = up.cross(z);
    if (x.lengthSquared < 1e-8) {
      // forward is parallel to up; any perpendicular will do.
      x = (Math.abs(z.y) < 0.9 ? vec3.up() : vec3.forward()).cross(z);
    }
    x = x.normalize();
    const y = z.cross(x);
    return quat.fromBasis(x, y, z);
  }

  /** Quaternion from an orthonormal basis given as column vectors. */
  static fromBasis(x, y, z) {
    const m00 = x.x, m01 = y.x, m02 = z.x;
    const m10 = x.y, m11 = y.y, m12 = z.y;
    const m20 = x.z, m21 = y.z, m22 = z.z;
    const tr = m00 + m11 + m22;
    let qx, qy, qz, qw;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
    }
    return new quat(qx, qy, qz, qw);
  }

  static slerp(a, b, t) {
    let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (cos > 0.9995) {
      return new quat(a.x + (bx - a.x) * t, a.y + (by - a.y) * t,
                      a.z + (bz - a.z) * t, a.w + (bw - a.w) * t).normalize();
    }
    const th = Math.acos(cos), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return new quat(a.x * wa + bx * wb, a.y * wa + by * wb, a.z * wa + bz * wb, a.w * wa + bw * wb);
  }

  /** Euler angles in radians, applied Y then X then Z about local axes. */
  static fromEulerAngles(x, y, z) {
    const qx = quat.angleAxis(x, new vec3(1, 0, 0));
    const qy = quat.angleAxis(y, new vec3(0, 1, 0));
    const qz = quat.angleAxis(z, new vec3(0, 0, 1));
    return qy.multiply(qx).multiply(qz);
  }
}

/** Components are never actually constructed by the tests; this is a shell. */
class Component {
  constructor() { this.enabled = true; }
  getSceneObject() { return null; }
  getTransform() { return null; }
  destroy() {}
}
class BaseScriptComponent extends Component {
  createEvent() { return { bind() {}, enabled: true }; }
}

class SliderWidget { constructor(min, max, step) { Object.assign(this, { min, max, step }); } }
class ComboBoxWidget { constructor(...items) { this.items = items; } }

const noopClassDecorator = (target) => target;
const noopPropertyDecorator = () => {};
const noopDecoratorFactory = () => noopPropertyDecorator;

function install(target) {
  Object.assign(target, {
    vec3, vec4, quat, Component, BaseScriptComponent, SliderWidget, ComboBoxWidget,
    component: noopClassDecorator,
    input: noopPropertyDecorator,
    allowUndefined: noopPropertyDecorator,
    hint: noopDecoratorFactory,
    label: noopDecoratorFactory,
    widget: noopDecoratorFactory,
    showIf: noopDecoratorFactory,
    typeName: () => noopClassDecorator,
    print: (m) => console.log(m),
    getTime: () => Date.now() / 1000,
    getDeltaTime: () => 1 / 60,
    isNull: (v) => v === null || v === undefined,
    global: { scene: { getRootObject: () => null, getRootObjectsCount: () => 0 } },
  });
}

// Node: the test harness requires this and installs explicitly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { install, vec3, vec4, quat };
}

// Browser: self-install. This file must be a classic <script>, which runs
// during parsing, so the globals exist before any deferred module body runs.
if (typeof window !== "undefined") {
  install(window);
}
