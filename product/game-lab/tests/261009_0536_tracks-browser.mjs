import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = new URL(process.env.ROOM_BASE_URL || 'http://localhost:8791').origin;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
const readOnly = !local || process.env.TRACKS_READ_ONLY === '1';
const vars = readOnly ? '' : await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const key = process.env.ROOM_ADMIN_KEY || vars.match(/^ROOM_ADMIN_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
const basicKey = process.env.NONOL_BASIC_KEY || vars.match(/^NONOL_BASIC_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
const secrets = new Set([key, basicKey].filter(Boolean));
const redact = value => [...secrets].reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
const path = '/api/lab-tracks/kw-silence';
const output = new URL('../../../.local/game-lab-browser/tracks-evidence/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const contexts = [], rooms = new Set(), errors = [], checks = [];
let previousTrack;

async function api(url, method = 'GET', body, token) {
  if (readOnly && method !== 'GET') throw new Error('Remote track QA permits read-only requests');
  return fetch(`${base}${url}`, { method, headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

function settings(track) {
  return {
    places: Object.fromEntries(Object.entries(track.places).map(([id, place]) => [id, { lat: place.lat, lon: place.lon, radius: place.radius }])),
    reference: { label: track.reference.label, image: track.reference.image ?? null }, ending: track.ending, spatial: track.spatial
  };
}

async function context() {
  const value = await browser.newContext({ viewport: { width: 360, height: 844 }, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: 37.619, longitude: 127.059, accuracy: 3 } });
  contexts.push(value); value.on('page', page => page.on('pageerror', error => {
    errors.push(redact(error.message)); console.error(redact(`${new URL(page.url()).pathname}: ${error.stack || error.message}`));
  }));
  await value.addInitScript(() => {
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
    window.__qaMessages = [];
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); window.__qaSocket = this;
        this.addEventListener('message', event => {
          if (event.data === 'pong') return;
          const message = JSON.parse(event.data); window.__qaMessages.push(message);
          if (message.type === 'state') { window.__qaState = message.state; window.__qaSelf = message.selfId; }
        });
      }
    };
  });
  return value;
}

async function click(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, selector); await page.locator(selector).click();
}

async function state(page) { return page.evaluate(() => structuredClone(window.__qaState)); }

async function stage(pages, expected) {
  await Promise.all(pages.map(page => page.waitForFunction(expected => window.__qaState?.lab?.stage === expected, expected)));
  for (const page of pages) await page.locator(`#${expected}-panel`).waitFor({ state: 'visible' });
}

async function select(leader, pages, target) { await click(leader, `#steps button[data-stage="${target}"]`); await stage(pages, target); }

async function action(page, payload) {
  const requestId = crypto.randomUUID();
  await page.evaluate(({ payload, requestId }) => {
    const lab = window.__qaState.lab;
    window.__qaSocket.send(JSON.stringify({ runId: lab.runId, stage: lab.stage, ...payload, requestId }));
  }, { payload, requestId });
  await page.waitForFunction(id => window.__qaMessages.some(message => message.requestId === id && ['ack', 'error'].includes(message.type)), requestId);
  return page.evaluate(id => window.__qaMessages.find(message => message.requestId === id && ['ack', 'error'].includes(message.type)), requestId);
}

async function join(room, name) {
  const value = await context(), page = await value.newPage(); await page.goto(room.inviteUrl);
  await page.locator('#nickname').fill(name); await click(page, '#join-button'); await page.locator('#lobby').waitFor({ state: 'visible' });
  const identity = await page.evaluate(id => JSON.parse(localStorage.getItem(`nonol-room:${id}`)), room.roomId); secrets.add(identity.token);
  return { value, page, identity };
}

async function move(person, point) {
  await person.value.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy: 3 });
  await click(person.page, '#gps-start');
  await person.page.waitForFunction(point => {
    const position = window.__qaState.lab.positions[window.__qaSelf];
    return position?.source === 'gps' && position.lat === point.lat && position.lon === point.lon && Date.now() - position.at < 30000;
  }, point);
}

async function mobile(page, label) {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} fits the mobile viewport`);
    await page.screenshot({ path: new URL(`261009_0536_${label}-${width}.png`, output).pathname, fullPage: true });
  }
}

async function fixturePhoto(page, color = '#455bee') {
  return page.evaluate(color => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 200;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 200, 200);
    context.fillStyle = '#fff'; context.fillRect(65, 50, 70, 100); return canvas.toDataURL('image/png');
  }, color);
}

async function editorGPS(value, page, point) {
  await value.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy: 3 });
  await click(page, '#track-location-connect');
  await page.waitForFunction(point => {
    let present = false;
    window.__qaLeafletMaps.get('track-map')?.eachLayer(layer => {
      const coordinate = layer.getLatLng?.();
      if (coordinate?.lat === point.lat && coordinate.lng === point.lon && layer.options.radius === 9 && layer.options.fillColor === '#171b16') present = true;
    });
    return present && document.querySelector('#track-gps-status').dataset.fresh === 'true' && document.querySelector('#track-map').dataset.gpsMarker === 'true';
  }, point);
}

async function mapPoint(page, position = { x: 100, y: 150 }) {
  await page.waitForFunction(() => {
    const map = window.__qaLeafletMaps.get('track-map'), container = document.querySelector('#track-map');
    return map && container.dataset.mapProvider === 'leaflet' && container.contains(map.getPane('mapPane'));
  });
  await page.locator('#track-map').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    window.__qaMapClick = null;
    window.__qaLeafletMaps.get('track-map').once('click', event => { window.__qaMapClick = { lat: event.latlng.lat, lon: event.latlng.lng }; });
  });
  await page.locator('#track-map').click({ position });
  await page.waitForFunction(() => Boolean(window.__qaMapClick));
  return page.evaluate(() => structuredClone(window.__qaMapClick));
}

try {
  const anonymous = await context(), publicPage = await anonymous.newPage(); await publicPage.goto(`${base}/tracks`);
  await publicPage.waitForFunction(() => document.querySelector('#track-state').textContent.includes('광운대 묵언수행'));
  const listing = await (await api('/api/lab-tracks')).json(), publicTrack = (await (await api(path)).json()).track;
  assert.ok(listing.tracks.some(track => track.id === 'kw-silence')); assert.equal('image' in publicTrack.reference, false);
  assert.deepEqual(Object.keys(publicTrack.places), ['welfare', 'square', 'bima', 'futsal']);
  assert.equal(publicTrack.ending, 'cafe');
  assert.equal(publicTrack.definitionVersion, 2);
  assert.equal(await publicPage.locator('.mapping-table tbody tr').count(), 5);
  const mapping = await publicPage.locator('.mapping-table').textContent();
  for (const label of ['복지관', '광운스퀘어', '비마관', '풋살장', '이층집', '우이천', '정령', '카페']) assert.ok(mapping.includes(label));
  assert.equal(await publicPage.locator('#track-save').isDisabled(), true);
  assert.equal(await publicPage.locator('#track-create-room').isDisabled(), true);
  assert.deepEqual(await publicPage.locator('#track-form input[type="number"]').evaluateAll(inputs => inputs.map(input => input.id)), ['track-welfare-radius', 'track-square-radius', 'track-bima-radius', 'track-futsal-radius']);
  assert.equal(await publicPage.locator('input[id$="-lat"], input[id$="-lon"]').count(), 0);
  await publicPage.waitForFunction(() => document.querySelector('#track-map').dataset.gpsMarker === 'true');
  assert.equal(await publicPage.locator('#track-gps-status').getAttribute('data-fresh'), 'true');
  const mapConfig = await (await api('/api/map-config')).json();
  if (!mapConfig.configured) {
    await publicPage.locator('#track-map[data-map-provider="leaflet"]').waitFor();
    assert.match(await publicPage.locator('#kakao-state').textContent(), /키와 SDK 도메인 등록이 필요/);
    checks.push('missing-kakao-key-shows-explicit-leaflet-fallback');
  }
  checks.push('public-track-page-and-reference-image-privacy'); await mobile(publicPage, readOnly ? 'live-public-track' : 'public-track');

  if (!readOnly) {
    assert.ok(key && basicKey, 'Local track QA requires administration credentials');
    previousTrack = (await (await api(path, 'GET', undefined, key)).json()).track;
    const input = settings(previousTrack);
    assert.equal((await api(path, 'PUT', input)).status, 401);
    assert.equal((await api(`${path}/rooms`, 'POST', { title: 'Unauthorized fixed track' })).status, 401);
    assert.equal((await api(path, 'PUT', { ...input, expectedVersion: previousTrack.version, story: ['changed'] }, key)).status, 400);
    assert.equal((await api(path, 'PUT', { ...input, expectedVersion: 'old' }, key)).status, 400);
    checks.push('anonymous-mutations-and-story-overrides-rejected');

    const administrator = await context(), home = await administrator.newPage(); await home.goto(base);
    await click(home, '#admin-open'); await home.locator('#admin-password').fill(basicKey); await click(home, '#admin-submit'); await home.locator('#admin-logout').waitFor({ state: 'visible' });
    const editor = await administrator.newPage(); await editor.goto(`${base}/tracks`); await editor.locator('#track-form').waitFor({ state: 'visible' });
    const fixturePlaces = {
      welfare: { lat: 37.619, lon: 127.059, radius: 10 }, square: { lat: 37.6202, lon: 127.0602, radius: 10 },
      bima: { lat: 37.6214, lon: 127.0614, radius: 10 }, futsal: { lat: 37.6226, lon: 127.0626, radius: 10 }
    };
    for (const [id, point] of Object.entries(fixturePlaces)) {
      await editor.locator('#track-active-place').selectOption(id);
      await editorGPS(administrator, editor, point);
      await click(editor, '#track-current-gps');
      assert.match(await editor.locator(`#track-${id}-status`).textContent(), /지정됨/);
      await editor.locator(`#track-${id}-radius`).fill(String(point.radius));
    }
    await editor.locator('#track-active-place').selectOption('square');
    const selectedSquare = await mapPoint(editor);
    assert.match(await editor.locator('#track-place-feedback').textContent(), /광운스퀘어 위치를 지도에서 지정/);
    const gpsUpdate = { lat: fixturePlaces.square.lat + .00002, lon: fixturePlaces.square.lon };
    await editor.locator('#track-square-radius').fill('11');
    await administrator.setGeolocation({ latitude: gpsUpdate.lat, longitude: gpsUpdate.lon, accuracy: 3 });
    await editor.waitForFunction(point => {
      let present = false;
      window.__qaLeafletMaps.get('track-map')?.eachLayer(layer => {
        const coordinate = layer.getLatLng?.();
        if (coordinate?.lat === point.lat && coordinate.lng === point.lon && layer.options.radius === 9 && layer.options.fillColor === '#171b16') present = true;
      });
      return present;
    }, gpsUpdate);
    assert.equal(await editor.locator('#track-square-radius').inputValue(), '11');
    assert.equal(await editor.evaluate(() => document.activeElement.id), 'track-square-radius');
    await click(editor, '#track-center-gps');
    await editor.locator('#track-square-radius').fill('10');
    checks.push('map-first-place-selection-current-gps-marker-and-draft-preservation');
    const image = await fixturePhoto(editor); await editor.locator('#track-reference-file').setInputFiles({ name: 'qa-track-reference.png', mimeType: 'image/png', buffer: Buffer.from(image.split(',')[1], 'base64') });
    const saved = editor.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'PUT');
    await click(editor, '#track-save'); const response = await saved; assert.equal(response.status(), 200); const savedTrack = (await response.json()).track;
    const submitted = response.request().postDataJSON().places, places = savedTrack.places;
    assert.deepEqual({ lat: submitted.square.lat, lon: submitted.square.lon }, selectedSquare);
    for (const [id, point] of Object.entries(submitted)) {
      assert.deepEqual(point, { lat: places[id].lat, lon: places[id].lon, radius: places[id].radius });
      assert.equal(point.radius, 10);
      if (id !== 'square') assert.deepEqual(point, fixturePlaces[id]);
    }
    assert.equal(savedTrack.status, 'ready'); assert.ok(savedTrack.version > previousTrack.version);
    assert.equal(savedTrack.reference.label, '에어팟'); assert.equal(savedTrack.ending, 'cafe');
    await mobile(editor, 'track-editor'); checks.push('four-place-editor-reference-upload-and-versioned-ready-track');

    const created = editor.waitForResponse(response => response.url().endsWith(`${path}/rooms`) && response.request().method() === 'POST');
    await click(editor, '#track-create-room'); const createdResponse = await created; assert.equal(createdResponse.status(), 201); const room = await createdResponse.json(); rooms.add(room.roomId);
    const leader = await join(room, 'QA 고정 팀장'), member = await join(room, 'QA 고정 팀원'), people = [leader, member], pages = people.map(person => person.page);
    await leader.page.waitForFunction(() => window.__qaState.members.length === 2);
    for (const person of people) await click(person.page, '#ready-button'); await click(leader.page, '#start-button');
    await Promise.all(pages.map(page => page.waitForURL(url => url.pathname === '/lab'))); await stage(pages, 'map');
    const original = (await state(leader.page)).lab;
    assert.deepEqual(original.stageOrder, ['map', 'photo', 'silence', 'ar-route', 'npc', 'finder', 'ending']);
    assert.equal(original.trackSnapshot.version, savedTrack.version);
    assert.match(original.trackSnapshot.story.join(' '), /카페/);
    assert.equal(original.trackSnapshot.story.join(' ').includes('풋살장'), false);
    for (const page of pages) {
      assert.equal(await page.locator('#module-settings-editor:visible').count(), 0);
      assert.deepEqual(await page.locator('#steps button[data-stage]').evaluateAll(buttons => buttons.map(button => button.dataset.stage)), original.stageOrder);
    }
    assert.equal((await action(leader.page, { type: 'lab:configure-module', config: { radius: 50 } })).type, 'error');
    assert.equal((await action(member.page, { type: 'lab:configure-module', config: { radius: 50 } })).type, 'error');
    await mobile(leader.page, 'fixed-map');
    checks.push('fixed-room-snapshot-order-and-configuration-lock');

    const staleEditor = await administrator.newPage(); await staleEditor.goto(`${base}/tracks`);
    await staleEditor.waitForFunction(() => !document.querySelector('#track-create-room').disabled);
    await editor.locator('#track-active-place').selectOption('welfare');
    await editorGPS(administrator, editor, { lat: 37.6191, lon: fixturePlaces.welfare.lon });
    await click(editor, '#track-current-gps');
    const edited = editor.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'PUT');
    await click(editor, '#track-save'); const editedResponse = await edited; assert.equal(editedResponse.status(), 200);
    const currentTrack = (await editedResponse.json()).track;
    const staleCreation = staleEditor.waitForResponse(response => response.url().endsWith(`${path}/rooms`) && response.request().method() === 'POST');
    await click(staleEditor, '#track-create-room'); assert.equal((await staleCreation).status(), 409);
    const staleSave = staleEditor.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'PUT');
    await click(staleEditor, '#track-save'); assert.equal((await staleSave).status(), 409);
    assert.equal((await (await api(path, 'GET', undefined, key)).json()).track.version, currentTrack.version);
    checks.push('stale-administrator-save-and-room-creation-rejected');
    await leader.page.reload(); await stage([leader.page], 'map');
    assert.deepEqual((await state(leader.page)).lab.trackSnapshot, original.trackSnapshot);
    assert.deepEqual((await state(leader.page)).lab.moduleConfigs, original.moduleConfigs);
    checks.push('catalog-edit-keeps-existing-room-snapshot-immutable');

    await select(leader.page, pages, 'photo');
    for (const page of pages) assert.equal(await page.locator('#reference-editor:visible').count(), 0);
    const premature = await api(`/api/rooms/${room.roomId}/photo`, 'POST', { runId: (await state(leader.page)).lab.runId, image }, leader.identity.token);
    assert.equal(premature.status, 400); assert.match((await premature.json()).error, /지도/);
    const changeReference = await api(`/api/rooms/${room.roomId}/reference`, 'POST', { runId: (await state(leader.page)).lab.runId, image, label: '다른 물체' }, leader.identity.token);
    assert.equal(changeReference.status, 409);
    await select(leader.page, pages, 'map');
    for (const person of people) { await move(person, places.square); await click(person.page, '#map-complete'); }
    await stage(pages, 'photo');
    const roomReference = await (await api(`/api/rooms/${room.roomId}/reference`, 'GET', undefined, leader.identity.token)).json();
    assert.equal(roomReference.reference.image, savedTrack.reference.image);
    checks.push('fixed-photo-requires-map-arrival-and-keeps-copied-reference');

    await select(leader.page, pages, 'silence');
    await click(leader.page, `#report-members [data-report="${member.identity.participantId}"]`);
    for (const person of people) await click(person.page, '#silence-complete'); await stage(pages, 'ar-route');
    const routeConfig = (await state(leader.page)).lab.config;
    assert.deepEqual(routeConfig.start, { lat: places.square.lat, lon: places.square.lon });
    assert.deepEqual(routeConfig.destination, { lat: places.bima.lat, lon: places.bima.lon });
    await click(leader.page, `#report-members [data-report="${member.identity.participantId}"]`);
    await leader.page.waitForFunction(id => window.__qaState.lab.penalties[id] === 2, member.identity.participantId);
    await mobile(leader.page, 'fixed-ar-report');
    const middle = { lat: (places.square.lat + places.bima.lat) / 2, lon: (places.square.lon + places.bima.lon) / 2 };
    for (const point of [middle, places.bima]) for (const person of people) { await move(person, point); await click(person.page, '#route-arrive'); }
    await stage(pages, 'npc'); checks.push('fixed-ar-walk-route-and-active-silence-reporting');

    for (const person of people) {
      await move(person, places.bima); await click(person.page, '#camera-start'); await click(person.page, '#npc-touch');
      for (const [index, line] of original.trackSnapshot.story.entries()) {
        assert.equal(await person.page.locator('#story-copy').textContent(), line); await click(person.page, '#story-next');
        if (index === original.trackSnapshot.story.length - 1 && person === leader) assert.equal((await state(person.page)).lab.stage, 'npc');
      }
    }
    await stage(pages, 'finder');
    assert.deepEqual((await state(leader.page)).lab.config.destination, { lat: places.futsal.lat, lon: places.futsal.lon });
    for (const page of pages) {
      const summary = await page.locator('#module-config-summary').textContent();
      for (const hidden of ['풋살장', String(places.futsal.lat), String(places.futsal.lon)]) assert.equal(summary.includes(hidden), false);
    }
    for (const person of people) { await move(person, places.futsal); await click(person.page, '#finder-complete'); }
    await stage(pages, 'ending');
    assert.equal((await state(leader.page)).lab.penalties[member.identity.participantId], 2);
    await mobile(leader.page, 'fixed-ending'); checks.push('fixed-spirit-story-futsal-cafe-arrival-and-score-ending');

    leader.page.once('dialog', dialog => dialog.accept()); await click(leader.page, '#reset');
    for (const page of pages) { await page.waitForURL(url => url.pathname === '/'); await page.locator('#join-form').waitFor({ state: 'visible' }); }
    await leader.page.locator('#nickname').fill('QA 재입장 팀장');
    await click(leader.page, '#join-button'); await leader.page.locator('#lobby').waitFor({ state: 'visible' });
    const reset = (await state(leader.page)).lab;
    assert.deepEqual(reset.trackSnapshot, original.trackSnapshot); assert.deepEqual(reset.moduleConfigs, original.moduleConfigs);
    assert.deepEqual(reset.stageOrder, original.stageOrder); assert.deepEqual(reset.arrivals, {}); assert.deepEqual(reset.penalties, {});
    checks.push('full-reset-preserves-fixed-scenario-and-clears-team-progress');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', readOnly, checks, screenshotDirectory: output.pathname, limitations: 'GPS is injected through the browser test API. This run does not assess AI recognition accuracy, real Kakao SDK access or floor AR localization.' }));
} catch (error) {
  console.error(redact(error.stack || error.message)); process.exitCode = 1;
  for (const value of contexts) for (const page of value.pages()) {
    try {
      const diagnostics = await page.evaluate(() => ({ path: location.pathname, error: document.querySelector('#error')?.textContent || document.querySelector('#track-error')?.textContent, entry: document.querySelector('#entry-note')?.textContent, phase: window.__qaState?.phase, stage: window.__qaState?.lab?.stage }));
      console.error(redact(JSON.stringify(diagnostics)));
    } catch {}
  }
}
finally {
  if (!readOnly) {
    for (const roomId of rooms) try { const response = await api(`/api/rooms/${roomId}`, 'DELETE', undefined, key); if (response.status !== 200) console.error('Owned QA room cleanup was not confirmed'); } catch { console.error('Owned QA room cleanup failed'); }
    if (previousTrack) try {
      const current = (await (await api(path, 'GET', undefined, key)).json()).track;
      const restored = await api(path, 'PUT', { ...settings(previousTrack), expectedVersion: current.version }, key);
      if (restored.status !== 200) { console.error('Local catalog restoration was not confirmed'); process.exitCode = 1; }
    } catch { console.error('Local catalog restoration failed'); process.exitCode = 1; }
  }
  for (const value of contexts) await value.close().catch(() => {}); await browser.close();
}
