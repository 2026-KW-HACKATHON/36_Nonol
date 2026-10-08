import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import track from '../public/test-track.json' with { type: 'json' };

// Execute production methods with Node SQLite. Cloudflare host objects are substituted here;
// deployed WebSocket and Workers AI behavior require separate runtime checks.
const sourceUrl = new URL('../src/game-room.js', import.meta.url);
let roomSource = await readFile(sourceUrl, 'utf8');
roomSource = roomSource.replace("import { DurableObject } from 'cloudflare:workers';", 'const DurableObject = class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } };');
for (const filename of ['room-state.js', 'lab-state.js', 'photo-verification.js', '261009_0536_track-config.js']) {
  roomSource = roomSource.replace(`'./${filename}'`, JSON.stringify(new URL(filename, sourceUrl).href));
}
roomSource = roomSource.replace("'../public/test-track.json'", JSON.stringify(new URL('../public/test-track.json', sourceUrl).href));
roomSource += `\n//# sourceURL=${sourceUrl.href}\n`;
const roomModuleUrl = `data:text/javascript;base64,${Buffer.from(roomSource).toString('base64')}`;
const { GameRoom } = await import(roomModuleUrl);
const directorySource = (await readFile(new URL('../src/261009_0159_lab-directory.js', import.meta.url), 'utf8')).replace("import { DurableObject } from 'cloudflare:workers';", 'const DurableObject = class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } };');
const directoryModuleUrl = `data:text/javascript;base64,${Buffer.from(directorySource).toString('base64')}`;
let workerSource = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
workerSource = workerSource.replace("'./game-room.js'", JSON.stringify(roomModuleUrl));
workerSource = workerSource.replaceAll("'./261009_0159_lab-directory.js'", JSON.stringify(directoryModuleUrl));
workerSource = workerSource.replace("'./photo-verification.js'", JSON.stringify(new URL('../src/photo-verification.js', import.meta.url).href));
workerSource += `\n//# sourceURL=${new URL('../src/worker.js', import.meta.url).href}\n`;
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { this.request = request; this.response = response; } };

function fixture(t, count = 2, config = {}, { startImmediately = true } = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sockets = [];
  const sql = { exec(query, ...bindings) {
    const statement = database.prepare(query);
    const rows = statement.all(...bindings).map(row => ({ ...row }));
    return { toArray: () => rows };
  } };
  const ctx = {
    storage: { sql, transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    } },
    getWebSockets: () => sockets,
    setWebSocketAutoResponse() {},
  };
  const room = new GameRoom(ctx, {});
  const roomId = crypto.randomUUID();
  room.create(roomId, '집에서 검증', 'lab');
  function connect(credential) {
    const ws = { readyState: 1, messages: [], attachment: null,
      deserializeAttachment() { return this.attachment; },
      serializeAttachment(value) { this.attachment = value; },
      send(value) { this.messages.push(JSON.parse(value)); },
      close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; },
    };
    sockets.push(ws);
    room.webSocketMessage(ws, JSON.stringify({ type: 'hello', token: credential.token }));
    return { ...credential, ws };
  }
  const clients = Array.from({ length: count }, (_, index) => connect(room.join(`참가자${index + 1}`, null, crypto.randomUUID())));
  function send(index, action) {
    const state = room.read();
    const requestId = crypto.randomUUID();
    if (action.type === 'lab:location' && action.measuredAt === undefined) action = { measuredAt: Date.now(), ...action };
    room.webSocketMessage(clients[index].ws, JSON.stringify({ runId: state.lab.runId, stage: state.lab.stage, requestId, ...action }));
    return clients[index].ws.messages.findLast(message => message.requestId === requestId);
  }
  function photoStage() {
    for (let index = 0; index < clients.length; index++) {
      const state = room.read();
      assert.equal(send(index, { type: 'lab:location', ...state.lab.config.destination, source: 'gps', accuracy: 3, heading: null }).type, 'ack');
    }
    for (let index = 0; index < clients.length; index++) assert.equal(send(index, { type: 'lab:complete' }).type, 'ack');
    assert.equal(room.read().lab.stage, 'photo');
  }
  function rejoin(count = clients.length) {
    const generationId = room.summary().generationId;
    const fresh = Array.from({ length: count }, (_, index) => connect(room.join(`새 참가자${index + 1}`, null, crypto.randomUUID(), generationId)));
    clients.splice(0, clients.length, ...fresh);
    return fresh;
  }
  function start() {
    for (let index = 0; index < clients.length; index++) assert.equal(send(index, { type: 'ready', ready: true }).type, 'ack');
    assert.equal(send(0, { type: 'start' }).type, 'ack');
  }
  if (config.radius > track.defaults.radius && !config.destination) config = { destination: { lat: track.defaults.start.lat + .01, lon: track.defaults.start.lon }, ...config };
  if (Object.keys(config).length) assert.equal(send(0, { type: 'lab:configure', config }).type, 'ack');
  if (startImmediately) start();
  return { room, roomId, clients, ctx, database, sql, send, photoStage, connect, rejoin, start };
}

const fakeJpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, ...Array(100).fill(0)]).toString('base64')}`;
const referenceJpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, ...Array(100).fill(1)]).toString('base64')}`;
function photoRequest(roomId, token, runId, image = fakeJpeg) {
  return new Request(`https://game.test/api/rooms/${roomId}/photo`, {
    method: 'POST', headers: { Origin: 'https://game.test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId, image }),
  });
}
function joinRequest(roomId, body) {
  return new Request(`https://game.test/api/rooms/${roomId}/join`, {
    method: 'POST', headers: { Origin: 'https://game.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
function jobs(f) { return f.sql.exec('SELECT actor_id, job_id FROM photo_jobs').toArray(); }

test('모듈 선택과 설정은 모든 소켓에 같은 실행과 설정을 보내고 참가자 인증을 유지한다', t => {
  const f = fixture(t);
  const identities = f.sql.exec('SELECT id,token FROM identities ORDER BY id').toArray();
  assert.equal(f.send(1, { type: 'lab:select-stage', target: 'finder' }).type, 'error');
  assert.equal(f.send(0, { type: 'lab:select-stage', target: 'finder' }).type, 'ack');
  const selected = f.room.read();
  assert.equal(f.send(1, { type: 'lab:configure-module', config: { radius: 10 } }).type, 'error');
  assert.equal(f.send(0, { type: 'lab:configure-module', config: { destination: { lat: 37.505, lon: 127.005 }, radius: 10 } }).type, 'ack');
  const configured = f.room.read();
  assert.notEqual(configured.lab.runId, selected.lab.runId);
  assert.equal(configured.lab.config.radius, 10);
  assert.deepEqual(configured.lab.config, configured.lab.moduleConfigs.finder);
  assert.deepEqual(f.sql.exec('SELECT id,token FROM identities ORDER BY id').toArray(), identities);
  for (const client of f.clients) {
    assert.equal(client.ws.attachment.generationId, configured.lab.runId);
    assert.equal(client.ws.readyState, 1);
    assert.deepEqual(client.ws.messages.findLast(message => message.type === 'state').state.lab, configured.lab);
    assert.equal(f.room.join('', client.token, null).participantId, client.participantId);
  }
  assert.deepEqual(new GameRoom(f.ctx, {}).read(), configured);
  assert.equal(f.send(0, { type: 'lab:select-stage', target: 'map' }).type, 'ack');
  assert.equal(f.room.read().lab.config.radius, track.defaults.radius);
  assert.equal(f.send(0, { type: 'lab:select-stage', target: 'finder' }).type, 'ack');
  assert.equal(f.room.read().lab.config.radius, 10);
});

test('사진 모듈 설정 저장 실패는 사진 예약과 완료 및 소켓 실행을 원자적으로 유지한다', t => {
  const f = fixture(t); f.photoStage();
  const original = f.room.setReference(f.clients[0].token, referenceJpeg, '이전 기준', f.room.read().lab.runId);
  f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  const before = f.room.read(), beforeJobs = jobs(f), save = f.room.save;
  f.room.save = () => { throw new Error('모듈 저장 실패'); };
  assert.equal(f.send(0, { type: 'lab:configure-module', config: { photoTarget: '새 기준' } }).type, 'error');
  f.room.save = save;
  assert.deepEqual(f.room.read(), before);
  assert.deepEqual(jobs(f), beforeJobs);
  assert.deepEqual(f.room.reference(f.clients[1].token), original);
  assert.ok(f.clients.every(client => client.ws.attachment.generationId === before.lab.runId));
  assert.equal(f.send(0, { type: 'lab:configure-module', config: { photoTarget: '새 기준' } }).type, 'ack');
  const next = f.room.read();
  assert.deepEqual(jobs(f), []);
  assert.equal(next.lab.reference, undefined);
  assert.equal(f.room.reference(f.clients[0].token), null);
  assert.ok(f.clients.every(client => client.ws.attachment.generationId === next.lab.runId));
});

test('같은 시각에 이어지는 소켓 신고는 전부 집계하고 동일 요청 재전송은 한 번만 반영한다', t => {
  const f = fixture(t);
  assert.equal(f.send(0, { type: 'lab:select-stage', target: 'silence' }).type, 'ack');
  for (let index = 0; index < 20; index++) assert.equal(f.send(0, { type: 'lab:report', targetId: f.clients[1].participantId }).type, 'ack');
  const state = f.room.read();
  const requestId = crypto.randomUUID();
  const message = JSON.stringify({ type: 'lab:report', runId: state.lab.runId, stage: 'silence', requestId, targetId: f.clients[1].participantId });
  f.room.webSocketMessage(f.clients[0].ws, message);
  const once = f.room.read();
  f.room.webSocketMessage(f.clients[0].ws, message);
  assert.deepEqual(f.room.read(), once);
  assert.equal(once.lab.reports.length, 21);
  assert.equal(once.lab.penalties[f.clients[1].participantId], 21);
  assert.equal(f.send(0, { type: 'lab:select-stage', target: 'ending' }).type, 'ack');
  assert.equal(f.room.read().lab.penalties[f.clients[1].participantId], 21);
});

test('단계 초기화는 사진 작업만 취소하고 참가자 신원과 연결 및 기준 사진을 유지한다', t => {
  const f = fixture(t, 2, { mode: 'gps' }); f.photoStage();
  const reference = f.room.setReference(f.clients[0].token, referenceJpeg, '팀 기준', f.room.read().lab.runId);
  const before = f.room.read();
  const old = f.room.photoContext(f.clients[0].token, before.lab.runId);
  const identities = f.sql.exec('SELECT id, token FROM identities ORDER BY id').toArray();
  assert.equal(f.send(1, { type: 'lab:stage-control', action: 'reset' }).type, 'error');
  assert.equal(jobs(f)[0].job_id, old.jobId);
  assert.equal(f.send(0, { type: 'lab:stage-control', action: 'reset' }).type, 'ack');
  const after = f.room.read();
  assert.notEqual(after.lab.runId, before.lab.runId); assert.equal(after.lab.stage, 'photo');
  assert.deepEqual(after.lab.arrivals, before.lab.arrivals); assert.deepEqual(after.lab.config, before.lab.config);
  assert.deepEqual(f.sql.exec('SELECT id, token FROM identities ORDER BY id').toArray(), identities);
  assert.deepEqual(jobs(f), []); assert.deepEqual(f.room.reference(f.clients[1].token), reference);
  for (const client of f.clients) {
    assert.equal(client.ws.readyState, 1); assert.equal(client.ws.attachment.generationId, after.lab.runId);
    assert.equal(f.room.join('', client.token, null).participantId, client.participantId);
    assert.equal(client.ws.messages.some(message => message.type === 'room-reset'), false);
  }
  assert.equal(f.send(1, { type: 'lab:photo-simulate', runId: before.lab.runId, verdict: true }).type, 'error');
  assert.throws(() => f.room.recordPhoto(old.actorId, before.lab.runId, old.jobId, { method: 'ai', verdict: true }), /갱신/);
  const current = f.room.photoContext(f.clients[0].token, after.lab.runId);
  f.room.recordPhoto(current.actorId, after.lab.runId, current.jobId, { method: 'ai', verdict: true });
  assert.equal(f.room.read().lab.completed[current.actorId], true);
  assert.deepEqual(new GameRoom(f.ctx, {}).read(), f.room.read());
});

test('단계 제어 저장 실패는 사진 예약과 소켓 실행 ID를 함께 유지한다', t => {
  const f = fixture(t); f.photoStage();
  f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  const before = f.room.read(), beforeJobs = jobs(f);
  const save = f.room.save;
  f.room.save = () => { throw new Error('단계 제어 저장 실패'); };
  assert.equal(f.send(0, { type: 'lab:stage-control', action: 'next' }).type, 'error');
  f.room.save = save;
  assert.deepEqual(f.room.read(), before); assert.deepEqual(jobs(f), beforeJobs);
  assert.ok(f.clients.every(client => client.ws.attachment.generationId === before.lab.runId && client.ws.readyState === 1));
  assert.equal(f.send(0, { type: 'lab:stage-control', action: 'next' }).type, 'ack');
  assert.equal(f.room.read().lab.stage, 'silence');
});

test('이전 방의 GPS 정책 이관은 연결과 실제 도착을 유지하고 오래된 판정 예약을 취소한다', t => {
  const f = fixture(t); f.photoStage();
  const job = f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  const legacy = f.room.read();
  legacy.lab.policyId = 'nonol-test-lab-v4'; legacy.lab.policyVersion = 4;
  delete legacy.lab.moduleConfigs;
  f.room.save(legacy);
  const restored = new GameRoom(f.ctx, {}), after = restored.read();
  assert.equal(after.lab.policyVersion, track.version);
  assert.equal(after.revision, legacy.revision + 1);
  assert.notEqual(after.lab.runId, legacy.lab.runId);
  assert.deepEqual(after.lab.arrivals, legacy.lab.arrivals);
  assert.deepEqual(after.lab.positions, {});
  assert.deepEqual(after.members, legacy.members);
  assert.equal(after.leaderId, legacy.leaderId);
  assert.deepEqual(jobs(f), []);
  assert.ok(f.clients.every(client => client.ws.attachment.generationId === after.lab.runId));
  assert.throws(() => restored.recordPhoto(job.actorId, legacy.lab.runId, job.jobId, { method: 'ai', verdict: true }), /갱신/);
  const fresh = restored.photoContext(f.clients[0].token, after.lab.runId);
  restored.recordPhoto(fresh.actorId, after.lab.runId, fresh.jobId, { method: 'ai', verdict: true });
  assert.equal(restored.read().lab.completed[job.actorId], true);
});

test('이전 코스 정책 이관은 기존 좌표 설정과 토큰을 유지하며 현재 GPS를 새로 받는다', t => {
  const f = fixture(t); f.photoStage();
  const legacy = f.room.read();
  legacy.lab.policyId = 'nonol-test-lab-v5'; legacy.lab.policyVersion = 5;
  legacy.lab.config.destination = { ...legacy.lab.config.start };
  delete legacy.lab.moduleConfigs;
  f.room.save(legacy);
  const restored = new GameRoom(f.ctx, {}), after = restored.read();
  assert.equal(after.lab.policyVersion, track.version);
  assert.notEqual(after.lab.runId, legacy.lab.runId);
  assert.deepEqual(after.lab.config, legacy.lab.config);
  assert.deepEqual(after.lab.positions, {});
  assert.deepEqual(after.lab.arrivals, legacy.lab.arrivals);
  assert.deepEqual(after.members, legacy.members);
  assert.equal(restored.join('', f.clients[0].token, null).participantId, f.clients[0].participantId);
});

test('이전 소켓의 첫 요청 중 GPS 이관이 일어나도 신원은 유지하고 이전 실행만 거절한다', t => {
  const f = fixture(t);
  const legacy = f.room.read();
  legacy.lab.policyId = 'nonol-test-lab-v11'; legacy.lab.policyVersion = 11;
  legacy.lab.config.mode = 'simulation';
  legacy.lab.positions[f.clients[0].participantId] = { ...legacy.lab.config.destination, accuracy: 0, at: Date.now(), source: 'simulated' };
  f.room.save(legacy);
  const requestId = crypto.randomUUID();
  f.room.webSocketMessage(f.clients[0].ws, JSON.stringify({ type: 'lab:select-stage', target: 'photo', runId: legacy.lab.runId, stage: 'map', requestId }));
  const error = f.clients[0].ws.messages.findLast(message => message.requestId === requestId);
  assert.equal(error.type, 'error');
  assert.equal(error.code, undefined);
  assert.match(error.message, /새 실행/);
  const migrated = f.room.read();
  assert.notEqual(migrated.lab.runId, legacy.lab.runId);
  assert.deepEqual(migrated.lab.positions, {});
  assert.ok(f.clients.every(client => client.ws.attachment.generationId === migrated.lab.runId && client.ws.readyState === 1));
  assert.equal(f.send(0, { type: 'lab:select-stage', target: 'photo' }).type, 'ack');
  assert.equal(f.room.read().lab.stage, 'photo');
});

test('겹치는 GPS 코스도 대기실에서 시작하고 지도 완료는 유효한 목적지를 요구한다', t => {
  const lobby = fixture(t, 2, {}, { startImmediately: false });
  const configState = lobby.room.read();
  configState.lab.config.mode = 'gps'; configState.lab.config.destination = { ...configState.lab.config.start };
  lobby.room.save(configState);
  for (let index = 0; index < 2; index++) assert.equal(lobby.send(index, { type: 'ready', ready: true }).type, 'ack');
  assert.equal(lobby.send(0, { type: 'start' }).type, 'ack');
  assert.equal(lobby.room.read().phase, 'started');
  const started = fixture(t, 2, { mode: 'gps' });
  const legacy = started.room.read(); legacy.lab.config.destination = { ...legacy.lab.config.start };
  started.room.save(legacy);
  assert.equal(started.send(0, { type: 'lab:location', ...legacy.lab.config.start, accuracy: 3, heading: null, source: 'gps' }).type, 'ack');
  const beforeArrival = started.room.read();
  assert.equal(started.send(0, { type: 'lab:complete' }).type, 'error');
  assert.deepEqual(started.room.read(), beforeArrival);
  assert.deepEqual(started.room.read().lab.arrivals, {});
});

test('단계 제어 중 한 소켓의 attachment 실패는 다른 연결의 동기화와 인증을 유지한다', t => {
  const f = fixture(t, 3);
  f.clients[1].ws.serializeAttachment = () => { throw new Error('attachment 저장 실패'); };
  assert.equal(f.send(0, { type: 'lab:stage-control', action: 'next' }).type, 'ack');
  const after = f.room.read();
  assert.equal(f.clients[1].ws.readyState, 3); assert.equal(f.clients[1].ws.closeCode, 1011);
  for (const index of [0, 2]) {
    assert.equal(f.clients[index].ws.readyState, 1);
    assert.equal(f.clients[index].ws.attachment.generationId, after.lab.runId);
    assert.equal(f.clients[index].ws.messages.findLast(message => message.type === 'state').state.lab.runId, after.lab.runId);
  }
  assert.equal(f.send(2, { type: 'lab:location', ...after.lab.config.destination, source: 'gps', accuracy: 3, heading: null }).type, 'ack');
  const reconnect = f.connect(f.room.join('', f.clients[1].token, null));
  assert.equal(reconnect.ws.attachment.generationId, after.lab.runId);
  assert.equal(reconnect.ws.readyState, 1);
});

test('현재 사진 단계 초기화 뒤 늦은 HTTP 판정과 finally는 새 사진 예약을 변경하지 않는다', async t => {
  const f = fixture(t); f.photoStage();
  const runId = f.room.read().lab.runId;
  let releaseAI, signalAI;
  const entered = new Promise(resolve => { signalAI = resolve; });
  const env = referenceEnv(f); env.AI = { run: () => { signalAI(); return new Promise(resolve => { releaseAI = resolve; }); } };
  const oldRequest = worker.fetch(photoRequest(f.roomId, f.clients[0].token, runId), env);
  await entered;
  assert.equal(f.send(0, { type: 'lab:stage-control', action: 'reset' }).type, 'ack');
  const after = f.room.read(), current = f.room.photoContext(f.clients[0].token, after.lab.runId);
  releaseAI({ response: 'YES' });
  assert.equal((await oldRequest).status, 400);
  assert.deepEqual(f.room.read().lab.completed, {});
  assert.equal(jobs(f)[0].job_id, current.jobId);
  f.room.recordPhoto(current.actorId, after.lab.runId, current.jobId, { method: 'ai', verdict: true });
  assert.equal(f.room.read().lab.completed[current.actorId], true);
});
function referenceRequest(roomId, token, body, { method = 'POST', origin = 'https://game.test' } = {}) {
  return new Request(`https://game.test/api/rooms/${roomId}/reference`, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}
function catalogRequest(id, token, body, method = 'POST') {
  return new Request(`https://game.test/api/photo-references/${id}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}
function referenceEnv(f, catalog = { getReference: id => ({ id, image: referenceJpeg, label: track.defaults.photoTarget, updatedAt: 0 }) }) {
  return { ROOMS: { getByName(name) {
    if (name === f.roomId) return f.room;
    if (name === 'lab-photo-reference-catalog') return catalog;
    throw new Error(`Unexpected room: ${name}`);
  } } };
}

test('실제 SQL에서 테스트 방을 생성하고 재구성해도 설정과 참가자 및 진행을 보존한다', t => {
  const f = fixture(t, 2, { photoTarget: '하나은행 간판', radius: 50 });
  const before = f.room.read();
  assert.equal(before.track, 'lab');
  assert.equal(before.screen, 'map');
  assert.equal(f.room.summary().track, 'lab');
  assert.throws(() => f.room.create(f.roomId, '중복', 'lab'), /존재/);
  const restored = new GameRoom({ ...f.ctx, getWebSockets: () => [] }, {});
  assert.deepEqual(restored.read(), before);
  assert.equal(restored.read().lab.config.photoTarget, '하나은행 간판');
  assert.equal(f.sql.exec('SELECT id FROM identities').toArray().length, 2);
  assert.equal(f.room.summary().generationId, before.lab.runId);
  assert.equal(f.room.summary().labPolicyId, before.lab.policyId);
  assert.equal(f.room.summary().labPolicyVersion, before.lab.policyVersion);
  assert.deepEqual(restored.join('', f.clients[0].token, null), { participantId: f.clients[0].participantId, token: f.clients[0].token, generationId: before.lab.runId });
});

test('이전 정책의 참가자만 저장한 소켓은 GPS 이관 후 현재 실행으로 전체 초기화한다', t => {
  const f = fixture(t); f.photoStage();
  const legacy = f.room.read();
  for (const field of ['policyId', 'policyVersion', 'generation', 'moduleConfigs']) delete legacy.lab[field];
  for (const client of f.clients) client.ws.serializeAttachment({ participantId: client.participantId });
  f.room.save(legacy);
  const restored = new GameRoom(f.ctx, {}), upgraded = restored.read();
  assert.equal(upgraded.lab.policyVersion, track.version);
  assert.notEqual(upgraded.lab.runId, legacy.lab.runId);
  assert.ok(f.clients.every(client => client.ws.attachment.generationId === upgraded.lab.runId));
  const requestId = crypto.randomUUID();
  restored.webSocketMessage(f.clients[0].ws, JSON.stringify({ type: 'lab:reset', requestId, runId: upgraded.lab.runId }));
  assert.equal(f.clients[0].ws.messages.findLast(message => message.requestId === requestId).type, 'ack');
  const after = restored.read();
  assert.equal(after.phase, 'lobby');
  assert.equal(after.leaderId, null);
  assert.equal(after.lab.generation, 2);
  assert.deepEqual(after.members, []);
  assert.deepEqual(after.lab.positions, {});
  assert.deepEqual(jobs(f), []);
  assert.deepEqual(f.sql.exec('SELECT id FROM identities').toArray(), []);
  assert.ok(f.clients.every(client => client.ws.readyState === 3 && client.ws.attachment === null));
  assert.equal(restored.join('', f.clients[0].token, null).code, 'ROOM_IDENTITY_EXPIRED');
});

test('이전 컵 대상은 기본 생수병으로 이관하고 실제 사진 기록과 정산 및 참가자는 보존한다', t => {
  const f = fixture(t); f.photoStage();
  const legacy = f.room.read(), person = f.clients[0].participantId;
  legacy.lab.config.photoTarget = '컵';
  legacy.lab.policyId = 'nonol-test-lab-v2'; legacy.lab.policyVersion = 2;
  delete legacy.lab.moduleConfigs;
  legacy.lab.completed[person] = true;
  legacy.lab.evidence[person] = { method: 'ai', verdict: true, at: Date.now(), reason: '컵 확인' };
  legacy.lab.penalties[f.clients[1].participantId] = 2;
  legacy.lab.reports = [{ actorId: person, targetId: f.clients[1].participantId, at: Date.now() }];
  f.room.save(legacy);
  const current = f.room.read();
  assert.equal(current.lab.config.photoTarget, track.defaults.photoTarget);
  assert.notEqual(current.lab.runId, legacy.lab.runId);
  assert.deepEqual(current.lab.completed, {});
  assert.deepEqual(current.lab.positions, {});
  assert.deepEqual(current.lab.evidence, legacy.lab.evidence);
  assert.deepEqual(current.lab.penalties, legacy.lab.penalties);
  assert.deepEqual(current.lab.reports, legacy.lab.reports);
  assert.deepEqual(current.members, legacy.members);
  assert.deepEqual(new GameRoom(f.ctx, {}).read(), current);
  assert.equal(f.room.photoContext(f.clients[0].token, current.lab.runId).target, track.defaults.photoTarget);
});

test('이전 사용자 지정 사진 대상은 그대로 유지하고 새 실행에서 실제 사진을 판정한다', t => {
  const f = fixture(t, 2, { photoTarget: '하나은행 간판' }); f.photoStage();
  const custom = f.room.read();
  custom.lab.policyId = 'nonol-test-lab-v2'; custom.lab.policyVersion = 2;
  delete custom.lab.moduleConfigs;
  f.room.save(custom);
  const upgraded = f.room.read();
  assert.notEqual(upgraded.lab.runId, custom.lab.runId);
  assert.equal(upgraded.lab.config.photoTarget, '하나은행 간판');
  const job = f.room.photoContext(f.clients[0].token, upgraded.lab.runId);
  f.room.recordPhoto(job.actorId, upgraded.lab.runId, job.jobId, { method: 'ai', verdict: true });
  assert.equal(f.room.read().lab.completed[job.actorId], true);
});

test('현재 정책에서 직접 선택한 컵 대상은 저장과 재접속 후에도 유지하고 기존 예약을 완료한다', t => {
  const f = fixture(t, 2, { photoTarget: '컵' }); f.photoStage();
  const custom = f.room.read();
  assert.equal(custom.lab.policyVersion, track.version);
  assert.equal(custom.lab.config.photoTarget, '컵');
  const job = f.room.photoContext(f.clients[0].token, custom.lab.runId);
  assert.equal(job.target, '컵');
  const beforeJobs = jobs(f);
  const restored = new GameRoom(f.ctx, {});
  assert.deepEqual(restored.read(), custom);
  assert.deepEqual(JSON.parse(f.sql.exec('SELECT state FROM room WHERE id = 1').toArray()[0].state), custom);
  assert.equal(restored.snapshot().lab.config.photoTarget, '컵');
  assert.deepEqual(jobs(f), beforeJobs);
  assert.equal(restored.join('', f.clients[0].token, null).participantId, f.clients[0].participantId);
  restored.recordPhoto(job.actorId, custom.lab.runId, job.jobId, { method: 'ai', verdict: true });
  assert.equal(restored.read().lab.config.photoTarget, '컵');
  assert.equal(restored.read().lab.completed[job.actorId], true);
  assert.equal(restored.photoContext(f.clients[1].token, custom.lab.runId).target, '컵');
});

test('대상 전환 이전 컵 판정의 늦은 응답은 생수병 인증을 완료하지 못한다', t => {
  const f = fixture(t, 2); f.photoStage();
  const legacy = f.room.read();
  legacy.lab.config.photoTarget = '컵';
  legacy.lab.policyId = 'nonol-test-lab-v2';
  legacy.lab.policyVersion = 2;
  const actorId = f.clients[0].participantId;
  const oldJobId = crypto.randomUUID();
  f.room.save(legacy);
  f.sql.exec('INSERT INTO photo_jobs (actor_id, job_id, started_at) VALUES (?, ?, ?)', actorId, oldJobId, Date.now());
  assert.throws(() => f.room.recordPhoto(actorId, legacy.lab.runId, oldJobId, { method: 'ai', verdict: true }), /갱신/);
  assert.deepEqual(jobs(f), []);
  assert.equal(f.room.read().lab.config.photoTarget, track.defaults.photoTarget);
  assert.deepEqual(f.room.read().lab.evidence, legacy.lab.evidence);
  assert.deepEqual(f.room.read().lab.completed, legacy.lab.completed);
  const fresh = f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  assert.equal(fresh.target, track.defaults.photoTarget);
  f.room.finishPhoto(actorId, oldJobId);
  assert.equal(jobs(f)[0].job_id, fresh.jobId);
});

test('v3 GPS 사진 단계는 도착을 만들지 않고 이전 용량 판정 작업을 취소한다', t => {
  const f = fixture(t, 2, { mode: 'gps' }); f.photoStage();
  const legacy = f.room.read();
  legacy.lab.config.photoTarget = '500ml 생수병';
  legacy.lab.policyId = 'nonol-test-lab-v3';
  legacy.lab.policyVersion = 3;
  delete legacy.lab.arrivals;
  for (const position of Object.values(legacy.lab.positions)) {
    position.accuracy = 500;
    position.at = Date.now() - 60000;
  }
  f.room.save(legacy);
  const oldJobId = crypto.randomUUID();
  f.sql.exec('INSERT INTO photo_jobs (actor_id, job_id, started_at) VALUES (?, ?, ?)', f.clients[0].participantId, oldJobId, Date.now());
  const restored = new GameRoom(f.ctx, {});
  const upgraded = restored.read();
  assert.equal(upgraded.lab.config.photoTarget, track.defaults.photoTarget);
  assert.equal(upgraded.lab.policyId, track.id);
  assert.equal(upgraded.lab.policyVersion, track.version);
  assert.equal(upgraded.revision, legacy.revision + 1);
  assert.deepEqual(jobs(f), []);
  for (const client of f.clients) {
    assert.equal(upgraded.lab.arrivals[client.participantId], undefined);
    assert.equal(restored.join('', client.token, null).participantId, client.participantId);
  }
  assert.deepEqual(new GameRoom(f.ctx, {}).read(), upgraded);
  assert.throws(() => restored.recordPhoto(f.clients[0].participantId, legacy.lab.runId, oldJobId, { method: 'ai', verdict: true }), /갱신/);
  const current = restored.photoContext(f.clients[0].token, upgraded.lab.runId);
  assert.equal(current.referenceId, track.photoRules[track.defaults.photoTarget].referenceId);
  assert.equal(current.customReference, false);
});

test('독립 사진 모듈은 도착 기록이 없어도 위치와 유효한 사진 작업을 유지한다', t => {
  const f = fixture(t, 2, { mode: 'gps' }); f.photoStage();
  const state = f.room.read();
  const currentJob = f.room.photoContext(f.clients[0].token, state.lab.runId);
  const savedArrival = state.lab.arrivals[f.clients[1].participantId];
  delete state.lab.arrivals[f.clients[0].participantId];
  f.room.save(state);
  const repaired = f.room.read();
  assert.equal(repaired.lab.arrivals[f.clients[0].participantId], undefined);
  assert.deepEqual(repaired.lab.arrivals[f.clients[1].participantId], savedArrival);
  assert.equal(repaired.revision, state.revision);
  assert.equal(jobs(f)[0].job_id, currentJob.jobId);
  assert.deepEqual(f.room.read(), repaired);
  f.room.recordPhoto(currentJob.actorId, state.lab.runId, currentJob.jobId, { method: 'ai', verdict: true });
  assert.equal(f.room.read().lab.completed[currentJob.actorId], true);
});

test('같은 참가자의 동시 사진 예약은 하나만 승인하며 다른 참가자는 별도로 판정한다', async t => {
  const f = fixture(t); f.photoStage();
  const runId = f.room.read().lab.runId;
  const results = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => f.room.photoContext(f.clients[0].token, runId))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /판정/);
  assert.equal(jobs(f).length, 1);
  const other = f.room.photoContext(f.clients[1].token, runId);
  assert.equal(other.actorId, f.clients[1].participantId);
  assert.equal(jobs(f).length, 2);
});

test('실패한 사진 판정의 작업을 해제하면 같은 참가자가 재촬영할 수 있다', t => {
  const f = fixture(t); f.photoStage();
  const runId = f.room.read().lab.runId;
  const job = f.room.photoContext(f.clients[0].token, runId);
  f.room.recordPhoto(job.actorId, runId, job.jobId, { method: 'ai', verdict: false });
  f.room.finishPhoto(job.actorId, job.jobId);
  const next = f.room.photoContext(f.clients[0].token, runId);
  assert.notEqual(next.jobId, job.jobId);
  assert.equal(f.room.read().lab.evidence[job.actorId].verdict, false);
  assert.equal(f.room.read().lab.completed[job.actorId], undefined);
});

test('초기화는 모든 신원과 사진 작업을 지우고 같은 방을 기본 설정의 빈 대기실로 저장한다', t => {
  const f = fixture(t, 2, { radius: 50, photoTarget: '하나은행 간판' }); f.photoStage();
  const oldRun = f.room.read().lab.runId;
  f.room.photoContext(f.clients[0].token, oldRun);
  const before = f.room.read();
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  const after = f.room.read();
  assert.equal(jobs(f).length, 0);
  assert.equal(f.sql.exec('SELECT id, token FROM identities').toArray().length, 0);
  assert.equal(after.id, before.id);
  assert.equal(after.title, before.title);
  assert.equal(after.phase, 'lobby');
  assert.equal(after.screen, 'lobby');
  assert.equal(after.leaderId, null);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.lab.generation, 2);
  assert.notEqual(after.lab.runId, oldRun);
  assert.deepEqual(after.members, []);
  assert.deepEqual(after.lab.config, track.defaults);
  for (const field of ['completed', 'positions', 'penalties', 'npcTouched', 'routeProgress', 'evidence']) assert.deepEqual(after.lab[field], {});
  for (const field of ['reports', 'processedRequests']) assert.deepEqual(after.lab[field], []);
  const restored = new GameRoom({ ...f.ctx, getWebSockets: () => [] }, {});
  assert.deepEqual(restored.read(), after);
  assert.equal(restored.summary().generationId, after.lab.runId);
  for (const old of f.clients) {
    assert.equal(old.ws.attachment, null);
    assert.equal(old.ws.readyState, 3);
    assert.equal(old.ws.closeCode, 4401);
    assert.deepEqual(old.ws.messages.findLast(message => message.type === 'room-reset'), { type: 'room-reset', generationId: after.lab.runId });
    const lobby = old.ws.messages.findLast(message => message.type === 'state');
    assert.equal(lobby.state.phase, 'lobby');
    assert.deepEqual(lobby.state.members, []);
    assert.equal(restored.join('', old.token, null).code, 'ROOM_IDENTITY_EXPIRED');
    assert.throws(() => restored.photoContext(old.token, oldRun), /입장/);
  }
  const first = restored.join('새 팀장', null, crypto.randomUUID(), after.lab.runId);
  assert.equal(first.generationId, after.lab.runId);
  assert.equal(restored.read().leaderId, first.participantId);
  assert.equal(restored.read().members[0].ready, false);
});

test('팀원이 보낸 초기화는 진행과 예약된 사진 작업을 변경하지 않는다', t => {
  const f = fixture(t); f.photoStage();
  f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  const before = f.room.read(); const beforeJobs = jobs(f);
  assert.equal(f.send(1, { type: 'lab:reset' }).type, 'error');
  assert.deepEqual(f.room.read(), before);
  assert.deepEqual(jobs(f), beforeJobs);
  assert.equal(f.sql.exec('SELECT id FROM identities').toArray().length, 2);
  assert.ok(f.clients.every(client => client.ws.readyState === 1));
  assert.ok(f.clients.every(client => !client.ws.messages.some(message => message.type === 'room-reset')));
});

test('초기화에는 현재 실행 ID와 진행 중인 팀장 권한이 필요하다', t => {
  const f = fixture(t);
  const before = f.room.read();
  assert.equal(f.send(0, { type: 'lab:reset', runId: crypto.randomUUID() }).type, 'error');
  assert.deepEqual(f.room.read(), before);
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  f.rejoin();
  const lobby = f.room.read();
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'error');
  assert.deepEqual(f.room.read(), lobby);
});

test('초기화 저장이 실패하면 신원과 사진 예약을 함께 복구한다', t => {
  const f = fixture(t); f.photoStage();
  const reference = f.room.setReference(f.clients[0].token, referenceJpeg, '초기화 기준', f.room.read().lab.runId);
  f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  const before = f.room.read();
  const identities = f.sql.exec('SELECT id, token FROM identities ORDER BY id').toArray();
  const beforeJobs = jobs(f);
  const save = f.room.save;
  f.room.save = () => { throw new Error('저장 실패 시험'); };
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'error');
  f.room.save = save;
  assert.deepEqual(f.room.read(), before);
  assert.deepEqual(f.sql.exec('SELECT id, token FROM identities ORDER BY id').toArray(), identities);
  assert.deepEqual(jobs(f), beforeJobs);
  assert.deepEqual(f.room.reference(f.clients[1].token), reference);
  assert.ok(f.clients.every(client => client.ws.readyState === 1 && client.ws.attachment));
  assert.ok(f.clients.every(client => !client.ws.messages.some(message => message.type === 'room-reset')));
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  assert.deepEqual(jobs(f), []);
  assert.deepEqual(f.sql.exec('SELECT id FROM identities').toArray(), []);
  assert.deepEqual(f.sql.exec('SELECT id FROM photo_references').toArray(), []);
});

test('초기화 이후 이전 조회 세대와 세대 없는 입장 요청은 참가자를 복원하지 못한다', t => {
  const f = fixture(t);
  const before = f.room.read();
  const initialKey = crypto.randomUUID();
  assert.equal(f.room.join('추가', null, initialKey, crypto.randomUUID()).code, 'ROOM_RESET');
  assert.equal(f.room.join('추가', null, initialKey, before.lab.runId).status, 409);
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  const after = f.room.read();
  for (const expectedGeneration of [undefined, null, before.lab.runId, crypto.randomUUID()]) {
    const rejected = f.room.join('늦은 입장', null, crypto.randomUUID(), expectedGeneration);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.code, 'ROOM_RESET');
    assert.equal(rejected.generationId, after.lab.runId);
  }
  assert.deepEqual(f.room.read(), after);
  assert.deepEqual(f.sql.exec('SELECT id FROM identities').toArray(), []);
  const joinKey = crypto.randomUUID();
  const fresh = f.room.join('새 입장', null, joinKey, after.lab.runId);
  assert.equal(fresh.generationId, after.lab.runId);
  assert.deepEqual(f.room.join('중복 입장', null, joinKey, after.lab.runId), fresh);
  assert.equal(f.room.join('지난 조회', null, joinKey, before.lab.runId).code, 'ROOM_RESET');
  assert.deepEqual(f.room.join('', fresh.token, null), fresh);
  assert.equal(f.room.read().members.length, 1);
});

test('HTTP 입장은 조회한 세대를 전달하고 초기화 및 신원 만료 상태를 유지한다', async t => {
  const f = fixture(t, 1);
  const oldToken = f.clients[0].token;
  const oldRun = f.room.read().lab.runId;
  const env = { ROOMS: { getByName: () => f.room } };
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  const after = f.room.read();
  const beforeMembers = after.members;
  const base = { name: '새 팀장', joinKey: crypto.randomUUID() };
  for (const expectedGeneration of [null, 3, {}, [], '잘못된 세대', '']) {
    const response = await worker.fetch(joinRequest(f.roomId, { ...base, expectedGeneration }), env);
    assert.equal(response.status, 400);
  }
  for (const body of [base, { ...base, expectedGeneration: oldRun }]) {
    const response = await worker.fetch(joinRequest(f.roomId, body), env);
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.code, 'ROOM_RESET');
    assert.equal(result.generationId, after.lab.runId);
  }
  const expired = await worker.fetch(joinRequest(f.roomId, { token: oldToken }), env);
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).code, 'ROOM_IDENTITY_EXPIRED');
  assert.deepEqual(f.room.read().members, beforeMembers);
  assert.deepEqual(f.sql.exec('SELECT id FROM identities').toArray(), []);
  const joined = await worker.fetch(joinRequest(f.roomId, { ...base, expectedGeneration: after.lab.runId }), env);
  assert.equal(joined.status, 200);
  const fresh = await joined.json();
  assert.equal(fresh.generationId, after.lab.runId);
  assert.equal(f.room.read().leaderId, fresh.participantId);
  assert.equal(f.room.read().members.length, 1);
});

test('이전 연결의 요청과 초기화 이후 재접속한 이전 토큰은 typed 신원 만료 오류를 받는다', t => {
  const f = fixture(t);
  const old = f.clients[0];
  const oldAttachment = structuredClone(old.ws.attachment);
  const oldRun = f.room.read().lab.runId;
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  const after = f.room.read();
  const reconnect = f.connect(old);
  assert.deepEqual(reconnect.ws.messages.at(-1), {
    type: 'error', code: 'ROOM_IDENTITY_EXPIRED', message: '방이 초기화되었습니다. 닉네임을 입력해 다시 입장해 주세요.'
  });
  assert.equal(reconnect.ws.attachment, null);
  old.ws.attachment = oldAttachment;
  const requestId = crypto.randomUUID();
  f.room.webSocketMessage(old.ws, JSON.stringify({ type: 'lab:location', runId: oldRun, requestId, source: 'simulated', lat: 0, lon: 0, accuracy: 3, heading: null }));
  assert.equal(old.ws.messages.at(-1).code, 'ROOM_IDENTITY_EXPIRED');
  assert.deepEqual(f.room.read(), after);
  assert.deepEqual(jobs(f), []);
  assert.deepEqual(f.sql.exec('SELECT id FROM identities').toArray(), []);
});

test('반복 초기화는 새 참가자의 권한과 연속된 세대를 유지하고 대기 중 연결도 닫는다', t => {
  const f = fixture(t, 1);
  const firstRun = f.room.read().lab.runId;
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  f.rejoin(); f.start();
  const current = f.clients[0];
  assert.equal(f.room.read().leaderId, current.participantId);
  const waiting = f.connect({ token: crypto.randomUUID() });
  const before = f.room.read();
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  const after = f.room.read();
  assert.equal(after.lab.generation, 3);
  assert.equal(after.revision, before.revision + 1);
  assert.notEqual(after.lab.runId, before.lab.runId);
  assert.notEqual(after.lab.runId, firstRun);
  assert.deepEqual(after.members, []);
  assert.equal(waiting.ws.readyState, 3);
  assert.equal(waiting.ws.attachment, null);
  assert.equal(waiting.ws.messages.at(-1).generationId, after.lab.runId);
  assert.equal(f.room.join('', current.token, null).code, 'ROOM_IDENTITY_EXPIRED');
});

test('이전 실행의 늦은 판정과 작업 해제는 새 실행의 작업에 영향을 주지 않는다', t => {
  const f = fixture(t); f.photoStage();
  const oldRun = f.room.read().lab.runId;
  const old = f.room.photoContext(f.clients[0].token, oldRun);
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  f.rejoin(); f.start();
  f.photoStage();
  const runId = f.room.read().lab.runId;
  const current = f.room.photoContext(f.clients[0].token, runId);
  const before = f.room.read();
  assert.throws(() => f.room.recordPhoto(old.actorId, oldRun, old.jobId, { method: 'ai', verdict: true }), /갱신/);
  assert.throws(() => f.room.recordPhoto(current.actorId, oldRun, current.jobId, { method: 'ai', verdict: true }), /실행/);
  f.room.finishPhoto(old.actorId, old.jobId);
  assert.deepEqual(f.room.read(), before);
  assert.deepEqual(jobs(f), [{ actor_id: current.actorId, job_id: current.jobId }]);
});

test('만료한 예약을 교체한 뒤 이전 결과는 새 사진 결과를 덮어쓰지 못한다', t => {
  const f = fixture(t); f.photoStage();
  const runId = f.room.read().lab.runId;
  const old = f.room.photoContext(f.clients[0].token, runId);
  f.sql.exec('UPDATE photo_jobs SET started_at = ? WHERE actor_id = ?', Date.now() - 60_001, old.actorId);
  const current = f.room.photoContext(f.clients[0].token, runId);
  assert.notEqual(current.jobId, old.jobId);
  assert.throws(() => f.room.recordPhoto(old.actorId, runId, old.jobId, { method: 'ai', verdict: false }), /갱신/);
  f.room.finishPhoto(old.actorId, old.jobId);
  assert.equal(jobs(f)[0].job_id, current.jobId);
  f.room.recordPhoto(current.actorId, runId, current.jobId, { method: 'ai', verdict: true });
  assert.equal(f.room.read().lab.evidence[current.actorId].verdict, true);
});

test('GPS 모드에서 소켓의 임의 성공 판정과 직접 완료로 사진 인증을 우회하지 못한다', t => {
  const f = fixture(t, 2, { mode: 'gps' }); f.photoStage();
  const before = f.room.read();
  for (const action of [
    { type: 'lab:photo-simulate', verdict: true },
    { type: 'lab:photo-complete', method: 'ai', verdict: true },
    { type: 'lab:complete', verdict: true, actorId: f.clients[1].participantId },
  ]) assert.equal(f.send(0, action).type, 'error');
  assert.deepEqual(f.room.read(), before);
  assert.equal(jobs(f).length, 0);
});

test('서버의 사진 판정은 SQL에 저장되고 전원의 소켓 화면을 함께 전환한다', t => {
  const f = fixture(t); f.photoStage();
  const runId = f.room.read().lab.runId;
  const first = f.room.photoContext(f.clients[0].token, runId);
  const second = f.room.photoContext(f.clients[1].token, runId);
  const revision = f.room.read().revision;
  f.room.recordPhoto(first.actorId, runId, first.jobId, { method: 'ai', verdict: true, reason: '컵 확인' });
  f.room.finishPhoto(first.actorId, first.jobId);
  assert.equal(f.room.read().revision, revision + 1);
  assert.equal(f.room.read().lab.stage, 'photo');
  assert.equal(f.room.read().lab.completed[first.actorId], true);
  assert.throws(() => f.room.photoContext(f.clients[0].token, runId), /완료/);
  f.room.recordPhoto(second.actorId, runId, second.jobId, { method: 'ai', verdict: true });
  f.room.finishPhoto(second.actorId, second.jobId);
  assert.equal(f.room.read().lab.stage, 'silence');
  assert.equal(f.room.read().screen, 'silence');
  assert.equal(jobs(f).length, 0);
  for (const client of f.clients) {
    const message = client.ws.messages.findLast(item => item.type === 'state');
    assert.equal(message.selfId, client.participantId);
    assert.equal(message.state.lab.stage, 'silence');
    assert.equal(message.state.lab.evidence[first.actorId].reason, '컵 확인');
    assert.equal(JSON.stringify(message).includes(client.token), false);
  }
  assert.equal(new GameRoom(f.ctx, {}).read().lab.stage, 'silence');
});

test('잘못된 인증 정보와 사진 입력은 AI 호출과 작업 예약보다 먼저 거절한다', async t => {
  const f = fixture(t); f.photoStage();
  const before = f.room.read(); let calls = 0;
  const env = { ...referenceEnv(f), AI: { run: async () => { calls++; return { choices: [{ message: { content: 'YES' } }] }; } } };
  const runId = before.lab.runId;
  for (const request of [
    photoRequest(f.roomId, crypto.randomUUID(), runId),
    photoRequest(f.roomId, 'not-a-token', runId),
    photoRequest(f.roomId, f.clients[0].token, runId, 'invalid-image'),
    photoRequest(f.roomId, f.clients[0].token, crypto.randomUUID()),
  ]) {
    const response = await worker.fetch(request, env);
    assert.ok(response.status >= 400 && response.status < 500);
  }
  assert.equal(calls, 0);
  assert.equal(jobs(f).length, 0);
  assert.deepEqual(f.room.read(), before);
});

test('사진 HTTP 처리의 finally는 AI 오류 뒤에도 예약을 해제한다', async t => {
  const f = fixture(t); f.photoStage();
  const runId = f.room.read().lab.runId;
  const env = { ...referenceEnv(f), AI: { run: async () => { throw new Error('provider unavailable'); } } };
  const failed = await worker.fetch(photoRequest(f.roomId, f.clients[0].token, runId), env);
  assert.equal(failed.status, 400);
  assert.equal(jobs(f).length, 0);
  assert.deepEqual(f.room.read().lab.evidence, {});
  env.AI.run = async () => ({ choices: [{ message: { content: 'NO' } }] });
  const retry = await worker.fetch(photoRequest(f.roomId, f.clients[0].token, runId), env);
  assert.equal(retry.status, 200);
  assert.equal(jobs(f).length, 0);
  assert.equal(f.room.read().lab.evidence[f.clients[0].participantId].verdict, false);
});

test('정상 사진 HTTP 판정은 공유 진행과 저장을 완료한 뒤 작업을 해제한다', async t => {
  const f = fixture(t, 1); f.photoStage();
  const runId = f.room.read().lab.runId; let calls = 0;
  const env = { ...referenceEnv(f), AI: { run: async () => { calls++; return { choices: [{ message: { content: 'YES' } }] }; } } };
  const response = await worker.fetch(photoRequest(f.roomId, f.clients[0].token, runId), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verdict, true);
  assert.equal(calls, 1);
  assert.equal(jobs(f).length, 0);
  assert.equal(f.room.read().lab.stage, 'silence');
  const last = f.clients[0].ws.messages.findLast(message => message.type === 'state');
  assert.equal(last.state.lab.stage, 'silence');
  const duplicate = await worker.fetch(photoRequest(f.roomId, f.clients[0].token, runId), env);
  assert.equal(duplicate.status, 400);
  assert.equal(calls, 1);
});

test('AI 응답을 기다리는 실제 HTTP 요청이 있으면 중복 요청은 추가 AI 호출을 만들지 않는다', { timeout: 2000 }, async t => {
  const f = fixture(t); f.photoStage();
  const runId = f.room.read().lab.runId;
  let calls = 0; let answer; let started;
  const aiStarted = new Promise(resolve => { started = resolve; });
  const pendingAnswer = new Promise(resolve => { answer = resolve; });
  const env = { ...referenceEnv(f), AI: { run: async () => { calls++; started(); return pendingAnswer; } } };
  const first = worker.fetch(photoRequest(f.roomId, f.clients[0].token, runId), env);
  await aiStarted;
  const duplicate = await worker.fetch(photoRequest(f.roomId, f.clients[0].token, runId), env);
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error, /판정/);
  assert.equal(calls, 1);
  assert.equal(jobs(f).length, 1);
  answer({ choices: [{ message: { content: 'NO' } }] });
  assert.equal((await first).status, 200);
  assert.equal(jobs(f).length, 0);
});

test('초기화 이전의 HTTP 사진 결과와 finally 처리는 새 참가자의 판정 작업을 변경하지 않는다', { timeout: 2000 }, async t => {
  const f = fixture(t, 1); f.photoStage();
  const oldRun = f.room.read().lab.runId;
  const oldToken = f.clients[0].token;
  let answer; let started;
  const aiStarted = new Promise(resolve => { started = resolve; });
  const pendingAnswer = new Promise(resolve => { answer = resolve; });
  const env = { ...referenceEnv(f), AI: { run: async () => { started(); return pendingAnswer; } } };
  const pending = worker.fetch(photoRequest(f.roomId, oldToken, oldRun), env);
  await aiStarted;
  assert.equal(jobs(f).length, 1);
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  assert.deepEqual(jobs(f), []);
  const oldRequest = await worker.fetch(photoRequest(f.roomId, oldToken, oldRun), env);
  assert.equal(oldRequest.status, 400);
  assert.deepEqual(jobs(f), []);
  f.rejoin(); f.start(); f.photoStage();
  const current = f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  const before = f.room.read();
  answer({ choices: [{ message: { content: 'YES' } }] });
  const response = await pending;
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /갱신/);
  assert.deepEqual(f.room.read(), before);
  assert.deepEqual(jobs(f), [{ actor_id: current.actorId, job_id: current.jobId }]);
  assert.deepEqual(f.room.read().lab.evidence, {});
  assert.equal(f.room.read().members.length, 1);
});

test('참조 사진 카탈로그는 관리자 등록만 허용하고 저장 원본을 공개하지 않는다', async t => {
  const f = fixture(t);
  const catalog = fixture(t, 0, {}, { startImmediately: false });
  const env = { ...referenceEnv(f, catalog.room), ROOM_ADMIN_KEY: 'test-reference-admin' };
  const id = track.photoRules[track.defaults.photoTarget].referenceId;
  const body = { image: referenceJpeg, label: '기본 생수병' };
  assert.equal((await worker.fetch(catalogRequest(id, 'wrong-admin', body), env)).status, 401);
  assert.equal(catalog.room.getReference(id), null);
  const noKey = await worker.fetch(catalogRequest(id, 'test-reference-admin', body), { ...env, ROOM_ADMIN_KEY: undefined });
  assert.equal(noKey.status, 503);
  for (const invalid of [{ ...body, image: 'invalid-image' }, { ...body, label: '가'.repeat(81) }]) {
    assert.equal((await worker.fetch(catalogRequest(id, env.ROOM_ADMIN_KEY, invalid), env)).status, 400);
    assert.equal(catalog.room.getReference(id), null);
  }
  const created = await worker.fetch(catalogRequest(id, env.ROOM_ADMIN_KEY, body), env);
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.reference.id, id);
  assert.equal(result.reference.label, body.label);
  assert.equal(typeof result.reference.updatedAt, 'number');
  assert.equal(result.reference.image, undefined);
  assert.equal(JSON.stringify(result).includes(referenceJpeg), false);
  const stored = catalog.room.getReference(id);
  assert.equal(stored.image, referenceJpeg);
  assert.equal(stored.label, body.label);
  assert.deepEqual(new GameRoom(catalog.ctx, {}).getReference(id), stored);
  for (const token of [env.ROOM_ADMIN_KEY, f.clients[0].token]) {
    const response = await worker.fetch(catalogRequest(id, token, undefined, 'GET'), env);
    assert.ok(response.status >= 400);
    assert.equal((await response.text()).includes(referenceJpeg), false);
  }
});

test('기본 카탈로그 재등록은 같은 원본과 이름의 시각을 유지하고 변경은 새 ID로 등록한다', async t => {
  const f = fixture(t);
  const catalog = fixture(t, 0, {}, { startImmediately: false });
  const env = { ...referenceEnv(f, catalog.room), ROOM_ADMIN_KEY: 'test-reference-admin' };
  const id = track.photoRules[track.defaults.photoTarget].referenceId;
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const body = { image: referenceJpeg, label: '  기본 생수병  ' };
  const created = await worker.fetch(catalogRequest(id, env.ROOM_ADMIN_KEY, body), env);
  assert.equal(created.status, 201);
  const metadata = await created.json();
  const original = catalog.room.getReference(id);
  assert.equal(original.label, '기본 생수병');
  assert.equal(original.updatedAt, 1000);
  now = 2000;
  const retry = await worker.fetch(catalogRequest(id, env.ROOM_ADMIN_KEY, { ...body, label: original.label }), env);
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), metadata);
  assert.deepEqual(catalog.room.getReference(id), original);
  for (const replacement of [{ ...body, image: fakeJpeg }, { ...body, label: '다른 생수병' }]) {
    const rejected = await worker.fetch(catalogRequest(id, env.ROOM_ADMIN_KEY, replacement), env);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.text()).includes(referenceJpeg), false);
    assert.deepEqual(catalog.room.getReference(id), original);
  }
  const nextId = `${id}-next`;
  const next = await worker.fetch(catalogRequest(nextId, env.ROOM_ADMIN_KEY, { image: fakeJpeg, label: '새 기준' }), env);
  assert.equal(next.status, 201);
  assert.equal((await next.json()).reference.id, nextId);
  assert.deepEqual(catalog.room.getReference(nextId), { id: nextId, label: '새 기준', image: fakeJpeg, updatedAt: 2000 });
  assert.deepEqual(catalog.room.getReference(id), original);
});

test('입장한 참가자는 기본 기준 사진을 읽고 방의 기준 사진을 우선 사용한다', async t => {
  const f = fixture(t);
  const catalog = fixture(t, 0, {}, { startImmediately: false });
  const id = track.photoRules[track.defaults.photoTarget].referenceId;
  catalog.room.putReference(id, referenceJpeg, '기본 생수병');
  const env = referenceEnv(f, catalog.room);
  assert.equal(f.room.reference(f.clients[0].token), null);
  assert.equal(f.room.referenceContext(f.clients[0].token).referenceId, id);
  const initial = await worker.fetch(referenceRequest(f.roomId, f.clients[1].token, undefined, { method: 'GET' }), env);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual((await initial.json()).reference, catalog.room.getReference(id));
  f.photoStage();
  const custom = f.room.setReference(f.clients[0].token, fakeJpeg, '팀 기준 사진', f.room.read().lab.runId);
  const current = await worker.fetch(referenceRequest(f.roomId, f.clients[1].token, undefined, { method: 'GET' }), env);
  assert.equal(current.status, 200);
  assert.deepEqual((await current.json()).reference, custom);
  assert.equal(f.room.referenceContext(f.clients[1].token).customReference, true);
  assert.equal(f.room.referenceContext(f.clients[1].token).referenceId, custom.id);
  for (const token of ['bad-token', crypto.randomUUID()]) {
    const response = await worker.fetch(referenceRequest(f.roomId, token, undefined, { method: 'GET' }), env);
    assert.ok(response.status >= 400);
    const body = await response.text();
    assert.equal(body.includes(fakeJpeg), false);
    assert.equal(body.includes(referenceJpeg), false);
  }
  assert.equal(JSON.stringify(f.room.summary()).includes(fakeJpeg), false);
  assert.equal(JSON.stringify(f.room.snapshot()).includes(fakeJpeg), false);
});

test('기본 기준 사진이 없으면 비교 판정을 보류하고 예약을 해제한다', async t => {
  const f = fixture(t); f.photoStage();
  let calls = 0;
  const env = { ...referenceEnv(f, { getReference: () => null }), AI: { run: async () => {
    calls++;
    return { choices: [{ message: { content: 'YES' } }] };
  } } };
  const before = f.room.read();
  const missing = await worker.fetch(referenceRequest(f.roomId, f.clients[0].token, undefined, { method: 'GET' }), env);
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /기준 사진.*등록/);
  const response = await worker.fetch(photoRequest(f.roomId, f.clients[0].token, before.lab.runId), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /기준 사진.*등록/);
  assert.equal(calls, 0);
  assert.deepEqual(jobs(f), []);
  assert.deepEqual(f.room.read(), before);
});

test('팀장은 사진 모듈에서 기준 사진을 바꾸며 일부 인증이 있어도 모두 새로 시험한다', t => {
  const f = fixture(t, 2, {}, { startImmediately: false });
  assert.throws(() => f.room.setReference(f.clients[0].token, referenceJpeg, '대기실 기준', f.room.read().lab.runId), /사진 모듈/);
  f.start();
  assert.throws(() => f.room.setReference(f.clients[0].token, referenceJpeg, '지도 기준', f.room.read().lab.runId), /사진 모듈/);
  f.photoStage();
  const originalRun = f.room.read().lab.runId;
  const first = f.room.setReference(f.clients[0].token, referenceJpeg, '  첫 기준  ', originalRun);
  assert.equal(first.label, '첫 기준');
  const state = f.room.read();
  assert.notEqual(state.lab.runId, originalRun);
  assert.equal(state.lab.moduleConfigs.photo.photoTarget, first.label);
  assert.deepEqual(new GameRoom(f.ctx, {}).reference(f.clients[1].token), first);
  assert.throws(() => f.room.setReference(f.clients[1].token, fakeJpeg, '팀원 기준', state.lab.runId), /팀장/);
  assert.throws(() => f.room.setReference(crypto.randomUUID(), fakeJpeg, '외부 기준', state.lab.runId), /입장/);
  assert.throws(() => f.room.setReference(f.clients[0].token, fakeJpeg, '이전 실행 기준', originalRun), /진행이 변경/);
  assert.throws(() => f.room.setReference(f.clients[0].token, fakeJpeg, '실행 누락'), /진행이 변경/);
  const job = f.room.photoContext(f.clients[0].token, state.lab.runId);
  f.room.recordPhoto(job.actorId, state.lab.runId, job.jobId, { method: 'ai', verdict: true, referenceId: first.id });
  const second = f.room.setReference(f.clients[0].token, fakeJpeg, '새 기준', state.lab.runId);
  const after = f.room.read();
  assert.notEqual(second.id, first.id);
  assert.notEqual(after.lab.runId, state.lab.runId);
  assert.deepEqual(after.lab.completed, {});
  assert.deepEqual(after.lab.evidence, {});
  assert.deepEqual(jobs(f), []);
  for (const client of f.clients) {
    assert.equal(client.ws.attachment.generationId, after.lab.runId);
    assert.equal(JSON.stringify(client.ws.messages).includes(referenceJpeg), false);
    assert.equal(JSON.stringify(client.ws.messages).includes(fakeJpeg), false);
    assert.equal(JSON.stringify(client.ws.messages).includes(client.token), false);
  }
});

test('묵언 이후 단계와 운영 트랙에서는 기준 사진을 변경하지 못한다', t => {
  const f = fixture(t, 1); f.photoStage();
  const original = f.room.setReference(f.clients[0].token, referenceJpeg, '촬영 기준', f.room.read().lab.runId);
  const runId = f.room.read().lab.runId;
  const job = f.room.photoContext(f.clients[0].token, runId);
  f.room.recordPhoto(job.actorId, runId, job.jobId, { method: 'ai', verdict: true, referenceId: original.id });
  f.room.finishPhoto(job.actorId, job.jobId);
  assert.equal(f.room.read().lab.stage, 'silence');
  const before = f.room.read();
  assert.throws(() => f.room.setReference(f.clients[0].token, fakeJpeg, '묵언 기준', f.room.read().lab.runId), /변경|사진/);
  assert.deepEqual(f.room.read(), before);
  const standard = fixture(t, 1, {}, { startImmediately: false });
  const state = standard.room.read();
  delete state.track;
  delete state.lab;
  standard.room.save(state);
  assert.throws(() => standard.room.setReference(standard.clients[0].token, fakeJpeg, '운영 기준'), /테스트/);
  assert.deepEqual(standard.room.read(), state);
});

test('기준 사진 HTTP 등록은 팀장과 동일 출처를 확인하고 원본은 별도 SQL에 저장한다', async t => {
  const f = fixture(t); f.photoStage();
  const env = referenceEnv(f);
  const body = { image: referenceJpeg, label: '팀 기준', runId: f.room.read().lab.runId };
  const before = f.room.read();
  for (const [token, options] of [
    [f.clients[1].token, {}],
    [crypto.randomUUID(), {}],
    [f.clients[0].token, { origin: 'https://elsewhere.test' }],
  ]) {
    const response = await worker.fetch(referenceRequest(f.roomId, token, body, options), env);
    assert.ok(response.status >= 400);
    assert.deepEqual(f.room.read(), before);
  }
  for (const invalid of [{ ...body, image: 'invalid' }, { ...body, label: '가'.repeat(81) }]) {
    assert.equal((await worker.fetch(referenceRequest(f.roomId, f.clients[0].token, invalid), env)).status, 400);
    assert.deepEqual(f.room.read(), before);
  }
  const response = await worker.fetch(referenceRequest(f.roomId, f.clients[0].token, body), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.reference.image, referenceJpeg);
  assert.equal(result.reference.label, body.label);
  const storedState = f.sql.exec('SELECT state FROM room WHERE id = 1').toArray()[0].state;
  assert.equal(storedState.includes(referenceJpeg), false);
  for (const client of f.clients) {
    const state = client.ws.messages.findLast(message => message.type === 'state').state;
    assert.equal(state.lab.reference.id, result.reference.id);
    assert.equal(JSON.stringify(state).includes(referenceJpeg), false);
  }
});

test('기준 사진 교체는 진행 중 판정을 취소하고 늦은 응답과 해제를 새 작업에서 분리한다', { timeout: 2000 }, async t => {
  const f = fixture(t); f.photoStage();
  const original = f.room.setReference(f.clients[0].token, referenceJpeg, '첫 기준', f.room.read().lab.runId);
  const runId = f.room.read().lab.runId;
  let resolveAnswer; let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const answer = new Promise(resolve => { resolveAnswer = resolve; });
  const env = { ...referenceEnv(f), AI: { run: async (model, payload) => {
    assert.deepEqual(payload.messages[1].content.filter(item => item.type === 'image_url').map(item => item.image_url.url), [referenceJpeg, fakeJpeg]);
    resolveStarted();
    return answer;
  } } };
  const pending = worker.fetch(photoRequest(f.roomId, f.clients[0].token, runId), env);
  await started;
  assert.equal(jobs(f).length, 1);
  const replacement = f.room.setReference(f.clients[0].token, fakeJpeg, '새 기준', f.room.read().lab.runId);
  assert.notEqual(replacement.id, original.id);
  assert.deepEqual(jobs(f), []);
  const current = f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  const before = f.room.read();
  resolveAnswer({ choices: [{ message: { content: 'YES' } }] });
  const response = await pending;
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /갱신|기준/);
  assert.deepEqual(f.room.read(), before);
  assert.deepEqual(jobs(f), [{ actor_id: current.actorId, job_id: current.jobId }]);
  assert.deepEqual(f.room.read().lab.evidence, {});
});

test('기준 사진 교체 저장 실패는 원본과 메타데이터 및 판정 예약을 함께 복구한다', t => {
  const f = fixture(t); f.photoStage();
  const original = f.room.setReference(f.clients[0].token, referenceJpeg, '첫 기준', f.room.read().lab.runId);
  f.room.photoContext(f.clients[0].token, f.room.read().lab.runId);
  const before = f.room.read();
  const beforeJobs = jobs(f);
  const beforeMessages = f.clients.map(client => client.ws.messages.length);
  const save = f.room.save;
  f.room.save = () => { throw new Error('기준 저장 실패 시험'); };
  assert.throws(() => f.room.setReference(f.clients[0].token, fakeJpeg, '새 기준', f.room.read().lab.runId), /저장 실패/);
  f.room.save = save;
  assert.deepEqual(f.room.read(), before);
  assert.deepEqual(f.room.reference(f.clients[1].token), original);
  assert.deepEqual(jobs(f), beforeJobs);
  assert.deepEqual(f.clients.map(client => client.ws.messages.length), beforeMessages);
});

test('방 초기화는 방의 기준 원본을 지우고 기본 카탈로그 사진으로 복귀한다', async t => {
  const f = fixture(t); f.photoStage();
  const catalog = fixture(t, 0, {}, { startImmediately: false });
  const id = track.photoRules[track.defaults.photoTarget].referenceId;
  catalog.room.putReference(id, fakeJpeg, '기본 기준');
  f.room.setReference(f.clients[0].token, referenceJpeg, '방 기준', f.room.read().lab.runId);
  const oldToken = f.clients[0].token;
  const oldRun = f.room.read().lab.runId;
  const job = f.room.photoContext(oldToken, oldRun);
  const env = referenceEnv(f, catalog.room);
  assert.equal(f.send(0, { type: 'lab:reset' }).type, 'ack');
  assert.deepEqual(jobs(f), []);
  assert.throws(() => f.room.reference(oldToken), /입장/);
  assert.throws(() => f.room.recordPhoto(job.actorId, oldRun, job.jobId, { method: 'ai', verdict: true }), /갱신/);
  f.rejoin();
  assert.equal(f.room.reference(f.clients[0].token), null);
  assert.equal(f.room.read().lab.reference?.custom, undefined);
  const restored = new GameRoom(f.ctx, {});
  assert.equal(restored.reference(f.clients[0].token), null);
  const response = await worker.fetch(referenceRequest(f.roomId, f.clients[0].token, undefined, { method: 'GET' }), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).reference, catalog.room.getReference(id));
  assert.equal(catalog.room.getReference(id).image, fakeJpeg);
});
