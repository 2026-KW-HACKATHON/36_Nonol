import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, bearingDegrees, angleDifference, guidance } from '../public/geo.js';

test('distance is zero at the same position and matches one equatorial degree', () => {
  assert.equal(distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }), 0);
  assert.ok(Math.abs(distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111195.08) < 1);
});

test('bearings point north, east, south and west', () => {
  const origin = { lat: 0, lon: 0 };
  for (const [target, expected] of [[{ lat: 1, lon: 0 }, 0], [{ lat: 0, lon: 1 }, 90], [{ lat: -1, lon: 0 }, 180], [{ lat: 0, lon: -1 }, 270]]) {
    assert.equal(bearingDegrees(origin, target), expected);
  }
});

test('distance and bearing cross the dateline along the short path', () => {
  const from = { lat: 0, lon: 179.9 };
  const to = { lat: 0, lon: -179.9 };
  assert.ok(distanceMeters(from, to) < 23000);
  assert.equal(bearingDegrees(from, to), 90);
});

test('angle differences wrap around north and reject missing headings', () => {
  assert.equal(angleDifference(355, 5), 10);
  assert.equal(angleDifference(0, 180), 180);
  assert.equal(angleDifference(720, -10), 10);
  assert.throws(() => angleDifference(null, 10), TypeError);
});

test('guidance combines proximity and alignment and keeps turn signs', () => {
  const target = { lat: 0.0001, lon: 0 };
  const facing = guidance({ lat: 0, lon: 0 }, target, 355);
  const away = guidance({ lat: 0, lon: 0 }, target, 180);
  assert.equal(facing.aligned, true);
  assert.equal(facing.turn, 5);
  assert.equal(away.aligned, false);
  assert.notEqual(facing.color, away.color);
  assert.equal(guidance({ lat: 0, lon: 0 }, target, 5).turn, -5);
});

test('guidance distinguishes unavailable position from unavailable direction', () => {
  assert.equal(guidance(null, { lat: 0, lon: 0 }).distance, null);
  const result = guidance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.equal(result.turn, null);
  assert.equal(result.aligned, null);
  assert.match(result.label, /방향/);
});

test('invalid coordinates and radius do not create confident guidance', () => {
  for (const value of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 0 }, { lat: '0', lon: 0 }]) {
    assert.throws(() => distanceMeters(value, { lat: 0, lon: 0 }), TypeError);
    assert.equal(guidance(value, { lat: 0, lon: 0 }).distance, null);
  }
  assert.throws(() => guidance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, 0, 0), TypeError);
});
