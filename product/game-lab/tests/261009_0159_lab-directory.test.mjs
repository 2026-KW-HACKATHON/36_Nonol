import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

async function moduleUrl(filename, imports = {}) {
  const url = new URL(`../src/${filename}`, import.meta.url);
  let source = await readFile(url, 'utf8');
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
const { LabDirectory, hashToken } = await import(directoryUrl);
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
  const ctx = storage(t), store = new LabDirectory(ctx, { NONOL_BASIC_KEY: 'test-only-login-secret' });
  const rooms = new Map(), objectRooms = new Map();
  const env = {
    ROOM_ADMIN_KEY: 'test-only-api-secret', NONOL_BASIC_KEY: 'test-only-login-secret', LAB_DIRECTORY: { getByName: () => store },
    ROOMS: { getByName(id) { if (!rooms.has(id)) rooms.set(id, new GameRoom(storage(t), {})); return rooms.get(id); }, idFromString: id => id, get: id => objectRooms.get(id) }
  };
  function room(title = '테스트 방') { const id = crypto.randomUUID(), value = env.ROOMS.getByName(id); value.create(id, title, 'lab'); return { id, value }; }
  async function request(path, method = 'GET', body, headers = {}) {
    return worker.fetch(new Request(`https://lab.test${path}`, { method, headers: { Origin: 'https://lab.test', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  }
  return { ctx, store, env, rooms, objectRooms, room, request };
}

test('공개 목록은 최신순 페이지와 이름 검색을 제공하고 개인정보를 제외한다', async t => {
  const f = fixture(t);
  for (let index = 0; index < 4; index++) f.store.register({ id: crypto.randomUUID(), title: `방${index}`, track: 'lab', phase: 'lobby', memberCount: 2, stage: 'map', createdAt: index + 1, token: 'private', members: ['private'], positions: {} });
  const first = f.store.list(2); assert.equal(first.total, 4); assert.deepEqual(first.rooms.map(room => room.title), ['방3', '방2']);
  assert.deepEqual(f.store.list(2, first.nextCursor).rooms.map(room => room.title), ['방1', '방0']);
  assert.equal(f.store.list(25, null, '방1').total, 1);
  assert.equal(f.store.list(25, null, '%').total, 0);
  assert.deepEqual(Object.keys(first.rooms[0]).sort(), ['createdAt', 'id', 'memberCount', 'phase', 'stage', 'title', 'track']);
  const live = f.room('현재 팀'); live.value.join('비공개 이름', null, crypto.randomUUID()); f.store.register(live.value.summary());
  const unavailable = f.room('일시 장애'); f.store.register(unavailable.value.summary()); unavailable.value.summary = () => { throw new Error('일시 장애'); };
  const response = await f.request('/api/rooms'); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.rooms.find(room => room.id === live.id).memberCount, 1);
  assert.ok(data.rooms.find(room => room.id === unavailable.id)); assert.equal(JSON.stringify(data).includes('비공개 이름'), false);
});

test('관리자 세션은 해시만 저장하고 재시작, 만료 및 로그아웃을 반영한다', async t => {
  const f = fixture(t);
  const login = await f.request('/api/admin/session', 'POST', { password: f.env.NONOL_BASIC_KEY });
  assert.equal(login.status, 200); assert.deepEqual(await login.json(), { admin: true });
  const cookie = login.headers.get('Set-Cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/);
  const raw = cookie.split(';')[0].split('=')[1]; const rows = f.ctx.sql.exec('SELECT token_hash,expires_at FROM admin_sessions').toArray();
  assert.equal(rows[0].token_hash, await hashToken(raw)); assert.notEqual(rows[0].token_hash, raw);
  assert.ok(await new LabDirectory(f.ctx, f.env).session(raw));
  assert.deepEqual(await (await f.request('/api/admin/session', 'GET', undefined, { Cookie: cookie })).json(), { admin: true });
  const logout = await f.request('/api/admin/session', 'DELETE', undefined, { Cookie: cookie }); assert.deepEqual(await logout.json(), { admin: false }); assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(await f.store.session(raw), false);
  const next = await f.store.login(f.env.NONOL_BASIC_KEY, 'next-ip'); f.ctx.sql.exec('UPDATE admin_sessions SET expires_at=0'); assert.equal(await f.store.session(next.token), false);
});

test('브라우저 로그인과 관리 API는 각각 지정한 시크릿을 사용한다', async t => {
  const f = fixture(t);
  assert.equal((await f.request('/api/admin/session', 'POST', { password: f.env.ROOM_ADMIN_KEY })).status, 401);
  assert.equal((await f.request('/api/admin/session', 'POST', { password: f.env.NONOL_BASIC_KEY })).status, 200);
  assert.equal((await f.request('/api/rooms', 'POST', { title: '관리 API' }, { Authorization: `Bearer ${f.env.NONOL_BASIC_KEY}` })).status, 401);
  assert.equal((await f.request('/api/rooms', 'POST', { title: '관리 API' }, { Authorization: `Bearer ${f.env.ROOM_ADMIN_KEY}` })).status, 201);
  delete f.env.NONOL_BASIC_KEY;
  assert.equal((await f.request('/api/admin/session', 'POST', { password: 'any' })).status, 503);
});

test('로그인 5회 실패와 외부 Origin 및 일반 사용자 삭제를 거절한다', async t => {
  const f = fixture(t), room = f.room();
  for (let index = 0; index < 5; index++) assert.equal((await f.request('/api/admin/session', 'POST', { password: 'wrong' })).status, 401);
  const blocked = await f.request('/api/admin/session', 'POST', { password: f.env.NONOL_BASIC_KEY }); assert.equal(blocked.status, 429); assert.ok(blocked.headers.get('Retry-After'));
  assert.equal((await f.request('/api/admin/session', 'POST', { password: f.env.NONOL_BASIC_KEY }, { Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await f.request(`/api/rooms/${room.id}`, 'DELETE')).status, 401);
  assert.equal((await f.request(`/api/rooms/${room.id}`, 'DELETE', undefined, { Authorization: `Bearer ${f.env.ROOM_ADMIN_KEY}`, Origin: 'https://foreign.test' })).status, 403);
  assert.ok(room.value.read());
  f.ctx.sql.exec('UPDATE admin_attempts SET window_start=0'); assert.equal((await f.store.login(f.env.NONOL_BASIC_KEY, 'local')).status, 200);
});

test('방 생성과 기존 객체 등록 및 방문 등록은 실제 방 UUID만 목록에 추가한다', async t => {
  const f = fixture(t), authorization = { Authorization: `Bearer ${f.env.ROOM_ADMIN_KEY}` };
  const created = await f.request('/api/rooms', 'POST', { title: '새 방' }, authorization); assert.equal(created.status, 201);
  const fresh = await created.json(); assert.ok(f.store.list().rooms.find(room => room.id === fresh.roomId));
  const old = f.room('기존 방'); await f.request(`/api/rooms/${old.id}`); assert.ok(f.store.list().rooms.find(room => room.id === old.id));
  const imported = f.room('발견한 객체'); f.objectRooms.set('a'.repeat(64), imported.value);
  f.objectRooms.set('b'.repeat(64), { summary: () => null });
  f.objectRooms.set('c'.repeat(64), { summary: () => { throw new Error('객체 장애'); } });
  const response = await f.request('/api/admin/rooms/import', 'POST', { objectIds: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)] }, authorization);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { imported: 1, skipped: 2, failed: 1 });
  assert.ok(f.store.list().rooms.find(room => room.id === imported.id));
});

test('루트 삭제는 모든 방 데이터와 연결을 정리하고 늦은 요청과 재등록을 차단한다', async t => {
  const f = fixture(t), room = f.room();
  const member = room.value.join('참가자', null, crypto.randomUUID());
  const state = room.value.read(); f.store.register(room.value.summary());
  room.value.sql.exec('INSERT INTO photo_jobs VALUES (?,?,?)', member.participantId, 'old-job', Date.now());
  room.value.sql.exec('INSERT INTO photo_references VALUES (?,?,?,?)', 'custom', '물병', 'private-image', Date.now());
  const socket = { readyState: 1, messages: [], attachment: { participantId: member.participantId }, send(value) { this.messages.push(JSON.parse(value)); }, serializeAttachment(value) { this.attachment = value; }, close(code) { this.readyState = 3; this.code = code; } };
  room.value.ctx.sockets.push(socket, { readyState: 1, send() { throw new Error('끊어진 연결'); }, serializeAttachment() { throw new Error('끊어진 연결'); }, close() {} });
  const oldSummary = room.value.summary();
  const login = await f.store.login(f.env.NONOL_BASIC_KEY, 'admin'); const headers = { Cookie: `nonol_lab_admin=${login.token}` };
  const response = await f.request(`/api/rooms/${room.id}`, 'DELETE', undefined, headers); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, roomId: room.id });
  for (const table of ['room', 'identities', 'photo_jobs', 'photo_references']) assert.equal(room.value.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0].count, 0);
  assert.equal(socket.code, 4404); assert.equal(socket.attachment, null); assert.deepEqual(socket.messages, [{ type: 'room-deleted', code: 'ROOM_DELETED' }]);
  assert.equal(room.value.snapshot(), null); room.value.webSocketClose(); room.value.webSocketError();
  assert.throws(() => room.value.recordPhoto(member.participantId, state.lab.runId, 'old-job', { verdict: true, method: 'ai' }), /갱신/);
  assert.throws(() => room.value.save(state), error => error.code === 'ROOM_DELETED');
  assert.throws(() => room.value.create(room.id, '복원', 'lab'), error => error.code === 'ROOM_DELETED');
  assert.equal(new GameRoom(room.value.ctx, {}).read(), null); assert.equal(room.value.join('늦은 입장', member.token).code, 'ROOM_DELETED');
  assert.equal(f.store.register(oldSummary), false); assert.equal(f.store.list().total, 0);
  assert.equal((await f.request(`/api/rooms/${room.id}`)).status, 404);
  assert.equal((await (await f.request(`/api/rooms/${room.id}/join`, 'POST', { name: '다시', joinKey: crypto.randomUUID() })).json()).code, 'ROOM_DELETED');
  assert.equal((await f.request(`/api/rooms/${room.id}/socket`)).status, 404);
  assert.equal((await f.request(`/api/rooms/${room.id}`, 'DELETE', undefined, headers)).status, 200);
});

test('삭제 저장 실패는 방과 자격 및 연결을 보존하고 목록 삭제도 실행하지 않는다', async t => {
  const f = fixture(t), room = f.room(); room.value.join('참가자', null, crypto.randomUUID()); f.store.register(room.value.summary());
  const state = room.value.read(); const original = room.value.sql.exec;
  room.value.sql.exec = (query, ...values) => { if (query === 'DELETE FROM identities') throw new Error('저장 실패'); return original(query, ...values); };
  const response = await f.request(`/api/rooms/${room.id}`, 'DELETE', undefined, { Authorization: `Bearer ${f.env.ROOM_ADMIN_KEY}` }); assert.equal(response.status, 503);
  room.value.sql.exec = original; assert.deepEqual(room.value.read(), state); assert.equal(room.value.deleted(), false); assert.equal(f.store.list().total, 1);
});
