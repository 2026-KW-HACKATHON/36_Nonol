import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRoute } from '../public/route-geo.js';
import { RouteAR } from '../public/route-ar.js';

const origin = { lat: 0, lon: 0, accuracy: 5 };
const north = { lat: 0.001, lon: 0 };
const project = (heading, options = {}) => projectRoute(origin, north, { heading, ...options });

test('a waypoint ahead projects to the center with its real distance', () => {
  const result = project(0);
  assert.equal(result.state, 'ready');
  assert.equal(result.onScreen, true);
  assert.equal(result.markerPercent, 50);
  assert.equal(result.turn, 0);
  assert.ok(Math.abs(result.distance - 111.195) < 0.01);
  assert.equal(result.direction, '정면으로 이동해 주세요.');
});

test('perspective projection is symmetric and moves off-screen cues to each edge', () => {
  const right = project(345);
  const left = project(15);
  assert.ok(right.markerPercent > 50 && right.markerPercent < 92);
  assert.ok(Math.abs(left.markerPercent - (100 - right.markerPercent)) < 0.000001);
  assert.equal(project(330).markerPercent, 92);
  assert.equal(project(30).markerPercent, 8);
  assert.equal(project(300).edge, 'right');
  assert.equal(project(60).edge, 'left');
  assert.equal(project(300).onScreen, false);
  assert.equal(project(60).onScreen, false);
});

test('heading wrapping and a waypoint behind never produce a false centered marker', () => {
  assert.equal(project(359).turn, 1);
  assert.equal(project(-1).turn, 1);
  const behind = project(180);
  assert.equal(behind.turn, -180);
  assert.equal(behind.onScreen, false);
  assert.equal(behind.edge, 'left');
  assert.equal(behind.markerPercent, 8);
});

test('arrival uses position and radius even without a heading', () => {
  const result = projectRoute(origin, { lat: 0.00005, lon: 0 }, { radius: 10 });
  assert.equal(result.state, 'arrived');
  assert.equal(result.arrived, true);
  assert.equal(result.markerVisible, false);
  assert.equal(result.direction, '도착 반경 안이에요.');
});

test('missing or stale headings retain distance and give a clear fallback', () => {
  for (const heading of [null, undefined, NaN, Infinity, '90']) {
    const result = project(heading);
    assert.equal(result.state, 'missing-heading');
    assert.equal(result.markerVisible, false);
    assert.ok(result.distance > 100);
    assert.equal(result.turn, null);
  }
  assert.equal(project(0, { headingStale: true }).state, 'missing-heading');
});

test('bad, stale or inaccurate GPS positions suppress distance and the marker', () => {
  for (const position of [null, { lat: 91, lon: 0 }, { lat: 0, lon: NaN }]) {
    assert.equal(projectRoute(position, north).state, 'missing-position');
  }
  assert.equal(project(0, { positionStale: true }).state, 'missing-position');
  for (const accuracy of [null, undefined, -1, NaN, Infinity, 101]) {
    const result = projectRoute({ ...origin, accuracy }, north, { heading: 0 });
    assert.equal(result.state, 'inaccurate-position');
    assert.equal(result.distance, null);
    assert.equal(result.markerVisible, false);
  }
  assert.equal(projectRoute({ ...origin, accuracy: 100 }, north, { heading: 0 }).state, 'ready');
});

test('simulation is explicit and does not require a fabricated GPS accuracy', () => {
  const result = projectRoute({ lat: 0, lon: 0 }, north, { mode: 'simulation', heading: 0 });
  assert.equal(result.mode, 'simulation');
  assert.equal(result.state, 'ready');
  assert.match(result.message, /가상/);
  assert.equal(projectRoute({ lat: 0, lon: 0 }, north, { heading: 0 }).state, 'inaccurate-position');
});

test('dateline route bearing uses the short geographic route', () => {
  const result = projectRoute({ lat: 0, lon: 179.999, accuracy: 2 }, { lat: 0, lon: -179.999 }, { heading: 90 });
  assert.ok(Math.abs(result.distance - 222.39) < 0.05);
  assert.ok(Math.abs(result.bearing - 90) < 0.01);
  assert.equal(result.markerPercent, 50);
});

test('invalid route configuration fails explicitly and invalid targets remain safe', () => {
  for (const options of [{ radius: 0 }, { radius: Infinity }, { horizontalFov: 0 }, { horizontalFov: 180 }, { maxAccuracy: 0 }]) {
    assert.throws(() => project(0, options), TypeError);
  }
  assert.equal(projectRoute(origin, { lat: 0, lon: 181 }).state, 'missing-target');
});

test('route overlay clears a previous arrow when heading or position is lost and restarts cleanly', () => {
  const element = () => ({ hidden: false, dataset: {}, style: {}, textContent: '' });
  const elements = { container: element(), marker: element(), distance: element(), direction: element(), status: element() };
  const route = new RouteAR(elements);
  route.update(origin, north, { heading: 300 });
  assert.equal(elements.marker.textContent, '→');
  assert.equal(elements.marker.style.left, '92%');
  assert.equal(elements.marker.hidden, false);
  route.update(origin, north, { heading: 300, headingStale: true });
  assert.equal(elements.marker.hidden, true);
  assert.equal(elements.distance.textContent, '111m');
  assert.match(elements.status.textContent, /방향 센서/);
  route.update(null, north, { heading: 0 });
  assert.equal(elements.distance.textContent, '거리 확인 중');
  assert.equal(elements.marker.hidden, true);
  route.stop();
  assert.equal(elements.container.hidden, true);
  assert.equal(elements.marker.hidden, true);
  route.update(origin, north, { heading: 0 });
  assert.equal(elements.container.hidden, false);
  assert.equal(elements.marker.hidden, false);
  route.update(origin, origin, { heading: 0 });
  assert.equal(elements.marker.hidden, true);
  assert.equal(elements.distance.textContent, '0m');
  assert.equal(elements.direction.textContent, '도착 반경 안이에요.');
});
