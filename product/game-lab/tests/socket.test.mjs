import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const base = process.env.ROOM_BASE_URL || 'http://localhost:8791';
const vars = process.env.ROOM_ADMIN_KEY ? '' : await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const key = process.env.ROOM_ADMIN_KEY || vars.match(/^ROOM_ADMIN_KEY=(.+)$/m)?.[1];

async function api(path, body, admin = false) {
  if (path.endsWith('/join') && body?.name && !body.token && !body.joinKey) body = { ...body, joinKey: crypto.randomUUID() };
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: base, 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${key}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}

async function makeRoom(t) {
  const response = await api('/api/rooms', { title: '통신 검증', track: 'standard' }, true);
  assert.equal(response.status, 201);
  const id = response.body.roomId;
  t.after(async () => { const deleted = await fetch(`${base}/api/rooms/${id}`, { method: 'DELETE', headers: { Origin: base, Authorization: `Bearer ${key}` } }); assert.equal(deleted.status, 200); });
  return id;
}

async function connect(roomId, token, t) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/rooms/${roomId}/socket`, { headers: { Origin: base } });
  const client = { ws, messages: [], state: null, selfId: null };
  ws.on('message', raw => {
    if (raw.toString() === 'pong') return;
    const message = JSON.parse(raw.toString());
    client.messages.push(message);
    if (message.type === 'state') { client.state = message.state; client.selfId = message.selfId; }
  });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  client.send = async action => {
    const requestId = crypto.randomUUID();
    ws.send(JSON.stringify({ ...action, requestId }));
    return until(() => client.messages.find(m => m.requestId === requestId && (m.type === 'ack' || m.type === 'error')));
  };
  if (token) {
    ws.send(JSON.stringify({ type: 'hello', token }));
    await until(() => client.state);
  }
  return client;
}

async function until(check) {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('상태 동기화 대기 시간 초과');
}

test('7인 입장, 양도, 동시 시작, 재접속을 실제 WebSocket으로 검증한다', async t => {
  const roomId = await makeRoom(t);
  const credentials = await Promise.all(Array.from({ length: 7 }, (_, index) => api(`/api/rooms/${roomId}/join`, { name: `참가자${index + 1}` })));
  for (const credential of credentials) assert.equal(credential.status, 200);
  const clients = await Promise.all(credentials.map(credential => connect(roomId, credential.body.token, t)));
  await until(() => clients.every(client => client.state.members.length === 7));
  const leader = clients.find(client => client.selfId === client.state.leaderId);
  const target = clients.find(client => client !== leader);
  assert.equal((await target.send({ type: 'start' })).type, 'error');
  assert.equal((await target.send({ type: 'transfer', targetId: leader.selfId })).type, 'error');
  const ready = await Promise.all(clients.map(client => client.send({ type: 'ready', ready: true })));
  assert.ok(ready.every(result => result.type === 'ack'));
  await until(() => clients.every(client => client.state.members.every(member => member.ready)));
  assert.equal((await leader.send({ type: 'transfer', targetId: target.selfId })).type, 'ack');
  await until(() => clients.every(client => client.state.leaderId === target.selfId));
  for (const client of clients) {
    assert.equal(client.state.members.find(member => member.id === leader.selfId).ready, false);
    assert.equal(client.state.members.find(member => member.id === target.selfId).ready, true);
  }
  assert.equal((await target.send({ type: 'start' })).type, 'error');
  assert.equal((await leader.send({ type: 'ready', ready: true })).type, 'ack');
  await until(() => clients.every(client => client.state.members.every(member => member.ready)));
  const beforeRevision = target.state.revision;
  const starts = await Promise.all([target.send({ type: 'start' }), target.send({ type: 'start' })]);
  assert.ok(starts.every(result => result.type === 'ack'));
  await until(() => clients.every(client => client.state.phase === 'started'));
  for (const client of clients) {
    assert.equal(client.state.screen, 'track-start');
    assert.equal(client.state.revision, beforeRevision + 1);
    assert.equal(JSON.stringify(client.state).includes('token'), false);
  }
  const targetIndex = clients.indexOf(target);
  const resume = await api(`/api/rooms/${roomId}/join`, { token: credentials[targetIndex].body.token });
  assert.equal(resume.body.participantId, target.selfId);
  target.ws.close();
  const reconnected = await connect(roomId, resume.body.token, t);
  assert.equal(reconnected.state.members.length, 7);
  assert.equal(reconnected.state.phase, 'started');
  assert.equal(reconnected.state.leaderId, target.selfId);
});

test('1인도 준비 후 시작하고 중복 탭은 참가자로 추가되지 않는다', async t => {
  const roomId = await makeRoom(t);
  const join = await api(`/api/rooms/${roomId}/join`, { name: '혼자' });
  const first = await connect(roomId, join.body.token, t);
  const second = await connect(roomId, join.body.token, t);
  assert.equal(second.state.members.length, 1);
  await first.send({ type: 'ready', ready: true });
  await until(() => second.state.members[0].ready);
  await second.send({ type: 'start' });
  await until(() => first.state.phase === 'started');
});

test('방 생성과 참가자 복구 권한을 확인한다', async t => {
  assert.equal((await api('/api/rooms', { title: '권한 없음' })).status, 401);
  const roomId = await makeRoom(t);
  assert.equal((await api(`/api/rooms/${roomId}/join`, { token: crypto.randomUUID() })).status, 401);
  assert.equal((await api(`/api/rooms/${crypto.randomUUID()}`)).status, 404);
});

test('입장 응답 유실 후 같은 입장 키로 재시도해도 한 명만 등록된다', async t => {
  const roomId = await makeRoom(t);
  const payload = { name: '재시도', joinKey: crypto.randomUUID() };
  const first = await api(`/api/rooms/${roomId}/join`, payload);
  const second = await api(`/api/rooms/${roomId}/join`, payload);
  assert.deepEqual(second.body, first.body);
  const client = await connect(roomId, second.body.token, t);
  assert.equal(client.state.members.length, 1);
  assert.equal(client.state.leaderId, second.body.participantId);
});

test('다른 출처와 인증 전 동작 및 잘못된 소켓 토큰을 차단한다', async t => {
  const roomId = await makeRoom(t);
  const join = await api(`/api/rooms/${roomId}/join`, { name: '인증된 참가자' });
  for (const path of ['join', 'socket']) {
    const response = await fetch(`${base}/api/rooms/${roomId}/${path}`, {
      method: path === 'join' ? 'POST' : 'GET',
      headers: { Origin: 'https://another-origin.invalid', 'Content-Type': 'application/json' },
      ...(path === 'join' ? { body: JSON.stringify({ name: '외부 요청', joinKey: crypto.randomUUID() }) } : {})
    });
    assert.equal(response.status, 403);
  }
  const authorized = await connect(roomId, join.body.token, t);
  const stranger = await connect(roomId, null, t);
  assert.equal((await stranger.send({ type: 'ready', ready: true, actorId: authorized.selfId })).type, 'error');
  assert.equal((await stranger.send({ type: 'hello', token: crypto.randomUUID() })).type, 'error');
  assert.equal((await authorized.send({ type: 'ready', ready: true })).type, 'ack');
  assert.equal(authorized.state.members.length, 1);
  assert.equal(stranger.messages.some(message => message.type === 'state'), false);
});
