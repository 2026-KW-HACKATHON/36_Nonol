import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class Element extends EventTarget {
  children = [];
  style = {};
  dataset = {};
  isConnected = true;
  clientWidth = 360;
  clientHeight = 500;
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
  setAttribute() {}
  focus() { globalThis.document.activeElement = this; }
  querySelector(name) { return this.children.find(child => child.tagName === name); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
}
const metrics = () => globalThis.__npcARMetrics;
class Vector {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  setScalar(value) { return this.set(value, value, value); }
  copy(value) { return this.set(value.x, value.y, value.z); }
  clone() { return new Vector(this.x, this.y, this.z); }
  add(value) { return this.set(this.x + value.x, this.y + value.y, this.z + value.z); }
  addScaledVector(value, scale) { return this.set(this.x + value.x * scale, this.y + value.y * scale, this.z + value.z * scale); }
  multiplyScalar(scale) { return this.set(this.x * scale, this.y * scale, this.z * scale); }
  applyQuaternion(q) {
    const { x, y, z } = this;
    const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x, iw = -q.x * x - q.y * y - q.z * z;
    return this.set(ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
  }
  normalize() { const length = Math.hypot(this.x, this.y, this.z) || 1; return this.multiplyScalar(1 / length); }
  setFromMatrixPosition(matrix) { return this.set(matrix.values[12], matrix.values[13], matrix.values[14]); }
  transformDirection(matrix) { const m = matrix.values; return this.set(m[0] * this.x + m[4] * this.y + m[8] * this.z, m[1] * this.x + m[5] * this.y + m[9] * this.z, m[2] * this.x + m[6] * this.y + m[10] * this.z).normalize(); }
}
class Matrix {
  fromArray(values) { this.values = values; return this; }
}
class Group {
  children = [];
  position = new Vector();
  scale = new Vector(1, 1, 1);
  rotation = {};
  quaternion = { x: 0, y: 0, z: 0, w: 1 };
  getWorldDirection(target) { return target.set(0, 0, -1); }
  updateMatrixWorld() {}
  add(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  removeFromParent() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  traverse(callback) { callback(this); for (const child of this.children) child.traverse(callback); }
}
class Mesh extends Group {
  matrix = new Matrix();
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}
class Geometry {
  rotateX() { return this; }
  dispose() { metrics().geometries++; }
}
class Material {
  dispose() { metrics().materials++; }
}
class Renderer {
  domElement = new Element();
  xr = { setReferenceSpaceType() {}, async setSession() { await metrics().sessionSetup?.(); }, getReferenceSpace: () => ({}) };
  setPixelRatio() {}
  setSize() {}
  setAnimationLoop(loop) { metrics().loop = loop; }
  render() {}
  dispose() { metrics().renderers++; }
}
class Raycaster {
  ray = { origin: new Vector(), direction: new Vector() };
  setFromCamera() {}
  intersectObject() { return metrics().missSpirit ? [] : [{}]; }
}
globalThis.__npcTestThree = {
  Scene: Group, Group, Mesh, WebGLRenderer: Renderer, PerspectiveCamera: Group, HemisphereLight: Group,
  CylinderGeometry: Geometry, TorusGeometry: Geometry, SphereGeometry: Geometry, ConeGeometry: Geometry, RingGeometry: Geometry,
  MeshStandardMaterial: Material, MeshBasicMaterial: Material, Raycaster, Matrix4: Matrix, Vector3: Vector, Vector2: Vector, DoubleSide: 2,
};
const threeModule = `data:text/javascript,${encodeURIComponent(Object.keys(globalThis.__npcTestThree).map(name => `export const ${name} = globalThis.__npcTestThree.${name};`).join('\n'))}`;
const sourcePath = new URL('../public/npc-ar.js', import.meta.url);
const source = (await readFile(sourcePath, 'utf8'))
  .replace("import('/vendor/three.module.js')", `import('${threeModule}')`)
  .replace(/from '\.\/([^']+)'/g, (_match, path) => `from '${new URL(path, sourcePath).href}'`);
const { NpcAR, placeSpiritAhead, makeSpirit } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('NPC creation follows camera yaw and keeps the model facing the participant', t => {
  fixture(t);
  const spirit = makeSpirit(globalThis.__npcTestThree);
  assert.deepEqual(spirit.scale, new Vector(.65, .65, .65));
  const camera = { position: new Vector(4, 1.6, 7), quaternion: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } };
  placeSpiritAhead(globalThis.__npcTestThree, spirit, camera);
  assert.equal(spirit.visible, true);
  assert.ok(Math.abs(spirit.position.x - 3) < 1e-10);
  assert.ok(Math.abs(spirit.position.z - 7) < 1e-10);
  assert.ok(Math.abs(spirit.rotation.y - Math.PI / 2) < 1e-10);
});

function fixture(t, { requestSession, hitTest, sessionSetup } = {}) {
  const previous = new Map();
  const stats = { ended: 0, canceled: 0, renderers: 0, geometries: 0, materials: 0, hitRequests: 0, loop: null };
  stats.sessionSetup = sessionSetup;
  const session = new EventTarget();
  session.end = async () => { stats.ended++; session.dispatchEvent(new Event('end')); };
  session.requestReferenceSpace = async type => { assert.equal(type, 'viewer'); return {}; };
  session.requestHitTestSource = async () => { stats.hitRequests++; return hitTest ? hitTest() : { cancel() { stats.canceled++; } }; };
  const values = {
    __npcARMetrics: stats,
    isSecureContext: true,
    navigator: { xr: {
      isSessionSupported: async () => true,
      requestSession: (mode, options) => { assert.equal(mode, 'immersive-ar'); stats.options = options; return requestSession ? requestSession() : Promise.resolve(session); },
    } },
    document: { createElement(tagName) { const element = new Element(); element.tagName = tagName; return element; } },
  };
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const statuses = [];
  const container = new Element();
  const ar = new NpcAR({ onStatus: status => statuses.push(status) });
  t.after(async () => {
    await ar.stop();
    for (const [name, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
  });
  return { ar, session, stats, statuses, container };
}

test('mocked WebXR permission denial offers 2D and leaves no active session', async t => {
  const f = fixture(t, { requestSession: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
  assert.equal(await f.ar.start(f.container), false);
  assert.equal(f.statuses.at(-1).state, 'denied');
  assert.match(f.statuses.at(-1).message, /2D/);
  assert.equal(f.ar.session, null);
  assert.equal(f.ar.starting, false);
  assert.equal(f.container.children.length, 0);
});

test('mocked WebXR starts without requiring or requesting a hit-test source', async t => {
  const f = fixture(t, { hitTest: async () => { throw Object.assign(new Error('no hit-test'), { name: 'NotSupportedError' }); } });
  assert.equal(await f.ar.start(f.container), true);
  assert.deepEqual(f.stats.options.requiredFeatures, ['local']);
  assert.equal(f.stats.options.domOverlay.root, f.container);
  assert.equal(f.statuses.at(-1).state, 'active');
  assert.equal(f.stats.hitRequests, 0);
  assert.equal(f.stats.ended, 0);
  assert.equal(f.ar.session, f.session);
});

test('mocked active WebXR cleanup is complete and idempotent', async t => {
  const f = fixture(t);
  assert.equal(await f.ar.start(f.container), true);
  assert.equal(f.ar.session, f.session);
  assert.equal(f.container.children.length, 2);
  assert.equal(typeof f.stats.loop, 'function');
  await f.ar.stop();
  const afterStop = { ended: f.stats.ended, canceled: f.stats.canceled, renderers: f.stats.renderers, geometries: f.stats.geometries, materials: f.stats.materials };
  assert.equal(afterStop.ended, 1);
  assert.equal(afterStop.canceled, 0);
  assert.equal(afterStop.renderers, 1);
  assert.equal(f.stats.loop, null);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.ar.session, null);
  assert.equal(f.ar.resources, null);
  await f.ar.stop();
  assert.deepEqual({ ended: f.stats.ended, canceled: f.stats.canceled, renderers: f.stats.renderers, geometries: f.stats.geometries, materials: f.stats.materials }, afterStop);
});

test('mocked WebXR renderer setup arriving after stage cleanup cannot recreate the scene', async t => {
  let resolveSetup, entered = false;
  const pending = new Promise(resolve => { resolveSetup = resolve; });
  const f = fixture(t, { sessionSetup: () => { entered = true; return pending; } });
  const opening = f.ar.start(f.container);
  for (let attempt = 0; attempt < 30 && !entered; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true);
  await f.ar.stop();
  resolveSetup();
  assert.equal(await opening, false);
  assert.equal(f.stats.ended, 1);
  assert.equal(f.stats.canceled, 0);
  assert.equal(f.stats.renderers, 1);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.ar.session, null);
});

test('mocked WebXR spirit appears ahead without floor hits and keeps the 1.5m touch gate', async t => {
  const f = fixture(t);
  let touches = 0, accepted = false;
  f.ar.onTouch = () => { touches++; return accepted; };
  assert.equal(await f.ar.start(f.container), true);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const pose = z => ({ transform: { position: { x: 0, y: 1.6, z }, orientation: { x: 0, y: 0, z: 0, w: 1 }, matrix } });
  const frame = z => ({
    getViewerPose: () => pose(z), getPose: () => pose(0),
    getHitTestResults: () => { throw new Error('floor hit-test must not run'); },
  });
  const select = z => { const event = new Event('select'); Object.assign(event, { frame: frame(z), inputSource: { targetRaySpace: {} } }); f.session.dispatchEvent(event); };
  select(0);
  assert.equal(touches, 0);
  f.stats.loop(0, frame(0));
  const spirit = f.ar.resources.scene.children.find(child => child.children.length > 0);
  assert.equal(spirit.visible, true);
  assert.equal(spirit.position.x, 0);
  assert.equal(spirit.position.z, -1);
  assert.ok(spirit.position.y < 1.6 && spirit.position.y > 1);
  f.stats.loop(1, frame(.4));
  assert.equal(spirit.position.z, -1, 'created NPC remains fixed after camera movement');
  select(.6);
  assert.equal(touches, 0);
  f.stats.missSpirit = true; select(.5);
  assert.equal(touches, 0);
  f.stats.missSpirit = false; select(.5);
  assert.equal(touches, 1);
  assert.match(f.statuses.at(-1).message, /다시/);
  accepted = true;
  select(.5); select(.5);
  assert.equal(touches, 2);
  assert.match(f.statuses.at(-1).message, /만났습니다/);
  await f.ar.stop();
  select(0);
  assert.equal(touches, 2);
});

test('mocked old WebXR session ending late preserves a new active session status', async t => {
  const f = fixture(t);
  assert.equal(await f.ar.start(f.container), true);
  let endOld;
  const pendingEnd = new Promise(resolve => { endOld = resolve; });
  f.session.end = () => pendingEnd.then(() => { f.stats.ended++; f.session.dispatchEvent(new Event('end')); });
  const closing = f.ar.stop();
  const nextSession = new EventTarget();
  nextSession.end = async () => { f.stats.ended++; nextSession.dispatchEvent(new Event('end')); };
  nextSession.requestReferenceSpace = async () => ({});
  nextSession.requestHitTestSource = async () => ({ cancel() { f.stats.canceled++; } });
  globalThis.navigator.xr.requestSession = async () => nextSession;
  assert.equal(await f.ar.start(f.container), true);
  assert.equal(f.statuses.at(-1).state, 'active');
  endOld(); await closing;
  assert.equal(f.ar.session, nextSession);
  assert.equal(f.statuses.at(-1).state, 'active');
  assert.equal(f.container.children.length, 2);
  assert.equal(f.stats.canceled, 0);
  await f.ar.stop();
  assert.equal(f.stats.canceled, 0);
  assert.equal(f.container.children.length, 0);
});

async function webarFixture(t, { compatible = true, failDownload = false, failRun = false, motionPermission } = {}) {
  const stats = { downloads: 0, runs: 0, stops: 0, trackStops: 0, renderers: 0, geometries: 0, materials: 0, focused: 0, hitRequests: 0 };
  const scene = new Group(), camera = new Group();
  const XR8 = {
    XrConfig: { device: () => ({ MOBILE_AND_HEADSETS: 'mobile' }), camera: () => ({ BACK: 'back' }) },
    XrDevice: { isDeviceBrowserCompatible: () => compatible },
    GlTextureRenderer: { pipelineModule: () => ({ name: 'gl-texture' }) },
    Threejs: { pipelineModule: () => ({ name: 'three' }), xrScene: () => ({ scene, camera }) },
    XrController: { pipelineModule: () => ({ name: 'controller' }), configure: options => { stats.trackingOptions = options; }, updateCameraProjectionMatrix() {}, hitTest: () => { stats.hitRequests++; return []; } },
    addCameraPipelineModules: modules => { stats.modules = modules; stats.pipeline = modules.find(module => module.name === 'nonol-npc-webar'); },
    run: options => { stats.runs++; stats.runOptions = options; if (failRun) throw new Error('SDK failed'); },
    stop: () => { stats.stops++; },
    removeCameraPipelineModules: names => { stats.removed = names; },
  };
  const head = new Element(), body = new Element(), window = new EventTarget();
  body.style.overflow = 'auto';
  const previousFocus = { isConnected: true, focus() { stats.focused++; } };
  const document = { head, body, activeElement: previousFocus, createElement(tagName) { const element = new Element(); element.tagName = tagName; return element; } };
  head.append = script => {
    Element.prototype.append.call(head, script); stats.downloads++;
    if (failDownload) queueMicrotask(() => script.onerror());
  };
  const values = { __npcARMetrics: stats, XR8: undefined, THREE: undefined, window, document, innerWidth: 360, innerHeight: 800, isSecureContext: true, DeviceMotionEvent: motionPermission ? class { static requestPermission() { return motionPermission; } } : undefined, DeviceOrientationEvent: undefined, navigator: { mediaDevices: { async getUserMedia() { throw new Error('capability must not request the camera'); } } } };
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const providerPath = new URL('../public/261008_2234_npc-webar.js', import.meta.url);
  const providerSource = (await readFile(providerPath, 'utf8'))
    .replace("import('/vendor/three.module.js')", `import('${threeModule}')`)
    .replace(/from '\.\/([^']+)'/g, (_match, path) => `from '${new URL(path, providerPath).href}'`);
  const { NpcWebAR } = await import(`data:text/javascript,${encodeURIComponent(providerSource)}#${crypto.randomUUID()}`);
  const statuses = [], container = new Element();
  const ar = new NpcWebAR({ onStatus: status => statuses.push(status) });
  t.after(() => {
    ar.stop();
    for (const [name, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
  });
  const ready = () => { globalThis.XR8 = XR8; window.dispatchEvent(new Event('xrloaded')); };
  return { ar, XR8, stats, statuses, container, document, scene, camera, ready };
}

test('mocked WebAR creates a visible spirit before tracking with no floor hits, then anchors it', async t => {
  const f = await webarFixture(t);
  const preparing = f.ar.capability(); f.ready(); await preparing;
  let touches = 0, accepted = false;
  f.ar.onTouch = () => { touches++; return accepted; };
  const opening = f.ar.start(f.container);
  await f.stats.pipeline.onBeforeRun();
  f.stats.pipeline.onStart();
  assert.equal(await opening, true);
  const spirit = f.ar.resources.spirit, canvas = f.ar.resources.canvas;
  assert.equal(spirit.visible, true);
  assert.equal(spirit.position.z, 1, 'initial camera z=2 creates NPC one meter ahead');
  assert.ok(spirit.position.y < f.camera.position.y);
  f.camera.position.set(2, 1.6, 3);
  f.stats.pipeline.onUpdate({ processCpuResult: { reality: { trackingStatus: 'LIMITED', trackingReason: 'INITIALIZING' } } });
  assert.equal(spirit.visible, true);
  assert.equal(spirit.position.x, 2);
  assert.equal(spirit.position.z, 2);
  assert.equal(f.stats.hitRequests, 0);
  const touch = () => { const event = new Event('pointerdown'); Object.assign(event, { clientX: 180, clientY: 250 }); canvas.dispatchEvent(event); };
  touch();
  assert.equal(touches, 1, 'visible spirit can be touched while engine initialization continues');
  f.stats.pipeline.onUpdate({ processCpuResult: { reality: { trackingStatus: 'NORMAL', trackingReason: 'UNSPECIFIED' } } });
  const anchored = spirit.position.clone();
  f.camera.position.set(5, 1.6, 3);
  f.stats.pipeline.onUpdate({ processCpuResult: { reality: { trackingStatus: 'NORMAL', trackingReason: 'UNSPECIFIED' } } });
  assert.deepEqual(spirit.position, anchored, 'NPC stays at its first tracked position');
  touch(); assert.equal(touches, 1, 'outside 1.5m cannot touch');
  f.camera.position.copy(anchored).add(new Vector(0, .25, 1.5));
  f.stats.missSpirit = true; touch(); assert.equal(touches, 1, 'touch must hit the actual model');
  f.stats.missSpirit = false; accepted = true; touch(); touch();
  assert.equal(touches, 2, 'accepted touch completes once');
  assert.match(f.statuses.at(-1).message, /만났습니다/);
  f.ar.stop(); touch();
  assert.equal(touches, 2);
  assert.equal(f.stats.stops, 1);
  assert.equal(f.container.children.length, 0);
  assert.ok(f.stats.geometries > 0);
});

test('mocked WebAR download failure is actionable and compatibility rejects unsupported devices', async t => {
  const f = await webarFixture(t, { failDownload: true });
  const failed = await f.ar.capability();
  assert.equal(failed.supported, false);
  assert.equal(failed.state, 'error');
  assert.match(failed.message, /2D/);
  assert.equal(f.stats.downloads, 1);
  assert.equal(f.document.head.children.length, 0);
  assert.equal(f.stats.runs, 0);
  globalThis.XR8 = f.XR8;
  f.XR8.XrDevice.isDeviceBrowserCompatible = () => false;
  const unsupported = await f.ar.capability();
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.state, 'unsupported');
  assert.equal(f.stats.runs, 0);
});

test('mocked WebAR preparation arriving after cleanup cannot start a session', async t => {
  const f = await webarFixture(t);
  const preparing = f.ar.capability();
  assert.equal(f.stats.downloads, 1);
  f.ar.stop(); f.ready();
  const canceled = await preparing;
  assert.equal(canceled.supported, false);
  assert.equal(canceled.state, 'canceled');
  assert.equal(await f.ar.start(f.container), false);
  assert.equal(f.stats.runs, 0);
  assert.equal(f.container.children.length, 0);
});

test('mocked WebAR session starts on the user action and cleans SDK, camera and overlay', async t => {
  const f = await webarFixture(t);
  const preparing = f.ar.capability(); f.ready();
  assert.equal((await preparing).supported, true);
  assert.equal(f.stats.runs, 0);
  const opening = f.ar.start(f.container);
  assert.equal(f.stats.runs, 1);
  assert.equal(f.ar.starting, true);
  assert.equal(f.container.children.length, 1);
  assert.equal(f.document.body.style.overflow, 'hidden');
  assert.deepEqual(f.stats.trackingOptions, { disableWorldTracking: false, scale: 'absolute' });
  f.stats.pipeline.onStart();
  assert.equal(await opening, true);
  assert.equal(f.ar.active, true);
  f.stats.pipeline.onCameraStatusChange({ status: 'hasStream', stream: { getTracks: () => [{ stop() { f.stats.trackStops++; } }] } });
  f.ar.stop();
  assert.equal(f.ar.active, false);
  assert.equal(f.stats.stops, 1);
  assert.equal(f.stats.trackStops, 1);
  assert.deepEqual(f.stats.removed, ['gl-texture', 'three', 'controller', 'nonol-npc-webar']);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.document.body.style.overflow, 'auto');
  assert.equal(f.stats.focused, 1);
  assert.ok(f.stats.geometries > 0);
  assert.ok(f.stats.materials > 0);
  f.ar.stop();
  assert.equal(f.stats.stops, 1);
  assert.equal(f.stats.trackStops, 1);
});

for (const failure of ['track', 'geometry']) test(`real WebAR stop restores the overlay and scroll after a ${failure} cleanup error`, async t => {
  const f = await webarFixture(t);
  const preparing = f.ar.capability(); f.ready(); await preparing;
  const opening = f.ar.start(f.container); f.stats.pipeline.onStart(); await opening;
  if (failure === 'track') {
    f.stats.pipeline.onCameraStatusChange({ status: 'hasStream', stream: { getTracks: () => [
      { stop() { throw new Error('QA track cleanup failure'); } },
      { stop() { f.stats.trackStops++; } },
    ] } });
  } else {
    f.ar.resources.spirit.children[0].geometry.dispose = () => { throw new Error('QA geometry cleanup failure'); };
  }
  let result;
  assert.doesNotThrow(() => { result = f.ar.stop(); });
  assert.equal(result, false, 'cleanup failure is reported without throwing');
  assert.equal(f.container.children.length, 0);
  assert.equal(f.document.body.style.overflow, 'auto');
  assert.equal(f.stats.focused, 1);
  assert.equal(f.ar.active, false);
  assert.equal(f.ar.resources, null);
  if (failure === 'track') assert.equal(f.stats.trackStops, 1, 'remaining camera tracks are still stopped');
  assert.doesNotThrow(() => f.ar.stop());
});

test('mocked late WebAR camera and startup callbacks remain canceled after cleanup', async t => {
  const f = await webarFixture(t);
  const preparing = f.ar.capability(); f.ready(); await preparing;
  const opening = f.ar.start(f.container);
  const pipeline = f.stats.pipeline;
  f.ar.stop();
  assert.equal(await opening, false);
  pipeline.onStart();
  pipeline.onCameraStatusChange({ status: 'hasStream', stream: { getTracks: () => [{ stop() { f.stats.trackStops++; } }] } });
  pipeline.onException();
  assert.equal(f.ar.active, false);
  assert.equal(f.stats.trackStops, 1);
  assert.equal(f.stats.stops, 1);
  assert.equal(f.stats.geometries, 0);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.statuses.at(-1).state, 'stopped');
});

test('mocked WebAR SDK startup failure closes the overlay and offers 2D', async t => {
  const f = await webarFixture(t, { failRun: true });
  const preparing = f.ar.capability(); f.ready(); await preparing;
  assert.equal(await f.ar.start(f.container), false);
  assert.equal(f.stats.runs, 1);
  assert.equal(f.stats.stops, 1);
  assert.equal(f.ar.starting, false);
  assert.equal(f.ar.active, false);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.document.body.style.overflow, 'auto');
  assert.equal(f.statuses.at(-1).state, 'error');
  assert.match(f.statuses.at(-1).message, /2D/);
});

test('mocked WebAR motion permission arriving after stop rejects engine startup', async t => {
  let grant;
  const permission = new Promise(resolve => { grant = resolve; });
  const f = await webarFixture(t, { motionPermission: permission });
  const preparing = f.ar.capability(); f.ready(); await preparing;
  const opening = f.ar.start(f.container);
  const rejected = assert.rejects(f.stats.pipeline.onBeforeRun());
  f.ar.stop();
  grant('granted');
  await rejected;
  assert.equal(await opening, false);
  assert.equal(f.ar.active, false);
  assert.equal(f.stats.stops, 1);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.document.body.style.overflow, 'auto');
});
