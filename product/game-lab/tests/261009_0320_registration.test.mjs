import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

async function moduleUrl(filename, imports = {}) {
  let source = await readFile(new URL(`../src/${filename}`, import.meta.url), 'utf8');
  source = source.replace("import { DurableObject } from 'cloudflare:workers';", 'const DurableObject = class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } };');
  for (const [relative, target] of Object.entries(imports)) source = source.replaceAll(`'${relative}'`, JSON.stringify(target));
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const directoryUrl = await moduleUrl('261009_0159_lab-directory.js');
const roomUrl = await moduleUrl('game-room.js', Object.fromEntries([
  ...['room-state.js', 'lab-state.js', 'photo-verification.js', '261009_0536_track-config.js'].map(file => [`./${file}`, new URL(`../src/${file}`, import.meta.url).href]),
  ['../public/test-track.json', new URL('../public/test-track.json', import.meta.url).href]
]));
const workerUrl = await moduleUrl('worker.js', {
  './game-room.js': roomUrl, './261009_0159_lab-directory.js': directoryUrl,
  './photo-verification.js': new URL('../src/photo-verification.js', import.meta.url).href
});
const { LabDirectory } = await import(directoryUrl);
const { GameRoom } = await import(roomUrl);
const { default: worker } = await import(workerUrl);
globalThis.WebSocketRequestResponsePair = class {};

function storage(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const sql = { exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const sockets = [];
  return { sql, sockets, storage: { sql, transactionSync(callback) {
    db.exec('BEGIN'); try { const value = callback(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } }, setWebSocketAutoResponse() {}, getWebSockets: () => sockets };
}
function fixture(t) {
  const store = new LabDirectory(storage(t), { NONOL_BASIC_KEY: 'registration-login-test' }), rooms = new Map();
  const env = { ROOM_ADMIN_KEY: 'registration-api-test', NONOL_BASIC_KEY: 'registration-login-test', LAB_DIRECTORY: { getByName: () => store },
    ROOMS: { getByName(id) { if (!rooms.has(id)) rooms.set(id, new GameRoom(storage(t), {})); return rooms.get(id); } } };
  const auth = { Authorization: `Bearer ${env.ROOM_ADMIN_KEY}` };
  async function request(path, method = 'GET', body, headers = {}) {
    return worker.fetch(new Request(`https://lab.test${path}`, { method, headers: { Origin: 'https://lab.test', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  }
  async function group(names = ['신청자 하나', '신청자 둘']) {
    const response = await request('/api/groups', 'POST', { title: '신청 그룹 시험', date: '2026-10-09', time: '19:30', names }, auth);
    assert.equal(response.status, 201);
    const result = await response.json(), room = env.ROOMS.getByName(result.roomId);
    return { ...result, room, people: result.participants.map(person => ({ ...person, invite: new URLSearchParams(new URL(person.inviteUrl).hash.slice(1)).get('invite') })) };
  }
  async function join(g, index) {
    const response = await request(`/api/rooms/${g.roomId}/join`, 'POST', { invite: g.people[index].invite, expectedGeneration: g.room.read().lab.runId });
    assert.equal(response.status, 200); return response.json();
  }
  async function tag(g, member, extra = {}, headers = {}) {
    return request(`/api/rooms/${g.roomId}/board`, 'POST', { boardId: 'icheungjip-lab', generationId: g.room.read().lab.runId, ...extra }, { Authorization: `Bearer ${member.token}`, ...headers });
  }
  return { env, store, rooms, auth, request, group, join, tag };
}
function socket(room, member) {
  const ws = { readyState: 1, messages: [], attachment: null,
    send(message) { this.messages.push(JSON.parse(message)); }, serializeAttachment(value) { this.attachment = value; }, deserializeAttachment() { return this.attachment; },
    close(code) { this.readyState = 3; this.code = code; } };
  room.ctx.sockets.push(ws); room.webSocketMessage(ws, JSON.stringify({ type: 'hello', token: member.token }));
  assert.equal(ws.attachment?.participantId, member.participantId); return ws;
}
function send(room, ws, action) {
  const requestId = crypto.randomUUID(); room.webSocketMessage(ws, JSON.stringify({ ...action, requestId }));
  const reply = ws.messages.findLast(message => message.requestId === requestId); assert.ok(reply); return reply;
}

test('신청 그룹 생성은 관리자 인증과 유효 신청 정보를 요구하고 4명 상한을 두지 않는다', async t => {
  const f = fixture(t), body = { title: '그룹', date: '2026-10-09', time: '19:30', names: ['하나', '둘'] };
  assert.equal((await f.request('/api/groups', 'POST', body)).status, 401);
  assert.equal((await f.request('/api/groups', 'POST', body, { ...f.auth, Origin: 'https://other.test' })).status, 403);
  for (const change of [{ names: ['하나'] }, { names: ['하나', ''] }, { date: '2026-02-30' }, { time: '24:00' }, { title: '' }]) {
    assert.equal((await f.request('/api/groups', 'POST', { ...body, ...change }, f.auth)).status, 400);
  }
  const login = await f.request('/api/admin/session', 'POST', { password: f.env.NONOL_BASIC_KEY });
  const response = await f.request('/api/groups', 'POST', { ...body, names: ['1', '2', '3', '4', '5', '6'] }, { Cookie: login.headers.get('Set-Cookie') });
  assert.equal(response.status, 201); assert.equal((await response.json()).participants.length, 6);
});

test('개인 링크는 서로 다른 해시로 저장되고 공개 응답에서 신청자와 자격을 제외한다', async t => {
  const f = fixture(t), g = await f.group(), rows = g.room.sql.exec('SELECT id,name,invite_hash FROM registrations').toArray();
  assert.equal(new Set(g.people.map(person => person.invite)).size, 2);
  for (const person of g.people) {
    assert.match(person.invite, /^[0-9a-f]{64}$/);
    assert.equal(rows.find(row => row.id === person.id).invite_hash, await g.room.inviteHash(person.invite));
    assert.equal(JSON.stringify(rows).includes(person.invite), false);
  }
  assert.equal(JSON.stringify(g.room.read()).includes('invite'), false);
  const summary = await (await f.request(`/api/rooms/${g.roomId}`)).json(); assert.equal(summary.registrationRequired, true);
  const directory = await (await f.request('/api/rooms')).json();
  for (const publicData of [summary, directory]) {
    const serialized = JSON.stringify(publicData);
    for (const person of g.people) for (const value of [person.name, person.invite, person.id]) assert.equal(serialized.includes(value), false);
    assert.equal(serialized.includes('19:30'), false); assert.equal('registration' in publicData, false);
  }
  const own = await (await f.request(`/api/rooms/${g.roomId}/invite`, 'POST', { invite: g.people[1].invite })).json();
  assert.equal(own.participantId, g.people[1].id); assert.equal(own.name, g.people[1].name);
  assert.equal(JSON.stringify(own).includes(g.people[0].name), false); assert.equal('people' in own, false);
  for (const invite of ['invalid', '0'.repeat(64)]) assert.equal((await f.request(`/api/rooms/${g.roomId}/invite`, 'POST', { invite })).status, 401);
  const other = await f.group(); assert.equal((await f.request(`/api/rooms/${other.roomId}/invite`, 'POST', { invite: g.people[0].invite })).status, 401);
});

test('개인 링크 중복 입장은 동일 신청자로 유지되며 실제 첫 입장자가 팀장이다', async t => {
  const f = fixture(t), g = await f.group();
  assert.equal((await f.request(`/api/rooms/${g.roomId}/join`, 'POST', { name: '임의 이름', joinKey: crypto.randomUUID() })).status, 403);
  const first = await f.join(g, 1), duplicate = await f.join(g, 1); assert.deepEqual(duplicate, first);
  const second = await f.join(g, 0); assert.notEqual(first.token, second.token);
  assert.equal(g.room.read().leaderId, first.participantId); assert.equal(g.room.read().members.length, 2);
  assert.equal(g.room.snapshot().registration.people.filter(person => person.joined).length, 2);
  const stale = await f.request(`/api/rooms/${g.roomId}/join`, 'POST', { invite: g.people[1].invite, expectedGeneration: crypto.randomUUID() });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'ROOM_RESET');
  const restored = await f.request(`/api/rooms/${g.roomId}/join`, 'POST', { token: first.token });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).participantId, first.participantId);
});

test('노놀판은 본인 자격과 현재 실행 및 지정 판을 확인하고 중복 기록을 한 번으로 유지한다', async t => {
  const f = fixture(t), g = await f.group(), first = await f.join(g, 0);
  const path = `/api/rooms/${g.roomId}/board`, body = { boardId: 'icheungjip-lab', generationId: g.room.read().lab.runId };
  assert.equal((await f.request(path, 'POST', body)).status, 401);
  assert.equal((await f.tag(g, { token: crypto.randomUUID() })).status, 401);
  assert.equal((await f.tag(g, first, { boardId: 'different-board' })).status, 400);
  assert.equal((await f.tag(g, first, { generationId: crypto.randomUUID() })).status, 409);
  assert.equal((await f.tag(g, first, {}, { Origin: 'https://other.test' })).status, 403);
  const tagged = await (await f.tag(g, first)).json(); assert.equal(tagged.duplicate, false);
  assert.equal(tagged.registration.taggedCount, 1); assert.equal(tagged.registration.allTagged, false);
  assert.equal(tagged.registration.people[0].tagged, true); assert.equal(tagged.registration.people[1].joined, false);
  const revision = g.room.read().revision, timestamp = tagged.registration.people[0].taggedAt;
  const duplicate = await (await f.tag(g, first)).json(); assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.registration.taggedCount, 1); assert.equal(duplicate.registration.people[0].taggedAt, timestamp); assert.equal(g.room.read().revision, revision);
});

test('전원 노놀판 확인과 준비 완료 후 팀장만 시작하며 같은 소켓 상태가 전달된다', async t => {
  const f = fixture(t), g = await f.group(), first = await f.join(g, 1), leader = socket(g.room, first);
  assert.equal(send(g.room, leader, { type: 'ready', ready: true }).type, 'ack');
  assert.equal(send(g.room, leader, { type: 'start' }).type, 'error'); assert.equal(g.room.read().phase, 'lobby');
  await f.tag(g, first);
  assert.equal(send(g.room, leader, { type: 'start' }).type, 'error');
  const second = await f.join(g, 0), member = socket(g.room, second); await f.tag(g, second);
  assert.equal(g.room.registration().allTagged, true); assert.equal(g.room.read().phase, 'lobby');
  assert.equal(send(g.room, leader, { type: 'start' }).type, 'error');
  assert.equal(send(g.room, member, { type: 'ready', ready: true }).type, 'ack');
  assert.equal(send(g.room, member, { type: 'start' }).type, 'error');
  assert.equal(send(g.room, leader, { type: 'start' }).type, 'ack');
  for (const ws of [leader, member]) {
    const state = ws.messages.findLast(message => message.type === 'state').state;
    assert.equal(state.phase, 'started'); assert.equal(state.lab.stage, 'map'); assert.equal(state.registration.allTagged, true);
  }
  const repeat = await f.tag(g, first); assert.equal(repeat.status, 200); assert.equal((await repeat.json()).duplicate, true);
});

test('전체 방 초기화는 명단과 개인 링크를 유지하고 태그 및 이전 자격을 비운다', async t => {
  const f = fixture(t), g = await f.group(), first = await f.join(g, 0), second = await f.join(g, 1);
  const leader = socket(g.room, first), teammate = socket(g.room, second);
  for (const [identity, ws] of [[first, leader], [second, teammate]]) { await f.tag(g, identity); send(g.room, ws, { type: 'ready', ready: true }); }
  send(g.room, leader, { type: 'start' });
  const old = g.room.read(), registrations = g.room.sql.exec('SELECT id,name,invite_hash FROM registrations').toArray();
  assert.equal(send(g.room, teammate, { type: 'lab:reset', runId: old.lab.runId }).type, 'error');
  assert.equal(send(g.room, leader, { type: 'lab:reset', runId: old.lab.runId }).type, 'ack');
  const reset = g.room.read(); assert.notEqual(reset.lab.runId, old.lab.runId); assert.equal(reset.lab.generation, old.lab.generation + 1);
  assert.equal(reset.phase, 'lobby'); assert.equal(reset.members.length, 0); assert.equal(reset.leaderId, null);
  assert.deepEqual(g.room.sql.exec('SELECT id,name,invite_hash FROM registrations').toArray(), registrations);
  assert.equal(g.room.registration().taggedCount, 0); assert.equal(g.room.registration().people.every(person => !person.joined && person.taggedAt === null), true);
  for (const ws of [leader, teammate]) { assert.equal(ws.code, 4401); assert.equal(ws.attachment, null); assert.ok(ws.messages.some(message => message.type === 'room-reset')); }
  assert.equal((await f.request(`/api/rooms/${g.roomId}/join`, 'POST', { token: first.token })).status, 401);
  assert.equal((await f.request(`/api/rooms/${g.roomId}/join`, 'POST', { invite: g.people[0].invite, expectedGeneration: old.lab.runId })).status, 409);
  const entered = await f.join(g, 1); assert.equal(entered.participantId, second.participantId); assert.notEqual(entered.token, second.token);
  assert.equal(g.room.read().leaderId, second.participantId);
  assert.equal((await f.tag(g, entered, { generationId: old.lab.runId })).status, 409);
  assert.equal((await f.tag(g, entered)).status, 200);
});

test('관리자 삭제는 명단과 신청 정보까지 삭제하고 개인 링크 재사용을 차단한다', async t => {
  const f = fixture(t), g = await f.group(), first = await f.join(g, 0), ws = socket(g.room, first); await f.tag(g, first);
  const response = await f.request(`/api/rooms/${g.roomId}`, 'DELETE', undefined, f.auth); assert.equal(response.status, 200);
  for (const table of ['room', 'identities', 'registrations', 'booking']) assert.equal(g.room.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0].count, 0);
  assert.equal(ws.code, 4404); assert.ok(ws.messages.some(message => message.type === 'room-deleted'));
  for (const suffix of ['invite', 'join']) assert.equal((await f.request(`/api/rooms/${g.roomId}/${suffix}`, 'POST', { invite: g.people[0].invite })).status, 404);
  assert.equal((await f.request(`/api/rooms/${g.roomId}`)).status, 404); assert.equal(f.store.list().total, 0);
});

test('개인 링크 확인 중 방이 삭제되면 늦은 입장이 명단과 자격을 복원하지 않는다', async t => {
  const f = fixture(t), g = await f.group(), original = g.room.inviteContext.bind(g.room);
  g.room.inviteContext = async invite => { const person = await original(invite); g.room.deleteRoom(); return person; };
  const response = await f.request(`/api/rooms/${g.roomId}/join`, 'POST', { invite: g.people[0].invite });
  assert.equal(response.status, 404); assert.equal((await response.json()).code, 'ROOM_DELETED');
  for (const table of ['room', 'identities', 'registrations']) assert.equal(g.room.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0].count, 0);
});

test('개인 링크 확인 중 초기화되거나 새 실행 번호를 생략하면 늦은 입장을 거절한다', async t => {
  const f = fixture(t), g = await f.group(), first = await f.join(g, 0), second = await f.join(g, 1);
  const leader = socket(g.room, first), member = socket(g.room, second);
  for (const [identity, ws] of [[first, leader], [second, member]]) { await f.tag(g, identity); send(g.room, ws, { type: 'ready', ready: true }); }
  send(g.room, leader, { type: 'start' });
  const original = g.room.inviteContext.bind(g.room), previousRun = g.room.read().lab.runId;
  g.room.inviteContext = async invite => { const person = await original(invite); send(g.room, leader, { type: 'lab:reset', runId: previousRun }); return person; };
  const late = await f.request(`/api/rooms/${g.roomId}/join`, 'POST', { invite: g.people[0].invite, expectedGeneration: previousRun });
  assert.equal(late.status, 409); assert.equal((await late.json()).code, 'ROOM_RESET'); assert.equal(g.room.read().members.length, 0);
  g.room.inviteContext = original;
  const unspecified = await f.request(`/api/rooms/${g.roomId}/join`, 'POST', { invite: g.people[0].invite });
  assert.equal(unspecified.status, 409); assert.equal(g.room.read().members.length, 0);
  assert.equal((await f.join(g, 0)).name, g.people[0].name);
});

test('기존 일반 방은 닉네임 입장과 준비 및 팀장 양도를 그대로 유지한다', async t => {
  const f = fixture(t), created = await f.request('/api/rooms', 'POST', { title: '일반 방', track: 'lab' }, f.auth), { roomId } = await created.json();
  const room = f.env.ROOMS.getByName(roomId), people = [], sockets = [];
  for (let index = 0; index < 5; index++) {
    const response = await f.request(`/api/rooms/${roomId}/join`, 'POST', { name: `참가자 ${index}`, joinKey: crypto.randomUUID() });
    assert.equal(response.status, 200); people.push(await response.json()); sockets.push(socket(room, people[index]));
  }
  assert.equal(room.registration(), null); assert.equal(room.summary().registrationRequired, false);
  for (const ws of sockets) send(room, ws, { type: 'ready', ready: true });
  assert.equal(send(room, sockets[0], { type: 'transfer', targetId: people[1].participantId }).type, 'ack');
  assert.equal(room.read().leaderId, people[1].participantId); assert.equal(room.read().members[0].ready, false); assert.equal(room.read().members[1].ready, true);
  send(room, sockets[0], { type: 'ready', ready: true });
  assert.equal(send(room, sockets[1], { type: 'start' }).type, 'ack'); assert.equal(room.read().phase, 'started');
});
