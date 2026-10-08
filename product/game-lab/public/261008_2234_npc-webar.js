import npcPolicy from './261008_2228_npc-policy.js';
import { makeSpirit, placeSpiritAhead } from './npc-ar.js';

let enginePromise;
function loadEngine() {
  if (globalThis.XR8?.run) return Promise.resolve(globalThis.XR8);
  if (!enginePromise) enginePromise = new Promise((resolve, reject) => {
    let settled = false;
    const script = document.createElement('script');
    script.src = npcPolicy.webAR.script; script.async = true;
    script.dataset.preloadChunks = npcPolicy.webAR.chunk;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); window.removeEventListener('xrloaded', ready);
      script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else resolve(globalThis.XR8);
    };
    const ready = () => globalThis.XR8?.run && finish();
    const timer = setTimeout(() => finish(new Error('WebAR 엔진 준비가 늦습니다. 2D로 진행할 수 있어요.')), 25000);
    script.onerror = () => finish(new Error('WebAR 엔진을 불러오지 못했습니다. 2D로 진행할 수 있어요.'));
    window.addEventListener('xrloaded', ready);
    document.head.append(script);
  }).catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}

function releaseScene(resources) {
  if (!resources || resources.cleaned) return;
  resources.cleaned = true;
  for (const object of [resources.spirit]) {
    object?.traverse(child => { child.geometry?.dispose(); for (const material of Array.isArray(child.material) ? child.material : [child.material]) material?.dispose(); });
    object?.removeFromParent();
  }
  resources.light?.removeFromParent();
}

export class NpcWebAR {
  constructor({ onStatus = () => {}, onTouch = () => {}, onFallback = () => {} } = {}) {
    this.onStatus = onStatus; this.onTouch = onTouch; this.onFallback = onFallback;
    this.version = 0; this.starting = false; this.active = false; this.ready = false; this.resources = null;
  }

  status(state, message) {
    this.onStatus({ sensor: 'ar', state, message, provider: 'webar' });
    if (this.resources) this.resources.text.textContent = message;
  }

  async capability() {
    const version = this.version;
    if (globalThis.isSecureContext === false || !globalThis.navigator?.mediaDevices?.getUserMedia) return { supported: false, state: 'missing', message: '현재 브라우저에서 WebAR 카메라를 사용할 수 없습니다. 2D 정령으로 진행해 주세요.' };
    try {
      const [XR8, THREE] = await Promise.all([loadEngine(), import('/vendor/three.module.js')]);
      if (version !== this.version) return { supported: false, state: 'canceled', message: 'WebAR 준비를 종료했습니다.' };
      globalThis.THREE = THREE;
      const allowedDevices = XR8.XrConfig.device().MOBILE_AND_HEADSETS;
      if (XR8.XrDevice?.isDeviceBrowserCompatible && !XR8.XrDevice.isDeviceBrowserCompatible({ allowedDevices })) return { supported: false, state: 'unsupported', message: 'WebAR 엔진의 현재 기기 지원 검사에서 실행할 수 없습니다. 2D 정령으로 진행해 주세요.' };
      this.XR8 = XR8; this.THREE = THREE; this.ready = true;
      return { supported: true, state: 'supported', message: 'WebAR 엔진이 준비됐습니다. 시작 후 카메라 권한과 공간 추적을 확인합니다.' };
    } catch (error) { return { supported: false, state: 'error', message: error.message || 'WebAR 엔진을 준비하지 못했습니다. 2D로 진행해 주세요.' }; }
  }

  start(container) {
    if (this.starting || this.active) return Promise.resolve(false);
    if (!this.ready) { this.status('error', 'WebAR 준비를 완료하지 못했습니다. 카메라 2D로 진행하기를 눌러 주세요.'); return Promise.resolve(false); }
    const version = ++this.version, XR8 = this.XR8, THREE = this.THREE;
    this.starting = true;
    const permissions = [];
    for (const sensor of [globalThis.DeviceMotionEvent, globalThis.DeviceOrientationEvent]) {
      if (typeof sensor?.requestPermission === 'function') {
        try { permissions.push(Promise.resolve(sensor.requestPermission())); }
        catch { permissions.push(Promise.resolve('denied')); }
      }
    }
    const permissionReady = Promise.all(permissions).then(results => { if (results.some(result => result !== 'granted')) throw new Error('움직임 센서 권한이 허용되지 않았습니다. 2D로 진행해 주세요.'); });
    const overlay = document.createElement('div'); overlay.className = 'webar-overlay'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'WebAR 정령'); overlay.setAttribute('aria-modal', 'true');
    const canvas = document.createElement('canvas'); canvas.className = 'webar-canvas'; canvas.setAttribute('aria-label', '공간 추적 카메라');
    const controls = document.createElement('div'); controls.className = 'webar-controls';
    const text = document.createElement('p'); text.setAttribute('role', 'status');
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'WebAR 닫기';
    const fallback = document.createElement('button'); fallback.type = 'button'; fallback.textContent = '카메라 2D로 전환';
    const license = document.createElement('a'); license.href = '/vendor/8thwall/LICENSE'; license.target = '_blank'; license.rel = 'noopener'; license.className = 'webar-license'; license.textContent = '8th Wall © 2026 Niantic Spatial, Inc. / 라이선스 및 보증 조건';
    controls.append(text, close, fallback, license); overlay.append(canvas, controls); container.append(overlay);
    const resources = { overlay, canvas, text, scene: null, spirit: null, stream: null, tracking: false, anchored: false, touched: false, cleaned: false, modules: [], previousFocus: document.activeElement, overflow: document.body.style.overflow };
    this.resources = resources; document.body.style.overflow = 'hidden'; close.focus();
    const resize = () => { canvas.width = innerWidth; canvas.height = innerHeight; };
    resources.resize = resize; resize(); window.addEventListener('resize', resize);
    const current = () => this.resources === resources && version === this.version;
    let resolveStart;
    const opening = new Promise(resolve => { resolveStart = resolve; }); resources.resolve = resolveStart;
    const fail = message => { if (current()) { this.stop(); this.status('error', message); } };
    permissionReady.catch(error => fail(error.message));
    close.addEventListener('click', () => this.stop());
    fallback.addEventListener('click', () => { this.stop(); this.onFallback(); });
    resources.keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); this.stop(); }
      else if (event.key === 'Tab') {
        const first = close, last = license;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', resources.keydown);
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); fail('WebAR 그래픽 연결이 종료됐습니다. 카메라 2D로 진행해 주세요.'); });
    canvas.addEventListener('pointerdown', event => {
      if (!current() || !resources.spirit) return;
      if (!resources.spirit.visible) { this.status('active', '정령을 준비하고 있습니다. 잠시 기다리거나 WebAR을 닫고 다시 생성해 주세요.'); return; }
      const { camera } = XR8.Threejs.xrScene();
      const distance = Math.hypot(camera.position.x - resources.spirit.position.x, camera.position.z - resources.spirit.position.z);
      if (distance > npcPolicy.maxTouchDistanceMeters) { this.status('active', `정령까지 약 ${distance.toFixed(1)}m입니다. 가까이 가서 터치해 주세요.`); return; }
      const box = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, 1 - (event.clientY - box.top) / box.height * 2), camera);
      if (!ray.intersectObject(resources.spirit, true).length) { this.status('active', '화면의 정령을 직접 터치해 주세요.'); return; }
      if (!resources.touched) {
        if (this.onTouch() === false) { this.status('active', '연결과 도착 상태를 확인한 뒤 정령을 다시 터치해 주세요.'); return; }
        resources.touched = true; this.status('active', '정령과 만났습니다. 이야기를 이어갑니다.');
      }
    });
    const module = {
      name: 'nonol-npc-webar',
      onBeforeRun: () => permissionReady.then(() => { if (!current()) throw new Error('WebAR 실행을 종료했습니다.'); }),
      onStart: () => {
        if (!current()) return;
        const { scene, camera } = XR8.Threejs.xrScene(); resources.scene = scene;
        resources.spirit = makeSpirit(THREE);
        resources.light = new THREE.HemisphereLight(0xffffff, 0x667755, 3); scene.add(resources.spirit, resources.light);
        camera.position.set(0, 2, 2); XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
        placeSpiritAhead(THREE, resources.spirit, camera);
        this.starting = false; this.active = true; resolveStart(true);
        this.status('active', '정령을 생성했습니다. 공간 추적을 준비하는 동안에도 정령을 터치할 수 있어요.');
      },
      onUpdate: ({ processCpuResult }) => {
        if (!current() || !resources.spirit) return;
        const reality = processCpuResult?.reality;
        resources.tracking = reality?.trackingStatus === 'NORMAL' && reality.trackingReason !== 'INITIALIZING';
        if (!resources.anchored) {
          placeSpiritAhead(THREE, resources.spirit, XR8.Threejs.xrScene().camera);
          if (resources.tracking) {
            resources.anchored = true;
            this.status('active', `카메라 앞 ${npcPolicy.initialPlacement.distanceMeters}m에 정령을 고정했습니다. 정령을 직접 터치해 주세요.`);
          }
        }
        if (!resources.tracking) {
          if (!resources.timeout) resources.timeout = setTimeout(() => fail('공간 추적을 복구하지 못했습니다. 카메라 2D로 진행해 주세요.'), 30000);
          const message = resources.anchored ? '공간 추적을 다시 확인하고 있습니다. 밝은 곳에서 천천히 움직여 주세요.' : '정령을 생성했습니다. 공간 추적을 준비하는 동안에도 정령을 터치할 수 있어요.';
          if (resources.spirit.visible && text.textContent !== message) this.status('active', message);
          return;
        }
        clearTimeout(resources.timeout); resources.timeout = null;
      },
      onCameraStatusChange: ({ status, stream }) => {
        if (!current()) { stream?.getTracks().forEach(track => track.stop()); return; }
        if (stream) resources.stream = stream;
        if (status === 'failed') fail('WebAR 카메라를 열지 못했습니다. 카메라 2D로 진행해 주세요.');
      },
      onException: () => fail('WebAR 실행 또는 공간 추적에 실패했습니다. 카메라 2D로 진행해 주세요.'),
      onDetach: () => releaseScene(resources), onRemove: () => releaseScene(resources),
    };
    resources.timeout = setTimeout(() => fail('공간 추적을 확인하지 못했습니다. 카메라 2D로 진행하거나 다시 시도해 주세요.'), 30000);
    this.status('requesting', 'WebAR 카메라와 공간 추적을 시작하고 있습니다.');
    try {
      XR8.XrController.configure({ disableWorldTracking: false, scale: 'absolute' });
      resources.modules = [XR8.GlTextureRenderer.pipelineModule(), XR8.Threejs.pipelineModule(), XR8.XrController.pipelineModule(), module];
      XR8.addCameraPipelineModules(resources.modules);
      XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().MOBILE_AND_HEADSETS, cameraConfig: { direction: XR8.XrConfig.camera().BACK } });
    } catch { fail('WebAR 실행을 시작하지 못했습니다. 카메라 2D로 진행해 주세요.'); }
    return opening;
  }

  stop() {
    const version = ++this.version; this.starting = false; this.active = false;
    const resources = this.resources; this.resources = null;
    if (!resources) return;
    clearTimeout(resources.timeout); resources.resolve(false);
    let failed = false;
    const clean = operation => { try { operation(); } catch { failed = true; } };
    try {
      clean(() => this.XR8.stop());
      clean(() => this.XR8.removeCameraPipelineModules(resources.modules.map(module => module.name)));
      clean(() => resources.stream?.getTracks().forEach(track => clean(() => track.stop())));
      clean(() => releaseScene(resources));
    } finally {
      clean(() => window.removeEventListener('resize', resources.resize));
      clean(() => window.removeEventListener('keydown', resources.keydown));
      clean(() => resources.overlay.remove());
      clean(() => { document.body.style.overflow = resources.overflow; });
      clean(() => { if (resources.previousFocus?.isConnected && !resources.previousFocus.disabled) resources.previousFocus.focus(); });
    }
    if (version === this.version) this.status('stopped', failed ? 'WebAR 화면을 정리하지 못했습니다. 카메라가 남으면 새로고침해 주세요.' : 'WebAR을 닫았습니다.');
    return !failed;
  }
}
