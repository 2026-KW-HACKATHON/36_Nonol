import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import track from '../public/test-track.json' with { type: 'json' };
const base = process.env.ROOM_BASE_URL || 'http://localhost:8791';
const vars = process.env.ROOM_ADMIN_KEY ? '' : await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const key = process.env.ROOM_ADMIN_KEY || vars.match(/^ROOM_ADMIN_KEY=(.+)$/m)?.[1];
async function api(path, body, authorization) {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: base, 'Content-Type': 'application/json', ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function until(check) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('팀 상태 동기화 시간 초과');
}
async function connect(id, token, t, expired = false) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/rooms/${id}/socket`, { headers: { Origin: base } });
  const client = { ws, state: null, selfId: null, messages: [], token };
  ws.on('message', raw => { if (raw.toString() === 'pong') return; const message = JSON.parse(raw.toString()); client.messages.push(message); if (message.type === 'state') { client.state = message.state; client.selfId = message.selfId; } });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', token }));
  await until(() => expired ? client.messages.find(message => message.code === 'ROOM_IDENTITY_EXPIRED') : client.state);
  client.send = async action => { const requestId = action.requestId || crypto.randomUUID(); ws.send(JSON.stringify({ runId: client.state.lab?.runId, stage: client.state.lab?.stage, ...action, requestId })); return until(() => client.messages.find(message => message.requestId === requestId && ['ack', 'error'].includes(message.type))); };
  return client;
}
async function room(t, count = 3) {
  const created = await api('/api/rooms', { title: '테스트 모듈 통신 검증', track: 'lab' }, key); assert.equal(created.status, 201);
  const id = created.body.roomId, clients = [];
  t.after(async () => { const deleted = await fetch(`${base}/api/rooms/${id}`, { method: 'DELETE', headers: { Origin: base, Authorization: `Bearer ${key}` } }); assert.equal(deleted.status, 200); });
  const summary = await api(`/api/rooms/${id}`);
  assert.equal(summary.status, 200, '생성한 실험 방의 조회가 성공해야 합니다.');
  assert.equal(summary.body.track, 'lab', '생성한 방은 실험 트랙으로 조회되어야 합니다.');
  for (let i = 0; i < count; i++) {
    const joined = await api(`/api/rooms/${id}/join`, { name: `참가${i}`, joinKey: crypto.randomUUID(), expectedGeneration: summary.body.generationId });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.generationId, summary.body.generationId);
    clients.push(await connect(id, joined.body.token, t));
  }
  await until(() => clients.every(client => client.state.members.length === count));
  return { id, clients };
}
async function start(clients) { for (const client of clients) assert.equal((await client.send({ type: 'ready', ready: true })).type, 'ack'); assert.equal((await clients[0].send({ type: 'start' })).type, 'ack'); await until(() => clients.every(client => client.state.lab.stage === 'map' && client.state.phase === 'started')); }
async function location(client, target = 'destination', extra = {}) { return client.send({ type: 'lab:location', ...client.state.lab.config[target], accuracy: 3, heading: 0, source: 'gps', measuredAt: Date.now(), ...extra }); }
async function completeAll(clients, stage) { await until(() => clients.every(client => client.state.lab.stage === stage)); const responses = await Promise.all(clients.map(client => client.send({ type: 'lab:complete' }))); assert.ok(responses.every(response => response.type === 'ack')); }

test('팀장 단계 제어는 전원 연결과 도착 기록을 유지하고 이전 실행의 요청을 격리한다', async t => {
  const { id, clients } = await room(t, 3); await start(clients);
  assert.equal((await clients[0].send({ type: 'lab:stage-control', action: 'previous' })).type, 'error');
  for (const client of clients) await location(client);
  await completeAll(clients, 'map'); await until(() => clients.every(client => client.state.lab.stage === 'photo'));
  const before = structuredClone(clients[0].state), oldRun = before.lab.runId;
  assert.equal((await clients[1].send({ type: 'lab:stage-control', action: 'reset' })).type, 'error');
  assert.equal((await clients[0].send({ type: 'lab:stage-control', action: 'previous' })).type, 'ack');
  await until(() => clients.every(client => client.state.lab.stage === 'map' && client.state.lab.runId !== oldRun));
  for (const client of clients) {
    assert.equal(client.ws.readyState, WebSocket.OPEN);
    assert.deepEqual(client.state.lab.arrivals, before.lab.arrivals);
    assert.deepEqual(client.state.lab.positions, before.lab.positions);
    assert.equal(client.state.leaderId, before.leaderId); assert.equal(client.state.members.length, 3);
  }
  const stale = await clients[1].send({ type: 'lab:complete', stage: 'photo', runId: oldRun });
  assert.equal(stale.type, 'error'); assert.notEqual(stale.code, 'ROOM_IDENTITY_EXPIRED');
  for (const stage of track.stageControl.stages.slice(1)) {
    const run = clients[0].state.lab.runId;
    assert.equal((await clients[0].send({ type: 'lab:stage-control', action: 'next' })).type, 'ack');
    await until(() => clients.every(client => client.state.lab.stage === stage && client.state.lab.runId !== run));
    assert.ok(clients.every(client => Object.keys(client.state.lab.completed).length === 0));
  }
  assert.equal((await clients[0].send({ type: 'lab:stage-control', action: 'next' })).type, 'error');
  assert.equal((await clients[0].send({ type: 'lab:stage-control', action: 'reset' })).type, 'ack');
  const resumed = await connect(id, clients[1].token, t);
  assert.equal(resumed.state.lab.stage, 'ending'); assert.equal(resumed.state.leaderId, before.leaderId);
  assert.equal((await clients[0].send({ type: 'lab:stage-control', action: 'previous' })).type, 'ack');
  await until(() => resumed.state.lab.stage === 'finder');
});

test('7명이 GPS 지도, 사진 단계 선택, 신고, NPC 개인 대화와 숨은 목적지를 함께 시험한다', async t => {
  const { clients } = await room(t, 7); await start(clients);
  assert.equal((await clients[1].send({ type: 'lab:complete' })).type, 'error');
  for (const client of clients) await location(client);
  await completeAll(clients, 'map'); await until(() => clients.every(client => client.state.lab.stage === 'photo'));
  assert.equal((await clients[0].send({ type: 'lab:complete' })).type, 'error', 'photo requires an actual server image verdict');
  assert.equal((await clients[0].send({ type: 'lab:select-stage', target: 'silence' })).type, 'ack');
  await until(() => clients.every(client => client.state.lab.stage === 'silence'));
  const requestId = crypto.randomUUID();
  await clients[0].send({ type: 'lab:report', targetId: clients[1].selfId, requestId });
  clients[0].ws.send(JSON.stringify({ type: 'lab:report', targetId: clients[1].selfId, runId: clients[0].state.lab.runId, stage: 'silence', requestId }));
  await until(() => clients[0].messages.filter(message => message.requestId === requestId && message.type === 'ack').length === 2);
  assert.equal(clients[0].state.lab.penalties[clients[1].selfId], 1);
  assert.equal((await clients[0].send({ type: 'lab:report', targetId: clients[1].selfId })).type, 'ack');
  await completeAll(clients, 'silence'); await until(() => clients.every(client => client.state.lab.stage === 'npc'));
  assert.equal((await clients[0].send({ type: 'lab:complete' })).type, 'error');
  for (const client of clients) { await location(client); assert.equal((await client.send({ type: 'lab:npc-touch' })).type, 'ack'); }
  await completeAll(clients, 'npc'); await until(() => clients.every(client => client.state.lab.stage === 'ar-route'));
  assert.equal((await clients[0].send({ type: 'lab:complete' })).type, 'error');
  for (const client of clients) {
    const { start, destination } = client.state.lab.config;
    await client.send({ type: 'lab:location', lat: (start.lat + destination.lat) / 2, lon: (start.lon + destination.lon) / 2, accuracy: 3, heading: 0, source: 'gps', measuredAt: Date.now() });
    assert.equal((await client.send({ type: 'lab:route-arrive', waypoint: 0 })).type, 'ack');
    if (client === clients[0]) {
      client.ws.close();
      const resumed = await connect(client.state.id, client.token, t);
      assert.equal(resumed.state.lab.routeProgress[resumed.selfId], 1);
      clients[0] = resumed;
    }
  }
  for (const client of clients) { await location(client); assert.equal((await client.send({ type: 'lab:route-arrive', waypoint: 1 })).type, 'ack'); }
  await until(() => clients.every(client => client.state.lab.stage === 'finder'));
  assert.equal((await clients[0].send({ type: 'lab:complete' })).type, 'error');
  for (const client of clients) await location(client, 'start');
  await completeAll(clients, 'finder'); await until(() => clients.every(client => client.state.lab.stage === 'ending'));
  for (const client of clients) { assert.equal(client.state.screen, 'ending'); assert.equal(client.state.lab.reports.length, 2); assert.equal(client.state.lab.penalties[clients[1].selfId], 2); }
});

test('마지막 경유점의 동시 도착과 중복 재전송은 전원을 한 번만 다음 단계로 이동시킨다', async t => {
  const { id, clients } = await room(t, 3); await start(clients);
  for (const client of clients) await location(client);
  await completeAll(clients, 'map');
  await until(() => clients.every(client => client.state.lab.stage === 'photo'));
  assert.equal((await clients[0].send({ type: 'lab:select-stage', target: 'silence' })).type, 'ack');
  await until(() => clients.every(client => client.state.lab.stage === 'silence'));
  await completeAll(clients, 'silence');
  await until(() => clients.every(client => client.state.lab.stage === 'npc'));
  for (const client of clients) {
    await location(client);
    assert.equal((await client.send({ type: 'lab:npc-touch' })).type, 'ack');
  }
  await completeAll(clients, 'npc');
  await until(() => clients.every(client => client.state.lab.stage === 'ar-route'));
  for (const client of clients) {
    const { start, destination } = client.state.lab.config;
    assert.equal((await client.send({ type: 'lab:location', lat: (start.lat + destination.lat) / 2, lon: (start.lon + destination.lon) / 2, accuracy: 3, heading: 0, source: 'gps', measuredAt: Date.now() })).type, 'ack');
    assert.equal((await client.send({ type: 'lab:route-arrive', waypoint: 0 })).type, 'ack');
  }
  const positions = await Promise.all(clients.map(client => location(client)));
  assert.ok(positions.every(response => response.type === 'ack'));
  const runId = clients[0].state.lab.runId;
  const arrivals = clients.map(() => ({ type: 'lab:route-arrive', waypoint: 1, stage: 'ar-route', runId, requestId: crypto.randomUUID() }));
  const completed = await Promise.all(clients.map((client, index) => client.send(arrivals[index])));
  assert.ok(completed.every(response => response.type === 'ack'));
  await until(() => clients.every(client => client.state.lab.stage === 'finder'));
  const revision = clients[0].state.revision;
  const repeated = await Promise.all(clients.map(async (client, index) => {
    client.ws.send(JSON.stringify(arrivals[index]));
    return until(() => {
      const responses = client.messages.filter(message => message.requestId === arrivals[index].requestId && ['ack', 'error'].includes(message.type));
      return responses.length >= 2 && responses.at(-1);
    });
  }));
  assert.ok(repeated.every(response => response.type === 'ack'));
  for (const client of clients) {
    assert.equal(client.state.lab.stage, 'finder');
    assert.equal(client.state.revision, revision);
    assert.deepEqual(client.state.lab.completed, {});
    assert.ok(clients.every(member => client.state.lab.routeProgress[member.selfId] === 2));
  }
  assert.equal((await clients[0].send({ ...arrivals[0], requestId: crypto.randomUUID() })).type, 'error');
  const resumed = await connect(id, clients[0].token, t);
  assert.equal(resumed.state.lab.stage, 'finder');
  assert.equal(resumed.state.revision, revision);
  assert.equal(resumed.state.lab.routeProgress[resumed.selfId], 2);
});

test('진행 중 재접속 후 초기화는 전원을 같은 링크의 빈 대기실로 보내고 이전 신원을 만료한다', async t => {
  const { id, clients } = await room(t);
  assert.equal((await clients[0].send({ type: 'lab:configure', config: { photoTarget: '하나은행 간판', radius: 20 } })).type, 'ack');
  await start(clients);
  await location(clients[0]); await clients[0].send({ type: 'lab:complete' });
  clients[0].ws.close(); const resumed = await connect(id, clients[0].token, t);
  assert.equal(resumed.state.lab.completed[resumed.selfId], true);
  const run = resumed.state.lab.runId;
  const revision = resumed.state.revision;
  assert.equal((await clients[1].send({ type: 'lab:reset' })).type, 'error');
  assert.equal((await resumed.send({ type: 'lab:reset' })).type, 'ack');
  const connected = [resumed, ...clients.slice(1)];
  await until(() => connected.every(client => client.messages.some(message => message.type === 'room-reset')));
  await until(() => connected.every(client => client.ws.readyState === WebSocket.CLOSED));
  for (const client of connected) {
    assert.notEqual(client.state.lab.runId, run);
    assert.equal(client.state.id, id);
    assert.equal(client.state.phase, 'lobby');
    assert.equal(client.state.screen, 'lobby');
    assert.equal(client.state.leaderId, null);
    assert.equal(client.state.revision, revision + 1);
    assert.equal(client.state.lab.generation, 2);
    assert.deepEqual(client.state.members, []);
    assert.deepEqual(client.state.lab.config, track.defaults);
    assert.deepEqual(client.state.lab.positions, {});
    assert.deepEqual(client.state.lab.completed, {});
    const denied = await api(`/api/rooms/${id}/join`, { token: client.token });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, 'ROOM_IDENTITY_EXPIRED');
  }
  const summary = await api(`/api/rooms/${id}`);
  assert.equal(summary.body.phase, 'lobby');
  assert.equal(summary.body.generationId, resumed.state.lab.runId);
  for (const expectedGeneration of [undefined, run]) {
    const denied = await api(`/api/rooms/${id}/join`, { name: '늦은 입장', joinKey: crypto.randomUUID(), expectedGeneration });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, 'ROOM_RESET');
  }
  const stale = await connect(id, resumed.token, t, true);
  assert.equal(stale.state, null);
  const fresh = [];
  for (let i = 0; i < 3; i++) {
    const joined = await api(`/api/rooms/${id}/join`, { name: `새 참가${i}`, joinKey: crypto.randomUUID(), expectedGeneration: summary.body.generationId });
    assert.equal(joined.status, 200);
    fresh.push(await connect(id, joined.body.token, t));
  }
  await until(() => fresh.every(client => client.state.members.length === 3));
  assert.equal(fresh[0].state.leaderId, fresh[0].selfId);
  assert.ok(fresh[0].state.members.every(member => !member.ready));
  await start(fresh);
  assert.equal((await fresh[0].send({ type: 'lab:complete', runId: run })).type, 'error');
  assert.deepEqual(fresh[0].state.lab.positions, {});
  assert.equal((await fresh[1].send({ type: 'lab:reset' })).type, 'error');
  assert.equal((await fresh[0].send({ type: 'lab:reset' })).type, 'ack');
  await until(() => fresh.every(client => client.state.lab.generation === 3 && client.ws.readyState === WebSocket.CLOSED));
  assert.deepEqual(fresh[0].state.members, []);
  assert.equal((await api(`/api/rooms/${id}/join`, { token: fresh[0].token })).body.code, 'ROOM_IDENTITY_EXPIRED');
});

test('GPS 모드의 가상 인증, 위조 판정과 사진 API 권한 및 입력을 검증한다', async t => {
  const { id, clients } = await room(t, 1), client = clients[0];
  assert.equal((await client.send({ type: 'lab:configure', config: { mode: 'gps' } })).type, 'ack'); await start(clients);
  assert.equal((await location(client, 'destination', { source: 'simulated' })).type, 'error');
  await location(client, 'destination', { source: 'gps' }); await completeAll(clients, 'map');
  assert.equal((await client.send({ type: 'lab:photo-simulate', verdict: true })).type, 'error');
  assert.equal((await client.send({ type: 'lab:complete', verdict: true })).type, 'error');
  assert.equal((await api(`/api/rooms/${id}/photo`, { runId: client.state.lab.runId, image: '' })).status, 401);
  assert.equal((await api(`/api/rooms/${id}/photo`, { runId: client.state.lab.runId, image: 'data:image/jpeg;base64,AAAA' }, client.token)).status, 400);
  const response = await fetch(`${base}/api/rooms/${id}/photo`, { method: 'POST', headers: { Origin: 'https://invalid.example', Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(response.status, 403);
  assert.equal(client.state.lab.stage, 'photo');
});
