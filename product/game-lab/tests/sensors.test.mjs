import test from 'node:test';
import assert from 'node:assert/strict';
import { Sensors } from '../public/lab-sensors.js';
import { NpcAR } from '../public/npc-ar.js';

function environment(t, overrides = {}) {
  for (const [key, value] of Object.entries(overrides)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
}

function orientation(target, properties) {
  const event = new Event('deviceorientation');
  Object.assign(event, properties);
  target.dispatchEvent(event);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('GPS emits coordinates without treating movement heading as compass heading', (t) => {
  let success;
  const cleared = [];
  environment(t, { navigator: { geolocation: {
    watchPosition(callback) { success = callback; return 7; },
    clearWatch(id) { cleared.push(id); },
  } } });
  const positions = [];
  const sensor = new Sensors({ onPosition: (position) => positions.push(position) });
  assert.equal(sensor.startGPS(), true);
  const measuredAt = Date.now();
  success({ coords: { latitude: 37, longitude: 127, accuracy: 15, heading: 90 }, timestamp: measuredAt });
  assert.deepEqual(positions[0], { lat: 37, lon: 127, accuracy: 15, heading: null, source: 'gps', measuredAt });
  sensor.stopGPS();
  success({ coords: { latitude: 38, longitude: 128, accuracy: 15 }, timestamp: measuredAt + 1 });
  assert.equal(positions.length, 1);
  assert.deepEqual(cleared, [7]);
});


test('GPS rejects stale and future measurements while preserving a valid measurement timestamp', (t) => {
  let success;
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  environment(t, { navigator: { geolocation: {
    watchPosition(callback) { success = callback; return 7; }, clearWatch() {},
  } } });
  const positions = [], statuses = [];
  const sensor = new Sensors({ onPosition: value => positions.push(value), onStatus: value => statuses.push(value) });
  t.after(() => sensor.stop());
  sensor.startGPS();
  const fix = timestamp => ({ coords: { latitude: 37, longitude: 127, accuracy: 5 }, timestamp });
  success(fix(now - 30001)); success(fix(now + 5001));
  assert.equal(positions.length, 0);
  assert.equal(statuses.at(-1).state, 'error');
  success(fix(now - 29999));
  assert.equal(positions[0].measuredAt, now - 29999);
  success(fix(now - 30000));
  assert.equal(positions.length, 1, 'older sensor fix cannot replace the last valid fix');
});

test('GPS permission errors produce an actionable denied status', (t) => {
  let failure;
  environment(t, { navigator: { geolocation: { watchPosition(_success, error) { failure = error; return 1; }, clearWatch() {} } } });
  const statuses = [];
  const sensor = new Sensors({ onStatus: (status) => statuses.push(status) });
  sensor.startGPS();
  failure({ code: 1 });
  assert.equal(statuses.at(-1).state, 'denied');
  assert.equal(sensor.watchId, null);
});

test('GPS refreshes an idle foreground fix without overlapping requests or changing old timestamps', (t) => {
  let tick, watch, refresh, requests = 0, now = 1000;
  const page = { visibilityState: 'visible' };
  const positions = [], cleared = [];
  t.mock.method(Date, 'now', () => now);
  environment(t, {
    document: page,
    setInterval(callback, delay) { assert.equal(delay, 10000); tick = callback; return 44; },
    clearInterval(id) { cleared.push(id); },
    navigator: { geolocation: {
      watchPosition(success) { watch = success; return 7; }, clearWatch() {},
      getCurrentPosition(success, _error, options) { requests++; refresh = success; assert.equal(options.maximumAge, 0); },
    } },
  });
  const sensor = new Sensors({ onPosition: position => positions.push(position) });
  t.after(() => sensor.stopGPS());
  const fix = timestamp => ({ coords: { latitude: 37, longitude: 127, accuracy: 5 }, timestamp });
  sensor.startGPS(); watch(fix(1000)); tick(); assert.equal(requests, 0);
  now = 12000; tick(); tick(); assert.equal(requests, 1);
  watch(fix(12000)); refresh(fix(11000));
  assert.equal(positions.at(-1).measuredAt, 12000);
  now = 24000; page.visibilityState = 'hidden'; tick(); assert.equal(requests, 1);
  page.visibilityState = 'visible'; tick(); assert.equal(requests, 2);
  sensor.stopGPS(); refresh(fix(24000)); tick();
  assert.equal(positions.length, 2);
  assert.ok(cleared.includes(44));
});

test('GPS refresh permission denial stops the watch and refresh timer', (t) => {
  let tick, failure;
  const statuses = [];
  environment(t, {
    setInterval(callback) { tick = callback; return 44; }, clearInterval() {},
    navigator: { geolocation: {
      watchPosition() { return 7; }, clearWatch() {},
      getCurrentPosition(_success, error) { failure = error; },
    } },
  });
  const sensor = new Sensors({ onStatus: status => statuses.push(status) });
  sensor.startGPS(); tick(); failure({ code: 1 });
  assert.equal(sensor.watchId, null);
  assert.equal(sensor.gpsRefreshTimer, null);
  assert.equal(sensor.gpsRefreshing, false);
  assert.equal(statuses.at(-1).state, 'denied');
});

test('GPS startup failure is reported and invalid readings are ignored', (t) => {
  let success;
  const positions = [];
  const statuses = [];
  environment(t, { navigator: { geolocation: { watchPosition() { throw new Error('disabled'); } } } });
  const sensor = new Sensors({ onPosition: (value) => positions.push(value), onStatus: (value) => statuses.push(value) });
  assert.equal(sensor.startGPS(), false);
  assert.equal(statuses.at(-1).state, 'error');
  globalThis.navigator.geolocation.watchPosition = (callback) => { success = callback; return 1; };
  globalThis.navigator.geolocation.clearWatch = () => {};
  sensor.startGPS();
  success({ coords: { latitude: 95, longitude: 127, accuracy: -2 }, timestamp: 1 });
  assert.deepEqual(positions, []);
  sensor.stop();
});

test('direction ignores relative alpha and uncalibrated compass readings', async (t) => {
  const target = new EventTarget();
  environment(t, { window: target, DeviceOrientationEvent: class {}, screen: { orientation: { angle: 0 } } });
  const headings = [];
  const sensor = new Sensors({ onHeading: (heading) => headings.push(heading) });
  t.after(() => sensor.stop());
  assert.equal(await sensor.startHeading(), true);
  orientation(target, { alpha: 120, absolute: false });
  orientation(target, { webkitCompassHeading: 90, webkitCompassAccuracy: -1 });
  assert.equal(headings.length, 0);
  orientation(target, { alpha: 10, absolute: true });
  orientation(target, { webkitCompassHeading: 80, webkitCompassAccuracy: 10 });
  assert.deepEqual(headings, [350, 80]);
  sensor.stop();
  orientation(target, { alpha: 20, absolute: true });
  assert.equal(headings.length, 2);
});

test('direction cancellation while permission is pending attaches no listener', async (t) => {
  const permission = deferred();
  const target = new EventTarget();
  environment(t, { window: target, DeviceOrientationEvent: class { static requestPermission() { return permission.promise; } } });
  const headings = [];
  const sensor = new Sensors({ onHeading: (heading) => headings.push(heading) });
  const start = sensor.startHeading();
  sensor.stop();
  permission.resolve('granted');
  assert.equal(await start, false);
  orientation(target, { webkitCompassHeading: 90 });
  assert.deepEqual(headings, []);
});

test('uncalibrated compass clears a previously active direction and valid readings recover it', async (t) => {
  const target = new EventTarget();
  environment(t, { window: target, DeviceOrientationEvent: class {}, screen: { orientation: { angle: 0 } } });
  let heading = null;
  const statuses = [];
  const sensor = new Sensors({
    onHeading: value => { heading = value; },
    onStatus: status => { statuses.push(status); if (status.state !== 'active') heading = null; }
  });
  t.after(() => sensor.stop());
  await sensor.startHeading();
  orientation(target, { webkitCompassHeading: 80, webkitCompassAccuracy: 10 });
  assert.equal(heading, 80);
  assert.equal(statuses.at(-1).state, 'active');
  orientation(target, { webkitCompassHeading: 90, webkitCompassAccuracy: -1 });
  assert.equal(heading, null);
  assert.equal(statuses.at(-1).state, 'error');
  orientation(target, { webkitCompassHeading: 95, webkitCompassAccuracy: 5 });
  assert.equal(heading, 95);
  assert.equal(statuses.at(-1).state, 'active');
});

test('direction permission denial does not expose a heading', async (t) => {
  const target = new EventTarget();
  environment(t, { window: target, DeviceOrientationEvent: class { static async requestPermission(absolute) { assert.equal(absolute, true); return 'denied'; } } });
  const headings = [];
  const statuses = [];
  const sensor = new Sensors({ onHeading: (value) => headings.push(value), onStatus: (value) => statuses.push(value) });
  assert.equal(await sensor.startHeading(), false);
  orientation(target, { alpha: 10, absolute: true });
  assert.deepEqual(headings, []);
  assert.equal(statuses.at(-1).state, 'denied');
});

test('camera stream arriving after close is immediately stopped', async (t) => {
  const request = deferred();
  let stopped = 0;
  const stream = { getTracks: () => [{ stop() { stopped += 1; } }] };
  environment(t, { navigator: { mediaDevices: { getUserMedia: () => request.promise } } });
  const sensor = new Sensors();
  const video = { play: async () => {} };
  const open = sensor.openCamera(video);
  sensor.closeCamera();
  request.resolve(stream);
  assert.equal(await open, null);
  assert.equal(stopped, 1);
  assert.equal(video.srcObject, undefined);
});

test('camera close during playback stops tracks and clears the video', async (t) => {
  const playback = deferred();
  let stopped = 0;
  const stream = { getTracks: () => [{ stop() { stopped += 1; } }] };
  environment(t, { navigator: { mediaDevices: { getUserMedia: async () => stream } } });
  const sensor = new Sensors();
  const video = { play: () => playback.promise };
  const open = sensor.openCamera(video);
  await Promise.resolve();
  sensor.closeCamera();
  playback.resolve();
  assert.equal(await open, null);
  assert.equal(stopped, 1);
  assert.equal(video.srcObject, null);
});

test('opening a new camera request stops only the obsolete stream', async (t) => {
  const first = deferred();
  const second = deferred();
  let requests = 0;
  let firstStopped = 0;
  let secondStopped = 0;
  const stream1 = { getTracks: () => [{ stop() { firstStopped += 1; } }] };
  const stream2 = { getTracks: () => [{ stop() { secondStopped += 1; } }] };
  environment(t, { navigator: { mediaDevices: { getUserMedia: () => (++requests === 1 ? first.promise : second.promise) } } });
  const sensor = new Sensors();
  const video1 = { play: async () => {} };
  const video2 = { play: async () => {} };
  const open1 = sensor.openCamera(video1);
  const open2 = sensor.openCamera(video2);
  second.resolve(stream2);
  assert.equal(await open2, stream2);
  first.resolve(stream1);
  assert.equal(await open1, null);
  assert.equal(firstStopped, 1);
  assert.equal(secondStopped, 0);
  assert.equal(video2.srcObject, stream2);
  sensor.stop();
  assert.equal(secondStopped, 1);
});

test('an AR session that arrives after start is canceled gets ended', async (t) => {
  const request = deferred();
  let ended = 0;
  environment(t, { navigator: { xr: { requestSession: () => request.promise } } });
  const ar = new NpcAR();
  const start = ar.start({});
  await ar.stop();
  request.resolve({ async end() { ended += 1; } });
  assert.equal(await start, false);
  await Promise.resolve();
  assert.equal(ended, 1);
  assert.equal(ar.session, null);
});

test('camera permission denial and unsupported AR are explicit', async (t) => {
  environment(t, { navigator: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); } } } });
  const statuses = [];
  const sensor = new Sensors({ onStatus: (status) => statuses.push(status) });
  assert.equal(await sensor.openCamera({}), null);
  assert.equal(statuses.at(-1).state, 'denied');
  const ar = new NpcAR({ onStatus: (status) => statuses.push(status) });
  assert.equal(await ar.supported(), false);
  assert.equal(await ar.start({}), false);
  assert.equal(statuses.at(-1).state, 'missing');
});

test('AR capability reports supported, missing, unsupported and failed checks', async (t) => {
  environment(t, { isSecureContext: true, navigator: {} });
  const ar = new NpcAR();
  assert.equal((await ar.capability()).state, 'missing');
  globalThis.navigator.xr = { requestSession() {}, isSessionSupported: async mode => { assert.equal(mode, 'immersive-ar'); return true; } };
  const supported = await ar.capability();
  assert.equal(supported.supported, true);
  assert.equal(supported.state, 'supported');
  assert.equal(await ar.supported(), true);
  globalThis.navigator.xr.isSessionSupported = async () => false;
  assert.equal((await ar.capability()).state, 'unsupported');
  assert.equal(await ar.supported(), false);
  globalThis.navigator.xr.isSessionSupported = async () => { throw new Error('unavailable'); };
  const failed = await ar.capability();
  assert.equal(failed.state, 'error');
  assert.equal(failed.supported, false);
  assert.equal(typeof failed.message, 'string');
  assert.ok(failed.message.length > 0);
  assert.equal(await ar.supported(), false);
});

test('AR capability explains an insecure context before requesting a session', async (t) => {
  let checks = 0;
  environment(t, { isSecureContext: false, navigator: { xr: { async isSessionSupported() { checks++; return true; } } } });
  const ar = new NpcAR();
  const capability = await ar.capability();
  assert.equal(capability.state, 'insecure');
  assert.equal(capability.supported, false);
  assert.equal(checks, 0);
  assert.equal(await ar.supported(), false);
});
