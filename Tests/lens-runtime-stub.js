/**
 * lens-runtime-stub.js
 * -----------------------------------------------------------------------------
 * Minimal stand-in for the Lens Studio runtime so Spatialis logic can be run
 * and asserted under plain Node, with no Lens Studio install and no headset.
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

class quat {
  constructor(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; }
  multiply(o) { return o; }
  multiplyVec3(v) { return v; }
  invert() { return this; }
  normalize() { return this; }
  static quatIdentity() { return new quat(0, 0, 0, 1); }
  static angleAxis(radians, axis) { return new quat(axis.x, axis.y, axis.z, radians); }
  static lookAt(forward, up) { return new quat(forward.x, forward.y, forward.z, up.y); }
  static slerp(a, b) { return b; }
  static fromEulerAngles(x, y, z) { return new quat(x, y, z, 1); }
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
    print: (m) => process.env.SPATIALIS_QUIET ? undefined : console.log(m),
    getTime: () => Date.now() / 1000,
    getDeltaTime: () => 1 / 60,
    isNull: (v) => v === null || v === undefined,
    global: { scene: { getRootObject: () => null, getRootObjectsCount: () => 0 } },
  });
}

module.exports = { install, vec3, vec4, quat };
