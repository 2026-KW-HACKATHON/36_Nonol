import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomState, joinRoom, applyAction } from '../src/room-state.js';
import { createLab, configureLab, startLab, applyLabAction, photoContext, completePhoto, upgradeLabPolicy } from '../src/lab-state.js';
import track from '../public/test-track.json' with { type: 'json' };
import { courseDistance, validWalkingCourse } from '../public/261008_2355_course-geo.js';

const NOW = 100_000;
let requestNumber = 0;

test('GPS 측정 시각을 갱신 요청으로 새 위치처럼 만들지 않는다', () => {
  const state = started(1, { mode: 'gps' });
  const next = near(state, 'p1', { measuredAt: NOW - 20000 });
  assert.equal(next.lab.positions.p1.at, NOW - 20000);
  assert.throws(() => near(state, 'p1', { measuredAt: NOW - 30001 }), /새 GPS/);
  assert.throws(() => near(state, 'p1', { measuredAt: NOW + 5001 }), /새 GPS/);
});

function room(count = 3, config = {}) {
  let state = { ...createRoomState({ id: 'room', title: '집에서 테스트' }), track: 'lab', lab: createLab() };
  for (let i = 1; i <= count; i++) state = joinRoom(state, { id: `p${i}`, name: `참가자${i}`, joinedAt: i });
  if (Object.keys(config).length) state = configureLab(state, 'p1', config);
  return state;
}

function started(count = 3, config = {}) {
  let state = room(count, config);
  for (const member of state.members) state = applyAction(state, member.id, { type: 'ready', ready: true });
  return startLab(applyAction(state, 'p1', { type: 'start' }));
}

function action(state, actorId, type, values = {}, now = NOW) {
  if (type === 'photo:ai') return completePhoto(state, actorId, state.lab.runId, { method: 'ai', verdict: values.verdict }, now);
  return applyLabAction(state, actorId, {
    type, runId: state.lab.runId, stage: state.lab.stage, requestId: `request-${++requestNumber}`, ...values
  }, now);
}

function near(state, actorId, values = {}, now = NOW) {
  const destination = state.lab.config.destination;
  return action(state, actorId, 'lab:location', {
    ...destination, accuracy: 5, heading: 90,
    source: 'gps', measuredAt: now, ...values
  }, now);
}

function finishAll(state, type = 'lab:complete', values = {}, now = NOW) {
  for (const member of state.members) state = action(state, member.id, type, values, now);
  return state;
}

function atPhoto(count = 3, config = {}) {
  let state = started(count, config);
  for (const member of state.members) state = near(state, member.id);
  return finishAll(state);
}

function atSilence(count = 3) {
  return finishAll(atPhoto(count), 'photo:ai', { verdict: true });
}

function atNpc(count = 3) {
  return finishAll(atSilence(count));
}

function finishRoute(state) {
  for (const member of state.members) {
    for (const [index, waypoint] of [
      { lat: (state.lab.config.start.lat + state.lab.config.destination.lat) / 2, lon: (state.lab.config.start.lon + state.lab.config.destination.lon) / 2 },
      state.lab.config.destination
    ].entries()) {
      state = action(state, member.id, 'lab:location', { ...waypoint, accuracy: 3, heading: 0, source: 'gps', measuredAt: NOW });
      state = action(state, member.id, 'lab:route-arrive', { waypoint: index });
    }
  }
  return state;
}

test('단계 제어는 진행 중인 팀장과 현재 실행 및 단계만 허용하고 양끝 이동을 거절한다', () => {
  const before = started();
  assert.throws(() => action(room(), 'p1', 'lab:stage-control', { action: 'next' }), /시작/);
  assert.throws(() => action(before, 'p2', 'lab:stage-control', { action: 'next' }), /팀장/);
  assert.throws(() => action(before, 'p1', 'lab:stage-control', { action: 'previous' }), /첫 단계/);
  assert.throws(() => action(before, 'p1', 'lab:stage-control', { action: 'other' }), /선택/);
  assert.throws(() => action(before, 'p1', 'lab:stage-control', { action: 'next', stage: 'photo' }), /현재 단계/);
  assert.throws(() => action(before, 'p1', 'lab:stage-control', { action: 'next', runId: 'old' }), /새 실행/);
  let state = before;
  for (const stage of track.stageControl.stages.slice(1)) {
    const oldRun = state.lab.runId;
    state = action(state, 'p1', 'lab:stage-control', { action: 'next' });
    assert.equal(state.lab.stage, stage); assert.equal(state.screen, stage);
    assert.notEqual(state.lab.runId, oldRun);
  }
  assert.throws(() => action(state, 'p1', 'lab:stage-control', { action: 'next' }), /마지막 단계/);
  assert.equal(action(state, 'p1', 'lab:stage-control', { action: 'previous' }).lab.stage, 'finder');
  assert.equal(before.lab.stage, 'map');
});

test('현재 단계 초기화는 목적 단계 기록만 비우며 팀과 코스 및 지도 도착 기록을 유지한다', () => {
  const base = atPhoto(3, { mode: 'gps', radius: 40, destination: { lat: 37.620, lon: 127.0595 } });
  Object.assign(base.lab, {
    completed: { p1: true }, evidence: { p1: { method: 'ai', verdict: true } },
    penalties: { p2: 3 }, reports: [{ actorId: 'p1', targetId: 'p2', at: NOW }],
    npcTouched: { p1: true }, routeProgress: { p1: 2 },
    reference: { id: 'custom-reference', label: '팀 기준', updatedAt: NOW, custom: true }
  });
  const cleared = { photo: ['evidence'], silence: ['reports', 'penalties'], npc: ['npcTouched'], 'ar-route': ['routeProgress'] };
  for (const stage of track.stageControl.stages) {
    const before = structuredClone(base); before.lab.stage = stage; before.screen = stage;
    const after = action(before, 'p1', 'lab:stage-control', { action: 'reset' });
    assert.equal(after.lab.stage, stage); assert.equal(after.screen, stage);
    assert.equal(after.phase, 'started'); assert.equal(after.lab.generation, before.lab.generation);
    assert.notEqual(after.lab.runId, before.lab.runId); assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.lab.completed, {}); assert.deepEqual(after.lab.processedRequests, []);
    for (const field of ['id', 'title', 'members', 'leaderId']) assert.deepEqual(after[field], before[field]);
    assert.deepEqual(after.lab.config, before.lab.moduleConfigs[stage]);
    for (const field of ['positions', 'arrivals', 'reference']) assert.deepEqual(after.lab[field], before.lab[field]);
    for (const field of ['evidence', 'reports', 'penalties', 'npcTouched', 'routeProgress']) {
      assert.deepEqual(after.lab[field], cleared[stage]?.includes(field) ? field === 'reports' ? [] : {} : before.lab[field]);
    }
  }
});

test('사진 모듈을 직접 선택하면 지도 인증 없이 시험하고 이전 요청은 격리한다', () => {
  const before = started(2, { mode: 'gps' });
  const after = action(before, 'p1', 'lab:stage-control', { action: 'next' });
  assert.equal(after.lab.stage, 'photo');
  assert.doesNotThrow(() => photoContext(after, 'p1', after.lab.runId, NOW));
  assert.throws(() => action(after, 'p1', 'lab:location', { runId: before.lab.runId, ...before.lab.config.destination, accuracy: 3, heading: null, source: 'gps' }), /새 실행/);
  const arrived = atPhoto(2, { mode: 'gps' });
  const reset = action(arrived, 'p1', 'lab:stage-control', { action: 'reset' });
  assert.doesNotThrow(() => photoContext(reset, 'p1', reset.lab.runId, NOW));
  assert.throws(() => completePhoto(reset, 'p1', arrived.lab.runId, { method: 'ai', verdict: true }, NOW), /새 실행/);
});

test('AR 경유점은 순서대로 근접 인증하고 전원이 마친 뒤 함께 이동한다', () => {
  let state = atNpc(2);
  for (const member of state.members) {
    state = action(state, member.id, 'lab:npc-touch');
    state = action(state, member.id, 'lab:complete');
  }
  assert.equal(state.lab.stage, 'ar-route');
  assert.throws(() => action(state, 'p1', 'lab:complete'), /경유점/);
  assert.throws(() => action(state, 'p1', 'lab:route-arrive', { waypoint: 0 }), /가까/);
  const midpoint = { lat: (state.lab.config.start.lat + state.lab.config.destination.lat) / 2, lon: (state.lab.config.start.lon + state.lab.config.destination.lon) / 2 };
  state = action(state, 'p1', 'lab:location', { ...midpoint, accuracy: 3, heading: 0, source: 'gps', measuredAt: NOW });
  const arrive = { type: 'lab:route-arrive', runId: state.lab.runId, stage: 'ar-route', waypoint: 0, requestId: 'route-once' };
  state = applyLabAction(state, 'p1', arrive, NOW);
  assert.equal(state.lab.routeProgress.p1, 1);
  assert.equal(applyLabAction(state, 'p1', arrive, NOW), state);
  assert.throws(() => action(state, 'p1', 'lab:route-arrive', { waypoint: 0 }), /경유점/);
  state = near(state, 'p1');
  state = action(state, 'p1', 'lab:route-arrive', { waypoint: 1 });
  assert.equal(state.lab.routeProgress.p1, 2);
  assert.equal(state.lab.completed.p1, true);
  assert.equal(state.lab.stage, 'ar-route');
  const reset = action(state, 'p1', 'lab:reset');
  assert.deepEqual(reset.lab.routeProgress, {});
  const complete = finishRoute(state);
  assert.equal(complete.lab.stage, 'finder');
});

test('기본 실험 설정과 실행 ID는 방마다 독립적이다', () => {
  const a = createLab();
  const b = createLab();
  assert.notEqual(a.runId, b.runId);
  assert.equal(a.config.mode, 'gps');
  assert.equal(a.stage, 'map');
  assert.equal(a.policyId, track.id);
  assert.equal(a.policyVersion, track.version ?? 1);
  assert.equal(a.generation, 1);
  a.positions.p1 = { lat: 0 };
  a.config.start.lat = 0;
  assert.deepEqual(b.positions, {});
  assert.notEqual(b.config.start.lat, 0);
});

test('대기실 팀장만 테스트 설정을 변경하고 원본 상태를 보존한다', () => {
  const before = room();
  assert.throws(() => configureLab(before, 'p2', { radius: 15 }), /팀장/);
  assert.throws(() => configureLab(before, 'missing', { radius: 15 }), /입장/);
  const after = configureLab(before, 'p1', { radius: 15, photoTarget: '  하나은행 간판  ', start: { lat: 37, lon: 127 } });
  assert.equal(after.lab.config.photoTarget, '하나은행 간판');
  assert.equal(after.lab.config.radius, 15);
  assert.deepEqual(after.lab.config.start, { lat: 37, lon: 127 });
  assert.equal(before.lab.config.radius, 25);
  assert.equal(after.revision, before.revision + 1);
  assert.throws(() => configureLab(started(), 'p1', { radius: 15 }), /대기실/);
});

test('GPS 코스는 반경 두 배보다 먼 목적지를 요구하며 가상 위치 모드를 거절한다', () => {
  const before = room();
  const original = structuredClone(before);
  const start = { lat: 37.5, lon: 127 }, destination = { lat: 37.5005, lon: 127 };
  const config = { ...before.lab.config, mode: 'gps', start, destination };
  const distance = courseDistance(config);
  assert.ok(distance > 50 && distance < 100);
  assert.equal(courseDistance({ start: { lat: NaN, lon: 127 }, destination }), null);
  for (const radius of [distance / 2, distance / 2 + .001]) {
    assert.equal(validWalkingCourse({ ...config, radius }), false);
    assert.throws(() => configureLab(before, 'p1', { ...config, radius }), /두 배/);
  }
  assert.equal(validWalkingCourse({ ...config, radius: distance / 2 - .001 }), true);
  assert.doesNotThrow(() => configureLab(before, 'p1', { ...config, radius: distance / 2 - .001 }));
  assert.throws(() => configureLab(before, 'p1', { mode: 'gps', start, destination: start }), /두 배/);
  assert.throws(() => configureLab(before, 'p1', { mode: 'simulation', start, destination: start }), /GPS/);
  assert.deepEqual(before, original);
});

test('기존 겹치는 GPS 코스도 시작하며 지도 완료는 유효한 코스를 요구한다', () => {
  const legacy = started(1);
  legacy.lab.config.mode = 'gps'; legacy.lab.config.destination = { ...legacy.lab.config.start };
  legacy.lab.policyId = 'nonol-test-lab-v5'; legacy.lab.policyVersion = 5; delete legacy.lab.moduleConfigs;
  const before = structuredClone(legacy);
  const atStart = { ...legacy, screen: 'track-start' };
  assert.equal(startLab(atStart).screen, 'map');
  const positioned = near(legacy, 'p1');
  assert.throws(() => action(positioned, 'p1', 'lab:complete'), /두 배/);
  const upgraded = upgradeLabPolicy(legacy);
  assert.equal(upgraded.lab.policyVersion, track.version);
  assert.deepEqual(upgraded.lab.config, legacy.lab.config);
  assert.notEqual(upgraded.lab.runId, legacy.lab.runId);
  assert.deepEqual(upgraded.members, legacy.members);
  assert.deepEqual(upgraded.lab.arrivals, legacy.lab.arrivals);
  assert.deepEqual(legacy, before);
});

test('GPS 출발점에 머무르면 도착할 수 없고 목적지로 이동한 좌표만 지도 완료를 승인한다', () => {
  let state = started(1, { mode: 'gps' });
  const atDeparture = near(state, 'p1', state.lab.config.start);
  assert.throws(() => action(atDeparture, 'p1', 'lab:complete'), /가까/);
  assert.deepEqual(atDeparture.lab.arrivals, {});
  state = near(atDeparture, 'p1');
  state = action(state, 'p1', 'lab:complete');
  assert.equal(state.lab.stage, 'photo');
  assert.equal(state.lab.arrivals.p1.lat, state.lab.config.destination.lat);
  assert.equal(state.lab.arrivals.p1.source, 'gps');
  assert.doesNotThrow(() => photoContext(state, 'p1', state.lab.runId, NOW));
});

test('다른 촬영 대상으로 변경하면 이전 기준을 해제하고 반경만 변경하면 유지한다', () => {
  const before = room();
  before.lab.reference = { id: 'custom-reference', label: before.lab.config.photoTarget, custom: true, updatedAt: NOW };
  const radiusChanged = configureLab(before, 'p1', { radius: 15 });
  assert.deepEqual(radiusChanged.lab.reference, before.lab.reference);
  const targetChanged = configureLab(before, 'p1', { photoTarget: '하나은행 간판' });
  assert.equal(targetChanged.lab.reference, undefined);
  assert.equal(targetChanged.lab.config.photoTarget, '하나은행 간판');
  assert.equal(before.lab.reference.id, 'custom-reference');
});

test('설정은 좌표, 모드, 반경과 물체 이름의 경계를 검사한다', () => {
  const before = room();
  for (const config of [
    null, [], { mode: 'other' }, { radius: NaN }, { radius: 4 }, { radius: 101 },
    { photoTarget: '' }, { photoTarget: ' '.repeat(4) }, { photoTarget: '컵'.repeat(81) },
    { start: { lat: 91, lon: 0 } }, { destination: { lat: 0, lon: -181 } },
    { start: { lat: '37', lon: 127 } }, { start: { lat: 37 } },
    { unknown: true }, { reportCooldownMs: -1 }, { start: { lat: 37, lon: 127, extra: true } }
  ]) assert.throws(() => configureLab(before, 'p1', config));
  const after = configureLab(before, 'p1', { mode: 'gps', radius: 100, destination: { lat: -90, lon: 180 } });
  assert.equal(after.lab.config.mode, 'gps');
  assert.equal(configureLab(after, 'p1', after.lab.config), after);
});

test('시작은 기존 방 버전을 유지하고 중복 호출로 진행을 초기화하지 않는다', () => {
  let before = room();
  for (const item of before.members) before = applyAction(before, item.id, { type: 'ready', ready: true });
  before = applyAction(before, 'p1', { type: 'start' });
  const state = startLab(before);
  assert.equal(state.revision, before.revision);
  assert.equal(before.screen, 'track-start');
  assert.equal(state.screen, 'map');
  const after = near(state, 'p1');
  assert.equal(startLab(after), after);
  assert.throws(() => startLab(room()), /시작/);
});

test('1명과 7명 모두 각 단계의 전원 완료 후 함께 끝까지 진행한다', () => {
  for (const count of [1, 7]) {
    let state = started(count);
    for (const member of state.members) state = near(state, member.id);
    state = finishAll(state);
    assert.equal(state.lab.stage, 'photo');
    state = finishAll(state, 'photo:ai', { verdict: true });
    assert.equal(state.lab.stage, 'silence');
    state = finishAll(state);
    assert.equal(state.lab.stage, 'npc');
    for (const member of state.members) {
      state = action(state, member.id, 'lab:npc-touch');
      state = action(state, member.id, 'lab:complete');
    }
    assert.equal(state.lab.stage, 'ar-route');
    state = finishRoute(state);
    assert.equal(state.lab.stage, 'finder');
    for (const member of state.members) state = near(state, member.id);
    state = finishAll(state);
    assert.equal(state.lab.stage, 'ending');
    assert.equal(state.screen, 'ending');
    assert.equal(Object.keys(state.lab.evidence).length, count);
    assert.equal(Object.keys(state.lab.npcTouched).length, count);
    assert.deepEqual(state.lab.completed, {});
  }
});

test('팀원 한 명의 도착만으로는 단계가 넘어가지 않는다', () => {
  const state = near(started(), 'p1');
  const after = action(state, 'p1', 'lab:complete');
  assert.equal(after.lab.stage, 'map');
  assert.deepEqual(after.lab.completed, { p1: true });
  assert.deepEqual(state.lab.completed, {});
});

test('위치는 서버 시각을 저장하고 전달된 사용자 시각을 신뢰하지 않는다', () => {
  const state = near(started(), 'p1', { at: 99_999_999 });
  assert.equal(state.lab.positions.p1.at, NOW);
  assert.equal(state.lab.positions.p1.source, 'gps');
});

test('잘못된 위치와 실제 모드에 섞인 가상 위치를 거절한다', () => {
  const state = started();
  for (const values of [
    { lat: NaN }, { lat: Infinity }, { lat: '37' }, { lon: -181 }, { lat: 91 },
    { accuracy: -1 }, { accuracy: 10001 }, { accuracy: null }, { heading: NaN },
    { heading: -1 }, { heading: 361 }, { source: 'simulated' }, { source: 'other' }, { measuredAt: undefined }
  ]) assert.throws(() => near(state, 'p1', values));
  assert.throws(() => near(started(3, { mode: 'gps' }), 'p1', { source: 'simulated' }));
  assert.equal(near(state, 'p1', { heading: null }).lab.positions.p1.heading, null);
  assert.equal(near(state, 'p1', { heading: 360 }).lab.positions.p1.heading, 0);
});

test('위치가 없거나 멀거나 오래되거나 오차가 크면 도착하지 못한다', () => {
  assert.throws(() => action(started(), 'p1', 'lab:complete'), /위치/);
  assert.throws(() => action(near(started(), 'p1', { lat: 0, lon: 0 }), 'p1', 'lab:complete'), /가까/);
  assert.throws(() => action(near(started(), 'p1', { accuracy: 26 }), 'p1', 'lab:complete'), /정확/);
  const fresh = near(started(), 'p1');
  assert.throws(() => action(fresh, 'p1', 'lab:complete', {}, NOW + 30_001), /위치/);
  assert.throws(() => action(fresh, 'p1', 'lab:complete', {}, NOW - 1), /위치/);
  assert.equal(action(fresh, 'p1', 'lab:complete', {}, NOW + 30_000).lab.completed.p1, true);
});

test('도착 반경은 미터 단위이며 정확도 경계를 포함한다', () => {
  const state = started(3, { destination: { lat: 0, lon: 0 } });
  const inside = near(state, 'p1', { lat: 0.0002248, lon: 0, accuracy: 25 });
  assert.equal(action(inside, 'p1', 'lab:complete').lab.completed.p1, true);
  const outside = near(state, 'p1', { lat: 0.000225, lon: 0 });
  assert.throws(() => action(outside, 'p1', 'lab:complete'), /가까/);
});

test('불완전한 사진 판정과 직접 완료로 인증 단계를 우회하지 못한다', () => {
  const state = atPhoto();
  assert.throws(() => action(state, 'p1', 'lab:complete'), /사진/);
  for (const verdict of ['true', null, 1, undefined]) {
    assert.throws(() => action(state, 'p1', 'photo:ai', { verdict }));
  }
  const after = action(state, 'p1', 'photo:ai', { verdict: false });
  assert.equal(after.lab.stage, 'photo');
  assert.equal(after.lab.completed.p1, undefined);
  assert.deepEqual(after.lab.evidence.p1, { method: 'ai', verdict: false, at: NOW });
});

test('사진 실패 후 재시도는 성공하며 성공 이후 늦은 실패는 완료를 되돌리지 않는다', () => {
  let state = action(atPhoto(), 'p1', 'photo:ai', { verdict: false });
  state = action(state, 'p1', 'photo:ai', { verdict: true });
  const success = state;
  state = action(state, 'p1', 'photo:ai', { verdict: false }, NOW + 1);
  assert.equal(state, success);
  assert.equal(state.lab.evidence.p1.verdict, true);
});

test('사진 성공을 임의로 만드는 소켓 동작을 사용할 수 없다', () => {
  assert.throws(() => action(atPhoto(), 'p1', 'lab:photo-simulate', { verdict: true }), /지원하지/);
});

test('AI 사진 컨텍스트는 회원과 실행 및 사진 단계를 확인하며 지도와 독립적이다', () => {
  const state = atPhoto(3, { mode: 'gps' });
  assert.equal(photoContext(state, 'p1', state.lab.runId, NOW).config.photoTarget, track.defaults.photoTarget);
  assert.throws(() => photoContext(state, 'missing', state.lab.runId, NOW), /입장/);
  assert.throws(() => photoContext(state, 'p1', 'old-run', NOW), /실행/);
  assert.throws(() => photoContext(started(), 'p1', state.lab.runId, NOW));
  assert.doesNotThrow(() => photoContext(state, 'p1', state.lab.runId, NOW + 30_001));
  const far = near(state, 'p1', { lat: 0, lon: 0 });
  assert.doesNotThrow(() => photoContext(far, 'p1', far.lab.runId, NOW));
  const unverified = structuredClone(state); delete unverified.lab.arrivals.p1;
  assert.doesNotThrow(() => photoContext(unverified, 'p1', unverified.lab.runId, NOW));
  const simulated = atPhoto();
  assert.doesNotThrow(() => photoContext(simulated, 'p1', simulated.lab.runId, NOW + 50_000));
});

test('지도에서 통과한 GPS 도착은 사진 촬영 중 정확도가 나빠져도 보존한다', () => {
  const arrived = atPhoto(2, { mode: 'gps' });
  const checkpoint = structuredClone(arrived.lab.arrivals.p1);
  assert.equal(checkpoint.accuracy, 5);
  assert.equal(checkpoint.source, 'gps');
  assert.equal(checkpoint.verifiedAt, NOW);
  const noisy = near(arrived, 'p1', { accuracy: 250 }, NOW + 10_000);
  assert.deepEqual(noisy.lab.arrivals.p1, checkpoint);
  assert.doesNotThrow(() => photoContext(noisy, 'p1', noisy.lab.runId, NOW + 180_000));
  assert.throws(() => action(near(started(1, { mode: 'gps' }), 'p1', { accuracy: 250 }), 'p1', 'lab:complete'), /정확도/);
});

test('기존 사진 단계는 도착을 만들어 내지 않고 새 정책을 한 번만 적용한다', () => {
  const legacy = atPhoto(2, { mode: 'gps' });
  delete legacy.lab.arrivals;
  legacy.lab.policyId = 'nonol-test-lab-v3'; legacy.lab.policyVersion = 3; delete legacy.lab.moduleConfigs;
  legacy.lab.config.photoTarget = '500ml 생수병';
  legacy.lab.completed.p1 = true; legacy.lab.penalties.p2 = 4;
  const upgraded = upgradeLabPolicy(legacy);
  assert.equal(upgraded.lab.policyVersion, track.version);
  assert.equal(upgraded.lab.config.photoTarget, track.defaults.photoTarget);
  assert.deepEqual(upgraded.lab.arrivals, {});
  assert.notEqual(upgraded.lab.runId, legacy.lab.runId);
  assert.equal(upgraded.lab.completed.p1, undefined);
  assert.equal(upgraded.lab.penalties.p2, 4);
  assert.equal(upgraded.revision, legacy.revision + 1);
  assert.equal(upgradeLabPolicy(upgraded), upgraded);
  assert.doesNotThrow(() => photoContext(upgraded, 'p2', upgraded.lab.runId, NOW + 50_000));
  assert.equal(legacy.lab.arrivals, undefined);
  const custom = structuredClone(legacy); custom.lab.config.photoTarget = '컵';
  assert.equal(upgradeLabPolicy(custom).lab.config.photoTarget, '컵');
  const map = started(1, { mode: 'gps' }); map.lab.policyVersion = 3; delete map.lab.arrivals;
  assert.deepEqual(upgradeLabPolicy(map).lab.arrivals, {});
});

test('AI 판정은 서버 함수에서만 승인하고 실패는 재촬영할 수 있다', () => {
  let state = atPhoto(3, { mode: 'gps' });
  const before = state;
  state = completePhoto(state, 'p1', state.lab.runId, { method: 'ai', verdict: false }, NOW);
  assert.equal(state.lab.completed.p1, undefined);
  assert.equal(state.lab.evidence.p1.method, 'ai');
  assert.equal(before.lab.evidence.p1, undefined);
  state = completePhoto(state, 'p1', state.lab.runId, { method: 'ai', verdict: true }, NOW + 60_000);
  assert.equal(state.lab.completed.p1, true);
  assert.equal(state.lab.evidence.p1.at, NOW + 60_000);
  const succeeded = state;
  assert.equal(completePhoto(state, 'p1', state.lab.runId, { method: 'ai', verdict: false }, NOW + 60_001), succeeded);
  assert.throws(() => completePhoto(state, 'p2', state.lab.runId, { method: 'simulation', verdict: true }, NOW));
  assert.throws(() => completePhoto(state, 'p2', state.lab.runId, { method: 'ai', verdict: 'true' }, NOW));
});

test('AI 설명은 저장 길이를 제한하고 컨텍스트 변경은 원본 설정에 영향을 주지 않는다', () => {
  const state = atPhoto();
  const context = photoContext(state, 'p1', state.lab.runId, NOW);
  context.config.destination.lat = 0;
  assert.notEqual(state.lab.config.destination.lat, 0);
  const after = completePhoto(state, 'p1', state.lab.runId, { method: 'ai', verdict: false, reason: `  ${'가'.repeat(300)}  ` }, NOW);
  assert.equal(after.lab.evidence.p1.reason.length, 200);
  assert.equal(state.lab.evidence.p1, undefined);
});

test('이전 지도 단계의 합성 도착 기록은 복원하지 않고 새 GPS로 다시 완료한다', () => {
  let legacy = near(started(2), 'p1');
  legacy = action(legacy, 'p1', 'lab:complete');
  delete legacy.lab.arrivals;
  delete legacy.lab.moduleConfigs;
  legacy.lab.policyId = 'nonol-test-lab-v3'; legacy.lab.policyVersion = 3;
  let upgraded = upgradeLabPolicy(legacy);
  assert.deepEqual(upgraded.lab.arrivals, {});
  assert.deepEqual(upgraded.lab.completed, {});
  assert.deepEqual(upgraded.lab.positions, {});
  for (const member of upgraded.members) {
    upgraded = near(upgraded, member.id);
    upgraded = action(upgraded, member.id, 'lab:complete');
  }
  assert.equal(upgraded.lab.stage, 'photo');
  assert.equal(upgraded.lab.arrivals.p1.source, 'gps');
  assert.equal(upgraded.lab.arrivals.p2.source, 'gps');
  assert.equal(upgradeLabPolicy(upgraded), upgraded);
});

test('새 실행이나 새 단계에 도착한 이전 AI 판정을 반영하지 않는다', () => {
  let state = atPhoto(1);
  const oldRun = state.lab.runId;
  state = completePhoto(state, 'p1', oldRun, { method: 'ai', verdict: true }, NOW);
  assert.equal(state.lab.stage, 'silence');
  assert.throws(() => completePhoto(state, 'p1', oldRun, { method: 'ai', verdict: true }, NOW));
  state = action(state, 'p1', 'lab:reset');
  assert.throws(() => completePhoto(state, 'p1', oldRun, { method: 'ai', verdict: true }, NOW), /입장/);
});

test('신고는 묵언 단계에서 기존 다른 참가자에게만 할 수 있다', () => {
  const state = atSilence();
  assert.throws(() => action(started(), 'p1', 'lab:report', { targetId: 'p2' }));
  assert.throws(() => action(state, 'p1', 'lab:report', { targetId: 'p1' }), /다른/);
  assert.throws(() => action(state, 'p1', 'lab:report', { targetId: 'missing' }), /팀원/);
  const after = action(state, 'p1', 'lab:report', { targetId: 'p2', at: 0 });
  assert.equal(after.lab.penalties.p2, 1);
  assert.deepEqual(after.lab.reports, [{ actorId: 'p1', targetId: 'p2', at: NOW }]);
  assert.deepEqual(state.lab.reports, []);
});

test('서로 다른 신고 요청은 같은 시각에도 연속으로 벌점을 누적한다', () => {
  let state = action(atSilence(), 'p1', 'lab:report', { targetId: 'p2' });
  state = action(state, 'p1', 'lab:report', { targetId: 'p2' }, NOW);
  state = action(state, 'p1', 'lab:report', { targetId: 'p3' }, NOW + 1);
  state = action(state, 'p3', 'lab:report', { targetId: 'p2' }, NOW + 1);
  state = action(state, 'p1', 'lab:report', { targetId: 'p2' }, NOW + 10_000);
  assert.equal(state.lab.penalties.p2, 4);
  assert.equal(state.lab.penalties.p3, 1);
});

test('신고 완료 요청의 재전송은 벌점을 중복 추가하지 않는다', () => {
  const before = atSilence();
  const report = { type: 'lab:report', stage: 'silence', targetId: 'p2', runId: before.lab.runId, requestId: 'same-id' };
  const after = applyLabAction(before, 'p1', report, NOW);
  assert.equal(applyLabAction(after, 'p1', report, NOW + 20_000), after);
  const other = applyLabAction(after, 'p3', report, NOW);
  assert.equal(other.lab.penalties.p2, 2);
});

test('NPC 가까이에서 터치한 뒤 각자 스토리 완료해야 진행한다', () => {
  let state = atNpc();
  assert.throws(() => action(state, 'p1', 'lab:complete'), /정령/);
  const far = near(state, 'p1', { lat: 0, lon: 0 });
  assert.throws(() => action(far, 'p1', 'lab:npc-touch'), /가까/);
  state = action(state, 'p1', 'lab:npc-touch');
  assert.equal(state.lab.npcTouched.p1, true);
  assert.deepEqual(state.lab.completed, {});
  state = action(state, 'p1', 'lab:complete');
  assert.equal(state.lab.stage, 'npc');
  assert.deepEqual(state.lab.completed, { p1: true });
});

test('방향 탐색은 NPC 위치에 머무르는 대신 출발점에 다시 도착해야 완료한다', () => {
  let state = action(atNpc(1), 'p1', 'lab:npc-touch');
  state = action(state, 'p1', 'lab:complete');
  state = finishRoute(state);
  assert.equal(state.lab.stage, 'finder');
  assert.throws(() => action(state, 'p1', 'lab:complete'), /가까/);
  state = near(state, 'p1');
  assert.equal(action(state, 'p1', 'lab:complete').lab.stage, 'ending');
});

test('완료한 참가자의 중복 완료는 버전을 늘리지 않는다', () => {
  const before = action(near(started(), 'p1'), 'p1', 'lab:complete');
  assert.equal(action(before, 'p1', 'lab:complete'), before);
});

test('마지막 완료 요청이 단계 전환 후 재전송되어도 다음 단계를 완료하지 않는다', () => {
  const before = near(started(1), 'p1');
  const completion = { type: 'lab:complete', stage: 'map', runId: before.lab.runId, requestId: 'last' };
  const after = applyLabAction(before, 'p1', completion, NOW);
  assert.equal(after.lab.stage, 'photo');
  assert.equal(applyLabAction(after, 'p1', completion, NOW), after);
  assert.throws(() => applyLabAction(after, 'p1', { ...completion, requestId: 'new' }, NOW), /단계/);
});

test('단계별 동작은 현재 단계 이름을 요구하고 다른 미션 동작을 거절한다', () => {
  const state = near(started(), 'p1');
  assert.throws(() => action(state, 'p1', 'lab:complete', { stage: undefined }), /단계/);
  assert.throws(() => action(state, 'p1', 'lab:npc-touch'), /정령/);
  assert.throws(() => action(state, 'p1', 'photo:ai', { verdict: true }), /사진/);
  assert.throws(() => action(atNpc(), 'p1', 'lab:npc-touch', { stage: 'silence' }), /단계/);
});

test('팀장 초기화는 같은 초대 방의 대기실과 기본 설정을 새로 만들고 모든 참가자 기록을 비운다', () => {
  let state = action(atSilence(), 'p1', 'lab:report', { targetId: 'p2' });
  state = action(state, 'p1', 'lab:complete');
  state.lab.config.radius = 50;
  state.lab.config.photoTarget = '하나은행 간판';
  state.extra = '이전 상태';
  const before = state;
  assert.throws(() => action(state, 'p2', 'lab:reset'), /팀장/);
  const after = action(state, 'p1', 'lab:reset');
  assert.equal(after.id, before.id);
  assert.equal(after.title, before.title);
  assert.equal(after.phase, 'lobby');
  assert.equal(after.screen, 'lobby');
  assert.equal(after.leaderId, null);
  assert.equal(after.extra, undefined);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.lab.stage, 'map');
  assert.notEqual(after.lab.runId, before.lab.runId);
  assert.equal(after.lab.generation, 2);
  assert.equal(after.lab.policyId, track.id);
  assert.equal(after.lab.policyVersion, track.version ?? 1);
  assert.deepEqual(after.lab.config, track.defaults);
  for (const field of ['positions', 'completed', 'penalties', 'npcTouched', 'routeProgress', 'evidence']) assert.deepEqual(after.lab[field], {});
  assert.deepEqual(after.lab.reports, []);
  assert.deepEqual(after.lab.processedRequests, []);
  assert.deepEqual(after.members, []);
  assert.equal(before.phase, 'started');
  assert.equal(before.members.length, 3);
  assert.equal(before.lab.config.radius, 50);
  assert.throws(() => action(after, 'p1', 'lab:reset'), /입장/);
  const fresh = joinRoom(after, { id: 'new', name: '새 참가자', joinedAt: NOW });
  assert.equal(fresh.leaderId, 'new');
  assert.equal(fresh.members[0].ready, false);
  assert.throws(() => action(fresh, 'new', 'lab:reset'), /시작/);
});

test('새 실행은 이전 WebSocket 요청과 중복 기록을 서로 공유하지 않는다', () => {
  const before = near(started(), 'p1');
  const old = { type: 'lab:location', measuredAt: NOW, ...before.lab.positions.p1, runId: before.lab.runId, requestId: 'old' };
  let after = action(before, 'p1', 'lab:reset');
  assert.throws(() => applyLabAction(after, 'p1', old, NOW), /입장/);
  after = joinRoom(after, { id: 'p1', name: '재입장', joinedAt: NOW });
  after = applyAction(after, 'p1', { type: 'ready', ready: true });
  after = startLab(applyAction(after, 'p1', { type: 'start' }));
  assert.throws(() => applyLabAction(after, 'p1', old, NOW), /실행/);
  assert.doesNotThrow(() => applyLabAction(after, 'p1', { ...old, runId: after.lab.runId }, NOW));
});

test('이전 정책의 실행도 초기화 세대와 상태 버전을 연속해서 증가시킨다', () => {
  let state = started(1);
  delete state.lab.generation;
  const first = action(state, 'p1', 'lab:reset');
  assert.equal(first.lab.generation, 2);
  assert.equal(first.revision, state.revision + 1);
  state = joinRoom(first, { id: 'new', name: '새 팀장', joinedAt: NOW });
  state = applyAction(state, 'new', { type: 'ready', ready: true });
  state = startLab(applyAction(state, 'new', { type: 'start' }));
  const second = action(state, 'new', 'lab:reset');
  assert.equal(second.lab.generation, 3);
  assert.equal(second.revision, state.revision + 1);
  assert.notEqual(second.lab.runId, first.lab.runId);
  assert.deepEqual(second.members, []);
});

test('모든 실험 동작은 참가자와 진행 상태 및 올바른 실행을 요구한다', () => {
  const state = started();
  assert.throws(() => action(state, 'missing', 'lab:location'), /입장/);
  assert.throws(() => action(room(), 'p1', 'lab:location'), /시작/);
  assert.throws(() => action(state, 'p1', 'lab:location', { runId: 'old' }), /실행/);
  assert.throws(() => action({ ...state, track: 'standard' }, 'p1', 'lab:reset'), /테스트/);
  assert.throws(() => action(state, 'p1', 'lab:unknown'), /지원/);
  assert.throws(() => applyLabAction(state, 'p1', null, NOW));
});

test('동작 ID는 필수이며 최근 200개만 실행별로 유지한다', () => {
  let state = started();
  for (const requestId of [undefined, null, '', 3, 'x'.repeat(81)]) {
    assert.throws(() => near(state, 'p1', { requestId }));
  }
  for (let i = 0; i < 210; i++) state = near(state, 'p1', { requestId: `position-${i}` }, NOW + i);
  assert.equal(state.lab.processedRequests.length, 200);
  assert.equal(state.lab.processedRequests[0].requestId, 'position-10');
  assert.equal(state.lab.processedRequests.at(-1).requestId, 'position-209');
});

test('완주 이후 직접 완료와 사진 인증은 결과 상태를 변경하지 못한다', () => {
  let state = atNpc(1);
  state = action(state, 'p1', 'lab:npc-touch');
  state = action(state, 'p1', 'lab:complete');
  state = finishRoute(state);
  state = near(state, 'p1');
  state = action(state, 'p1', 'lab:complete');
  const before = structuredClone(state);
  assert.equal(state.lab.stage, 'ending');
  assert.throws(() => action(state, 'p1', 'lab:complete'), /완주/);
  assert.throws(() => completePhoto(state, 'p1', state.lab.runId, { method: 'ai', verdict: true }, NOW));
  assert.deepEqual(state, before);
});
