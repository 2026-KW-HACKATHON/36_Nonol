import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const base = new URL(process.env.ROOM_BASE_URL || 'http://localhost:8791').origin;
const vars = process.env.ROOM_ADMIN_KEY && process.env.NONOL_BASIC_KEY ? '' : await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const key = process.env.ROOM_ADMIN_KEY || vars.match(/^ROOM_ADMIN_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
assert.ok(key, 'ROOM_ADMIN_KEY is required at runtime');
const basicKey = process.env.NONOL_BASIC_KEY || vars.match(/^NONOL_BASIC_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
assert.ok(basicKey, 'NONOL_BASIC_KEY is required at runtime');
const redact = value => String(value).split(key).join('[redacted]').split(basicKey).join('[redacted]');
const prefix = `QA directory ${crypto.randomUUID().slice(0, 8)}`;
const output = new URL('../../../.local/game-lab-browser/directory-evidence/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const contexts = [], ownedRooms = new Set(), errors = [], sockets = [];
let releaseInitialAuth;
const unavailableWebAR = `export class NpcWebAR {
  starting = false; active = false;
  async capability() { return { supported: false, state: 'unsupported', message: 'Directory QA uses the camera 2D flow.' }; }
  async start() { return false; }
  stop() { this.starting = false; this.active = false; }
}`;

async function createRoom(label) {
  const response = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ title: `${prefix} ${label}`, track: 'lab' }) });
  assert.equal(response.status, 201, 'QA room creation succeeds');
  const room = await response.json(); ownedRooms.add(room.roomId); return room;
}
async function context() {
  const value = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: 37.619, longitude: 127.059, accuracy: 3 } }); contexts.push(value);
  value.on('page', page => page.on('pageerror', error => errors.push(redact(error.message))));
  return value;
}
async function click(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, selector);
  await page.locator(selector).click();
}
const row = (page, id) => page.locator(`#room-list [data-room-id="${id}"]`);
async function filterRooms(page) {
  await page.locator('#rooms-query').fill(prefix); await page.locator('#rooms-search button').click();
  await page.waitForFunction(() => !document.querySelector('#rooms-status').textContent.includes('불러오고'));
}
async function join(room, name, enterLink = false) {
  const value = await context();
  await value.route(/\/261008_2234_npc-webar\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: unavailableWebAR }));
  await value.addInitScript(() => {
    const Native = WebSocket;
    window.WebSocket = class extends Native { constructor(...args) { super(...args); this.addEventListener('message', event => {
      if (event.data === 'pong') return;
      const data = JSON.parse(event.data); if (data.type === 'state') { window.__state = data.state; window.__self = data.selfId; }
    }); } };
  });
  const page = await value.newPage();
  if (enterLink) { await page.goto(base); await filterRooms(page); await row(page, room.roomId).locator('.room-enter').click(); }
  else await page.goto(room.inviteUrl);
  await page.locator('#nickname').fill(name); await click(page, '#join-button');
  await page.locator('#lobby').waitFor({ state: 'visible' });
  return page;
}
async function watchSocket(page, room) {
  const token = await page.evaluate(id => JSON.parse(localStorage.getItem(`nonol-room:${id}`)).token, room.roomId);
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/rooms/${room.roomId}/socket`, { headers: { Origin: base } }); sockets.push(socket);
  let deleted = false;
  const closed = new Promise(resolve => socket.once('close', code => resolve({ closed: true, code })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('QA socket state timeout')), 10000);
    socket.on('error', () => { clearTimeout(timer); reject(new Error('QA socket connection failed')); });
    socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', token })));
    socket.on('message', raw => { const data = JSON.parse(String(raw)); if (data.type === 'state') { clearTimeout(timer); resolve(); } if (data.type === 'room-deleted' && data.code === 'ROOM_DELETED') deleted = true; });
  });
  return async () => ({ ...await new Promise(resolve => { const timer = setTimeout(() => resolve({ closed: false }), 10000); closed.then(result => { clearTimeout(timer); resolve(result); }); }), deleted });
}
async function unavailableSocket(room) {
  return new Promise(resolve => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/rooms/${room.roomId}/socket`, { headers: { Origin: base } }); sockets.push(socket);
    const timer = setTimeout(() => { socket.terminate(); resolve(0); }, 5000);
    socket.once('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode); });
    socket.once('open', () => { clearTimeout(timer); socket.close(); resolve(101); });
    socket.on('error', () => {});
  });
}
async function deletedLanding(page, room) {
  await page.waitForURL(url => url.pathname === '/' && url.searchParams.has('deleted'));
  await page.locator('#home').waitFor({ state: 'visible' });
  assert.match(await page.locator('#home-notice').textContent(), /관리자가 방을 삭제/);
  assert.equal(await page.evaluate(id => localStorage.getItem(`nonol-room:${id}`), room.roomId), null, 'deleted room identity is cleared');
}
async function removeFromHome(page, room) {
  assert.ok(ownedRooms.has(room.roomId), 'only rooms created by this QA run may be deleted');
  page.once('dialog', dialog => dialog.accept());
  await row(page, room.roomId).locator('.room-delete').click();
  await row(page, room.roomId).waitFor({ state: 'detached' });
}

try {
  const doomed = await createRoom('삭제 검사'), preserved = await createRoom('보존 검사');
  const homeContext = await context(), home = await homeContext.newPage();
  let authSeen;
  const initialAuthSeen = new Promise(resolve => { authSeen = resolve; });
  const initialAuthHeld = new Promise(resolve => { releaseInitialAuth = resolve; });
  let holdFirstGet = true;
  await home.goto(base); await home.locator('#home').waitFor({ state: 'visible' });
  await filterRooms(home);
  await row(home, doomed.roomId).waitFor(); await row(home, preserved.roomId).waitFor();
  assert.equal(await home.locator('.room-delete').count(), 0, 'public list hides administrator deletion');
  assert.equal((await fetch(`${base}/api/rooms/${preserved.roomId}`, { method: 'DELETE', headers: { Origin: base } })).status, 401);

  const lobbyDoomed = await createRoom('대기실 삭제 검사');
  await click(home, '#rooms-refresh'); await row(home, lobbyDoomed.roomId).waitFor();
  await home.reload(); await filterRooms(home); await row(home, lobbyDoomed.roomId).waitFor();
  const keeper = await join(preserved, 'QA 보존 참가자', true);
  await keeper.waitForFunction(() => window.__state.leaderId === window.__self && window.__state.members.length === 1);
  const leader = await join(doomed, 'QA 삭제 팀장'), teammate = await join(doomed, 'QA 삭제 팀원'), lobby = await join(lobbyDoomed, 'QA 대기실 삭제');
  for (const page of [leader, teammate]) await click(page, '#ready-button');
  await click(leader, '#start-button');
  for (const page of [leader, teammate]) await page.waitForFunction(() => window.__state?.lab?.stage === 'map' && document.querySelector('#map-panel') && !document.querySelector('#map-panel').hidden);
  for (const target of ['photo', 'silence', 'npc']) {
    await click(leader, '#stage-next');
    for (const page of [leader, teammate]) await page.waitForFunction(target => window.__state.lab.stage === target && !document.querySelector(`#${target}-panel`).hidden, target);
  }
  const npcDestination = await leader.evaluate(() => window.__state.lab.config.destination);
  await leader.context().setGeolocation({ latitude: npcDestination.lat, longitude: npcDestination.lon, accuracy: 3 });
  await click(leader, '#gps-start');
  await leader.waitForFunction(({ lat, lon }) => window.__state.lab.positions[window.__self]?.source === 'gps' && window.__state.lab.positions[window.__self].lat === lat && window.__state.lab.positions[window.__self].lon === lon, npcDestination);
  await click(leader, '#camera-start'); await leader.waitForFunction(() => document.querySelector('#camera').srcObject?.active);
  await leader.evaluate(() => { const tracks = document.querySelector('#camera').srcObject.getTracks(); addEventListener('pagehide', () => sessionStorage.setItem('qa-directory-camera-ended', String(tracks.every(track => track.readyState === 'ended')))); });
  const stopped = await watchSocket(leader, doomed), lobbyStopped = await watchSocket(lobby, lobbyDoomed);

  const directoryResponse = await fetch(`${base}/api/rooms?limit=50&q=${encodeURIComponent(prefix)}`);
  assert.equal(directoryResponse.status, 200); assert.match(directoryResponse.headers.get('cache-control'), /no-store/);
  const metadata = await directoryResponse.json();
  assert.equal(metadata.rooms.length, 3);
  const publicFields = new Set(['id', 'title', 'track', 'phase', 'memberCount', 'stage', 'createdAt']);
  assert.ok(metadata.rooms.every(room => Object.keys(room).every(field => publicFields.has(field))), 'public metadata exposes only the room directory fields');
  const serialized = JSON.stringify(metadata);
  const privateToken = await leader.evaluate(id => JSON.parse(localStorage.getItem(`nonol-room:${id}`)).token, doomed.roomId);
  for (const privateValue of ['QA 삭제 팀장', 'QA 삭제 팀원', privateToken]) assert.equal(serialized.includes(privateValue), false, 'participant names and tokens are absent from public metadata');
  assert.equal(metadata.rooms.find(room => room.id === doomed.roomId).memberCount, 2);

  await homeContext.route(/\/api\/admin\/session$/, async route => {
    if (holdFirstGet && route.request().method() === 'GET') {
      holdFirstGet = false; const response = await route.fetch(); authSeen(); await initialAuthHeld; await route.fulfill({ response });
    } else await route.continue();
  });
  await home.reload(); await initialAuthSeen; await filterRooms(home);
  await click(home, '#admin-open');
  await home.locator('#admin-password').fill(`wrong-${crypto.randomUUID()}`); await click(home, '#admin-submit');
  await home.waitForFunction(() => document.querySelector('#admin-error').textContent.length > 0 && !document.querySelector('#admin-submit').disabled);
  assert.equal(await home.locator('#admin-password').inputValue(), '');
  assert.equal((await homeContext.request.get(`${base}/api/admin/session`)).status(), 200);
  assert.equal((await (await homeContext.request.get(`${base}/api/admin/session`)).json()).admin, false);
  await home.locator('#admin-password').fill(basicKey); await click(home, '#admin-submit');
  await home.locator('#admin-dialog').waitFor({ state: 'hidden' }); await home.locator('#admin-logout').waitFor({ state: 'visible' });
  const oldAuthCompleted = home.waitForEvent('requestfinished', { predicate: request => request.url().endsWith('/api/admin/session') && request.method() === 'GET' });
  releaseInitialAuth(); await oldAuthCompleted;
  await home.evaluate(() => new Promise(resolve => setTimeout(resolve, 10)));
  assert.equal(await home.locator('#admin-logout').isVisible(), true, 'old anonymous session response cannot override the new login');
  assert.equal((await (await homeContext.request.get(`${base}/api/admin/session`)).json()).admin, true);
  await row(home, doomed.roomId).locator('.room-delete').waitFor();
  const cookies = await homeContext.cookies(base);
  assert.ok(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict'), 'administrator session cookie is HttpOnly and SameSite Strict');
  const cookie = cookies.map(value => `${value.name}=${value.value}`).join('; ');
  assert.equal((await fetch(`${base}/api/rooms/${preserved.roomId}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await fetch(`${base}/api/rooms/${preserved.roomId}`)).status, 200);

  for (const [width, height] of [[360, 800], [390, 844]]) {
    await home.setViewportSize({ width, height });
    assert.ok(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile directory does not scroll horizontally');
    for (const room of [doomed, preserved, lobbyDoomed]) {
      const positions = await row(home, room.roomId).evaluate(row => {
        const enter = row.querySelector('.room-enter').getBoundingClientRect(), remove = row.querySelector('.room-delete').getBoundingClientRect();
        return { enter: { left: enter.left, top: enter.top, right: enter.right, bottom: enter.bottom }, remove: { left: remove.left, top: remove.top, right: remove.right, bottom: remove.bottom } };
      });
      assert.ok(positions.enter.right <= positions.remove.left || positions.remove.right <= positions.enter.left || positions.enter.bottom <= positions.remove.top || positions.remove.bottom <= positions.enter.top, 'room entry and delete controls do not overlap');
    }
    await home.screenshot({ path: new URL(`261009_0159_directory-${width}.png`, output).pathname, fullPage: true });
  }
  await removeFromHome(home, doomed);
  for (const page of [leader, teammate]) await deletedLanding(page, doomed);
  assert.equal(await leader.evaluate(() => sessionStorage.getItem('qa-directory-camera-ended')), 'true', 'active camera is stopped before deleted-room navigation');
  const socketEnd = await stopped(); assert.equal(socketEnd.deleted, true); assert.equal(socketEnd.closed, true); assert.equal(socketEnd.code, 4404);
  for (const payload of [{ name: 'QA 재입장', joinKey: crypto.randomUUID() }, { token: privateToken }]) {
    const response = await fetch(`${base}/api/rooms/${doomed.roomId}/join`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 404, 'deleted room rejects new and existing identities');
  }
  assert.equal((await fetch(`${base}/api/rooms/${doomed.roomId}`)).status, 404);
  assert.equal(await unavailableSocket(doomed), 404, 'deleted room rejects socket reconnection');
  const expiredContext = await context(), expired = await expiredContext.newPage(); await expired.goto(doomed.inviteUrl);
  await expired.waitForFunction(() => document.querySelector('#error').textContent.length > 0);
  assert.equal(await expired.locator('a.home-link[href="/"]').isVisible(), true);
  assert.equal(await expired.locator('#join-form').isVisible(), false);
  await removeFromHome(home, lobbyDoomed); await deletedLanding(lobby, lobbyDoomed);
  const lobbyEnd = await lobbyStopped(); assert.equal(lobbyEnd.deleted, true); assert.equal(lobbyEnd.closed, true); assert.equal(lobbyEnd.code, 4404);
  await row(home, preserved.roomId).waitFor(); assert.equal((await fetch(`${base}/api/rooms/${preserved.roomId}`)).status, 200);
  assert.equal(await keeper.locator('#lobby').isVisible(), true, 'deleting another room preserves the remaining participant');
  await click(home, '#admin-logout'); await home.locator('#admin-open').waitFor({ state: 'visible' });
  assert.equal((await (await homeContext.request.get(`${base}/api/admin/session`)).json()).admin, false);
  assert.equal(await home.locator('.room-delete').count(), 0);
  assert.equal((await homeContext.request.delete(`${base}/api/rooms/${preserved.roomId}`, { headers: { Origin: base } })).status(), 401);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks: ['public-room-directory','private-participant-data-absent','homepage-refresh-reload','directory-entry-first-leader','anonymous-delete-rejected','admin-login-failure-success','delayed-auth-response-isolated','admin-cookie-security','foreign-origin-delete-rejected','mobile-directory-layout','active-lab-room-deletion','camera-cleanup-on-deletion','lobby-room-deletion','deleted-room-socket-4404','deleted-room-rejoin-summary-socket-rejected','deleted-invite-home-link','unrelated-room-preserved','administrator-logout-revokes-browser-access','pageerrors-zero'] }));
} catch (error) {
  console.error(redact(error.stack || error.message)); process.exitCode = 1;
} finally {
  releaseInitialAuth?.();
  for (const socket of sockets) socket.terminate();
  if (ownedRooms.size && contexts.length) {
    try {
      const request = contexts[0].request;
      const login = await request.post(`${base}/api/admin/session`, { headers: { Origin: base }, data: { password: basicKey } });
      if (login.ok()) for (const id of ownedRooms) await request.delete(`${base}/api/rooms/${id}`, { headers: { Origin: base } });
    } catch {}
  }
  await browser.close();
}
