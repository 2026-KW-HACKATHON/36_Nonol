import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomState, joinRoom, applyAction } from '../src/room-state.js';
import { createLab, startLab, applyLabAction, photoContext, completePhoto, upgradeLabPolicy } from '../src/lab-state.js';

const NOW = 100_000;
function room(count = 2) {
  let state = { ...createRoomState({ id: 'modules', title: '모듈 시험' }), track: 'lab', lab: createLab() };
  for (let number = 1; number <= count; number++) {
    state = joinRoom(state, { id: `p${number}`, name: `참가자${number}`, joinedAt: number });
    state = applyAction(state, `p${number}`, { type: 'ready', ready: true });
  }
  return startLab(applyAction(state, 'p1', { type: 'start' }));
}
function action(state, type, values = {}, actorId = 'p1') {
  return applyLabAction(state, actorId, {
    type, stage: state.lab.stage, runId: state.lab.runId, requestId: crypto.randomUUID(), ...values
  }, NOW);
}
const select = (state, target) => action(state, 'lab:select-stage', { target });
const configure = (state, config, values = {}) => action(state, 'lab:configure-module', { config, ...values });

test('독립 모듈 설정은 해당 모듈만 바꾸고 선택 및 재선택 시 팀 모두에게 투영한다', () => {
  const original = room();
  let state = configure(original, { start: { lat: 37.5, lon: 127 }, destination: { lat: 37.501, lon: 127 }, radius: 20 });
  assert.notEqual(state.lab.runId, original.lab.runId);
  const map = structuredClone(state.lab.config);
  state = select(state, 'finder');
  assert.equal(state.lab.config.mode, 'gps');
  state = configure(state, { destination: { lat: 37.502, lon: 127 }, radius: 15 });
  const finder = structuredClone(state.lab.config);
  state = select(state, 'map');
  assert.deepEqual(state.lab.config, map);
  state = select(state, 'finder');
  assert.deepEqual(state.lab.config, finder);
  assert.deepEqual(original.lab.config, original.lab.moduleConfigs.map);
  assert.deepEqual(state.members, original.members);
  assert.equal(state.leaderId, original.leaderId);
});

test('모듈 설정과 선택은 현재 실행의 팀장만 할 수 있고 모듈 범위를 벗어난 키를 거절한다', () => {
  const state = room();
  assert.throws(() => action(state, 'lab:select-stage', { target: 'photo' }, 'p2'), /팀장/);
  assert.throws(() => action(state, 'lab:configure-module', { config: { radius: 10 } }, 'p2'), /팀장/);
  assert.throws(() => select(state, 'unknown'), /모듈/);
  assert.throws(() => configure(state, { photoTarget: '숨은 사진' }), /설정/);
  assert.throws(() => configure(state, { radius: 4 }), /반경/);
  assert.throws(() => configure(state, { destination: state.lab.config.start }), /두 배/);
  assert.throws(() => action(state, 'lab:configure-module', { config: { radius: 10 }, runId: 'old' }), /새 실행/);
  assert.throws(() => action(state, 'lab:select-stage', { target: 'photo', stage: 'npc' }), /현재 단계/);
  const forged = configure(state, { radius: 10 }, { action: 'next' });
  assert.equal(forged.lab.stage, 'map');
  assert.equal(forged.lab.moduleConfigs.map.radius, 10);
  assert.equal(forged.lab.moduleConfigs.photo.radius, state.lab.moduleConfigs.photo.radius);
});

test('사진 모듈은 GPS 도착과 독립적이며 기준을 바꾸면 전원의 이전 판정과 요청을 격리한다', () => {
  let state = select(room(), 'photo');
  state = configure(state, { photoTarget: '새 간판' });
  assert.deepEqual(state.lab.arrivals, {});
  assert.equal(photoContext(state, 'p1', state.lab.runId).target, '새 간판');
  state = completePhoto(state, 'p1', state.lab.runId, { method: 'ai', verdict: true }, NOW);
  const old = state.lab.runId;
  state.lab.reference = { id: 'old-image', label: '새 간판' };
  state = configure(state, { photoTarget: '다른 물체' });
  assert.deepEqual(state.lab.completed, {});
  assert.deepEqual(state.lab.evidence, {});
  assert.equal(state.lab.reference, undefined);
  assert.throws(() => completePhoto(state, 'p2', old, { method: 'ai', verdict: true }), /새 실행/);
  assert.equal(state.lab.moduleConfigs.map.photoTarget, room().lab.config.photoTarget);
});

test('각 신고는 딜레이 없이 합산하고 모듈을 오가도 정산 자료를 보존하며 명시적 초기화로만 지운다', () => {
  let state = select(room(), 'silence');
  for (let index = 0; index < 12; index++) state = action(state, 'lab:report', { targetId: 'p2' });
  assert.equal(state.lab.penalties.p2, 12);
  state = select(state, 'ending');
  assert.equal(state.lab.penalties.p2, 12);
  assert.equal(state.lab.reports.length, 12);
  state = select(state, 'silence');
  assert.equal(state.lab.penalties.p2, 12);
  state = action(state, 'lab:stage-control', { action: 'reset' });
  assert.deepEqual(state.lab.penalties, {});
  assert.deepEqual(state.lab.reports, []);
});

test('공간 경로 프로젝트는 HTTPS와 Map ID 경계를 검사하고 다른 모듈의 설정을 유지한다', () => {
  let state = select(room(), 'ar-route');
  for (const config of [
    { spatialProjectUrl: 'http://project.test' }, { spatialProjectUrl: 'javascript:alert(1)' },
    { spatialProjectUrl: 'https://user:pass@project.test' }, { spatialProjectUrl: 7 },
    { spatialMapId: null }, { spatialMapId: 'x'.repeat(101) }
  ]) assert.throws(() => configure(state, config));
  state = configure(state, { spatialProjectUrl: ' https://project.test/route ', spatialMapId: ' map-42 ' });
  const expected = structuredClone(state.lab.config);
  assert.equal(expected.spatialProjectUrl, 'https://project.test/route');
  assert.equal(expected.spatialMapId, 'map-42');
  state = select(state, 'npc');
  assert.equal(state.lab.config.spatialProjectUrl, undefined);
  state = select(state, 'ar-route');
  assert.deepEqual(state.lab.config, expected);
});

test('탐색은 신선한 GPS 위치로 독립적으로 지정한 목적지에 도착했음을 인증한다', () => {
  let state = select(room(1), 'finder');
  const target = { lat: 37.503, lon: 127.002 };
  state = configure(state, { destination: target });
  assert.throws(() => action(state, 'lab:complete'), /위치/);
  assert.throws(() => action(state, 'lab:location', { ...target, accuracy: 5, heading: null, source: 'simulated', measuredAt: NOW }), /GPS/);
  assert.throws(() => action(state, 'lab:location', { ...target, accuracy: 5, heading: null, source: 'gps' }), /새 GPS/);
  state = action(state, 'lab:location', { ...target, accuracy: 5, heading: null, source: 'gps', measuredAt: NOW });
  state = action(state, 'lab:complete');
  assert.equal(state.lab.stage, 'ending');
});

test('기존 저장 방은 현재 설정으로 각 모듈을 초기화하며 실제 도착 기록을 새로 만들지 않는다', () => {
  const old = room();
  delete old.lab.moduleConfigs;
  old.lab.policyVersion = 10;
  old.lab.policyId = 'nonol-test-lab-v10';
  old.lab.stage = 'photo'; old.screen = 'photo';
  old.lab.config.mode = 'gps'; old.lab.config.reportCooldownMs = 10000;
  old.lab.penalties.p2 = 5;
  const next = upgradeLabPolicy(old);
  assert.equal(Object.keys(next.lab.moduleConfigs).length, 7);
  assert.deepEqual(next.lab.moduleConfigs.finder.destination, old.lab.config.start);
  assert.equal(next.lab.config.reportCooldownMs, 0);
  assert.equal(next.lab.penalties.p2, 5);
  assert.notEqual(next.lab.runId, old.lab.runId);
  assert.deepEqual(next.lab.arrivals, {});
  assert.equal(upgradeLabPolicy(next), next);
});

test('완료한 AR 길을 정령 대화부터 다시 진행하면 첫 경유점부터 새로 인증한다', () => {
  let state = select(room(1), 'ar-route');
  const position = (current, target) => action(current, 'lab:location', { ...target, accuracy: 3, heading: null, source: 'gps', measuredAt: NOW });
  const points = [
    { lat: (state.lab.config.start.lat + state.lab.config.destination.lat) / 2, lon: (state.lab.config.start.lon + state.lab.config.destination.lon) / 2 },
    state.lab.config.destination
  ];
  for (const [waypoint, target] of points.entries()) {
    state = position(state, target);
    state = action(state, 'lab:route-arrive', { waypoint });
  }
  assert.equal(state.lab.stage, 'finder');
  assert.equal(state.lab.routeProgress.p1, 2);
  state = select(state, 'npc');
  state = position(state, state.lab.config.destination);
  state = action(state, 'lab:npc-touch');
  state = action(state, 'lab:complete');
  assert.equal(state.lab.stage, 'ar-route');
  assert.deepEqual(state.lab.routeProgress, {});
  state = position(state, points[0]);
  state = action(state, 'lab:route-arrive', { waypoint: 0 });
  assert.equal(state.lab.routeProgress.p1, 1);
});

test('자동 전환도 목적 모듈의 사진과 정령 기록을 비우며 기존 신고 정산 자료를 유지한다', () => {
  let state = room(1);
  state.lab.evidence.p1 = { method: 'ai', verdict: true };
  state.lab.npcTouched.p1 = true;
  state.lab.penalties.p1 = 3;
  state.lab.reports.push({ actorId: 'other', targetId: 'p1', at: NOW });
  state = action(state, 'lab:location', { ...state.lab.config.destination, accuracy: 3, heading: null, source: 'gps', measuredAt: NOW });
  state = action(state, 'lab:complete');
  assert.equal(state.lab.stage, 'photo');
  assert.deepEqual(state.lab.evidence, {});
  state = completePhoto(state, 'p1', state.lab.runId, { method: 'ai', verdict: true }, NOW);
  state = action(state, 'lab:complete');
  assert.equal(state.lab.stage, 'npc');
  assert.deepEqual(state.lab.npcTouched, {});
  assert.equal(state.lab.penalties.p1, 3);
  assert.equal(state.lab.reports.length, 1);
});

test('진행 중인 이전 탐색 방의 출발점 목표는 이관 후 활성 설정과 동일하게 유지한다', () => {
  const old = room(1);
  delete old.lab.moduleConfigs;
  old.lab.policyVersion = 10;
  old.lab.policyId = 'nonol-test-lab-v10';
  old.lab.stage = 'finder'; old.screen = 'finder';
  const target = structuredClone(old.lab.config.start);
  const next = upgradeLabPolicy(old);
  assert.deepEqual(next.lab.config, next.lab.moduleConfigs.finder);
  assert.deepEqual(next.lab.config.destination, target);
  assert.notEqual(next.lab.runId, old.lab.runId);
  const arrived = action(next, 'lab:location', { ...target, accuracy: 3, heading: null, source: 'gps', measuredAt: NOW });
  assert.equal(action(arrived, 'lab:complete').lab.stage, 'ending');
});

test('GPS 전용 이관은 가상 위치와 합성 완료를 격리하고 실제 사진 및 정산 이력은 보존한다', () => {
  const legacy = room();
  legacy.lab.policyVersion = 11;
  legacy.lab.policyId = 'nonol-test-lab-v11';
  legacy.lab.config.mode = 'simulation';
  for (const config of Object.values(legacy.lab.moduleConfigs)) config.mode = 'simulation';
  legacy.lab.positions.p1 = { lat: 37.5, lon: 127, accuracy: 0, at: NOW, source: 'simulated' };
  legacy.lab.completed.p1 = true;
  legacy.lab.npcTouched.p1 = true;
  legacy.lab.routeProgress.p1 = 2;
  legacy.lab.evidence.p1 = { method: 'simulation', verdict: true, at: NOW };
  legacy.lab.evidence.p2 = { method: 'ai', verdict: true, at: NOW };
  legacy.lab.arrivals.p1 = { source: 'verified-map-stage', inherited: true };
  legacy.lab.arrivals.p2 = { source: 'gps', lat: 37.5, lon: 127, verifiedAt: NOW };
  legacy.lab.penalties.p2 = 4;
  legacy.lab.reports = [{ actorId: 'p1', targetId: 'p2', at: NOW }];
  const next = upgradeLabPolicy(legacy);
  assert.notEqual(next.lab.runId, legacy.lab.runId);
  assert.ok(Object.values(next.lab.moduleConfigs).every(config => config.mode === 'gps'));
  assert.equal(next.lab.config.mode, 'gps');
  for (const field of ['positions', 'completed', 'npcTouched', 'routeProgress']) assert.deepEqual(next.lab[field], {});
  assert.equal(next.lab.evidence.p1, undefined);
  assert.deepEqual(next.lab.evidence.p2, legacy.lab.evidence.p2);
  assert.equal(next.lab.arrivals.p1, undefined);
  assert.deepEqual(next.lab.arrivals.p2, legacy.lab.arrivals.p2);
  assert.deepEqual(next.lab.reports, legacy.lab.reports);
  assert.equal(next.lab.penalties.p2, 4);
  assert.equal(upgradeLabPolicy(next), next);
});

test('GPS 측정 시각 없는 좌표와 가상 성공 및 설정은 서버에서 승인하지 않는다', () => {
  const state = room();
  const point = { ...state.lab.config.destination, accuracy: 3, heading: null, source: 'gps' };
  assert.throws(() => action(state, 'lab:location', point), /새 GPS/);
  assert.throws(() => action(state, 'lab:location', { ...point, measuredAt: NOW - 30001 }), /새 GPS/);
  assert.throws(() => action(state, 'lab:location', { ...point, measuredAt: NOW + 5001 }), /새 GPS/);
  assert.throws(() => action(state, 'lab:location', { ...point, source: 'simulated', measuredAt: NOW }), /GPS/);
  assert.throws(() => configure(state, { mode: 'simulation' }), /설정/);
  const photo = select(state, 'photo');
  assert.throws(() => action(photo, 'lab:photo-simulate', { verdict: true }), /지원하지/);
  assert.deepEqual(photo.lab.completed, {});
  assert.deepEqual(photo.lab.evidence, {});
});
