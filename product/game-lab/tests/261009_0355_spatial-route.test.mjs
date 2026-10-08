import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import * as THREE from '../node_modules/three/build/three.module.js';
import { validateFloorRoute, createFloorRoute } from '../public/spatial-route/261009_0355_floor-route.js';
import { createMattercraftRoute } from '../public/spatial-route/261009_0355_mattercraft-bridge.js';

const points = [[0, 0, 0], [3, 0, 0], [3, 0, -4]];
const config = () => ({ id: 'qa-floor-route', mapId: '12345', confirmed: true, coordinateSystem: 'immersal-map-local-metres', points: structuredClone(points), width: 0.4, arrivalRadius: 0.8, arrivalHoldMs: 1500 });
const pose = (x, z, y = 1.6) => [x, y, z];
const tracking = at => ({ localized: true, tracking: true, at });
const closeTo = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, message || `${actual} is close to ${expected}`);

function fixture(options = {}) {
  const scene = new THREE.Group(), outside = new THREE.Group(), trackedChild = new THREE.Group(), inner = new THREE.Group(), element = new THREE.Group();
  scene.add(outside); outside.add(trackedChild); trackedChild.add(inner); inner.add(element);
  const listeners = new Set(), onLocalize = { listeners, addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }, emit() { for (const fn of [...listeners]) fn(); } };
  const anchor = { element: outside, constructorProps: { mapID: '12345' }, localized: { value: true }, status: { value: 1 }, onLocalize, enabledResolved: { value: true }, disposed: false };
  const routeSpace = { parent: anchor, element, enabledResolved: { value: true }, disposed: false };
  const worldTracker = { quality: { value: 1 }, trackingEnabled: { value: true }, enabledResolved: { value: true }, disposed: false };
  const camera = new THREE.PerspectiveCamera(); scene.add(camera);
  let at = 0; const statuses = [], completions = [];
  const bridge = createMattercraftRoute({ THREE, anchor, routeSpace, worldTracker, getCamera: () => camera, config: config(), trackingStatus: 1, goodQuality: 1,
    now: () => at, onStatus: value => statuses.push(value), onComplete: value => completions.push(value), ...options });
  function move(local, time) { at = time; element.updateWorldMatrix(true, false); camera.position.copy(element.localToWorld(new THREE.Vector3(...local))); return bridge.tick(); }
  return { scene, outside, trackedChild, inner, element, anchor, routeSpace, worldTracker, camera, bridge, statuses, completions, move, time(value) { at = value; } };
}

test('바닥 경로는 유한한 평면 좌표와 지정 크기를 검증하고 원본을 복사한다', () => {
  const source = config(), route = validateFloorRoute(source); closeTo(route.length, 7);
  source.points[0][0] = 999; assert.equal(route.points[0][0], 0);
  const invalid = [null, { points: [] }, { points: [[0, 0, 0], [0, 0, 0]] }, { points: [[0, 0, 0], [0.04, 0, 0]] },
    { points: [[0, 0, 0], [1, 0.1, 0]] }, { points: [[0, 0, 0], [Infinity, 0, 0]] }, { points: [[0, 0, 0], [0, 0, NaN]] },
    { points: [[0, 0, 0], [2001, 0, 0]] }, { ...config(), width: 3 }, { ...config(), arrivalRadius: 0 }, { ...config(), arrivalHoldMs: 30001 }];
  for (const value of invalid) assert.throws(() => validateFloorRoute(value), TypeError);
  assert.throws(() => createFloorRoute({ THREE, parent: {}, config: config() }), TypeError);
});

test('경로 리본은 실제 Three.js 평면 geometry이며 화살표가 다음 지점을 향한다', () => {
  const parent = new THREE.Group(), floor = createFloorRoute({ THREE, parent, config: config() });
  try {
    assert.equal(floor.group.parent, parent); assert.equal(floor.group.visible, false); assert.equal(floor.group.children.length, 2);
    floor.group.children.forEach((segment, index) => {
      const ribbon = segment.children[0], arrow = segment.children[1];
      assert.ok(ribbon.isMesh && arrow.isMesh); assert.equal(ribbon.geometry.getIndex().count, 6); assert.equal(arrow.geometry.getIndex().count, 3);
      const vertices = ribbon.geometry.getAttribute('position');
      for (let vertex = 0; vertex < vertices.count; vertex++) closeTo(vertices.getY(vertex), 0.02);
      closeTo(new THREE.Vector3().fromBufferAttribute(vertices, 0).distanceTo(new THREE.Vector3().fromBufferAttribute(vertices, 1)), 0.4);
      const direction = new THREE.Vector3(...points[index + 1]).sub(new THREE.Vector3(...points[index])).normalize();
      const arrowVertices = arrow.geometry.getAttribute('position'), tip = new THREE.Vector3().fromBufferAttribute(arrowVertices, 0);
      for (let vertex = 1; vertex < arrowVertices.count; vertex++) assert.ok(tip.clone().sub(new THREE.Vector3().fromBufferAttribute(arrowVertices, vertex)).dot(direction) > 0);
    });
  } finally { floor.dispose(); }
});

test('GPS와 카메라 높이에 관계없이 다음 경유점부터 지정 순서로 1.5초 머문다', () => {
  const completed = [], floor = createFloorRoute({ THREE, parent: new THREE.Group(), config: config(), onComplete: value => completed.push(value) });
  try {
    assert.equal(floor.update(pose(3, -4), tracking(0)).nextIndex, 1);
    assert.equal(floor.update(pose(3, -4), tracking(750)).nextIndex, 1);
    assert.equal(floor.update(pose(3, -4), tracking(1500)).nextIndex, 1);
    assert.equal(floor.update(pose(3, 0, 20), tracking(2000)).state, 'arriving');
    floor.update(pose(3, 0, 20), tracking(2750)); const first = floor.update(pose(3, 0, 20), tracking(3500));
    assert.equal(first.nextIndex, 2); assert.equal(first.completed, false); assert.equal(floor.group.children[0].visible, false);
    floor.update(pose(3, -4), tracking(4000)); floor.update(pose(3, -4), tracking(4750)); const last = floor.update(pose(3, -4), tracking(5500));
    assert.equal(last.state, 'completed'); assert.equal(last.completed, true); assert.equal(floor.group.visible, false); assert.equal(completed.length, 1);
    floor.update(pose(3, -4), tracking(5750)); assert.equal(completed.length, 1);
  } finally { floor.dispose(); }
});

test('반경 이탈과 추적 손실은 도착 유지 시간을 비우고 복구 후 다시 측정한다', () => {
  const floor = createFloorRoute({ THREE, parent: new THREE.Group(), config: config() });
  try {
    floor.update(pose(3, 0), tracking(0)); floor.update(pose(3, 0), tracking(750));
    floor.update(pose(0, 0), tracking(1000)); assert.equal(floor.update(pose(3, 0), tracking(1500)).nextIndex, 1);
    const lost = floor.update(pose(3, 0), { localized: true, tracking: false, at: 2000 }); assert.equal(lost.state, 'tracking-lost'); assert.equal(floor.group.visible, false);
    assert.equal(floor.update(pose(3, 0), tracking(2500)).nextIndex, 1); assert.equal(floor.group.visible, true);
    floor.update(pose(3, 0), tracking(3250)); assert.equal(floor.update(pose(3, 0), tracking(4000)).nextIndex, 2);
    assert.equal(floor.update(pose(3, -4), { localized: false, tracking: true, at: 4500 }).state, 'localizing'); assert.equal(floor.group.visible, false);
  } finally { floor.dispose(); }
});

test('긴 프레임 공백과 역행 시계 및 무효 pose는 도착을 자동 완료하지 않는다', () => {
  for (const interruption of ['gap', 'clock', 'invalid']) {
    const floor = createFloorRoute({ THREE, parent: new THREE.Group(), config: config() });
    try {
      floor.update(pose(3, 0), tracking(1000)); floor.update(pose(3, 0), tracking(1750));
      const interruptedAt = interruption === 'clock' ? 500 : 5000;
      const interruptedPosition = interruption === 'invalid' ? [3, NaN, 0] : pose(3, 0);
      assert.equal(floor.update(interruptedPosition, tracking(interruptedAt)).nextIndex, 1);
      assert.equal(floor.update(pose(3, 0), tracking(interruptedAt + 750)).nextIndex, 1);
      const next = floor.update(pose(3, 0), tracking(interruptedAt + 1500));
      assert.equal(next.nextIndex, interruption === 'invalid' ? 1 : 2);
    } finally { floor.dispose(); }
  }
});

test('완료 후 초기화하면 모든 구간과 순서 및 도착 유지 시간이 복구된다', () => {
  const completed = [], floor = createFloorRoute({ THREE, parent: new THREE.Group(), config: config(), onComplete: value => completed.push(value) });
  try {
    for (const [x, z, time] of [[3, 0, 0], [3, 0, 750], [3, 0, 1500], [3, -4, 2000], [3, -4, 2750], [3, -4, 3500]]) floor.update(pose(x, z), tracking(time));
    assert.equal(completed.length, 1); const reset = floor.reset(); assert.equal(reset.nextIndex, 1); assert.equal(reset.completed, false);
    assert.equal(floor.group.children.every(segment => segment.visible), true); assert.equal(floor.group.visible, false);
    assert.equal(floor.update(pose(3, 0), tracking(4000)).nextIndex, 1); floor.update(pose(3, 0), tracking(4750)); assert.equal(floor.update(pose(3, 0), tracking(5500)).nextIndex, 2);
  } finally { floor.dispose(); }
});

test('종료는 소유 geometry와 공유 material을 한 번 정리하고 늦은 update를 차단한다', () => {
  const parent = new THREE.Group(), completed = [], floor = createFloorRoute({ THREE, parent, config: config(), onComplete: value => completed.push(value) });
  const geometries = new Set(), materials = new Set(), counts = new Map();
  floor.group.traverse(object => { if (object.geometry) geometries.add(object.geometry); if (object.material) materials.add(object.material); });
  for (const resource of [...geometries, ...materials]) { counts.set(resource, 0); resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1)); }
  floor.update(pose(3, 0), tracking(0)); floor.dispose(); floor.dispose();
  assert.equal(parent.children.length, 0); assert.equal(geometries.size, 4); assert.equal(materials.size, 2);
  for (const count of counts.values()) assert.equal(count, 1);
  assert.equal(floor.update(pose(3, 0), tracking(1500)).state, 'disposed'); assert.equal(floor.reset().state, 'disposed'); assert.equal(completed.length, 0);
});

test('Mattercraft는 확인한 동일 Map ID와 앵커 직계 자식의 기본 변환을 요구한다', () => {
  const f = fixture();
  const base = { THREE, anchor: f.anchor, routeSpace: f.routeSpace, worldTracker: f.worldTracker, getCamera: () => f.camera, trackingStatus: 1, goodQuality: 1, config: config() };
  try {
    for (const change of [{ confirmed: false }, { confirmed: 'false' }, { confirmed: 'true' }, { confirmed: 1 }, { mapId: 'another-map' }, { coordinateSystem: 'gps' }]) assert.throws(() => createMattercraftRoute({ ...base, config: { ...config(), ...change } }), TypeError);
    assert.throws(() => createMattercraftRoute({ ...base, trackingStatus: undefined }), TypeError);
    assert.throws(() => createMattercraftRoute({ ...base, routeSpace: { ...f.routeSpace, parent: {} } }), TypeError);
    for (const apply of [() => f.element.position.set(1, 0, 0), () => f.element.rotation.set(0, 0.2, 0), () => f.element.scale.setScalar(2)]) {
      f.element.position.set(0, 0, 0); f.element.quaternion.identity(); f.element.scale.set(1, 1, 1); apply();
      assert.throws(() => createMattercraftRoute(base), TypeError);
    }
  } finally { f.bridge.dispose(); }
});

test('카메라의 실제 world pose를 SDK 안쪽 추적 좌표로 변환한다', () => {
  const f = fixture();
  try {
    f.outside.position.set(100, 4, -80); f.outside.rotation.y = Math.PI / 3;
    f.trackedChild.position.set(-7, 0.4, 13); f.trackedChild.rotation.y = -Math.PI / 2;
    const result = f.move(pose(3, 0), 0); closeTo(result.distance, 0); assert.equal(result.state, 'arriving'); assert.equal(f.bridge.floor.group.parent, f.element);
    f.move(pose(3, 0), 750); assert.equal(f.move(pose(3, 0), 1500).nextIndex, 2);
    assert.equal(f.statuses.at(-1).nextIndex, 2);
  } finally { f.bridge.dispose(); }
});

test('Immersal localized가 유지되어도 WorldTracker 품질 손실과 복구를 판정한다', () => {
  const f = fixture();
  try {
    f.move(pose(3, 0), 0); f.move(pose(3, 0), 750);
    f.worldTracker.quality.value = 2; assert.equal(f.move(pose(3, 0), 1000).state, 'tracking-lost'); assert.equal(f.bridge.floor.group.visible, false);
    assert.equal(f.anchor.localized.value, true); assert.equal(f.anchor.status.value, 1);
    f.worldTracker.quality.value = 1; assert.equal(f.move(pose(3, 0), 1500).state, 'localizing'); assert.equal(f.bridge.floor.group.visible, false);
    f.anchor.onLocalize.emit(); assert.equal(f.move(pose(3, 0), 2000).nextIndex, 1); f.move(pose(3, 0), 2750); assert.equal(f.move(pose(3, 0), 3500).nextIndex, 2);
    f.anchor.localized.value = false; assert.equal(f.bridge.tick().state, 'localizing'); assert.equal(f.bridge.floor.group.visible, false);
    f.anchor.localized.value = true; f.anchor.status.value = 2; assert.equal(f.bridge.tick().state, 'tracking-lost');
  } finally { f.bridge.dispose(); }
});

test('추적 비활성 및 disposed 부모와 특이행렬은 경로를 숨기며 완료하지 않는다', () => {
  const changes = [f => { f.routeSpace.enabledResolved.value = false; }, f => { f.worldTracker.trackingEnabled.value = false; }, f => { f.worldTracker.enabledResolved.value = false; }, f => { f.anchor.enabledResolved.value = false; },
    f => { f.worldTracker.disposed = true; }, f => { f.anchor.disposed = true; }, f => { f.routeSpace.disposed = true; }, f => { f.trackedChild.scale.set(0, 1, 1); }];
  for (const change of changes) {
    const f = fixture();
    try { f.move(pose(3, 0), 0); change(f); f.time(1500); assert.equal(f.bridge.tick().state, 'tracking-lost'); assert.equal(f.bridge.floor.group.visible, false); assert.equal(f.completions.length, 0); }
    finally { f.bridge.dispose(); }
  }
  const f = fixture({ getCamera: () => null });
  try { assert.equal(f.bridge.tick().state, 'camera-missing'); assert.equal(f.bridge.floor.group.visible, false); } finally { f.bridge.dispose(); }
});

test('bridge pause와 reset은 도착 측정을 비우고 상태 안내를 중복 발행하지 않는다', () => {
  const f = fixture();
  try {
    f.move(pose(3, 0), 0); f.move(pose(3, 0), 750); assert.equal(f.statuses.length, 1);
    f.bridge.pause(); f.bridge.pause(); assert.equal(f.statuses.length, 2);
    assert.equal(f.move(pose(3, 0), 1000).state, 'localizing'); assert.equal(f.bridge.floor.group.visible, false);
    f.anchor.onLocalize.emit(); f.move(pose(3, 0), 1500); assert.equal(f.move(pose(3, 0), 2250).nextIndex, 1);
    assert.equal(f.bridge.reset().nextIndex, 1); assert.equal(f.bridge.floor.group.visible, false);
    assert.equal(f.move(pose(3, 0), 2500).state, 'localizing');
    f.anchor.onLocalize.emit(); f.move(pose(3, 0), 3000); assert.equal(f.move(pose(3, 0), 3750).nextIndex, 1);
  } finally { f.bridge.dispose(); }
});

test('bridge 완료 결과는 경로와 맵을 식별하고 dispose 이후 늦은 tick은 조용히 끝난다', () => {
  const f = fixture();
  for (const [x, z, time] of [[3, 0, 0], [3, 0, 750], [3, 0, 1500], [3, -4, 2000], [3, -4, 2750], [3, -4, 3500]]) f.move(pose(x, z), time);
  assert.deepEqual(f.completions, [{ completed: true, waypointCount: 2, mapId: '12345', routeId: 'qa-floor-route' }]);
  const statusCount = f.statuses.length, lateLocalize = [...f.anchor.onLocalize.listeners][0]; assert.equal(f.anchor.onLocalize.listeners.size, 1);
  f.bridge.dispose(); f.bridge.dispose(); assert.equal(f.anchor.onLocalize.listeners.size, 0); lateLocalize(); f.anchor.onLocalize.emit();
  f.worldTracker.quality.value = 1; f.anchor.localized.value = true;
  assert.equal(f.bridge.tick().state, 'disposed'); f.bridge.pause(); f.bridge.reset();
  assert.equal(f.element.children.length, 0); assert.equal(f.statuses.length, statusCount); assert.equal(f.completions.length, 1);
});

test('손실 중 들어온 localization은 GOOD 복귀를 승인하지 않고 새 성공을 기다린다', () => {
  const f = fixture();
  try {
    f.move(pose(3, 0), 0); f.worldTracker.quality.value = 2; assert.equal(f.bridge.tick().state, 'tracking-lost');
    f.anchor.onLocalize.emit(); f.worldTracker.quality.value = 1;
    assert.equal(f.move(pose(3, 0), 2000).state, 'localizing'); assert.equal(f.bridge.floor.group.visible, false);
    f.anchor.onLocalize.emit(); assert.equal(f.move(pose(3, 0), 2250).state, 'arriving'); assert.equal(f.bridge.floor.group.visible, true);
    f.move(pose(3, 0), 3000); assert.equal(f.move(pose(3, 0), 3750).nextIndex, 2);
  } finally { f.bridge.dispose(); }
});

test('활성화되지 않은 상태의 localization도 추적을 재개하지 않는다', () => {
  for (const change of [f => { f.worldTracker.trackingEnabled.value = false; }, f => { f.worldTracker.enabledResolved.value = false; }, f => { f.anchor.enabledResolved.value = false; }]) {
    const f = fixture();
    try {
      f.move(pose(3, 0), 0); f.bridge.pause(); change(f); f.anchor.onLocalize.emit();
      f.worldTracker.trackingEnabled.value = true; f.worldTracker.enabledResolved.value = true; f.anchor.enabledResolved.value = true;
      assert.equal(f.bridge.tick().state, 'localizing'); assert.equal(f.bridge.floor.group.visible, false);
      f.anchor.onLocalize.emit(); assert.equal(f.move(pose(3, 0), 2000).state, 'arriving');
    } finally { f.bridge.dispose(); }
  }
});

test('실제 Mattercraft Behavior는 화면 복귀 후 새 VPS 성공을 기다리고 늦은 started를 폐기한다', async t => {
  const f = fixture(); f.bridge.dispose();
  const frameListeners = new Set(), frame = { addListener(fn) { frameListeners.add(fn); }, removeListener(fn) { frameListeners.delete(fn); }, emit() { for (const fn of [...frameListeners]) fn(); } };
  class Group {}
  class WorldTracker extends Group {}
  class ImmersalAnchorGroup extends Group {}
  class Behavior {
    disposed = false; bindings = [];
    register(event, fn) { event.addListener(fn); this.bindings.push([event, fn]); }
    dispose() { this.disposed = true; for (const [event, fn] of this.bindings) event.removeListener(fn); }
  }
  const window = new EventTarget(), document = new EventTarget(), published = [];
  document.hidden = false; window.addEventListener('nonol:spatial-route-status', event => published.push(event.detail));
  const worldTracker = Object.assign(new WorldTracker(), f.worldTracker), anchor = Object.assign(new ImmersalAnchorGroup(), f.anchor, { parent: worldTracker });
  const instance = Object.assign(new Group(), f.routeSpace, { parent: anchor });
  const globals = { window, document, __nonolMattercraftRouteTest: {
    Behavior, Group, WorldTracker, ImmersalAnchorGroup, THREE, config: config(), createMattercraftRoute,
    isDesignTime: () => false, started: context => context.started || Promise.resolve(), useCamera: () => ({ value: f.camera }), useOnAfterRender: () => frame,
    Zappar: { AnchorStatus: { ANCHOR_STATUS_TRACKING: 1 }, WorldTrackerQuality: { WORLD_TRACKER_QUALITY_GOOD: 1 } }
  } };
  const previous = new Map(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const source = await readFile(new URL('../public/spatial-route/261009_0355_MattercraftFloorRoute.ts', import.meta.url), 'utf8');
  const bindings = 'const {Behavior,Group,WorldTracker,ImmersalAnchorGroup,THREE,config,createMattercraftRoute,isDesignTime,started,useCamera,useOnAfterRender,Zappar}=globalThis.__nonolMattercraftRouteTest;\n';
  const transformed = await transform(bindings + source.replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'esm', target: 'es2022' });
  const { default: MattercraftFloorRoute } = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`);
  const behavior = new MattercraftFloorRoute({}, instance);
  try {
    await new Promise(resolve => setImmediate(resolve)); f.camera.position.set(3, 1.6, 0); frame.emit(); assert.equal(published.at(-1).state, 'arriving');
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    anchor.onLocalize.emit();
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); frame.emit();
    assert.equal(published.at(-1).state, 'localizing', 'a background VPS response cannot approve the first visible frame');
    anchor.onLocalize.emit(); frame.emit(); assert.equal(published.at(-1).state, 'arriving');
    window.dispatchEvent(new Event('pagehide')); frame.emit(); assert.equal(published.at(-1).state, 'localizing');
  } finally { behavior.dispose(); }
  const endedCount = published.length; assert.equal(frameListeners.size, 0); assert.equal(anchor.onLocalize.listeners.size, 0); assert.equal(f.element.children.length, 0);
  document.dispatchEvent(new Event('visibilitychange')); frame.emit(); assert.equal(published.length, endedCount);
  let startLate; const delayed = new MattercraftFloorRoute({ started: new Promise(resolve => { startLate = resolve; }) }, instance);
  delayed.dispose(); startLate(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(frameListeners.size, 0); assert.equal(anchor.onLocalize.listeners.size, 0); assert.equal(f.element.children.length, 0); assert.equal(published.length, endedCount);
});
