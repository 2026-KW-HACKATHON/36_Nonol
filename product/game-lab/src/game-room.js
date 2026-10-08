import { DurableObject } from 'cloudflare:workers';
import { createRoomState, joinRoom, applyAction } from './room-state.js';
import { labPolicy, createLab, upgradeLabPolicy, startLab, applyLabAction, photoContext, completePhoto } from './lab-state.js';
import track from '../public/test-track.json' with { type: 'json' };
import { imageBytes } from './photo-verification.js';
import { campusTrackId, defaultCampusTrack, upgradeCampusTrack, validateCampusTrack, campusTrackDetails, campusTrackSummary, applyCampusTrack, validateKakaoJavascriptKey } from './261009_0536_track-config.js';

const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
const identityExpired = () => Object.assign(new Error('방이 초기화되었습니다. 닉네임을 입력해 다시 입장해 주세요.'), { code: 'ROOM_IDENTITY_EXPIRED', status: 401 });
const roomDeleted = () => Object.assign(new Error('관리자가 삭제한 방입니다. 홈에서 다른 방을 선택해 주세요.'), { code: 'ROOM_DELETED', status: 404 });
const referenceMetadata = state => ({
  referenceId: state.lab.reference?.id || track.photoRules?.[state.lab.moduleConfigs?.photo?.photoTarget ?? state.lab.config.photoTarget]?.referenceId || null,
  customReference: Boolean(state.lab.reference?.id), label: state.lab.reference?.label || state.lab.moduleConfigs?.photo?.photoTarget || state.lab.config.photoTarget
});

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS photo_jobs (actor_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, started_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS photo_references (id TEXT PRIMARY KEY, label TEXT NOT NULL, image TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_lifecycle (id INTEGER PRIMARY KEY CHECK(id = 1), created_at INTEGER NOT NULL, deleted_at INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS booking (id INTEGER PRIMARY KEY CHECK(id = 1), date TEXT NOT NULL, time TEXT NOT NULL, board_id TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS registrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_hash TEXT NOT NULL UNIQUE, tagged_generation INTEGER, tagged_at INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS test_tracks (id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS catalog_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  read() {
    if (this.deleted()) return null;
    const row = this.sql.exec('SELECT state FROM room WHERE id = 1').toArray()[0];
    if (!row) return null;
    const state = JSON.parse(row.state);
    const next = upgradeLabPolicy(state);
    if (next !== state) {
      this.ctx.storage.transactionSync(() => {
        if (next.lab.runId !== state.lab.runId || next.lab.config.photoTarget !== state.lab.config.photoTarget) this.sql.exec('DELETE FROM photo_jobs');
        this.save(next);
      });
      if (next.lab.runId !== state.lab.runId) this.refreshRunConnections(next.lab.runId);
    }
    return next;
  }

  save(state) {
    if (this.deleted()) throw roomDeleted();
    this.sql.exec('INSERT INTO room (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state', JSON.stringify(state));
  }

  create(id, title, track = 'standard') {
    if (this.deleted()) throw roomDeleted();
    if (this.read()) throw new Error('이미 존재하는 방입니다.');
    const state = createRoomState({ id, title });
    if (track === 'lab') { state.track = 'lab'; state.lab = createLab(); }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO room_lifecycle (id,created_at) VALUES (1,?)', Date.now());
      this.save(state);
    });
  }

  getTrack(id = campusTrackId, admin = false) {
    if (id !== campusTrackId) return null;
    const row = this.sql.exec('SELECT state FROM test_tracks WHERE id=?', id).toArray()[0];
    if (!row) return campusTrackDetails(defaultCampusTrack(), admin);
    const saved = JSON.parse(row.state), upgraded = upgradeCampusTrack(saved);
    if (upgraded !== saved) this.sql.exec('UPDATE test_tracks SET state=?,version=? WHERE id=?', JSON.stringify(upgraded), upgraded.version, id);
    return campusTrackDetails(upgraded, admin);
  }

  trackList() { return [campusTrackSummary(this.getTrack(campusTrackId, true))]; }

  saveTrack(input, expectedVersion) {
    const previous = this.getTrack(campusTrackId, true);
    if (expectedVersion !== undefined) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw Object.assign(new Error('확인한 트랙 버전을 다시 불러와 주세요.'), { status: 400 });
      if (expectedVersion !== previous.version) throw Object.assign(new Error('다른 관리자가 트랙을 변경했습니다. 최신 설정을 불러온 뒤 다시 저장해 주세요.'), { status: 409 });
    }
    const next = validateCampusTrack(input, previous.version + 1);
    this.sql.exec('INSERT INTO test_tracks(id,state,version) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,version=excluded.version', next.id, JSON.stringify(next), next.version);
    return next;
  }

  getMapKey() { return this.sql.exec('SELECT value FROM catalog_settings WHERE id=?', 'kakao-javascript-key').toArray()[0]?.value || null; }

  saveMapKey(body) {
    const key = validateKakaoJavascriptKey(body);
    this.sql.exec('INSERT INTO catalog_settings(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', 'kakao-javascript-key', key);
    return key || null;
  }

  createTrackRoom(id, title, track) {
    if (this.deleted()) throw roomDeleted();
    if (this.read()) throw new Error('이미 존재하는 방입니다.');
    const referenceId = crypto.randomUUID();
    const lab = applyCampusTrack(createLab(), track, referenceId);
    const state = { ...createRoomState({ id, title }), track: 'lab', lab };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO room_lifecycle (id,created_at) VALUES (1,?)', Date.now());
      const reference = this.putReference(referenceId, track.reference.image, track.reference.label);
      state.lab.reference = { id: reference.id, label: reference.label, updatedAt: reference.updatedAt, custom: true };
      this.save(state);
    });
    return this.summary();
  }

  deleted() { return Boolean(this.sql.exec('SELECT deleted_at FROM room_lifecycle WHERE id = 1 AND deleted_at IS NOT NULL').toArray()[0]); }

  async createRegistered(id, title, booking) {
    const names = booking?.names;
    if (!Array.isArray(names) || names.length < 2 || names.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 24)) throw Object.assign(new Error('신청자 이름을 2명 이상 입력해 주세요. 이름은 24자까지 사용할 수 있습니다.'), { status: 400 });
    if (typeof booking.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(booking.date) || !Number.isFinite(Date.parse(`${booking.date}T00:00:00Z`)) || new Date(`${booking.date}T00:00:00Z`).toISOString().slice(0, 10) !== booking.date) throw Object.assign(new Error('신청 날짜를 확인해 주세요.'), { status: 400 });
    if (typeof booking.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(booking.time)) throw Object.assign(new Error('신청 시간을 확인해 주세요.'), { status: 400 });
    const participants = await Promise.all(names.map(async name => {
      const invite = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return { id: crypto.randomUUID(), name: name.trim(), invite, hash: await this.inviteHash(invite) };
    }));
    if (this.deleted()) throw roomDeleted();
    if (this.read()) throw Object.assign(new Error('이미 존재하는 방입니다.'), { status: 409 });
    const state = { ...createRoomState({ id, title }), track: 'lab', lab: createLab() };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO room_lifecycle (id,created_at) VALUES (1,?)', Date.now());
      this.sql.exec('INSERT INTO booking (id,date,time,board_id) VALUES (1,?,?,?)', booking.date, booking.time, 'icheungjip-lab');
      for (const participant of participants) this.sql.exec('INSERT INTO registrations (id,name,invite_hash) VALUES (?,?,?)', participant.id, participant.name, participant.hash);
      this.save(state);
    });
    return participants.map(({ id, name, invite }) => ({ id, name, invite }));
  }

  async inviteHash(invite) {
    if (typeof invite !== 'string' || !/^[0-9a-f]{64}$/.test(invite)) throw Object.assign(new Error('개인 초대 링크를 확인해 주세요.'), { status: 401 });
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`nonol-personal-invite:${invite}`));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  registration(state = this.read()) {
    if (!state) return null;
    const booking = this.sql.exec('SELECT date,time,board_id FROM booking WHERE id=1').toArray()[0];
    if (!booking) return null;
    const people = this.sql.exec('SELECT id,name,tagged_generation,tagged_at FROM registrations ORDER BY rowid').toArray().map(person => ({
      id: person.id, name: person.name, joined: state.members.some(member => member.id === person.id),
      tagged: person.tagged_generation === state.lab.generation, taggedAt: person.tagged_generation === state.lab.generation ? person.tagged_at : null
    }));
    const taggedCount = people.filter(person => person.tagged).length;
    return { date: booking.date, time: booking.time, boardId: booking.board_id, total: people.length, taggedCount, allTagged: people.length > 0 && taggedCount === people.length, people };
  }

  async inviteContext(invite) {
    const hash = await this.inviteHash(invite);
    if (this.deleted()) throw roomDeleted();
    const state = this.read();
    const person = this.sql.exec('SELECT id,name FROM registrations WHERE invite_hash=?', hash).toArray()[0];
    if (!state || !person) throw Object.assign(new Error('이 그룹에 등록된 개인 초대 링크를 확인해 주세요.'), { status: 401 });
    const booking = this.sql.exec('SELECT date,time FROM booking WHERE id=1').toArray()[0];
    return { participantId: person.id, name: person.name, title: state.title, ...booking, generationId: state.lab.runId };
  }

  async joinPersonal(invite, expectedGeneration) {
    const person = await this.inviteContext(invite);
    if (this.deleted()) throw roomDeleted();
    const state = this.read();
    if (!state || !this.sql.exec('SELECT id FROM registrations WHERE id=?', person.participantId).toArray()[0]) throw roomDeleted();
    if (person.generationId !== state.lab.runId || (expectedGeneration !== undefined && expectedGeneration !== state.lab.runId) || (state.lab.generation > 1 && expectedGeneration !== state.lab.runId)) return { error: '방이 초기화되었습니다. 현재 방을 확인한 뒤 다시 입장해 주세요.', code: 'ROOM_RESET', status: 409, generationId: state.lab.runId };
    const existing = this.sql.exec('SELECT token FROM identities WHERE id=?', person.participantId).toArray()[0];
    if (existing) return { participantId: person.participantId, token: existing.token, generationId: state.lab.runId, name: person.name };
    if (state.phase !== 'lobby') return { error: '이미 출발한 팀입니다. 테스트를 초기화한 뒤 입장해 주세요.', status: 409 };
    const token = crypto.randomUUID();
    const next = joinRoom(state, { id: person.participantId, name: person.name, joinedAt: Date.now() });
    this.ctx.storage.transactionSync(() => { this.sql.exec('INSERT INTO identities (id,token) VALUES (?,?)', person.participantId, token); this.save(next); });
    this.broadcast();
    return { participantId: person.participantId, token, generationId: state.lab.runId, name: person.name };
  }

  recordBoard(token, boardId, generationId) {
    if (this.deleted()) throw roomDeleted();
    const identity = this.sql.exec('SELECT id FROM identities WHERE token=?', token).toArray()[0];
    if (!identity) throw identityExpired();
    const state = this.read(), registration = this.registration(state);
    if (!registration || !registration.people.some(person => person.id === identity.id)) throw Object.assign(new Error('신청 그룹의 개인 링크로 먼저 입장해 주세요.'), { status: 403 });
    if (generationId !== state.lab.runId) throw Object.assign(new Error('진행이 변경되었습니다. 개인 링크를 다시 열어 주세요.'), { status: 409 });
    if (boardId !== registration.boardId) throw Object.assign(new Error('이번 퀘스트의 노놀판을 확인해 주세요.'), { status: 400 });
    const duplicate = registration.people.find(person => person.id === identity.id).tagged;
    if (state.phase !== 'lobby' && !duplicate) throw Object.assign(new Error('식사 후 출발 전 태그를 진행해 주세요.'), { status: 409 });
    if (!duplicate) this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE registrations SET tagged_generation=?,tagged_at=? WHERE id=?', state.lab.generation, Date.now(), identity.id);
      this.save({ ...state, revision: state.revision + 1 });
    });
    this.broadcast();
    return { registration: this.registration(), duplicate };
  }

  deleteRoom() {
    const state = this.read();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO room_lifecycle (id,created_at,deleted_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET deleted_at=COALESCE(room_lifecycle.deleted_at,excluded.deleted_at)', Date.now(), Date.now());
      for (const table of ['room', 'identities', 'photo_jobs', 'photo_references', 'registrations', 'booking']) this.sql.exec(`DELETE FROM ${table}`);
    });
    for (const ws of this.ctx.getWebSockets()) {
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'room-deleted', code: 'ROOM_DELETED' })); } catch {}
      try { ws.serializeAttachment(null); } catch {}
      try { ws.close(4404, 'Room deleted'); } catch {}
    }
    return { deleted: true, roomId: state?.id || null };
  }

  summary() {
    const state = this.read();
    if (state && !this.sql.exec('SELECT created_at FROM room_lifecycle WHERE id = 1').toArray()[0]) {
      const earliest = state.members.map(member => member.joinedAt).filter(Number.isFinite);
      this.sql.exec('INSERT INTO room_lifecycle (id,created_at) VALUES (1,?)', earliest.length ? Math.min(...earliest) : Date.now());
    }
    return state ? {
      id: state.id, title: state.title, policyId: state.policyId, phase: state.phase, track: state.track || 'standard',
      memberCount: state.members.length, stage: state.lab?.stage || null, createdAt: this.sql.exec('SELECT created_at FROM room_lifecycle WHERE id = 1').toArray()[0].created_at,
      ...(state.lab ? {
        generationId: state.lab.runId, labPolicyId: state.lab.policyId ?? labPolicy.id, labPolicyVersion: state.lab.policyVersion ?? labPolicy.version,
        reference: state.lab.reference || null
      } : {}),
      registrationRequired: Boolean(this.sql.exec('SELECT id FROM booking WHERE id=1').toArray()[0]),
      ...(state.lab?.trackSnapshot ? { trackId: state.lab.trackSnapshot.id, trackVersion: state.lab.trackSnapshot.version } : {})
    } : null;
  }

  putReference(id, image, label, immutable = false) {
    if (this.deleted()) throw roomDeleted();
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error('기준 사진 ID를 확인해 주세요.');
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 80) throw new Error('기준 물체 이름은 1자부터 80자로 입력해 주세요.');
    imageBytes(image);
    if (immutable) {
      const existing = this.getReference(id);
      if (existing) {
        if (existing.label === label.trim() && existing.image === image) return existing;
        throw Object.assign(new Error('이미 등록한 기준 사진은 새 ID로 등록해 주세요.'), { status: 409 });
      }
    }
    const reference = { id, label: label.trim(), image, updatedAt: Date.now() };
    this.sql.exec('INSERT INTO photo_references (id, label, image, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, image = excluded.image, updated_at = excluded.updated_at', id, reference.label, image, reference.updatedAt);
    return reference;
  }

  getReference(id) {
    const row = this.sql.exec('SELECT id, label, image, updated_at FROM photo_references WHERE id = ?', id).toArray()[0];
    return row ? { id: row.id, label: row.label, image: row.image, updatedAt: row.updated_at } : null;
  }

  referenceContext(token) {
    const identity = this.sql.exec('SELECT id FROM identities WHERE token = ?', token).toArray()[0];
    if (!identity) throw identityExpired();
    const state = this.read();
    if (state?.track !== 'lab' || !state.lab) throw new Error('테스트 트랙에서 기준 사진을 확인해 주세요.');
    return referenceMetadata(state);
  }

  reference(token) {
    const context = this.referenceContext(token);
    return context.customReference ? this.getReference(context.referenceId) : null;
  }

  setReference(token, image, label, runId) {
    const identity = this.sql.exec('SELECT id FROM identities WHERE token = ?', token).toArray()[0];
    if (!identity) throw identityExpired();
    const state = this.read();
    if (state?.track !== 'lab' || !state.lab) throw new Error('테스트 트랙에서 기준 사진을 등록해 주세요.');
    if (identity.id !== state.leaderId) throw Object.assign(new Error('현재 팀장만 기준 사진을 등록할 수 있습니다.'), { status: 403 });
    if (state.lab.trackSnapshot) throw Object.assign(new Error('고정 트랙 방은 생성할 때의 기준 사진을 함께 사용합니다. 트랙 설정에서 새 방을 만들어 주세요.'), { status: 409 });
    if (state.phase !== 'started' || state.lab.stage !== 'photo') {
      throw Object.assign(new Error('사진 모듈에서 기준 사진을 변경해 주세요.'), { status: 409 });
    }
    if (runId !== state.lab.runId) throw Object.assign(new Error('진행이 변경되었습니다. 현재 사진 모듈에서 다시 등록해 주세요.'), { status: 409 });
    const next = applyLabAction(state, identity.id, {
      type: 'lab:configure-module', stage: 'photo', runId, requestId: crypto.randomUUID(), config: { photoTarget: label }
    });
    let reference;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM photo_references');
      reference = this.putReference(crypto.randomUUID(), image, label);
      next.lab.reference = { id: reference.id, label: reference.label, updatedAt: reference.updatedAt, custom: true };
      next.lab.config.photoTarget = reference.label;
      next.lab.moduleConfigs.photo.photoTarget = reference.label;
      next.lab.policyId = labPolicy.id; next.lab.policyVersion = labPolicy.version;
      this.sql.exec('DELETE FROM photo_jobs');
      this.save(next);
    });
    this.refreshRunConnections(next.lab.runId);
    this.broadcast();
    return reference;
  }

  photoContext(token, runId) {
    const identity = this.sql.exec('SELECT id FROM identities WHERE token = ?', token).toArray()[0];
    if (!identity) throw new Error('입장 정보를 확인해 주세요.');
    const state = this.read();
    const context = photoContext(state, identity.id, runId);
    if (state.lab.completed[identity.id]) throw new Error('이미 사진 인증을 완료했습니다. 팀원을 기다려 주세요.');
    const job = this.sql.exec('SELECT started_at FROM photo_jobs WHERE actor_id = ?', identity.id).toArray()[0];
    if (job && Date.now() - job.started_at < 60000) throw new Error('사진 한 장을 판정하고 있습니다. 결과를 기다려 주세요.');
    const jobId = crypto.randomUUID();
    this.sql.exec('INSERT INTO photo_jobs (actor_id, job_id, started_at) VALUES (?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET job_id = excluded.job_id, started_at = excluded.started_at', identity.id, jobId, Date.now());
    return { ...context, actorId: identity.id, jobId, ...referenceMetadata(state) };
  }

  recordPhoto(actorId, runId, jobId, evidence) {
    const before = this.read();
    const job = this.sql.exec('SELECT job_id FROM photo_jobs WHERE actor_id = ?', actorId).toArray()[0];
    if (job?.job_id !== jobId) throw new Error('사진 요청이 갱신됐습니다. 현재 진행 상태를 확인해 주세요.');
    const next = completePhoto(before, actorId, runId, evidence);
    if (next !== before) this.save(next);
    this.broadcast();
  }

  finishPhoto(actorId, jobId) { this.sql.exec('DELETE FROM photo_jobs WHERE actor_id = ? AND job_id = ?', actorId, jobId); }

  join(name, token, joinKey, expectedGeneration) {
    if (this.deleted()) return { error: roomDeleted().message, code: 'ROOM_DELETED', status: 404 };
    const state = this.read();
    if (!state) return { error: '초대 링크를 확인해 주세요.', status: 404 };
    const generation = state.lab ? { generationId: state.lab.runId } : {};
    if (token) {
      const identity = this.sql.exec('SELECT id FROM identities WHERE token = ?', token).toArray()[0];
      if (!identity) return { error: identityExpired().message, code: 'ROOM_IDENTITY_EXPIRED', status: 401 };
      return { participantId: identity.id, token, ...generation, ...(this.sql.exec('SELECT name FROM registrations WHERE id=?', identity.id).toArray()[0] || {}) };
    }
    if (this.sql.exec('SELECT id FROM booking WHERE id=1').toArray()[0]) return { error: '신청자별 개인 초대 링크로 입장해 주세요.', code: 'PERSONAL_INVITE_REQUIRED', status: 403 };
    if (state.lab && ((expectedGeneration !== undefined && expectedGeneration !== state.lab.runId) ||
      ((state.lab.generation ?? 1) > 1 && expectedGeneration !== state.lab.runId))) {
      return { error: '방이 초기화되었습니다. 현재 방을 확인한 뒤 다시 입장해 주세요.', code: 'ROOM_RESET', status: 409, ...generation };
    }
    const existing = this.sql.exec('SELECT id FROM identities WHERE token = ?', joinKey).toArray()[0];
    if (existing) return { participantId: existing.id, token: joinKey, ...generation };
    if (state.phase !== 'lobby') return { error: '이미 출발한 팀입니다. 기존 참가자는 처음 입장한 브라우저에서 링크를 열어 주세요.', status: 409 };
    const participantId = crypto.randomUUID();
    const credential = joinKey;
    const next = joinRoom(state, { id: participantId, name, joinedAt: Date.now() });
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO identities (id, token) VALUES (?, ?)', participantId, credential);
      this.save(next);
    });
    this.broadcast();
    return { participantId, token: credential, ...generation };
  }

  fetch(request) {
    if (this.deleted()) return json({ error: roomDeleted().message, code: 'ROOM_DELETED' }, 404);
    if (!this.read()) return json({ error: '초대 링크를 확인해 주세요.' }, 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket 연결이 필요합니다.' }, 426);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  snapshot() {
    const connected = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      try { const id = ws.deserializeAttachment()?.participantId; if (id) connected.add(id); }
      catch { try { ws.close(1011, 'Reconnect'); } catch {} }
    }
    const state = this.read();
    if (!state) return null;
    const lab = state.lab && { ...state.lab, policyId: state.lab.policyId ?? labPolicy.id, policyVersion: state.lab.policyVersion ?? labPolicy.version };
    const registration = this.registration(state);
    return { ...state, ...(lab ? { lab } : {}), ...(registration ? { registration } : {}), members: state.members.map(m => ({ ...m, connected: connected.has(m.id) })) };
  }

  broadcast() {
    const state = this.snapshot();
    if (!state) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      try {
        const participantId = ws.deserializeAttachment()?.participantId;
        if (participantId) ws.send(JSON.stringify({ type: 'state', selfId: participantId, state }));
      } catch { try { ws.close(1011, 'Reconnect'); } catch {} }
    }
  }

  resetConnections(generationId) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'room-reset', generationId }));
      } catch {}
      ws.serializeAttachment(null);
      try { ws.close(4401, 'Room reset'); } catch {}
    }
  }

  refreshRunConnections(runId) {
    for (const connection of this.ctx.getWebSockets()) {
      if (connection.readyState !== 1) continue;
      try {
        const attachment = connection.deserializeAttachment();
        if (attachment?.participantId) connection.serializeAttachment({ ...attachment, generationId: runId });
      } catch { try { connection.close(1011, 'Reconnect'); } catch {} }
    }
  }

  webSocketMessage(ws, message) {
    let data;
    try {
      if (this.deleted()) throw roomDeleted();
      if (typeof message !== 'string' || message.length > 2048) throw new Error('요청을 읽지 못했습니다.');
      data = JSON.parse(message);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('요청을 읽지 못했습니다.');
      const identity = ws.deserializeAttachment();
      if (data.type === 'hello') {
        if (identity) throw new Error('이미 연결되었습니다.');
        if (typeof data.token !== 'string') throw identityExpired();
        const participant = this.sql.exec('SELECT id FROM identities WHERE token = ?', data.token).toArray()[0];
        if (!participant) throw identityExpired();
        ws.serializeAttachment({ participantId: participant.id, generationId: this.read().lab?.runId });
        this.broadcast();
        return;
      }
      if (!identity?.participantId || !this.sql.exec('SELECT id FROM identities WHERE id = ?', identity.participantId).toArray()[0]) throw identityExpired();
      if (typeof data.requestId !== 'string' || data.requestId.length > 80) throw new Error('요청을 확인해 주세요.');
      const before = this.read();
      const currentIdentity = ws.deserializeAttachment();
      if (currentIdentity?.generationId && before.lab?.runId !== currentIdentity.generationId) throw identityExpired();
      if (data.type === 'start' && this.registration(before) && !this.registration(before).allTagged) throw new Error('신청자 전원이 각자 노놀판을 확인한 뒤 시작해 주세요.');
      let next = data.type?.startsWith('lab:') ? applyLabAction(before, identity.participantId, data) : applyAction(before, identity.participantId, data);
      if (data.type === 'start' && before.phase === 'lobby' && next.track === 'lab') next = startLab(next);
      if (data.type === 'lab:reset' && next !== before) {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('DELETE FROM identities');
          this.sql.exec('DELETE FROM photo_jobs');
          if (!next.lab.trackSnapshot) this.sql.exec('DELETE FROM photo_references');
          this.sql.exec('UPDATE registrations SET tagged_generation=NULL,tagged_at=NULL');
          this.save(next);
        });
        this.broadcast();
        try { ws.send(JSON.stringify({ type: 'ack', requestId: data.requestId })); } catch {}
        this.resetConnections(next.lab.runId);
        return;
      }
      if (['lab:stage-control', 'lab:select-stage', 'lab:configure-module'].includes(data.type) && next !== before) {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('DELETE FROM photo_jobs');
          if (before.lab.reference && !next.lab.reference) this.sql.exec('DELETE FROM photo_references');
          this.save(next);
        });
        this.refreshRunConnections(next.lab.runId);
      }
      else if (next !== before) this.save(next);
      this.broadcast();
      ws.send(JSON.stringify({ type: 'ack', requestId: data.requestId }));
    } catch (error) {
      try { ws.send(JSON.stringify({ type: 'error', requestId: data?.requestId, code: error.code, message: error.message || '처리하지 못했습니다. 다시 시도해 주세요.' })); } catch {}
    }
  }

  webSocketClose() { this.broadcast(); }
  webSocketError() { this.broadcast(); }
}
