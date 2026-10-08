import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = new URL(process.env.ROOM_BASE_URL || 'http://localhost:8791').origin;
const browser = await chromium.launch({ headless: true });
const output = new URL('../../../.local/game-lab-browser/spatial-route-evidence/', import.meta.url);
await mkdir(output, { recursive: true });
let pages = 0;
try {
  for (const width of [360, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(), errors = [], apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
    await page.goto(`${base}/spatial-route`);
    await page.locator('#spatial-check-status').waitFor();
    assert.match(await page.locator('.spatial-state').textContent(), /검증 전/);
    assert.equal(await page.locator('input[type=password]').count(), 0);
    const checks = page.locator('[data-check]'); assert.equal(await checks.count(), 3);
    await checks.nth(0).check(); await checks.nth(1).check();
    await page.reload(); assert.equal(await checks.nth(0).isChecked(), true); assert.equal(await checks.nth(1).isChecked(), true); assert.equal(await checks.nth(2).isChecked(), false);
    await checks.nth(2).check(); assert.match(await page.locator('#spatial-check-status').textContent(), /직접 확인한/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nonol-spatial-route-preparation:v1')));
    assert.deepEqual(stored, { scan: true, project: true, field: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const [id, file] of [
      ['route', '261009_0355_floor-route.js'], ['bridge', '261009_0355_mattercraft-bridge.js'],
      ['example', '261009_0355_route-example.json'], ['behavior', '261009_0355_MattercraftFloorRoute.ts']
    ]) {
      const downloaded = page.waitForEvent('download'); await page.locator(`#spatial-download-${id}`).click();
      const download = await downloaded; assert.equal(download.suggestedFilename(), file); assert.equal(await download.failure(), null);
      const path = await download.path(); assert.equal(await readFile(path, 'utf8'), await readFile(new URL(`../public/spatial-route/${file}`, import.meta.url), 'utf8'));
    }
    await page.screenshot({ path: new URL(`261009_0355_live-preparation-${width}.png`, output).pathname, fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(apiRequests, []); pages++;
    await context.close();
  }
  const context = await browser.newContext();
  await context.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error('storage disabled'); }; Storage.prototype.setItem = () => { throw new Error('storage disabled'); }; });
  const page = await context.newPage(); await page.goto(`${base}/spatial-route`); await page.locator('#spatial-check-status').waitFor();
  assert.match(await page.locator('#spatial-storage-status').textContent(), /읽지 못/);
  await page.locator('[data-check]').nth(0).check(); assert.match(await page.locator('#spatial-progress').textContent(), /1\/3/); assert.match(await page.locator('#spatial-storage-status').textContent(), /저장하지 못/);
  await context.close();
  console.log(JSON.stringify({ passed: true, mobileWidths: [360, 390], verifiedDownloads: 4, persistedCheckboxes: 3, storageFailure: 'usable', pageErrors: 0, privateApiRequests: 0, pages }));
} finally { await browser.close(); }
