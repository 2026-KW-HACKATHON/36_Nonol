import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = new URL(process.env.ROOM_BASE_URL || 'http://localhost:8791').origin;
const vars = process.env.ROOM_ADMIN_KEY && process.env.NONOL_BASIC_KEY ? '' : await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const key = process.env.ROOM_ADMIN_KEY || vars.match(/^ROOM_ADMIN_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
const basicKey = process.env.NONOL_BASIC_KEY || vars.match(/^NONOL_BASIC_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
assert.ok(key && basicKey, 'Runtime administrator credentials are required');
const secrets = new Set([key, basicKey]);
const redact = value => [...secrets].reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
const prefix = `QA registration ${crypto.randomUUID().slice(0, 8)}`;
const names = ['QA 신청자 하나', 'QA 신청자 둘', 'QA 신청자 셋'];
const output = new URL('../../../.local/game-lab-browser/registration-evidence/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const contexts = [], rooms = new Set(), pageErrors = [], checks = [];
let releaseHeldJoin;

async function api(path, method = 'GET', body, headers = {}) {
  return fetch(`${base}${path}`, { method, headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function context() {
  const value = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 } });
  contexts.push(value);
  value.on('page', page => page.on('pageerror', error => pageErrors.push(redact(error.message))));
  await value.addInitScript(() => {
    const Native = WebSocket;
    window.WebSocket = class extends Native { constructor(...args) { super(...args); this.addEventListener('message', event => {
      if (event.data === 'pong') return;
      const data = JSON.parse(event.data); if (data.type === 'state') { window.__state = data.state; window.__self = data.selfId; }
    }); } };
  });
  return value;
}
async function click(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, selector);
  await page.locator(selector).click();
}
async function identity(page, roomId) {
  const value = await page.evaluate(id => JSON.parse(localStorage.getItem(`nonol-room:${id}`)), roomId);
  if (value?.token) secrets.add(value.token);
  return value;
}
async function joinPersonal(link, name) {
  const value = await context(), page = await value.newPage(); await page.goto(link);
  await page.locator('#join-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#nickname').inputValue(), name);
  assert.equal(await page.locator('#nickname').evaluate(input => input.readOnly), true);
  await click(page, '#join-button'); await page.locator('#lobby').waitFor({ state: 'visible' });
  return { value, page };
}
async function board(value, boardUrl, name) {
  const page = await value.newPage(); await page.goto(boardUrl);
  await page.locator('#board-person').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#board-name').textContent()).trim(), `${name}님`);
  return page;
}
async function tag(page) {
  const response = page.waitForResponse(response => response.url().endsWith('/board') && response.request().method() === 'POST');
  await click(page, '#board-submit'); const result = await response; assert.equal(result.status(), 200);
  await page.locator('#board-result').waitFor({ state: 'visible' }); return result.json();
}
async function state(page, count) {
  await page.waitForFunction(count => window.__state?.registration?.taggedCount === count, count);
}
async function mobile(page, label, masks = []) {
  for (const [width, height] of [[360, 800], [390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} fits the mobile viewport`);
    const controls = await page.locator('button:visible, a.button:visible').evaluateAll(items => items.map(item => {
      const rect = item.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    for (let index = 0; index < controls.length; index++) for (let other = index + 1; other < controls.length; other++) {
      const a = controls[index], b = controls[other];
      assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${label} controls do not overlap`);
    }
    await page.screenshot({ path: new URL(`261009_0320_${label}-${width}.png`, output).pathname, fullPage: true, mask: masks.map(selector => page.locator(selector)) });
  }
}

try {
  const administrator = await context(), home = await administrator.newPage(); await home.goto(base);
  await click(home, '#admin-open'); await home.locator('#admin-password').fill(basicKey); await click(home, '#admin-submit');
  await home.locator('#admin-logout').waitFor({ state: 'visible' });
  const groupPage = await administrator.newPage(); await groupPage.goto(`${base}/groups`); await groupPage.locator('#groups-form').waitFor({ state: 'visible' });
  await groupPage.locator('#groups-title').fill(prefix); await groupPage.locator('#groups-date').fill('2026-10-09'); await groupPage.locator('#groups-time').fill('19:30');
  await groupPage.locator('#groups-names').fill(names[0]); await click(groupPage, '#groups-create');
  assert.match(await groupPage.locator('#groups-error').textContent(), /2명 이상/);
  await groupPage.locator('#groups-names').fill(names.join('\n'));
  const created = groupPage.waitForResponse(response => response.url().endsWith('/api/groups') && response.request().method() === 'POST');
  await click(groupPage, '#groups-create'); const createdResponse = await created; assert.equal(createdResponse.status(), 201);
  const group = await createdResponse.json(); rooms.add(group.roomId);
  const invites = group.participants.map(person => { const invite = new URLSearchParams(new URL(person.inviteUrl).hash.slice(1)).get('invite'); secrets.add(invite); return invite; });
  await groupPage.locator('#groups-result').waitFor({ state: 'visible' });
  const links = await groupPage.locator('#groups-participants input').evaluateAll(inputs => inputs.map(input => input.value));
  assert.deepEqual(links, group.participants.map(person => person.inviteUrl)); assert.equal(new Set(invites).size, 3);
  assert.equal(await groupPage.locator('#groups-board-link input').inputValue(), group.boardUrl);
  assert.equal(await groupPage.locator('#groups-room-link input').inputValue(), group.inviteUrl);
  checks.push('administrator-ui-group-create-and-personal-links');
  await mobile(groupPage, 'groups', ['#groups-participants input']);

  const anonymous = await context(), anonymousPage = await anonymous.newPage(); await anonymousPage.goto(`${base}/groups`);
  await anonymousPage.locator('#groups-login').waitFor({ state: 'visible' }); assert.equal(await anonymousPage.locator('#groups-form').isVisible(), false);
  await anonymousPage.goto(group.inviteUrl); await anonymousPage.waitForFunction(() => document.querySelector('#entry-note').textContent.includes('개인 링크'));
  assert.equal(await anonymousPage.locator('#join-form').isVisible(), false);
  assert.equal((await api(`/api/rooms/${group.roomId}/join`, 'POST', { name: '임의 가입', joinKey: crypto.randomUUID() })).status, 403);
  checks.push('registered-room-requires-personal-link');
  const summary = await (await api(`/api/rooms/${group.roomId}`)).json(), metadata = await (await api(`/api/rooms?q=${encodeURIComponent(prefix)}`)).json();
  assert.equal(summary.registrationRequired, true);
  for (const payload of [summary, metadata]) for (const value of [...names, ...invites]) assert.equal(JSON.stringify(payload).includes(value), false);
  checks.push('public-metadata-excludes-registration-data');

  const leader = await joinPersonal(links[1], names[1]), member = await joinPersonal(links[0], names[0]);
  await leader.page.waitForFunction(() => window.__state.members.length === 2 && window.__state.leaderId === window.__self);
  const leaderIdentity = await identity(leader.page, group.roomId); await identity(member.page, group.roomId);
  assert.equal(await leader.page.evaluate(() => location.hash), '');
  assert.equal(await member.page.locator('#start-button').isVisible(), false);
  assert.equal(await leader.page.locator('#registration-people li').count(), 3);
  for (const person of [leader, member]) await click(person.page, '#ready-button');
  await leader.page.waitForFunction(() => window.__state.members.every(member => member.ready));
  assert.equal(await leader.page.locator('#start-button').isDisabled(), true);
  checks.push('first-personal-entry-leader-and-all-applicants-start-gate');

  const memberBoard = await board(member.value, group.boardUrl, names[0]);
  await state(leader.page, 0); assert.equal(await memberBoard.locator('#board-result').isVisible(), false);
  const firstTag = await tag(memberBoard); assert.equal(firstTag.registration.taggedCount, 1); assert.equal(firstTag.duplicate, false); await state(leader.page, 1);
  const repeated = await tag(memberBoard); assert.equal(repeated.registration.taggedCount, 1); assert.equal(repeated.duplicate, true);
  const leaderBoard = await board(leader.value, group.boardUrl, names[1]); await tag(leaderBoard); await state(leader.page, 2);
  assert.equal(await leader.page.locator('#start-button').isDisabled(), true);
  checks.push('explicit-personal-tag-and-idempotent-repeat');

  const thirdContext = await context(), thirdBoard = await thirdContext.newPage(); await thirdBoard.goto(group.boardUrl);
  await thirdBoard.locator('#board-link-form').waitFor({ state: 'visible' }); assert.equal(await thirdBoard.locator('#board-submit').isDisabled(), true);
  await thirdBoard.locator('#board-invite').fill(links[2]); await click(thirdBoard, '#board-join');
  await thirdBoard.locator('#board-person').waitFor({ state: 'visible' }); assert.equal((await thirdBoard.locator('#board-name').textContent()).trim(), `${names[2]}님`);
  assert.equal(await thirdBoard.locator('#board-invite').inputValue(), ''); await state(leader.page, 2);
  assert.equal(await thirdBoard.evaluate(() => JSON.stringify({ ...localStorage })).then(value => invites.some(invite => value.includes(invite))), false);
  const thirdTag = await tag(thirdBoard); assert.equal(thirdTag.registration.allTagged, true); await state(leader.page, 3);
  assert.equal(await leader.page.locator('#start-button').isDisabled(), true);
  await click(thirdBoard, '#board-lobby'); await thirdBoard.locator('#lobby').waitFor({ state: 'visible' }); await identity(thirdBoard, group.roomId);
  assert.equal(await thirdBoard.locator('#start-button').isVisible(), false);
  checks.push('new-browser-personal-link-recovery-and-ready-gate');

  const swapContext = await context(), swapBoard = await swapContext.newPage(); await swapBoard.goto(group.boardUrl);
  await swapBoard.locator('#board-link-form').waitFor({ state: 'visible' }); await swapBoard.locator('#board-invite').fill(links[0]); await click(swapBoard, '#board-join'); await tag(swapBoard);
  await click(swapBoard, '#board-change'); await swapBoard.locator('#board-invite').fill(links[1]); await click(swapBoard, '#board-join');
  await swapBoard.waitForFunction(name => document.querySelector('#board-name').textContent === `${name}님`, names[1]);
  assert.equal(await swapBoard.locator('#board-result').isVisible(), false, 'changing the person clears the previous tag result');
  assert.equal(await swapBoard.locator('#board-lobby').isVisible(), false);
  assert.equal(await swapBoard.evaluate(id => sessionStorage.getItem(`nonol-personal-invite:${id}`), group.roomId), invites[1]);
  await tag(swapBoard); await click(swapBoard, '#board-lobby'); await swapBoard.locator('#lobby').waitFor({ state: 'visible' });
  assert.equal((await identity(swapBoard, group.roomId)).participantId, leaderIdentity.participantId);
  assert.equal(await leader.page.evaluate(() => window.__state.members.length), 3);
  checks.push('changing-person-clears-old-result-and-preserves-selected-identity');

  const raceContext = await context(), racePage = await raceContext.newPage();
  let joinSeen; const heldSeen = new Promise(resolve => { joinSeen = resolve; }), held = new Promise(resolve => { releaseHeldJoin = resolve; });
  await raceContext.route(new RegExp(`/api/rooms/${group.roomId}/join$`), async route => {
    const response = await route.fetch(); joinSeen(); await held; await route.fulfill({ response });
  });
  await racePage.goto(links[0]); await racePage.locator('#join-form').waitFor({ state: 'visible' }); await click(racePage, '#join-button'); await heldSeen;
  await racePage.evaluate(({ id, identity }) => { localStorage.setItem(`nonol-room:${id}`, JSON.stringify(identity)); localStorage.setItem('nonol-registered-room', JSON.stringify({ roomId: id, ...identity })); }, { id: group.roomId, identity: leaderIdentity });
  releaseHeldJoin(); await racePage.waitForFunction(() => document.querySelector('#error').textContent.includes('다른 탭'));
  assert.equal((await identity(racePage, group.roomId)).participantId, leaderIdentity.participantId);
  checks.push('late-personal-join-cannot-overwrite-new-local-identity');

  await mobile(leaderBoard, 'board'); await mobile(leader.page, 'registered-lobby');
  await click(thirdBoard, '#ready-button'); await leader.page.waitForFunction(() => window.__state.members.every(member => member.ready));
  await click(leader.page, '#start-button');
  for (const page of [leader.page, member.page, thirdBoard]) { await page.waitForURL(url => url.pathname === '/lab'); await page.locator('#map-panel').waitFor({ state: 'visible' }); }
  checks.push('all-ready-leader-start-shared-map');
  const oldToken = leaderIdentity.token, oldRun = summary.generationId;
  leader.page.once('dialog', dialog => dialog.accept()); await click(leader.page, '#reset');
  for (const [page, name] of [[leader.page, names[1]], [member.page, names[0]], [thirdBoard, names[2]]]) {
    await page.waitForURL(url => url.pathname === '/'); await page.locator('#join-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#nickname').inputValue(), name); assert.equal(await page.locator('#nickname').evaluate(input => input.readOnly), true);
  }
  assert.equal((await api(`/api/rooms/${group.roomId}/join`, 'POST', { token: oldToken })).status, 401);
  assert.equal((await api(`/api/rooms/${group.roomId}/join`, 'POST', { invite: invites[0], expectedGeneration: oldRun })).status, 409);
  assert.equal((await api(`/api/rooms/${group.roomId}/join`, 'POST', { invite: invites[0] })).status, 409);
  await click(thirdBoard, '#join-button'); await thirdBoard.locator('#lobby').waitFor({ state: 'visible' });
  await thirdBoard.waitForFunction(() => window.__state.leaderId === window.__self && window.__state.members.length === 1);
  assert.equal(await thirdBoard.evaluate(() => window.__state.registration.taggedCount), 0);
  assert.equal(await thirdBoard.locator('#registration-people li').count(), 3);
  assert.equal(await thirdBoard.locator('#start-button').isDisabled(), true);
  for (const page of [leader.page, member.page]) { await click(page, '#join-button'); await page.locator('#lobby').waitFor({ state: 'visible' }); }
  await thirdBoard.waitForFunction(() => window.__state.members.length === 3 && window.__state.members.every(member => !member.ready));
  checks.push('full-reset-keeps-personal-links-and-clears-tags-identities-ready');

  assert.ok(rooms.has(group.roomId)); assert.equal((await api(`/api/rooms/${group.roomId}`, 'DELETE', undefined, { Authorization: `Bearer ${key}` })).status, 200); rooms.delete(group.roomId);
  for (const page of [leader.page, member.page, thirdBoard]) await page.waitForURL(url => url.pathname === '/' && url.searchParams.has('deleted'));
  assert.equal((await api(`/api/rooms/${group.roomId}/invite`, 'POST', { invite: invites[0] })).status, 404);
  assert.equal((await api(`/api/rooms/${group.roomId}/join`, 'POST', { invite: invites[0] })).status, 404);
  checks.push('registered-room-deletion-expires-personal-links');

  const legacyResponse = await api('/api/rooms', 'POST', { title: `${prefix} legacy`, track: 'lab' }, { Authorization: `Bearer ${key}` }); assert.equal(legacyResponse.status, 201);
  const legacy = await legacyResponse.json(); rooms.add(legacy.roomId);
  const legacyContext = await context(), legacyPage = await legacyContext.newPage(); await legacyPage.goto(legacy.inviteUrl);
  await legacyPage.locator('#join-form').waitFor({ state: 'visible' }); assert.equal(await legacyPage.locator('#nickname').evaluate(input => input.readOnly), false);
  await legacyPage.locator('#nickname').fill('QA 일반 참가자'); await click(legacyPage, '#join-button'); await legacyPage.locator('#lobby').waitFor({ state: 'visible' });
  assert.equal(await legacyPage.locator('#registration-panel').isVisible(), false);
  await click(legacyPage, '#ready-button'); await click(legacyPage, '#start-button'); await legacyPage.waitForURL(url => url.pathname === '/lab');
  checks.push('legacy-room-nickname-and-solo-start-remain');
  await home.bringToFront(); await click(home, '#admin-logout'); await home.locator('#admin-open').waitFor({ state: 'visible' });
  await groupPage.reload(); await groupPage.locator('#groups-login').waitFor({ state: 'visible' }); checks.push('logout-revokes-group-administration');
  assert.deepEqual(pageErrors, []); checks.push('mobile-360-390-controls-and-zero-pageerrors');
  console.log(JSON.stringify({ status: 'passed', checks, screenshotDirectory: output.pathname }));
} catch (error) {
  console.error(redact(error.stack || error.message)); process.exitCode = 1;
} finally {
  releaseHeldJoin?.();
  for (const roomId of rooms) {
    try { await api(`/api/rooms/${roomId}`, 'DELETE', undefined, { Authorization: `Bearer ${key}` }); } catch { console.error('QA room cleanup request failed'); }
  }
  for (const value of contexts) await value.close().catch(() => {});
  await browser.close();
}
