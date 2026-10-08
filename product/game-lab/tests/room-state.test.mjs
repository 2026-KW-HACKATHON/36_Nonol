import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomState, joinRoom, applyAction } from '../src/room-state.js';

function room(count = 3) {
  let state = createRoomState({ id: 'room', title: '묵언수행' });
  for (let i = 1; i <= count; i++) state = joinRoom(state, { id: `p${i}`, name: `친구${i}`, joinedAt: i });
  return state;
}

function readyEveryone(state) {
  for (const member of state.members) state = applyAction(state, member.id, { type: 'ready', ready: true });
  return state;
}

test('첫 입장자가 팀장이 되며 1명과 7명도 입장할 수 있다', () => {
  assert.equal(room(1).leaderId, 'p1');
  const state = room(7);
  assert.equal(state.members.length, 7);
  assert.equal(state.leaderId, 'p1');
});

test('혼자 입장한 팀장도 준비와 준비 취소 후 다시 준비해야 시작할 수 있다', () => {
  let state = room(1);
  assert.throws(() => applyAction(state, 'p1', { type: 'start' }), /준비/);
  state = applyAction(state, 'p1', { type: 'ready', ready: true });
  state = applyAction(state, 'p1', { type: 'ready', ready: false });
  assert.throws(() => applyAction(state, 'p1', { type: 'start' }), /준비/);
  state = applyAction(state, 'p1', { type: 'ready', ready: true });
  const started = applyAction(state, 'p1', { type: 'start' });
  assert.equal(started.phase, 'started');
  assert.equal(started.leaderId, 'p1');
  assert.equal(started.members.length, 1);
});

test('두 명 방은 한 명만 준비하면 시작할 수 없고 전원 준비한 뒤 팀장이 시작한다', () => {
  let state = applyAction(room(2), 'p1', { type: 'ready', ready: true });
  assert.throws(() => applyAction(state, 'p1', { type: 'start' }), /준비/);
  state = applyAction(state, 'p2', { type: 'ready', ready: true });
  assert.throws(() => applyAction(state, 'p2', { type: 'start' }), /팀장/);
  assert.equal(applyAction(state, 'p1', { type: 'start' }).phase, 'started');
});

test('같은 참가자 재입장은 인원과 준비 상태를 바꾸지 않는다', () => {
  const before = readyEveryone(room());
  const after = joinRoom(before, { id: 'p1', name: '다른 이름', joinedAt: 9 });
  assert.deepEqual(after, before);
});

test('준비한 팀장끼리 양도하면 양도자만 준비가 해제된다', () => {
  const before = readyEveryone(room());
  const after = applyAction(before, 'p1', { type: 'transfer', targetId: 'p2' });
  assert.equal(after.leaderId, 'p2');
  assert.equal(after.members.find(m => m.id === 'p1').ready, false);
  assert.equal(after.members.find(m => m.id === 'p2').ready, true);
  assert.equal(after.members.find(m => m.id === 'p3').ready, true);
  assert.equal(before.members[0].ready, true);
  assert.throws(() => applyAction(after, 'p2', { type: 'start' }), /준비/);
});

test('준비하지 않은 수신자는 팀장을 받아도 준비하지 않은 상태다', () => {
  const after = applyAction(room(), 'p1', { type: 'transfer', targetId: 'p2' });
  assert.equal(after.members.find(m => m.id === 'p2').ready, false);
});

test('전원 준비 후 현재 팀장만 시작하고 시작은 한 번만 확정된다', () => {
  let state = readyEveryone(room());
  assert.throws(() => applyAction(state, 'p2', { type: 'start' }), /팀장/);
  state = applyAction(state, 'p1', { type: 'start' });
  assert.equal(state.phase, 'started');
  assert.equal(state.screen, 'track-start');
  assert.deepEqual(applyAction(state, 'p1', { type: 'start' }), state);
});

test('양도 뒤 이전 팀장에게 시작과 재양도 권한이 없다', () => {
  let state = applyAction(readyEveryone(room()), 'p1', { type: 'transfer', targetId: 'p2' });
  state = applyAction(state, 'p1', { type: 'ready', ready: true });
  assert.throws(() => applyAction(state, 'p1', { type: 'start' }), /팀장/);
  assert.throws(() => applyAction(state, 'p1', { type: 'transfer', targetId: 'p3' }), /팀장/);
  assert.equal(applyAction(state, 'p2', { type: 'start' }).phase, 'started');
});

test('새 참가자 입장 및 준비 해제 후에는 시작할 수 없다', () => {
  const before = readyEveryone(room());
  const added = joinRoom(before, { id: 'p4', name: '새 친구', joinedAt: 4 });
  assert.throws(() => applyAction(added, 'p1', { type: 'start' }), /준비/);
  const unready = applyAction(before, 'p3', { type: 'ready', ready: false });
  assert.throws(() => applyAction(unready, 'p1', { type: 'start' }), /준비/);
});

test('자기 자신과 없는 참가자에게 양도할 수 없다', () => {
  assert.throws(() => applyAction(room(), 'p1', { type: 'transfer', targetId: 'p1' }));
  assert.throws(() => applyAction(room(), 'p1', { type: 'transfer', targetId: 'missing' }));
});

test('중복 준비 요청은 버전과 상태를 불필요하게 바꾸지 않는다', () => {
  const before = applyAction(room(), 'p1', { type: 'ready', ready: true });
  assert.deepEqual(applyAction(before, 'p1', { type: 'ready', ready: true }), before);
});
