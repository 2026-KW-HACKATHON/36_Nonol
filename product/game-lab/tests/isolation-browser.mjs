import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

async function secret(path) {
  try {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    return text.match(/^ROOM_ADMIN_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function origin(value, name) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new Error(`${name}에 인증 정보가 없는 HTTP 또는 HTTPS 서비스 주소를 설정해 주세요.`); }
}

function skipped(reason) {
  console.log(JSON.stringify({ status: 'skipped', reason, required: ['PRODUCT_BASE_URL', 'PRODUCT_ADMIN_KEY'], labConfiguration: 'ROOM_BASE_URL 및 ROOM_ADMIN_KEY 또는 Lab .dev.vars' }));
}

async function run() {
  const localProduct = await access(new URL('../../game/src/worker.js', import.meta.url)).then(() => true, () => false);
  const productKey = process.env.PRODUCT_ADMIN_KEY || (localProduct ? await secret('../../game/.dev.vars') : null);
  const productUrl = process.env.PRODUCT_BASE_URL || (localProduct && productKey ? 'http://localhost:8790' : null);
  if (!productUrl || !productKey) { skipped('외부 제품 서비스의 주소와 관리자 키를 설정하면 분리 시험을 실행합니다.'); return; }
  const labKey = process.env.ROOM_ADMIN_KEY || await secret('../.dev.vars');
  if (!labKey) { skipped('Lab 관리자 키를 환경 변수 또는 Lab .dev.vars에 설정해 주세요.'); return; }
  assert.ok(labKey !== productKey, '제품과 테스트 관리자 비밀값은 독립적이어야 합니다.');
  const labBase = origin(process.env.ROOM_BASE_URL || 'http://localhost:8791', 'ROOM_BASE_URL');
  const productBase = origin(productUrl, 'PRODUCT_BASE_URL');
  assert.ok(labBase !== productBase, '제품과 Lab 서비스 주소는 서로 달라야 합니다.');

  const request = (base, key, path, method, body) => fetch(`${base}${path}`, {
    method, headers: { Origin: base, Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000)
  });
  let deletionProbe;
  try { deletionProbe = await request(productBase, productKey, `/api/rooms/${crypto.randomUUID()}`, 'DELETE'); }
  catch { skipped('제품 서비스 연결을 확인해 주세요. 방 생성 전에 시험을 중단했습니다.'); return; }
  if (![200, 204, 404].includes(deletionProbe.status)) { skipped('QA 방 정리를 위해 DELETE /api/rooms/:id를 지원하는 제품 주소와 관리자 키를 설정해 주세요. 방은 생성하지 않았습니다.'); return; }

  const ownedRooms = [], errors = [];
  let browser, failure;
  async function remember(response, base, key) {
    if (response.status !== 201) return null;
    const room = await response.json();
    assert.ok(typeof room.roomId === 'string' && /^[0-9a-f-]{36}$/.test(room.roomId), '생성한 QA 방의 ID를 확인해야 합니다.');
    ownedRooms.push({ base, key, roomId: room.roomId });
    return room;
  }
  async function create(base, key, track) {
    const response = await request(base, key, '/api/rooms', 'POST', { title: '사이트 분리 검증', ...(track ? { track } : {}) });
    const room = await remember(response, base, key);
    assert.equal(response.status, 201, 'QA 방을 생성해야 합니다.');
    return room;
  }
  try {
    const product = await create(productBase, productKey, 'standard');
    const lab = await create(labBase, labKey, 'lab');
    for (const [base, incorrectKey, cleanupKey] of [[productBase, labKey, productKey], [labBase, productKey, labKey]]) {
      const response = await request(base, incorrectKey, '/api/rooms', 'POST', {});
      await remember(response, base, cleanupKey);
      assert.equal(response.status, 401, '다른 서비스 비밀값으로 방을 생성할 수 없어야 합니다.');
    }
    assert.equal((await fetch(`${productBase}/api/rooms/${lab.roomId}`)).status, 404);
    assert.equal((await fetch(`${labBase}/api/rooms/${product.roomId}`)).status, 404);
    browser = await chromium.launch({ headless: true });
    const policy = JSON.parse(await readFile(new URL('../public/test-track.json', import.meta.url), 'utf8'));
    for (const [room, experimental] of [[product, false], [lab, true]]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['geolocation'], geolocation: { latitude: 37.619, longitude: 127.059, accuracy: 3 } });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(room.inviteUrl);
      await page.locator('#nickname').fill('분리 확인');
      await page.locator('#join-button').click();
      await page.locator('#lobby').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#ready-button').isVisible(), true);
      assert.equal(await page.locator('#start-button').isDisabled(), true, '준비 완료 전에는 시작할 수 없어야 합니다.');
      assert.match(await page.locator('#start-button').textContent(), experimental ? /테스트 시작하기/ : /트랙 시작하기/);
      assert.equal(await page.locator('#module-config-form').count(), 0, '대기실에서 모듈 설정을 요구하지 않아야 합니다.');
      await page.locator('#ready-button').click();
      await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
      await page.locator('#start-button').click();
      if (experimental) {
        await page.waitForURL(url => url.pathname === '/lab');
        await page.locator('#map-panel').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#mode-label').textContent(), `TEST v${policy.version} / 실제 GPS, 모듈별 도착 범위를 시험합니다.`);
        assert.equal(await page.locator('#gps-start').isVisible(), true);
        assert.equal(await page.locator('#module-settings').isVisible(), true);
        assert.equal(await page.locator('#simulator').count(), 0);
      } else {
        await page.locator('#started').waitFor({ state: 'visible' });
        assert.match(await page.locator('#started .intro').textContent(), /이층집/);
        assert.equal(new URL(page.url()).pathname, '/');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await context.close();
    }
    assert.deepEqual(errors, []);
  } catch (error) { failure = error; }
  finally {
    try { await browser?.close(); } catch (error) { failure ||= error; }
    const cleanup = await Promise.allSettled(ownedRooms.map(async room => {
      const response = await request(room.base, room.key, `/api/rooms/${room.roomId}`, 'DELETE');
      assert.ok([200, 204, 404].includes(response.status), '생성한 QA 방을 정리해야 합니다.');
    }));
    const rejected = cleanup.find(result => result.status === 'rejected');
    if (rejected) failure = new Error([failure?.message, `QA 방 정리 실패: ${rejected.reason.message}`].filter(Boolean).join(' / '));
  }
  if (failure) {
    const safeMessage = [labKey, productKey].reduce((text, key) => text.split(key).join('[redacted]'), String(failure.message));
    throw new Error(safeMessage);
  }
  console.log(JSON.stringify({ status: 'passed', checks: ['independent-admin-secrets', 'isolated-room-storage', 'ready-before-start', 'product-start-screen', 'GPS-test-mission-screen', 'desktop-layout', 'QA-room-cleanup'] }));
}

await run();
