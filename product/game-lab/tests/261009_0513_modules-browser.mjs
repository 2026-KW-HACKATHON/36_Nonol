import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = new URL(process.env.ROOM_BASE_URL || 'http://localhost:8791').origin;
const vars = process.env.ROOM_ADMIN_KEY ? '' : await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const key = process.env.ROOM_ADMIN_KEY || vars.match(/^ROOM_ADMIN_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
assert.ok(key, 'A runtime room administration credential is required');
const secrets = new Set([key]);
const redact = value => [...secrets].reduce((result, secret) => result.split(secret).join('[redacted]'), String(value));
const output = new URL('../../../.local/game-lab-browser/modules-evidence/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const contexts = [], rooms = new Set(), pageErrors = [], checks = [];
const stages = ['map', 'photo', 'silence', 'npc', 'ar-route', 'finder', 'ending'];

async function api(path, method = 'GET', body, token) {
  return fetch(`${base}${path}`, {
    method, headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

async function createRoom(label) {
  const response = await api('/api/rooms', 'POST', { title: `QA modules ${label} ${crypto.randomUUID().slice(0, 8)}`, track: 'lab' }, key);
  assert.equal(response.status, 201);
  const room = await response.json(); rooms.add(room.roomId); return room;
}

async function makeContext() {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: 37.619, longitude: 127.059, accuracy: 3 } });
  contexts.push(context);
  context.on('page', page => page.on('pageerror', error => pageErrors.push(redact(error.message))));
  await context.addInitScript(() => {
    const Native = WebSocket;
    let leaflet;
    window.__qaLeafletMaps = new Map();
    Object.defineProperty(window, 'L', { configurable: true, get: () => leaflet, set: value => {
      leaflet = value;
      const nativeMap = value.map;
      value.map = (...args) => {
        const map = nativeMap(...args), container = typeof args[0] === 'string' ? document.getElementById(args[0]) : args[0];
        window.__qaLeafletMaps.set(container.id, map); return map;
      };
    } });
    const geolocation = navigator.geolocation, watchPosition = geolocation.watchPosition.bind(geolocation);
    window.__qaGPSWatches = 0;
    geolocation.watchPosition = (...args) => { window.__qaGPSWatches++; return watchPosition(...args); };
    window.__qaMessages = []; window.__qaConfigurations = [];
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); window.__qaSocket = this;
        this.addEventListener('message', event => {
          if (event.data === 'pong') return;
          const message = JSON.parse(event.data); window.__qaMessages.push(message);
          if (message.type === 'state') { window.__qaState = message.state; window.__qaSelf = message.selfId; }
        });
      }
      send(value) {
        if (value === 'ping') return super.send(value);
        const message = JSON.parse(value);
        if (message.type === 'lab:configure-module') window.__qaConfigurations.push(structuredClone(message.config));
        return super.send(value);
      }
    };
  });
  return context;
}

async function click(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, selector);
  await page.locator(selector).click();
}

async function join(room, name) {
  const context = await makeContext(), page = await context.newPage(); await page.goto(room.inviteUrl);
  await page.locator('#join-form').waitFor({ state: 'visible' }); await page.locator('#nickname').fill(name); await click(page, '#join-button');
  await page.locator('#lobby').waitFor({ state: 'visible' });
  const identity = await page.evaluate(id => JSON.parse(localStorage.getItem(`nonol-room:${id}`)), room.roomId);
  secrets.add(identity.token);
  return { context, page, identity };
}

async function snapshot(page) { return page.evaluate(() => structuredClone(window.__qaState)); }

async function stage(pages, expected) {
  await Promise.all(pages.map(page => page.waitForFunction(expected => window.__qaState?.lab?.stage === expected, expected)));
  for (const page of pages) await page.locator(`#${expected}-panel`).waitFor({ state: 'visible' });
}

async function select(leader, pages, target) {
  const before = await snapshot(leader);
  await click(leader, `#steps button[data-stage="${target}"]`); await stage(pages, target);
  if (before.lab.stage !== target) await Promise.all(pages.map(page => page.waitForFunction(runId => window.__qaState.lab.runId !== runId, before.lab.runId)));
}

async function action(page, payload, envelope = {}) {
  const requestId = crypto.randomUUID();
  await page.evaluate(({ payload, envelope, requestId }) => {
    const lab = window.__qaState.lab;
    window.__qaSocket.send(JSON.stringify({ runId: lab.runId, stage: lab.stage, ...payload, ...envelope, requestId }));
  }, { payload, envelope, requestId });
  await page.waitForFunction(id => window.__qaMessages.some(message => message.requestId === id && ['ack', 'error'].includes(message.type)), requestId);
  return page.evaluate(id => window.__qaMessages.find(message => message.requestId === id && ['ack', 'error'].includes(message.type)), requestId);
}

async function configure(page, pages, fields) {
  await page.locator('#module-settings-editor').evaluate(details => { details.open = true; });
  for (const [selector, value] of Object.entries(fields)) await page.locator(selector).fill(String(value));
  const runId = (await snapshot(page)).lab.runId;
  await click(page, '#module-config-save');
  await Promise.all(pages.map(page => page.waitForFunction(previous => window.__qaState.lab.runId !== previous, runId)));
  return page.evaluate(() => window.__qaConfigurations.at(-1));
}

async function mapPoint(page, id, position = { x: 100, y: 150 }) {
  await page.waitForFunction(id => {
    const map = window.__qaLeafletMaps.get(id), container = document.getElementById(id);
    return map && container.dataset.mapProvider === 'leaflet' && container.contains(map.getPane('mapPane'));
  }, id);
  await page.locator(`#${id}`).scrollIntoViewIfNeeded();
  await page.evaluate(id => {
    window.__qaMapClick = null;
    window.__qaLeafletMaps.get(id).once('click', event => { window.__qaMapClick = { lat: event.latlng.lat, lon: event.latlng.lng }; });
  }, id);
  await page.locator(`#${id}`).click({ position });
  await page.waitForFunction(() => Boolean(window.__qaMapClick));
  return page.evaluate(() => structuredClone(window.__qaMapClick));
}

async function mineMarker(page, id, point) {
  await page.waitForFunction(({ id, point }) => {
    let present = false;
    window.__qaLeafletMaps.get(id)?.eachLayer(layer => {
      const coordinate = layer.getLatLng?.();
      if (coordinate?.lat === point.lat && coordinate.lng === point.lon && layer.options.radius === 9 && layer.options.fillColor === '#171b16') present = true;
    });
    return present;
  }, { id, point });
}

async function move(person, point, accuracy = 3) {
  await person.context.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy });
  if (await person.page.locator('#gps-start').isVisible()) await click(person.page, '#gps-start');
  await person.page.waitForFunction(({ point, accuracy }) => {
    const position = window.__qaState.lab.positions[window.__qaSelf];
    return position?.source === 'gps' && position.lat === point.lat && position.lon === point.lon && position.accuracy === accuracy && Date.now() - position.at < 30000;
  }, { point, accuracy });
}

async function referenceFile(page, color) {
  const data = await page.evaluate(color => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 128, 128);
    context.fillStyle = 'white'; context.fillRect(32, 24, 64, 80);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  return { name: 'qa-reference.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

async function replaceReference(leader, pages, label, color) {
  await leader.locator('#reference-editor').evaluate(details => { details.open = true; });
  await leader.locator('#reference-label').fill(label);
  await leader.locator('#reference-file').setInputFiles(await referenceFile(leader, color));
  const runId = (await snapshot(leader)).lab.runId;
  await click(leader, '#reference-save');
  await Promise.all(pages.map(page => page.waitForFunction(({ label, runId }) => window.__qaState.lab.config.photoTarget === label && window.__qaState.lab.runId !== runId, { label, runId })));
  await Promise.all(pages.map(page => page.locator('#reference-image').waitFor({ state: 'visible' })));
  await leader.waitForFunction(() => document.querySelector('#reference-status').textContent.includes('저장했습니다'));
}

async function mobile(page, label) {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} fits a ${width}px viewport`);
    const controls = await page.locator('button:visible').evaluateAll(items => items.map(item => {
      const rect = item.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    for (let index = 0; index < controls.length; index++) for (let other = index + 1; other < controls.length; other++) {
      const a = controls[index], b = controls[other];
      assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${label} visible buttons do not overlap`);
    }
    await page.screenshot({ path: new URL(`261009_0513_${label}-${width}.png`, output).pathname, fullPage: true });
  }
}

try {
  const room = await createRoom('shared'), leader = await join(room, 'QA 팀장'), member = await join(room, 'QA 팀원');
  const pages = [leader.page, member.page];
  await leader.page.waitForFunction(() => window.__qaState.members.length === 2 && window.__qaState.leaderId === window.__qaSelf);
  assert.equal(await leader.page.locator('#lab-config-editor:visible').count(), 0);
  assert.equal(await leader.page.locator('#reference-photo:visible').count(), 0);
  for (const page of pages) await click(page, '#ready-button');
  await leader.page.waitForFunction(() => window.__qaState.members.every(person => person.ready));
  await click(leader.page, '#start-button');
  await Promise.all(pages.map(page => page.waitForURL(url => url.pathname === '/lab'))); await stage(pages, 'map');
  assert.equal(await leader.page.locator('#steps button[data-stage]').count(), 7);
  assert.equal(await member.page.locator('#module-settings-editor:visible').count(), 0);
  assert.equal(await leader.page.locator('#reference-photo').isVisible(), false);
  assert.equal(await leader.page.locator('#simulator, #module-mode, #photo-pass, #photo-fail').count(), 0);
  checks.push('all-ready-shared-start-without-lobby-configuration');

  const deniedSelect = await action(member.page, { type: 'lab:select-stage', target: 'photo' }); assert.equal(deniedSelect.type, 'error');
  const deniedConfig = await action(member.page, { type: 'lab:configure-module', config: { radius: 45 } }); assert.equal(deniedConfig.type, 'error');
  assert.equal((await snapshot(leader.page)).lab.stage, 'map');
  const bootstrap = { start: { lat: 37.619, lon: 127.059 }, destination: { lat: 37.624, lon: 127.066 }, radius: 45 };
  assert.equal((await action(leader.page, { type: 'lab:configure-module', config: bootstrap })).type, 'ack');
  await leader.page.locator('#module-settings-editor').evaluate(details => { details.open = true; });
  assert.deepEqual(await leader.page.locator('#module-config-form input[type="number"]').evaluateAll(inputs => inputs.map(input => input.id)), ['module-radius']);
  assert.equal(await leader.page.locator('#module-start-lat, #module-start-lon, #module-destination-lat, #module-destination-lon').count(), 0);
  await move(leader, bootstrap.start);
  await mineMarker(leader.page, 'module-location-map', bootstrap.start);
  await click(leader.page, '#module-location-role [data-location-role="start"]');
  await click(leader.page, '#module-current-start');
  assert.match(await leader.page.locator('#module-start-status').textContent(), /지정됨/);
  await click(leader.page, '#module-location-role [data-location-role="destination"]');
  await click(leader.page, '#module-map-current');
  await click(leader.page, '#module-map-fit');
  const selectedMapPoint = await mapPoint(leader.page, 'module-location-map', { x: 70, y: 50 });
  await leader.page.locator('#module-radius').fill('46');
  const nearby = { lat: bootstrap.start.lat + 0.00001, lon: bootstrap.start.lon };
  await move(member, nearby);
  await leader.page.waitForFunction(({ id, lat }) => window.__qaState.lab.positions[id]?.lat === lat, { id: member.identity.participantId, lat: nearby.lat });
  assert.equal(await leader.page.locator('#module-radius').inputValue(), '46');
  assert.equal(await leader.page.evaluate(() => document.activeElement.id), 'module-radius');
  const mapPayload = await configure(leader.page, pages, { '#module-radius': 45 });
  assert.deepEqual(mapPayload.start, bootstrap.start); assert.deepEqual(mapPayload.destination, selectedMapPoint);
  const configuredMap = structuredClone((await snapshot(leader.page)).lab.moduleConfigs.map);
  assert.equal(configuredMap.radius, 45); assert.deepEqual(configuredMap.destination, selectedMapPoint);
  assert.deepEqual((await snapshot(member.page)).lab.config, (await snapshot(leader.page)).lab.config);
  await mobile(leader.page, 'map-settings');
  checks.push('leader-only-map-pin-settings-current-gps-marker-shared-save-and-draft-focus-retention');

  await select(leader.page, pages, 'photo');
  assert.deepEqual((await snapshot(leader.page)).lab.arrivals, {});
  for (const page of pages) {
    assert.equal(await page.locator('#reference-photo').isVisible(), true);
    for (const selector of ['#location-status', '#sensor-status', '#gps-start']) assert.equal(await page.locator(selector).isVisible(), false);
  }
  assert.equal(await member.page.locator('#reference-editor:visible').count(), 0);
  await replaceReference(leader.page, pages, 'QA 첫 기준 물체', '#ff4141');
  await replaceReference(leader.page, pages, 'QA 교체 기준 물체', '#315bff');
  assert.deepEqual((await snapshot(leader.page)).lab.completed, {});
  assert.equal((await snapshot(member.page)).lab.config.photoTarget, 'QA 교체 기준 물체');
  assert.equal((await snapshot(leader.page)).lab.moduleConfigs.photo.photoTarget, 'QA 교체 기준 물체');
  await click(leader.page, '#photo-pick'); await leader.page.locator('#photo-source-dialog').waitFor({ state: 'visible' });
  const picker = leader.page.waitForEvent('filechooser'); await click(leader.page, '#photo-library-pick');
  await (await picker).setFiles(await referenceFile(leader.page, '#315bff')); await leader.page.locator('#photo-preview').waitFor({ state: 'visible' });
  const photoPattern = new RegExp(`/api/rooms/${room.roomId}/photo$`);
  await leader.context.route(photoPattern, route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'QA 사진 판정 응답 시험' }) }));
  await click(leader.page, '#photo-submit'); await leader.page.waitForFunction(() => document.querySelector('#photo-status').textContent.includes('QA 사진 판정 응답 시험'));
  assert.equal((await snapshot(member.page)).lab.stage, 'photo');
  await leader.context.unroute(photoPattern);
  await mobile(leader.page, 'photo-reference'); checks.push('standalone-photo-reference-replacement-picker-and-rejected-response-ui');

  await select(leader.page, pages, 'silence');
  for (const page of pages) for (const selector of ['#location-status', '#sensor-status', '#gps-start']) assert.equal(await page.locator(selector).isVisible(), false);
  await leader.page.waitForFunction(() => document.querySelector('#report-members [data-report]') && !document.querySelector('#report-members [data-report]').disabled);
  await leader.page.locator(`#report-members [data-report="${member.identity.participantId}"]`).evaluate(button => {
    for (let index = 0; index < 5; index++) { if (button.disabled) throw new Error('Rapid report button became disabled'); button.click(); }
  });
  await Promise.all(pages.map(page => page.waitForFunction(id => window.__qaState.lab.penalties[id] === 5 && window.__qaState.lab.reports.length === 5, member.identity.participantId)));
  assert.equal(await leader.page.locator('#report-members [data-report]').isDisabled(), false);
  checks.push('five-rapid-ui-reports-without-cooldown-or-busy-drop');

  await select(leader.page, pages, 'ending');
  for (const page of pages) {
    assert.match(await page.locator('#scoreboard').textContent(), /QA 팀원/); assert.match(await page.locator('#scoreboard').textContent(), /5/);
    for (const selector of ['#location-status', '#sensor-status', '#gps-start']) assert.equal(await page.locator(selector).isVisible(), false);
  }
  assert.equal((await snapshot(leader.page)).lab.reports.length, 5);
  await mobile(leader.page, 'ending'); checks.push('ending-keeps-individual-penalties-and-report-history');

  await select(leader.page, pages, 'finder');
  await leader.page.locator('#module-settings-editor').evaluate(details => { details.open = true; });
  await move(leader, { lat: 37.6214, lon: 127.0624 });
  await click(leader.page, '#module-current-start');
  await mineMarker(leader.page, 'module-location-map', { lat: 37.6214, lon: 127.0624 });
  assert.equal(await leader.page.locator('#module-location-role [data-location-role="start"]').isVisible(), false);
  const finderPoint = await mapPoint(leader.page, 'module-location-map');
  const finderPayload = await configure(leader.page, pages, { '#module-radius': 35 });
  assert.deepEqual(finderPayload.destination, finderPoint);
  const finderConfig = structuredClone((await snapshot(leader.page)).lab.moduleConfigs.finder);
  assert.deepEqual(finderConfig.destination, finderPoint);
  await select(leader.page, pages, 'map'); assert.deepEqual((await snapshot(leader.page)).lab.moduleConfigs.map, configuredMap);
  const stale = (await snapshot(leader.page)).lab;
  await select(leader.page, pages, 'finder'); assert.deepEqual((await snapshot(leader.page)).lab.moduleConfigs.finder, finderConfig);
  const staleResponse = await action(leader.page, { type: 'lab:configure-module', config: { radius: 99 } }, { runId: stale.runId, stage: stale.stage }); assert.equal(staleResponse.type, 'error');
  const invalid = await action(leader.page, { type: 'lab:configure-module', config: { radius: -1 } }); assert.equal(invalid.type, 'error');
  assert.equal((await snapshot(member.page)).lab.config.radius, 35);
  checks.push('module-settings-persist-and-stale-or-invalid-writes-are-rejected');

  const beforeReconnect = await snapshot(member.page); await member.page.reload(); await stage([member.page], 'finder');
  const afterReconnect = await snapshot(member.page);
  assert.equal(afterReconnect.lab.runId, beforeReconnect.lab.runId); assert.deepEqual(afterReconnect.lab.moduleConfigs, beforeReconnect.lab.moduleConfigs);
  assert.deepEqual(afterReconnect.lab.penalties, beforeReconnect.lab.penalties); checks.push('reconnect-restores-shared-stage-settings-and-score');

  await select(leader.page, pages, 'map');
  for (const person of [leader, member]) { await move(person, configuredMap.start); await person.page.waitForFunction(() => document.querySelector('#map-complete').disabled); }
  for (const person of [leader, member]) { await move(person, configuredMap.destination); await person.page.waitForFunction(() => !document.querySelector('#map-complete').disabled); }
  assert.equal(await leader.page.locator('#location-status').getAttribute('data-fresh'), 'true');
  assert.match(await leader.page.locator('#location-status').textContent(), /초 전 측정/);
  const rejected = await action(leader.page, { type: 'lab:location', ...configuredMap.destination, accuracy: 3, heading: null, source: 'simulated', measuredAt: Date.now() });
  assert.equal(rejected.type, 'error');
  const aged = await action(leader.page, { type: 'lab:location', ...configuredMap.destination, accuracy: 3, heading: null, source: 'gps', measuredAt: Date.now() - 31000 });
  assert.equal(aged.type, 'error');
  await leader.page.evaluate(() => { const nativeNow = Date.now; Date.now = () => nativeNow() + 31000; window.__qaRestoreDate = () => { Date.now = nativeNow; }; });
  await leader.page.waitForFunction(() => document.querySelector('#map-complete').disabled);
  assert.equal(await leader.page.locator('#location-status').getAttribute('data-fresh'), 'false');
  await leader.page.evaluate(() => window.__qaRestoreDate());
  await move(leader, { lat: configuredMap.destination.lat + 0.000001, lon: configuredMap.destination.lon });
  await leader.page.waitForFunction(() => !document.querySelector('#map-complete').disabled);
  assert.equal(await leader.page.locator('#location-status').getAttribute('data-fresh'), 'true');
  const resumedWatch = await leader.page.evaluate(() => window.__qaGPSWatches);
  await leader.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await leader.page.waitForFunction(previous => window.__qaGPSWatches > previous && document.querySelector('#location-status').dataset.fresh === 'true' && !document.querySelector('#map-complete').disabled, resumedWatch);
  checks.push('gps-coordinate-updates-stale-fix-rejection-fresh-fix-and-foreground-recovery');
  await click(leader.page, '#map-complete'); await leader.page.waitForFunction(() => window.__qaState.lab.completed[window.__qaSelf]);
  assert.equal((await snapshot(member.page)).lab.stage, 'map');
  await click(member.page, '#map-complete'); await stage(pages, 'photo');
  assert.equal(Object.keys((await snapshot(leader.page)).lab.arrivals).length, 2);
  checks.push('map-circle-outside-inside-and-all-member-shared-completion');

  await select(leader.page, pages, 'npc');
  await leader.page.locator('#module-settings-editor').evaluate(details => { details.open = true; });
  assert.deepEqual(await leader.page.locator('#module-config-form input[type="number"]').evaluateAll(inputs => inputs.map(input => input.id)), ['module-radius']);
  assert.equal(await leader.page.locator('#module-location-role [data-location-role="start"]').isVisible(), false);
  await click(leader.page, '#module-location-role [data-location-role="destination"]');
  assert.equal(await leader.page.locator('#module-location-role [data-location-role="destination"]').getAttribute('aria-pressed'), 'true');
  const npcPoint = await mapPoint(leader.page, 'module-location-map');
  const npcPayload = await configure(leader.page, pages, { '#module-radius': 35 });
  assert.deepEqual(npcPayload.destination, npcPoint);
  assert.deepEqual((await snapshot(member.page)).lab.config.destination, npcPoint);
  for (const person of [leader, member]) {
    const config = (await snapshot(person.page)).lab.config;
    await move(person, config.start); await person.page.waitForFunction(() => document.querySelector('#camera-start').disabled);
    await move(person, config.destination); await click(person.page, '#camera-start');
    await person.page.locator('#npc-touch').waitFor({ state: 'visible' }); await click(person.page, '#npc-touch');
    await person.page.locator('#story').waitFor({ state: 'visible' });
  }
  for (const page of pages) for (let line = 0; line < 3; line++) await click(page, '#story-next');
  await stage(pages, 'ar-route'); checks.push('npc-geographic-radius-gate-2d-fallback-touch-and-personal-dialogue');
  assert.equal((await snapshot(leader.page)).lab.stage, 'ar-route');
  assert.equal(await leader.page.locator('a[href="/spatial-route"]').count() > 0, true);
  const invalidProject = await action(leader.page, { type: 'lab:configure-module', config: { spatialProjectUrl: 'http://example.org/route', spatialMapId: '42' } });
  assert.equal(invalidProject.type, 'error');
  await leader.page.locator('#module-settings-editor').evaluate(details => { details.open = true; });
  assert.deepEqual(await leader.page.locator('#module-config-form input[type="number"]').evaluateAll(inputs => inputs.map(input => input.id)), ['module-radius']);
  await click(leader.page, '#module-location-role [data-location-role="destination"]');
  assert.equal(await leader.page.locator('#module-location-role [data-location-role="destination"]').getAttribute('aria-pressed'), 'true');
  await click(leader.page, '#module-map-fit');
  const spatialPoint = await mapPoint(leader.page, 'module-location-map');
  const spatialPayload = await configure(leader.page, pages, { '#module-spatial-project-url': 'https://example.org/nonol-qa-route', '#module-spatial-map-id': 42 });
  assert.deepEqual(spatialPayload.destination, spatialPoint);
  const spatial = (await snapshot(leader.page)).lab.moduleConfigs['ar-route'];
  assert.equal(spatial.spatialProjectUrl, 'https://example.org/nonol-qa-route'); assert.equal(spatial.spatialMapId, '42');
  assert.deepEqual((await snapshot(member.page)).lab.config, (await snapshot(leader.page)).lab.config);
  await mobile(leader.page, 'spatial-route-settings');
  checks.push('real-spatial-project-configuration-shared-and-insecure-url-rejected');

  const soloRoom = await createRoom('solo'), solo = await join(soloRoom, 'QA 혼자');
  await click(solo.page, '#ready-button'); await click(solo.page, '#start-button'); await solo.page.waitForURL(url => url.pathname === '/lab'); await stage([solo.page], 'map');
  for (const target of stages.slice(1)) await select(solo.page, [solo.page], target);
  assert.equal((await snapshot(solo.page)).members.length, 1); checks.push('solo-ready-start-and-all-seven-module-direct-selection');

  const transferRoom = await createRoom('transfer'), previousLeader = await join(transferRoom, 'QA 이전 팀장'), nextLeader = await join(transferRoom, 'QA 새 팀장');
  const transferredPages = [previousLeader.page, nextLeader.page];
  await previousLeader.page.waitForFunction(() => window.__qaState.members.length === 2);
  for (const page of transferredPages) await click(page, '#ready-button');
  await click(previousLeader.page, `[data-transfer="${nextLeader.identity.participantId}"]`);
  await Promise.all(transferredPages.map(page => page.waitForFunction(({ next, previous }) => {
    const state = window.__qaState;
    return state.leaderId === next && state.members.find(person => person.id === next).ready && !state.members.find(person => person.id === previous).ready;
  }, { next: nextLeader.identity.participantId, previous: previousLeader.identity.participantId })));
  assert.equal(await nextLeader.page.locator('#start-button').isDisabled(), true);
  await click(previousLeader.page, '#ready-button');
  await click(nextLeader.page, '#start-button');
  await Promise.all(transferredPages.map(page => page.waitForURL(url => url.pathname === '/lab'))); await stage(transferredPages, 'map');
  assert.equal(await previousLeader.page.locator('#module-settings-editor:visible').count(), 0);
  assert.equal((await action(previousLeader.page, { type: 'lab:configure-module', config: { radius: 30 } })).type, 'error');
  assert.equal((await action(nextLeader.page, { type: 'lab:configure-module', config: bootstrap })).type, 'ack');
  await nextLeader.page.locator('#module-settings-editor').evaluate(details => { details.open = true; });
  await click(nextLeader.page, '#module-location-role [data-location-role="destination"]');
  await click(nextLeader.page, '#module-map-fit');
  const transferredPoint = await mapPoint(nextLeader.page, 'module-location-map', { x: 70, y: 50 });
  const transferredPayload = await configure(nextLeader.page, transferredPages, { '#module-radius': 30 });
  assert.deepEqual(transferredPayload.destination, transferredPoint);
  assert.deepEqual((await snapshot(previousLeader.page)).lab.config.destination, transferredPoint);
  assert.equal((await snapshot(nextLeader.page)).lab.config.radius, 30);
  checks.push('actual-lobby-leadership-transfer-ready-state-and-new-leader-map-save');

  assert.deepEqual(pageErrors, []); checks.push('zero-browser-page-errors');
  console.log(JSON.stringify({ status: 'passed', checks, screenshotDirectory: output.pathname, mockedChecks: 'Browser geolocation input and one rejected photo HTTP response are automation fixtures. This browser run does not assess AI recognition accuracy.', physicalChecks: 'GPS field movement, spatial NPC placement and floor route localization require devices and a mapped Mattercraft project' }));
} catch (error) {
  console.error(redact(error.stack || error.message)); process.exitCode = 1;
} finally {
  for (const roomId of rooms) {
    try { const response = await api(`/api/rooms/${roomId}`, 'DELETE', undefined, key); if (response.status !== 200) console.error('QA room cleanup was not confirmed'); }
    catch { console.error('QA room cleanup request failed'); }
  }
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
}
