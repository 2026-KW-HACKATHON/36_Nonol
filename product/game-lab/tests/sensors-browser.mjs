import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.ROOM_BASE_URL || 'http://localhost:8791';
const key = process.env.ROOM_ADMIN_KEY || (await readFile(new URL('../.dev.vars',import.meta.url),'utf8')).match(/^ROOM_ADMIN_KEY=(.+)$/m)?.[1];
const browser = await chromium.launch({headless:true}); const errors=[], ownedRooms=new Set();
const unavailableWebAR = `export class NpcWebAR {
  starting = false; active = false;
  async capability() { return { supported: false, state: 'unsupported', message: '브라우저 회귀 환경의 WebAR 미지원, 카메라 2D로 진행합니다.' }; }
  async start() { return false; }
  stop() { this.starting = false; this.active = false; }
}`;
function mockedWebAR(mode) {
  if (mode === 'unavailable') return unavailableWebAR;
  return `export class NpcWebAR {
    starting = false; active = false;
    constructor({ onStatus }) { this.onStatus = onStatus; window.__webarStarts = 0; window.__webarStops = 0; }
    async capability() { return { supported: true, state: 'supported', message: '브라우저 모의 WebAR 엔진 준비 완료' }; }
    start() {
      window.__webarStarts++; this.starting = true;
      if (${JSON.stringify(mode)} === 'failed') { this.starting = false; this.onStatus({ sensor: 'ar', provider: 'webar', state: 'error', message: '모의 WebAR 실행 실패, 2D로 진행해 주세요.' }); return Promise.resolve(false); }
      this.active = true; this.starting = false; this.onStatus({ sensor: 'ar', provider: 'webar', state: 'active', message: '모의 WebAR 공간 추적' }); return Promise.resolve(true);
    }
    stop() { if (this.starting || this.active) { window.__webarStops++; this.onStatus({ sensor: 'ar', provider: 'webar', state: 'stopped', message: '모의 WebAR 종료' }); } this.starting = false; this.active = false; }
  }`;
}
async function setup(name,options={},xrMode=null,webarMode='unavailable') {
  const response=await fetch(`${base}/api/rooms`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({title:name,track:'lab'})}); assert.equal(response.status,201); const room=await response.json(); ownedRooms.add(room.roomId);
  const readBack=await fetch(`${base}/api/rooms/${room.roomId}`); assert.equal(readBack.status,200,'생성한 실험 방의 조회가 성공해야 합니다.'); const summary=await readBack.json(); assert.equal(summary.track,'lab','생성한 방은 실험 트랙으로 조회되어야 합니다.');
  const context=await browser.newContext({viewport:{width:390,height:844},permissions:['geolocation'],geolocation:{latitude:37.6194,longitude:127.0595,accuracy:3},...options});
  await context.route(/\/api\/map-config$/, route => route.fulfill({contentType:'application/json',body:JSON.stringify({provider:'kakao',kakaoJavascriptKey:null,configured:false})}));
  await context.route(/\/261008_2234_npc-webar\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: mockedWebAR(webarMode) }));
  if (xrMode) await context.addInitScript(mode => {
    window.__cameraRequests = 0; window.__arRequests = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { window.__cameraRequests++; throw new DOMException('Denied', 'NotAllowedError'); } });
    Object.defineProperty(navigator, 'xr', { configurable: true, value: {
      async isSessionSupported() { if (mode === 'error') throw new Error('XR capability unavailable'); return true; },
      async requestSession() { window.__arRequests++; throw new DOMException('Denied', 'NotAllowedError'); },
    } });
  }, xrMode);
  await context.addInitScript(()=>{const Original=window.WebSocket; window.WebSocket=class extends Original {constructor(...args){super(...args);this.addEventListener('message',event=>{if(event.data==='pong')return;const m=JSON.parse(event.data);if(m.type==='state'){window.__state=m.state;window.__self=m.selfId;}});}};});
  const page=await context.newPage(); page.on('pageerror',error=>errors.push(error.message)); await page.goto(room.inviteUrl); await page.locator('#nickname').fill(name); await page.locator('#join-button').click(); await page.locator('#lobby').waitFor({state:'visible'}); return {page,context};
}
async function click(page,selector){await page.waitForFunction(selector=>document.querySelector(selector)&&!document.querySelector(selector).disabled,selector);await page.locator(selector).click();}
async function start(page){await click(page,'#ready-button');await click(page,'#start-button');await page.waitForURL(url=>url.pathname==='/lab');await page.locator('#map-panel').waitFor({state:'visible'});}
async function stage(page,value){await page.waitForFunction(value=>window.__state.lab.stage===value,value);}
async function reachNpc(page) {
  await start(page); await click(page, '#steps button[data-stage="npc"]'); await stage(page, 'npc');
}
try{
  const {page,context}=await setup('GPS 모드',{permissions:['geolocation'],geolocation:{latitude:37.5,longitude:127,accuracy:5}});
  await start(page);
  await page.locator('#module-settings-editor summary').click();
  assert.equal(await page.locator('#module-config-form input[data-config="start.lat"], #module-config-form input[data-config="destination.lat"]').count(),0,'장소 설정은 좌표 입력 없이 지도로 진행해야 합니다.');
  await page.waitForFunction(()=>document.querySelector('#module-location-map').dataset.mapProvider==='leaflet');
  const previousDestination = await page.locator('#module-destination-status').textContent();
  await click(page,'#module-location-role button[data-location-role="start"]');
  await context.setGeolocation({latitude:37.5,longitude:127,accuracy:5});
  await click(page,'#module-current-start'); await page.waitForFunction(()=>document.querySelector('#module-config-status').textContent.includes('출발지를 현재 위치로 지정했어요'));
  await page.waitForFunction(()=>document.querySelector('#module-location-map').dataset.currentLocation==='gps');
  assert.match(await page.locator('#module-map-gps-status').textContent(),/내 위치가 지도에 표시/);
  assert.equal(await page.locator('#module-destination-status').textContent(),previousDestination,'출발 역할의 현재 GPS는 목적지를 변경하지 않아야 합니다.');
  const currentStart = await page.locator('#module-start-status').textContent();
  await click(page,'#module-map-current');
  assert.equal(await page.locator('#module-start-status').textContent(),currentStart,'내 위치로 지도 중심 이동은 출발핀을 변경하지 않아야 합니다.');
  assert.equal(await page.locator('#module-destination-status').textContent(),previousDestination,'내 위치로 지도 중심 이동은 목적핀을 변경하지 않아야 합니다.');
  await click(page,'#module-location-role button[data-location-role="destination"]');
  await page.locator('#module-radius').fill('10');
  const bounds = await page.locator('#module-location-map').boundingBox();
  await page.locator('#module-location-map').click({position:{x:bounds.width*.8,y:bounds.height*.15}});
  await page.waitForFunction(()=>document.querySelector('#module-config-status').textContent.includes('목적지를 골랐어요'));
  assert.equal(await page.locator('#module-start-status').textContent(),currentStart,'목적지 지도 탭은 출발핀을 변경하지 않아야 합니다.');
  const previousRun = await page.evaluate(()=>window.__state.lab.runId);
  await page.locator('#module-config-form button[type=submit]').click(); await page.waitForFunction(run=>window.__state.lab.runId!==run,previousRun);
  const course=await page.evaluate(()=>window.__state.lab.moduleConfigs.map);
  assert.deepEqual(course.start,{lat:37.5,lon:127});
  assert.notDeepEqual(course.destination,course.start,'지도에서 고른 목적지는 현재 출발점과 분리되어야 합니다.');
  assert.equal(course.radius,10);
  assert.equal(await page.locator('#simulator').count(),0); await page.waitForFunction(()=>window.__state.lab.positions[window.__self]?.source==='gps');
  assert.equal(await page.locator('#map-complete').isDisabled(),true, 'departure GPS cannot immediately complete the map');
  assert.equal(await page.evaluate(()=>window.__state.lab.positions[window.__self].heading),null);
  await context.setGeolocation({latitude:course.destination.lat,longitude:course.destination.lon,accuracy:100}); await page.waitForFunction(()=>window.__state.lab.positions[window.__self].accuracy===100); assert.equal(await page.locator('#map-complete').isDisabled(),true);
  await context.setGeolocation({latitude:course.destination.lat,longitude:course.destination.lon,accuracy:5});
  await context.clearPermissions(); await page.locator('#gps-start').click(); await page.waitForFunction(()=>document.querySelector('#sensor-status').textContent.includes('권한이 꺼져'));
  await context.grantPermissions(['geolocation']); await page.locator('#gps-start').click(); await page.waitForFunction(()=>document.querySelector('#sensor-status').textContent.includes('실제 위치 연결됨'));
  await click(page,'#map-complete'); await stage(page,'photo'); assert.equal(await page.locator('#fake-photo').count(),0, 'only actual image verification is available');
  const other=await setup('카메라 거절'); await other.context.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>Promise.reject(new DOMException('Denied','NotAllowedError'))});}); await other.page.reload(); await other.page.locator('#lobby').waitFor({state:'visible'}); await start(other.page);
  await click(other.page, '#steps button[data-stage="npc"]'); await stage(other.page,'npc');
  assert.equal(await other.page.locator('#ar-start').isVisible(), true);
  await click(other.page, '#ar-start');
  await other.page.waitForFunction(()=>document.querySelector('#camera-status').textContent.includes('권한이 꺼져'));
  assert.equal(await other.page.evaluate(()=>document.querySelector('#camera').srcObject),null);
  assert.match(await other.page.locator('#npc-mode').textContent(), /2D/);
  assert.ok((await other.page.locator('#ar-capability').textContent()).trim());
  assert.ok((await other.page.locator('#npc-instructions').textContent()).trim());
  await click(other.page, '#camera-start');
  await other.page.waitForFunction(()=>document.querySelector('#camera-status').textContent.includes('권한이 꺼져'));
  assert.equal(await other.page.evaluate(()=>document.querySelector('#camera').srcObject),null);
  for (const mode of ['error', 'denied']) {
    const mocked = await setup(`모의 WebXR ${mode}`, {}, mode); await reachNpc(mocked.page);
    await click(mocked.page, '#ar-start');
    if (mode === 'denied') {
      await mocked.page.waitForFunction(() => document.querySelector('#ar-status').textContent.includes('권한 요청이 허용되지'));
      assert.deepEqual(await mocked.page.evaluate(() => ({ ar: window.__arRequests, camera: window.__cameraRequests })), { ar: 1, camera: 0 });
      assert.match(await mocked.page.locator('#npc-mode').textContent(), /2D/);
      assert.equal(await mocked.page.locator('#npc-touch').isVisible(), false);
      await click(mocked.page, '#camera-start');
      assert.equal(await mocked.page.locator('#npc-touch').isVisible(), true);
    } else {
      assert.match(await mocked.page.locator('#ar-capability').textContent(), /WebAR 미지원/);
      assert.match(await mocked.page.locator('#npc-mode').textContent(), /2D/);
      assert.equal(await mocked.page.evaluate(() => window.__arRequests), 0);
    }
    await mocked.page.waitForFunction(() => window.__cameraRequests === 1 && document.querySelector('#camera-status').textContent.includes('권한이 꺼져'));
    assert.equal(await mocked.page.locator('#ar-start').isVisible(), true);
    assert.equal(await mocked.page.evaluate(() => document.querySelector('#camera').srcObject), null);
    await click(mocked.page, '#npc-touch');
    for (let step = 0; step < 3; step++) await click(mocked.page, '#story-next');
    await stage(mocked.page, 'ar-route');
    await mocked.context.close();
  }
  for (const mode of ['active', 'failed']) {
    const mocked = await setup(`모의 WebAR ${mode}`, {}, 'error', mode); await reachNpc(mocked.page);
    assert.equal(await mocked.page.locator('#ar-start').textContent(), '정령 생성하기');
    await click(mocked.page, '#ar-start');
    await mocked.page.waitForFunction(() => window.__webarStarts === 1);
    assert.equal(await mocked.page.evaluate(() => window.__arRequests), 0);
    assert.equal(await mocked.page.evaluate(() => window.__cameraRequests), 0);
    assert.match(await mocked.page.locator('#npc-mode').textContent(), mode === 'active' ? /WebAR/ : /2D/);
    if (mode === 'active') {
      const oldRun = await mocked.page.evaluate(() => window.__state.lab.runId);
      await click(mocked.page, '#stage-reset');
      await mocked.page.waitForFunction(run => window.__state.lab.runId !== run, oldRun);
      await stage(mocked.page, 'npc');
      assert.equal(await mocked.page.evaluate(() => window.__webarStops), 1);
      assert.equal(await mocked.page.locator('#story').isVisible(), false);
      await click(mocked.page, '#ar-start');
      await mocked.page.waitForFunction(() => window.__webarStarts === 2);
      assert.match(await mocked.page.locator('#npc-mode').textContent(), /WebAR/);
    }
    await click(mocked.page, '#camera-start');
    await mocked.page.waitForFunction(() => window.__cameraRequests === 1 && document.querySelector('#camera-status').textContent.includes('권한이 꺼져'));
    if (mode === 'active') assert.equal(await mocked.page.evaluate(() => window.__webarStops), 2);
    assert.equal(await mocked.page.locator('#npc-touch').isVisible(), true);
    await click(mocked.page, '#npc-touch');
    for (let step = 0; step < 3; step++) await click(mocked.page, '#story-next');
    await stage(mocked.page, 'ar-route');
    await mocked.context.close();
  }
  assert.deepEqual(errors,[]); console.log(JSON.stringify({status:'passed',base,checks:['browser-GPS-path','map-first-no-coordinate-input','departure-role-current-GPS','map-current-center-preserves-pins','destination-role-map-tap','physical-separated-course','automatic-GPS-on-map-entry','no-arrival-at-departure','accuracy-gating','permission-denial','GPS-permission-retry','GPS-only-no-fake-photo-verdict','camera-denial','unsupported-primary-2D','mocked-XR-capability-error-2D','mocked-XR-permission-denial-explicit-2D','mocked-WebAR-provider-choice','mocked-WebAR-failure-explicit-2D','mocked-WebAR-stage-reset-restarts-session','mocked-WebAR-session-2D-cleanup','2D-story-completion']}));
}finally{await browser.close(); for(const id of ownedRooms) await fetch(`${base}/api/rooms/${id}`,{method:'DELETE',headers:{Origin:base,Authorization:`Bearer ${key}`}});}
