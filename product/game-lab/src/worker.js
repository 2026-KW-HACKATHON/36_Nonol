export { GameRoom } from './game-room.js';
export { LabDirectory } from './261009_0159_lab-directory.js';
import { secretMatches } from './261009_0159_lab-directory.js';
import { imageBytes, verifyPhoto } from './photo-verification.js';

const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
});
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const catalog = env => env.ROOMS.getByName('lab-photo-reference-catalog');
const trackCatalog = env => env.ROOMS.getByName('lab-track-catalog');
const directory = env => env.LAB_DIRECTORY.getByName('lab-directory');
const COOKIE = 'nonol_lab_admin';
const sessionToken = request => request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || null;
const cookie = (token, url) => `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 28800 : 0}${url.protocol === 'https:' ? '; Secure' : ''}`;
const keyAuthorized = (request, env) => secretMatches(request.headers.get('Authorization')?.replace(/^Bearer /, ''), env.ROOM_ADMIN_KEY);
const mutationOrigin = (request, url, hasKey = false) => request.headers.get('Origin') === url.origin || (hasKey && !request.headers.has('Origin'));
const publicRoom = summary => ({ id: summary.id, title: summary.title, track: summary.track, phase: summary.phase, memberCount: summary.memberCount, stage: summary.stage, createdAt: summary.createdAt });

async function resolvedReference(room, env, context) {
  if (!context.referenceId) return null;
  const reference = await (context.customReference ? room : catalog(env)).getReference(context.referenceId);
  if (!reference) throw new Error('기준 사진이 아직 등록되지 않았습니다. 팀장에게 확인해 주세요.');
  return reference;
}

export async function bodyOf(request, limit = 2048) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Error('입력 내용을 확인해 주세요.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('입력 내용을 확인해 주세요.');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('입력 내용이 너무 깁니다.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  const body = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('입력 내용을 확인해 주세요.');
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/map-config') {
      try {
        const store = trackCatalog(env);
        if (!['GET', 'PUT'].includes(request.method)) return json({ error: '지원하지 않는 요청입니다.' }, 405);
        if (request.method === 'PUT') {
          const hasKey = await keyAuthorized(request, env);
          if (!mutationOrigin(request, url, hasKey)) return json({ error: '같은 사이트에서 관리자 작업을 실행해 주세요.' }, 403);
          if (!hasKey && !await directory(env).session(sessionToken(request))) return json({ error: '관리자 로그인이 필요합니다.' }, 401);
          await store.saveMapKey(await bodyOf(request));
        }
        const kakaoJavascriptKey = env.KAKAO_MAPS_JAVASCRIPT_KEY || await store.getMapKey() || null;
        return json({ provider: 'kakao', kakaoJavascriptKey, configured: Boolean(kakaoJavascriptKey) });
      } catch (error) { return json({ error: error.message || '지도 설정을 확인하지 못했습니다.' }, error.status || 400); }
    }
    if (url.pathname === '/api/lab-tracks' && request.method === 'GET') {
      try { return json({ tracks: await trackCatalog(env).trackList() }); }
      catch { return json({ error: '트랙 목록을 불러오지 못했습니다.' }, 503); }
    }
    const trackMatch = url.pathname.match(/^\/api\/lab-tracks\/(kw-silence)(\/rooms)?$/);
    if (trackMatch) {
      try {
        const store = trackCatalog(env);
        const hasKey = await keyAuthorized(request, env);
        const admin = hasKey || await directory(env).session(sessionToken(request));
        if (request.method === 'GET' && !trackMatch[2]) return json({ track: await store.getTrack(trackMatch[1], admin) });
        if (!mutationOrigin(request, url, hasKey)) return json({ error: '같은 사이트에서 관리자 작업을 실행해 주세요.' }, 403);
        if (!admin) return json({ error: '관리자 로그인이 필요합니다.' }, 401);
        if (request.method === 'PUT' && !trackMatch[2]) {
          const { expectedVersion, ...configuration } = await bodyOf(request, 600000);
          const track = await store.saveTrack(configuration, expectedVersion);
          return json({ track });
        }
        if (request.method === 'POST' && trackMatch[2]) {
          const body = await bodyOf(request);
          if (Object.keys(body).some(key => !['title', 'expectedVersion'].includes(key))) return json({ error: '방 이름과 트랙 버전을 확인해 주세요.' }, 400);
          if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) return json({ error: '확인한 트랙 버전을 다시 불러와 주세요.' }, 400);
          const configuration = await store.getTrack(trackMatch[1], true);
          if (body.expectedVersion !== undefined && body.expectedVersion !== configuration.version) return json({ error: '다른 관리자가 트랙을 변경했습니다. 최신 설정을 확인한 뒤 방을 만들어 주세요.' }, 409);
          const title = typeof body.title === 'string' ? body.title.trim() : `${configuration.title} v${configuration.version}`;
          if (!title || title.length > 80) return json({ error: '방 이름은 1자부터 80자로 입력해 주세요.' }, 400);
          const roomId = crypto.randomUUID(), room = env.ROOMS.getByName(roomId);
          const summary = await room.createTrackRoom(roomId, title, configuration);
          try { await directory(env).register(summary); }
          catch { await room.deleteRoom(); throw new Error('방을 등록하지 못했습니다. 다시 시도해 주세요.'); }
          return json({ roomId, inviteUrl: `${url.origin}/?room=${roomId}`, trackId: configuration.id, trackVersion: configuration.version }, 201);
        }
        return json({ error: '지원하지 않는 요청입니다.' }, 405);
      } catch (error) { return json({ error: error.message || '트랙 설정을 처리하지 못했습니다.' }, error.status || 400); }
    }
    if (url.pathname === '/api/admin/session') {
      try {
        const store = directory(env);
        if (request.method === 'GET') return json({ admin: await store.session(sessionToken(request)) });
        if (!mutationOrigin(request, url)) return json({ error: '같은 사이트에서 관리자 작업을 실행해 주세요.' }, 403);
        if (request.method === 'DELETE') {
          await store.logout(sessionToken(request));
          const response = json({ admin: false }); response.headers.set('Set-Cookie', cookie(null, url)); return response;
        }
        if (request.method === 'POST') {
          if (!env.NONOL_BASIC_KEY) return json({ error: '관리자 로그인 설정이 필요합니다.' }, 503);
          const body = await bodyOf(request);
          if (typeof body.password !== 'string' || !body.password || body.password.length > 512) return json({ error: '관리자 비밀번호를 입력해 주세요.' }, 400);
          const result = await store.login(body.password, request.headers.get('CF-Connecting-IP') || 'local');
          if (result.status !== 200) {
            const response = json({ admin: false, error: result.status === 429 ? '로그인 시도가 많습니다. 잠시 뒤 다시 시도해 주세요.' : '관리자 비밀번호를 확인해 주세요.' }, result.status);
            if (result.retryAfter) response.headers.set('Retry-After', String(result.retryAfter));
            return response;
          }
          const response = json({ admin: true }); response.headers.set('Set-Cookie', cookie(result.token, url)); return response;
        }
        return json({ error: '지원하지 않는 요청입니다.' }, 405);
      } catch { return json({ error: '관리자 로그인을 처리하지 못했습니다.' }, 400); }
    }
    if (url.pathname === '/api/admin/rooms/import' && request.method === 'POST') {
      try {
        const hasKey = await keyAuthorized(request, env);
        if (!mutationOrigin(request, url, hasKey)) return json({ error: '같은 사이트에서 관리자 작업을 실행해 주세요.' }, 403);
        if (!hasKey && !await directory(env).session(sessionToken(request))) return json({ error: '관리자 로그인이 필요합니다.' }, 401);
        const body = await bodyOf(request, 10000);
        const roomIds = body.roomIds ?? [], objectIds = body.objectIds ?? [];
        if (!Array.isArray(roomIds) || !Array.isArray(objectIds) || roomIds.length + objectIds.length < 1 || roomIds.length + objectIds.length > 20 || roomIds.some(id => typeof id !== 'string' || !ROOM_ID.test(id)) || objectIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) return json({ error: '한 번에 방 또는 객체 ID를 1개부터 20개까지 등록해 주세요.' }, 400);
        const summaries = await Promise.allSettled([
          ...roomIds.map(id => Promise.resolve().then(() => env.ROOMS.getByName(id).summary())),
          ...objectIds.map(id => Promise.resolve().then(() => env.ROOMS.get(env.ROOMS.idFromString(id)).summary()))
        ]);
        const valid = summaries.filter(result => result.status === 'fulfilled' && result.value && ROOM_ID.test(result.value.id)).map(result => result.value);
        const imported = await directory(env).registerMany(valid);
        return json({ imported, skipped: summaries.length - valid.length, failed: summaries.filter(result => result.status === 'rejected').length });
      } catch { return json({ error: '기존 방 목록을 등록하지 못했습니다.' }, 400); }
    }
    if (url.pathname === '/api/groups' && request.method === 'POST') {
      try {
        const hasKey = await keyAuthorized(request, env);
        if (!mutationOrigin(request, url, hasKey)) return json({ error: '같은 사이트에서 관리자 작업을 실행해 주세요.' }, 403);
        if (!hasKey && !await directory(env).session(sessionToken(request))) return json({ error: '관리자 로그인이 필요합니다.' }, 401);
        const body = await bodyOf(request, 16384);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title || title.length > 80) return json({ error: '그룹 이름은 1자에서 80자로 입력해 주세요.' }, 400);
        const roomId = crypto.randomUUID(), room = env.ROOMS.getByName(roomId);
        const people = await room.createRegistered(roomId, title, body);
        try { await directory(env).register(await room.summary()); }
        catch { await room.deleteRoom(); throw new Error('그룹을 등록하지 못했습니다. 다시 시도해 주세요.'); }
        const inviteUrl = `${url.origin}/?room=${roomId}`;
        return json({ roomId, inviteUrl, boardUrl: `${url.origin}/board?board=icheungjip-lab`, participants: people.map(person => ({ id: person.id, name: person.name, inviteUrl: `${inviteUrl}#invite=${person.invite}` })) }, 201);
      } catch (error) { return json({ error: error.message || '신청 그룹을 만들지 못했습니다.' }, error.status || 400); }
    }
    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      try {
        const limitText = url.searchParams.get('limit');
        const limit = limitText === null ? 25 : Number(limitText);
        const query = url.searchParams.get('q') || '';
        if (!Number.isInteger(limit) || limit < 1 || limit > 50 || query.length > 80) return json({ error: '목록 조회 조건을 확인해 주세요.' }, 400);
        const page = await directory(env).list(limit, url.searchParams.get('cursor'), query);
        const live = await Promise.allSettled(page.rooms.map(item => Promise.resolve().then(() => env.ROOMS.getByName(item.id).summary())));
        return json({ ...page, rooms: page.rooms.flatMap((item, index) => live[index].status === 'rejected' ? [item] : live[index].value ? [publicRoom(live[index].value)] : []) });
      } catch (error) { return json({ error: '방 목록을 불러오지 못했습니다.' }, error.status || 503); }
    }
    const referenceMatch = url.pathname.match(/^\/api\/photo-references\/([^/]+)$/);
    if (referenceMatch && request.method === 'POST') {
      if (!env.ROOM_ADMIN_KEY) return json({ error: '기준 사진 등록 설정이 필요합니다.' }, 503);
      if (!await keyAuthorized(request, env)) return json({ error: '기준 사진 등록 권한이 없습니다.' }, 401);
      if (!mutationOrigin(request, url, true)) return json({ error: '같은 사이트에서 관리자 작업을 실행해 주세요.' }, 403);
      if (!REFERENCE_ID.test(referenceMatch[1])) return json({ error: '기준 사진 ID를 확인해 주세요.' }, 400);
      try {
        const body = await bodyOf(request, 600000);
        const reference = await catalog(env).putReference(referenceMatch[1], body.image, body.label, true);
        return json({ reference: { id: reference.id, label: reference.label, updatedAt: reference.updatedAt } }, 201);
      } catch (error) { return json({ error: error.message || '기준 사진을 등록하지 못했습니다.' }, error.status || 400); }
    }
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      if (!env.ROOM_ADMIN_KEY) return json({ error: '방 생성 설정이 필요합니다.' }, 503);
      if (!await keyAuthorized(request, env)) return json({ error: '방 생성 권한이 없습니다.' }, 401);
      if (!mutationOrigin(request, url, true)) return json({ error: '같은 사이트에서 관리자 작업을 실행해 주세요.' }, 403);
      try {
        const body = await bodyOf(request);
        const title = String(body.title ?? '묵언수행').trim();
        if (!title || title.length > 80) return json({ error: '방 이름은 1자에서 80자로 입력해 주세요.' }, 400);
        const roomId = crypto.randomUUID();
        const track = body.track ?? 'lab';
        if (!['standard', 'lab'].includes(track)) return json({ error: '트랙 종류를 확인해 주세요.' }, 400);
        const room = env.ROOMS.getByName(roomId);
        await room.create(roomId, title, track);
        await directory(env).register(await room.summary());
        return json({ roomId, inviteUrl: `${url.origin}/?room=${roomId}` }, 201);
      } catch { return json({ error: '방을 만들지 못했습니다. 다시 시도해 주세요.' }, 400); }
    }
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|socket|photo|reference|invite|board))?$/);
    if (!match || !ROOM_ID.test(match[1])) return json({ error: '초대 링크를 확인해 주세요.' }, 404);
    const room = env.ROOMS.getByName(match[1]);
    if (match[2] === 'invite' && request.method === 'POST') {
      if (!mutationOrigin(request, url)) return json({ error: '개인 링크를 같은 브라우저에서 열어 주세요.' }, 403);
      try { const body = await bodyOf(request); return json(await room.inviteContext(body.invite)); }
      catch (error) { return json({ error: error.message || '개인 링크를 확인해 주세요.', code: error.code }, error.status || 400); }
    }
    if (match[2] === 'board' && request.method === 'POST') {
      if (!mutationOrigin(request, url)) return json({ error: '노놀판을 같은 브라우저에서 열어 주세요.' }, 403);
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!token || !ROOM_ID.test(token)) return json({ error: '개인 링크로 먼저 입장해 주세요.' }, 401);
      try { const body = await bodyOf(request); return json(await room.recordBoard(token, body.boardId, body.generationId)); }
      catch (error) { return json({ error: error.message || '노놀판 기록을 확인해 주세요.', code: error.code }, error.status || 400); }
    }
    if (!match[2] && request.method === 'DELETE') {
      try {
        const hasKey = await keyAuthorized(request, env);
        if (!mutationOrigin(request, url, hasKey)) return json({ error: '같은 사이트에서 관리자 작업을 실행해 주세요.' }, 403);
        if (!hasKey && !await directory(env).session(sessionToken(request))) return json({ error: '관리자 로그인이 필요합니다.' }, 401);
        await room.deleteRoom();
        await directory(env).remove(match[1]);
        return json({ deleted: true, roomId: match[1] });
      } catch { return json({ error: '방을 삭제하지 못했습니다. 다시 시도해 주세요.' }, 503); }
    }
    if (match[2] === 'reference' && ['GET', 'POST'].includes(request.method)) {
      if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) return json({ error: '게임 페이지에서 등록해 주세요.' }, 403);
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!token || !ROOM_ID.test(token)) return json({ error: '입장 정보를 확인해 주세요.' }, 401);
      try {
        if (request.method === 'POST') {
          const body = await bodyOf(request, 600000);
          return json({ reference: await room.setReference(token, body.image, body.label, body.runId) });
        }
        const context = await room.referenceContext(token);
        return json({ reference: await resolvedReference(room, env, context) });
      } catch (error) { return json({ error: error.message || '기준 사진을 확인하지 못했습니다.', code: error.code }, error.status || 400); }
    }
    if (match[2] === 'photo' && request.method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) return json({ error: '게임 페이지에서 인증해 주세요.' }, 403);
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!token || !ROOM_ID.test(token)) return json({ error: '입장 정보를 확인해 주세요.' }, 401);
      let context;
      try {
        const body = await bodyOf(request, 600000);
        imageBytes(body.image);
        context = await room.photoContext(token, body.runId);
        const reference = await resolvedReference(room, env, context);
        const evidence = await verifyPhoto(env.AI, body.image, context.target, reference);
        await room.recordPhoto(context.actorId, body.runId, context.jobId, evidence);
        return json(evidence);
      } catch (error) { return json({ error: error.message || '사진을 판정하지 못했습니다. 다시 시도해 주세요.' }, 400); }
      finally { if (context) await room.finishPhoto(context.actorId, context.jobId); }
    }
    if (match[2] === 'socket' && request.method === 'GET') {
      if (request.headers.get('Origin') !== url.origin) return json({ error: '게임 페이지에서 연결해 주세요.' }, 403);
      return room.fetch(request);
    }
    if (match[2] === 'join' && request.method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) return json({ error: '게임 페이지에서 입장해 주세요.' }, 403);
      try {
        const body = await bodyOf(request);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const token = typeof body.token === 'string' ? body.token : null;
        const joinKey = typeof body.joinKey === 'string' ? body.joinKey : null;
        const expectedGeneration = body.expectedGeneration;
        if (expectedGeneration !== undefined && (typeof expectedGeneration !== 'string' || !ROOM_ID.test(expectedGeneration))) return json({ error: '방 정보를 새로 확인해 주세요.' }, 400);
        if (body.invite !== undefined) {
          const result = await room.joinPersonal(body.invite, expectedGeneration);
          return json(result, result.status || 200);
        }
        if ((!token && (!name || name.length > 24 || !joinKey || !ROOM_ID.test(joinKey))) || (token && !ROOM_ID.test(token))) return json({ error: '입장 정보와 닉네임을 확인해 주세요.' }, 400);
        const result = await room.join(name, token, joinKey, expectedGeneration);
        return json(result, result.status || 200);
      } catch (error) { return json({ error: error.message || '입장하지 못했습니다. 다시 시도해 주세요.', code: error.code }, error.status || 400); }
    }
    if (!match[2] && request.method === 'GET') {
      const summary = await room.summary();
      if (summary) { try { await directory(env).register(summary); } catch {} return json(summary); }
      return await room.deleted() ? json({ error: '관리자가 삭제한 방입니다. 홈에서 다른 방을 선택해 주세요.', code: 'ROOM_DELETED' }, 404) : json({ error: '초대 링크를 확인해 주세요.' }, 404);
    }
    return json({ error: '지원하지 않는 요청입니다.' }, 405);
  }
};
