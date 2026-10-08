import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { validateCampusTrack, defaultCampusTrack, campusTrackDetails, validateKakaoJavascriptKey } from '../src/261009_0536_track-config.js';
import template from '../public/261009_0536_campus-track.json' with { type: 'json' };

const sourceUrl = new URL('../src/game-room.js', import.meta.url);
let roomSource = (await readFile(sourceUrl, 'utf8')).replace("import { DurableObject } from 'cloudflare:workers';", 'const DurableObject = class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } };');
for (const file of ['room-state.js', 'lab-state.js', 'photo-verification.js', '261009_0536_track-config.js']) roomSource = roomSource.replace(`'./${file}'`, JSON.stringify(new URL(file, sourceUrl).href));
roomSource = roomSource.replace("'../public/test-track.json'", JSON.stringify(new URL('../public/test-track.json', sourceUrl).href));
const roomModuleUrl = `data:text/javascript;base64,${Buffer.from(roomSource).toString('base64')}`;
const { GameRoom } = await import(roomModuleUrl);
let workerSource = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
workerSource = workerSource.replace("'./game-room.js'", JSON.stringify(roomModuleUrl));
const directoryUrl = new URL('../src/261009_0159_lab-directory.js', import.meta.url);
const directorySource = (await readFile(directoryUrl, 'utf8')).replace("import { DurableObject } from 'cloudflare:workers';", 'const DurableObject = class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } };');
workerSource = workerSource.replaceAll("'./261009_0159_lab-directory.js'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(directorySource).toString('base64')}`));
workerSource = workerSource.replace("'./photo-verification.js'", JSON.stringify(new URL('../src/photo-verification.js', import.meta.url).href));
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
globalThis.WebSocketRequestResponsePair = class {};
const image = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, ...Array(100).fill(2)]).toString('base64')}`;

function configuration() {
  return {
    places: { welfare: { lat: 37.619, lon: 127.059, radius: 10 }, square: { lat: 37.6198, lon: 127.059, radius: 10 }, bima: { lat: 37.6206, lon: 127.059, radius: 10 }, futsal: { lat: 37.6199, lon: 127.060, radius: 10 } },
    reference: { label: '에어팟', image }, ending: 'cafe', spatial: { projectUrl: '', mapId: '' }
  };
}

function fixture(t) {
  const rooms = new Map(), summaries = [];
  function get(name) {
    if (rooms.has(name)) return rooms.get(name);
    const database = new DatabaseSync(':memory:');
    t.after(() => database.close());
    const sockets = [];
    const sql = { exec(query, ...bindings) {
      const rows = database.prepare(query).all(...bindings).map(row => ({ ...row }));
      return { toArray: () => rows };
    } };
    const ctx = { storage: { sql, transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    } }, getWebSockets: () => sockets, setWebSocketAutoResponse() {} };
    const room = new GameRoom(ctx, {}); room.testSockets = sockets;
    rooms.set(name, room); return room;
  }
  const env = { ROOMS: { getByName: get }, ROOM_ADMIN_KEY: 'root-key', NONOL_BASIC_KEY: 'private-password',
    LAB_DIRECTORY: { getByName: () => ({ session: async token => token === 'admin-cookie', register: async value => { summaries.push(value); return true; } }) } };
  async function request(path, method = 'GET', body, options = {}) {
    return worker.fetch(new Request(`https://game.test${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { Origin: 'https://game.test' }), ...(options.admin ? { Cookie: 'nonol_lab_admin=admin-cookie' } : {}), ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env);
  }
  function connect(room, name) {
    const credential = room.join(name, null, crypto.randomUUID(), room.summary().generationId);
    const ws = { readyState: 1, messages: [], attachment: null,
      serializeAttachment(value) { this.attachment = value; }, deserializeAttachment() { return this.attachment; },
      send(value) { this.messages.push(JSON.parse(value)); }, close() { this.readyState = 3; } };
    room.testSockets.push(ws);
    room.webSocketMessage(ws, JSON.stringify({ type: 'hello', token: credential.token }));
    return { ...credential, ws };
  }
  function send(room, client, action) {
    const state = room.read(), requestId = crypto.randomUUID();
    room.webSocketMessage(client.ws, JSON.stringify({ stage: state.lab.stage, runId: state.lab.runId, requestId, ...(action.type === 'lab:location' ? { measuredAt: Date.now() } : {}), ...action }));
    return client.ws.messages.findLast(message => message.requestId === requestId);
  }
  return { get, env, request, connect, send, summaries };
}

test('미확정 좌표와 사진은 초안으로 두고 네 장소 및 원본이 준비되면 카페까지 트랙을 만든다', () => {
  const draft = defaultCampusTrack();
  assert.equal(draft.status, 'draft');
  assert.equal(draft.version, 0);
  assert.equal(draft.ending, 'cafe');
  assert.equal(draft.definitionVersion, template.version);
  assert.equal(draft.places.welfare.lat, null);
  for (const id of Object.keys(template.places)) {
    assert.equal(draft.places[id].radius, template.places[id].radius);
    assert.equal(draft.places[id].radius, 10);
  }
  assert.equal(draft.reference.label, template.reference.label);
  const ready = validateCampusTrack(configuration(), 3, 100);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.stageOrder, ['map', 'photo', 'silence', 'ar-route', 'npc', 'finder', 'ending']);
  assert.ok(Array.isArray(ready.story));
  assert.deepEqual(ready.mappings, template.mappings);
  const missingFutsal = configuration(); missingFutsal.places.futsal = { lat: null, lon: null, radius: 10 };
  assert.equal(validateCampusTrack(missingFutsal).status, 'draft');
  assert.equal(campusTrackDetails(ready).reference.image, undefined);
  assert.equal(campusTrackDetails(ready).reference.configured, true);
  assert.equal(campusTrackDetails(ready, true).reference.image, image);
});

test('트랙 설정은 잘못된 좌표와 반경, 모르는 필드 및 확정하지 않은 종료 경로를 거절한다', () => {
  const invalid = [
    value => { value.places.welfare.lat = 91; }, value => { value.places.square.lon = -181; },
    value => { value.places.bima.radius = 4; }, value => { value.places.bima.radius = 101; },
    value => { value.places.welfare.lon = null; }, value => { value.places.square.extra = true; },
    value => { value.places.unknown = value.places.welfare; }, value => { value.extra = true; },
    value => { value.ending = 'bima'; }, value => { value.ending = 'return'; }, value => { value.reference.image = 'bad'; },
    value => { value.reference.label = '생수병'; }, value => { value.reference.extra = true; },
    value => { value.spatial.projectUrl = 'http://project.test'; }, value => { value.spatial.projectUrl = 'https://user:pass@project.test'; },
    value => { value.spatial.mapId = 'x'.repeat(101); }, value => { value.spatial.mapId = 3; },
    value => { value.places.square = { ...value.places.welfare }; }
  ];
  for (const mutate of invalid) { const value = configuration(); mutate(value); assert.throws(() => validateCampusTrack(value)); }
});

test('카탈로그 조회는 사진을 감추고 관리자만 버전을 저장하거나 고정 방을 생성한다', async t => {
  const f = fixture(t);
  const draft = await (await f.request('/api/lab-tracks/kw-silence')).json();
  assert.equal(draft.track.reference.image, undefined);
  assert.equal((await f.request('/api/lab-tracks/kw-silence/rooms', 'POST', {}, { admin: true })).status, 409);
  assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', configuration())).status, 401);
  assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', configuration(), { admin: true, headers: { Origin: 'https://elsewhere.test' } })).status, 403);
  const saved = await f.request('/api/lab-tracks/kw-silence', 'PUT', configuration(), { admin: true });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).track.version, 1);
  const invalid = configuration(); invalid.places.welfare.lat = 91;
  assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', invalid, { admin: true })).status, 400);
  assert.equal(f.get('lab-track-catalog').getTrack('kw-silence', true).version, 1);
  assert.equal((await (await f.request('/api/lab-tracks/kw-silence')).json()).track.reference.image, undefined);
  assert.equal((await (await f.request('/api/lab-tracks/kw-silence', 'GET', undefined, { admin: true })).json()).track.reference.image, image);
  const list = await (await f.request('/api/lab-tracks')).json();
  assert.equal(list.tracks[0].status, 'ready');
  assert.equal(JSON.stringify(list).includes(image), false);
  const created = await f.request('/api/lab-tracks/kw-silence/rooms', 'POST', { title: '현장 검증' }, { admin: true });
  assert.equal(created.status, 201);
  const metadata = await created.json(), room = f.get(metadata.roomId), before = room.read();
  assert.equal(metadata.trackVersion, 1);
  assert.equal(before.lab.trackSnapshot.reference.image, undefined);
  assert.equal(JSON.stringify(before).includes(image), false);
  assert.deepEqual(before.lab.moduleConfigs.map.destination, { lat: 37.6198, lon: 127.059 });
  assert.equal(before.lab.moduleConfigs.photo.photoTarget, '에어팟');
  const changed = configuration(); changed.places.square.lat = 37.620;
  assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', changed, { admin: true })).status, 200);
  assert.deepEqual(room.read(), before);
  const newer = await (await f.request('/api/lab-tracks/kw-silence/rooms', 'POST', {}, { admin: true })).json();
  assert.equal(newer.trackVersion, 2);
  assert.equal(f.get(newer.roomId).read().lab.moduleConfigs.map.destination.lat, 37.620);
});

test('세 장소 카탈로그를 한 번 이관하고 기존 복귀 방의 좌표와 사진 및 스토리는 유지한다', async t => {
  const f = fixture(t), catalog = f.get('lab-track-catalog');
  const legacy = validateCampusTrack(configuration(), 7, 100);
  delete legacy.definitionVersion;
  delete legacy.places.futsal;
  delete legacy.mappings;
  legacy.ending = 'return';
  legacy.story = ['복지관으로 돌아가게.'];
  legacy.spatial = { projectUrl: 'https://legacy.example/route', mapId: 'legacy-map' };
  const roomId = crypto.randomUUID(), room = f.get(roomId);
  room.createTrackRoom(roomId, '이전 복귀 코스', legacy);
  const member = f.connect(room, '기존 팀장'), before = room.read(), reference = room.reference(member.token);
  assert.deepEqual(before.lab.moduleConfigs.finder.destination, { lat: 37.619, lon: 127.059 });
  catalog.sql.exec('INSERT INTO test_tracks(id,state,version) VALUES (?,?,?)', legacy.id, JSON.stringify(legacy), legacy.version);

  const publicTrack = (await (await f.request('/api/lab-tracks/kw-silence')).json()).track;
  assert.equal(publicTrack.version, 8);
  assert.equal(publicTrack.definitionVersion, template.version);
  assert.equal(publicTrack.status, 'draft');
  assert.equal(publicTrack.ending, 'cafe');
  assert.deepEqual(publicTrack.places.futsal, { ...template.places.futsal });
  assert.equal(publicTrack.reference.image, undefined);
  for (const id of ['welfare', 'square', 'bima']) {
    for (const field of ['lat', 'lon', 'radius']) assert.equal(publicTrack.places[id][field], legacy.places[id][field]);
  }
  assert.deepEqual(publicTrack.spatial, legacy.spatial);
  assert.deepEqual(publicTrack.story, template.story);
  assert.deepEqual(publicTrack.mappings, template.mappings);
  const adminTrack = catalog.getTrack('kw-silence', true);
  assert.equal(adminTrack.version, 8);
  assert.equal(adminTrack.reference.image, image);
  assert.equal((await (await f.request('/api/lab-tracks')).json()).tracks[0].definitionVersion, template.version);
  assert.equal(catalog.getTrack('kw-silence', true).version, 8);
  assert.deepEqual(room.read(), before);
  assert.deepEqual(room.getReference(reference.id), reference);
  assert.equal((await f.request('/api/lab-tracks/kw-silence/rooms', 'POST', { expectedVersion: 8 }, { admin: true })).status, 409);
  assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', { ...configuration(), expectedVersion: 7 }, { admin: true })).status, 409);

  assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', { ...configuration(), expectedVersion: 8 }, { admin: true })).status, 200);
  const created = await (await f.request('/api/lab-tracks/kw-silence/rooms', 'POST', { expectedVersion: 9 }, { admin: true })).json();
  const current = f.get(created.roomId).read();
  assert.equal(current.lab.trackSnapshot.definitionVersion, template.version);
  assert.equal(current.lab.trackSnapshot.version, 9);
  assert.equal(current.lab.trackSnapshot.ending, 'cafe');
  assert.deepEqual(current.lab.moduleConfigs.finder.destination, { lat: 37.6199, lon: 127.060 });
  assert.deepEqual(current.lab.trackSnapshot.mappings, template.mappings);
  assert.deepEqual(room.read(), before);
});

test('고정 트랙은 설정과 기준 원본을 잠그고 지도 인증부터 스토리 및 카페 정산까지 공유한다', t => {
  const f = fixture(t), catalog = f.get('lab-track-catalog');
  catalog.saveTrack(configuration());
  const room = f.get(crypto.randomUUID());
  room.createTrackRoom(crypto.randomUUID(), '카페 시험', catalog.getTrack('kw-silence', true));
  const leader = f.connect(room, '팀장'), member = f.connect(room, '팀원');
  assert.equal(f.send(room, leader, { type: 'lab:configure', config: { radius: 15 } }).type, 'error');
  for (const client of [leader, member]) assert.equal(f.send(room, client, { type: 'ready', ready: true }).type, 'ack');
  assert.equal(f.send(room, leader, { type: 'start' }).type, 'ack');
  assert.equal(f.send(room, leader, { type: 'lab:select-stage', target: 'photo' }).type, 'ack');
  assert.throws(() => room.photoContext(leader.token, room.read().lab.runId), /먼저 인증/);
  assert.equal(f.send(room, leader, { type: 'lab:configure-module', config: { photoTarget: '다른 물체' } }).type, 'error');
  assert.throws(() => room.setReference(leader.token, image, '에어팟', room.read().lab.runId), /고정 트랙/);
  assert.equal(f.send(room, leader, { type: 'lab:select-stage', target: 'map' }).type, 'ack');
  for (const client of [leader, member]) {
    assert.equal(f.send(room, client, { type: 'lab:location', ...room.read().lab.config.destination, source: 'gps', accuracy: 3, heading: null }).type, 'ack');
    assert.equal(f.send(room, client, { type: 'lab:complete' }).type, 'ack');
  }
  assert.equal(room.read().lab.stage, 'photo');
  for (const client of [leader, member]) {
    const job = room.photoContext(client.token, room.read().lab.runId);
    room.recordPhoto(job.actorId, room.read().lab.runId, job.jobId, { method: 'ai', verdict: true });
    room.finishPhoto(job.actorId, job.jobId);
  }
  assert.equal(room.read().lab.stage, 'silence');
  for (const client of [leader, member]) assert.equal(f.send(room, client, { type: 'lab:complete' }).type, 'ack');
  assert.equal(room.read().lab.stage, 'ar-route');
  assert.equal(f.send(room, leader, { type: 'lab:report', targetId: member.participantId }).type, 'ack');
  const route = room.read().lab.config;
  for (const client of [leader, member]) {
    for (const [waypoint, point] of [
      { lat: (route.start.lat + route.destination.lat) / 2, lon: (route.start.lon + route.destination.lon) / 2 }, route.destination
    ].entries()) {
      assert.equal(f.send(room, client, { type: 'lab:location', ...point, source: 'gps', accuracy: 3, heading: null }).type, 'ack');
      assert.equal(f.send(room, client, { type: 'lab:route-arrive', waypoint }).type, 'ack');
    }
  }
  assert.equal(room.read().lab.stage, 'npc');
  for (const client of [leader, member]) {
    assert.equal(f.send(room, client, { type: 'lab:npc-touch' }).type, 'ack');
    assert.equal(f.send(room, client, { type: 'lab:complete' }).type, 'ack');
  }
  assert.equal(room.read().lab.stage, 'finder');
  assert.deepEqual(room.read().lab.config.start, { lat: 37.6206, lon: 127.059 });
  assert.deepEqual(room.read().lab.config.destination, { lat: 37.6199, lon: 127.060 });
  for (const client of [leader, member]) {
    assert.equal(f.send(room, client, { type: 'lab:location', ...room.read().lab.config.destination, source: 'gps', accuracy: 3, heading: null }).type, 'ack');
    assert.equal(f.send(room, client, { type: 'lab:complete' }).type, 'ack');
  }
  assert.equal(room.read().lab.stage, 'ending');
  assert.equal(room.read().lab.penalties[member.participantId], 1);
  assert.deepEqual(leader.ws.messages.findLast(message => message.type === 'state').state.lab, member.ws.messages.findLast(message => message.type === 'state').state.lab);
});

test('관리자가 검토한 버전이 바뀌면 저장과 방 생성을 거절하고 현재 설정을 보존한다', async t => {
  const f = fixture(t);
  assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', { ...configuration(), expectedVersion: 0 }, { admin: true })).status, 200);
  const reviewed = f.get('lab-track-catalog').getTrack('kw-silence', true);
  const changed = configuration(); changed.places.square.lat = 37.620;
  const saved = await f.request('/api/lab-tracks/kw-silence', 'PUT', { ...changed, expectedVersion: 1 }, { admin: true });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).track.version, 2);
  const before = f.get('lab-track-catalog').getTrack('kw-silence', true);
  assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', { ...configuration(), expectedVersion: reviewed.version }, { admin: true })).status, 409);
  assert.equal((await f.request('/api/lab-tracks/kw-silence/rooms', 'POST', { title: '오래된 화면', expectedVersion: reviewed.version }, { admin: true })).status, 409);
  assert.deepEqual(f.get('lab-track-catalog').getTrack('kw-silence', true), before);
  assert.equal(f.summaries.length, 0);
  for (const expectedVersion of [-1, null, '2', 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await f.request('/api/lab-tracks/kw-silence', 'PUT', { ...configuration(), expectedVersion }, { admin: true })).status, 400);
    assert.equal((await f.request('/api/lab-tracks/kw-silence/rooms', 'POST', { expectedVersion }, { admin: true })).status, 400);
  }
  const created = await f.request('/api/lab-tracks/kw-silence/rooms', 'POST', { title: '확인한 화면', expectedVersion: 2 }, { admin: true });
  assert.equal(created.status, 201);
  const metadata = await created.json(), room = f.get(metadata.roomId);
  assert.equal(metadata.trackVersion, 2);
  assert.deepEqual(room.read().lab.trackSnapshot.places, before.places);
  assert.equal(room.read().lab.trackSnapshot.version, before.version);
});

test('고정 트랙 전체 초기화는 입장과 진행만 비우며 버전과 좌표 및 사진 원본을 유지한다', t => {
  const f = fixture(t), catalog = f.get('lab-track-catalog');
  catalog.saveTrack(configuration());
  const roomId = crypto.randomUUID(), room = f.get(roomId);
  room.createTrackRoom(roomId, '고정 방', catalog.getTrack('kw-silence', true));
  const client = f.connect(room, '첫 팀장');
  const source = room.reference(client.token), before = room.read();
  assert.equal(f.send(room, client, { type: 'ready', ready: true }).type, 'ack');
  assert.equal(f.send(room, client, { type: 'start' }).type, 'ack');
  assert.equal(f.send(room, client, { type: 'lab:reset' }).type, 'ack');
  const after = room.read();
  assert.equal(after.phase, 'lobby');
  assert.deepEqual(after.members, []);
  assert.notEqual(after.lab.runId, before.lab.runId);
  assert.deepEqual(after.lab.trackSnapshot, before.lab.trackSnapshot);
  assert.deepEqual(after.lab.moduleConfigs, before.lab.moduleConfigs);
  assert.deepEqual(after.lab.stageOrder, before.lab.stageOrder);
  assert.deepEqual(room.getReference(source.id), source);
  assert.equal(room.join('', client.token, null).code, 'ROOM_IDENTITY_EXPIRED');
  assert.equal(room.join('이전 세대', null, crypto.randomUUID(), before.lab.runId).code, 'ROOM_RESET');
  assert.equal(room.join('세대 누락', null, crypto.randomUUID()).code, 'ROOM_RESET');
  const credential = f.connect(room, '새 팀장');
  assert.equal(room.read().leaderId, credential.participantId);
  assert.deepEqual(room.reference(credential.token), source);
  assert.equal(credential.ws.messages.findLast(message => message.type === 'state').state.phase, 'lobby');
  assert.equal(f.send(room, credential, { type: 'ready', ready: true }).type, 'ack');
  assert.equal(f.send(room, credential, { type: 'start' }).type, 'ack');
  assert.equal(room.read().lab.stage, 'map');
  assert.deepEqual(room.read().lab.config, before.lab.moduleConfigs.map);
});

test('카카오 지도 설정은 관리자만 저장하고 공개 JavaScript 키만 반환한다', async t => {
  const f = fixture(t), key = 'a'.repeat(32);
  assert.deepEqual(await (await f.request('/api/map-config')).json(), { provider: 'kakao', kakaoJavascriptKey: null, configured: false });
  assert.equal((await f.request('/api/map-config', 'PUT', { kakaoJavascriptKey: key })).status, 401);
  assert.equal((await f.request('/api/map-config', 'PUT', { kakaoJavascriptKey: key }, { admin: true, headers: { Origin: 'https://elsewhere.test' } })).status, 403);
  for (const body of [{ kakaoJavascriptKey: 'bad' }, { kakaoJavascriptKey: 1 }, { kakaoJavascriptKey: key, restKey: 'secret' }]) {
    assert.equal((await f.request('/api/map-config', 'PUT', body, { admin: true })).status, 400);
  }
  const saved = await f.request('/api/map-config', 'PUT', { kakaoJavascriptKey: key }, { admin: true });
  assert.deepEqual(await saved.json(), { provider: 'kakao', kakaoJavascriptKey: key, configured: true });
  assert.equal((await f.request('/api/map-config', 'PUT', { kakaoJavascriptKey: key }, { headers: { Authorization: 'Bearer root-key' } })).status, 200);
  f.env.KAKAO_MAPS_JAVASCRIPT_KEY = 'b'.repeat(32); f.env.KAKAO_REST_API_KEY = 'private-rest-key';
  const response = await (await f.request('/api/map-config')).json();
  assert.deepEqual(response, { provider: 'kakao', kakaoJavascriptKey: 'b'.repeat(32), configured: true });
  assert.equal(JSON.stringify(response).includes('private'), false);
  assert.equal((await f.request('/api/map-config', 'PUT', { kakaoJavascriptKey: '' }, { admin: true })).status, 200);
  assert.equal(f.get('lab-track-catalog').getMapKey(), null);
  assert.throws(() => validateKakaoJavascriptKey({ kakaoJavascriptKey: key, unknown: true }));
});
