import npcPolicy from './261008_2228_npc-policy.js';

export function makeSpirit(THREE) {
  const spirit = new THREE.Group();
  spirit.scale.setScalar(0.65);
  const ink = new THREE.MeshStandardMaterial({ color: 0x24352a, roughness: 0.6 });
  const lime = new THREE.MeshStandardMaterial({ color: 0xd7fb78, roughness: 0.45 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    spirit.add(mesh);
    return mesh;
  };
  add(new THREE.CylinderGeometry(0.21, 0.14, 0.2, 24), ink, 0, 0.12, 0);
  add(new THREE.TorusGeometry(0.21, 0.018, 8, 32), lime, 0, 0.23, 0).rotation.x = Math.PI / 2;
  for (const x of [-0.25, 0.25]) add(new THREE.TorusGeometry(0.065, 0.017, 8, 16), ink, x, 0.15, 0);
  add(new THREE.SphereGeometry(0.15, 24, 16), lime, 0, 0.43, 0);
  add(new THREE.ConeGeometry(0.13, 0.16, 16), lime, 0, 0.32, 0).rotation.z = Math.PI;
  for (const x of [-0.057, 0.057]) {
    add(new THREE.SphereGeometry(0.035, 12, 8), white, x, 0.445, 0.13);
    add(new THREE.SphereGeometry(0.017, 12, 8), ink, x, 0.445, 0.157);
  }
  spirit.visible = false;
  return spirit;
}

export function placeSpiritAhead(THREE, spirit, camera) {
  const { distanceMeters, heightOffsetMeters } = npcPolicy.initialPlacement;
  const forward = new THREE.Vector3(0, 0, -distanceMeters).applyQuaternion(camera.quaternion);
  spirit.position.copy(camera.position).add(forward);
  spirit.position.y += heightOffsetMeters;
  spirit.rotation.y = Math.atan2(camera.position.x - spirit.position.x, camera.position.z - spirit.position.z);
  spirit.visible = true;
}

function disposeScene(resources) {
  if (!resources || resources.cleaned) return;
  resources.cleaned = true;
  resources.renderer.setAnimationLoop(null);
  const geometries = new Set();
  const materials = new Set();
  resources.scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material) materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  resources.renderer.dispose();
  resources.renderer.domElement.remove();
  resources.instructions?.remove();
}

export class NpcAR {
  constructor({ onStatus = () => {}, onTouch = () => {} } = {}) {
    this.onStatus = onStatus;
    this.onTouch = onTouch;
    this.version = 0;
    this.starting = false;
    this.session = null;
    this.resources = null;
    this.policy = npcPolicy;
  }

  status(state, message) {
    this.onStatus({ sensor: 'ar', state, message });
    const text = this.resources?.instructions?.querySelector('p');
    if (text) text.textContent = message;
  }

  async capability() {
    if (globalThis.isSecureContext === false) return { supported: false, state: 'insecure', message: '안전한 연결에서 공간 AR을 확인할 수 있습니다. 현재는 카메라 2D로 진행해 주세요.' };
    if (!globalThis.navigator?.xr?.isSessionSupported || !globalThis.navigator.xr.requestSession) return { supported: false, state: 'missing', message: '이 브라우저에서 현재 방식의 공간 AR 기능을 사용할 수 없습니다. 카메라 2D로 진행해 주세요.' };
    try {
      const supported = await globalThis.navigator.xr.isSessionSupported('immersive-ar');
      return supported === true
        ? { supported: true, state: 'supported', message: '공간 AR 세션을 지원합니다. 실행할 때 권한과 공간 추적을 확인합니다.' }
        : { supported: false, state: 'unsupported', message: '현재 지원 검사에서 공간 AR 세션을 사용할 수 없습니다. 카메라 2D로 진행해 주세요.' };
    } catch {
      return { supported: false, state: 'error', message: '공간 AR 지원 여부를 확인하지 못했습니다. 카메라 2D로 진행해 주세요.' };
    }
  }

  async supported() { return (await this.capability()).supported; }

  async start(container) {
    if (this.starting || this.session) return false;
    if (!globalThis.navigator?.xr?.requestSession) {
      this.status('missing', '이 브라우저에서 공간 AR을 실행할 수 없습니다. 카메라 2D로 진행하기를 눌러 주세요.');
      return false;
    }
    this.starting = true;
    const version = ++this.version;
    this.status('requesting', '공간 AR을 연결하고 있습니다.');
    let session;
    let resources;
    try {
      const request = globalThis.navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: this.policy.requiredXRFeatures, optionalFeatures: this.policy.optionalXRFeatures, domOverlay: { root: container },
      }).then((opened) => {
        if (version !== this.version) {
          opened.end().catch(() => {});
          return null;
        }
        this.session = opened;
        return opened;
      });
      const [opened, THREE] = await Promise.all([request, import('/vendor/three.module.js')]);
      if (!opened || version !== this.version) return false;
      session = opened;
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x667755, 3));
      const camera = new THREE.PerspectiveCamera();
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
      renderer.setSize(container.clientWidth || globalThis.innerWidth, container.clientHeight || globalThis.innerHeight);
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType('local');
      renderer.domElement.setAttribute('aria-hidden', 'true');
      const instructions = document.createElement('div');
      instructions.className = 'ar-instructions';
      const instructionText = document.createElement('p');
      const exit = document.createElement('button');
      exit.type = 'button';
      exit.textContent = 'AR 닫기';
      exit.addEventListener('click', () => this.stop());
      instructions.append(instructionText, exit);
      instructions.addEventListener('beforexrselect', (event) => event.preventDefault());
      container.append(renderer.domElement, instructions);
      const spirit = makeSpirit(THREE);
      scene.add(spirit);
      resources = { renderer, scene, instructions, cleaned: false };
      this.resources = resources;
      const ended = () => {
        disposeScene(resources);
        if (this.session === session) {
          this.session = null;
          this.resources = null;
          this.starting = false;
          this.version += 1;
          this.status('stopped', '공간 AR을 닫았습니다.');
        }
      };
      session.addEventListener('end', ended, { once: true });
      await renderer.xr.setSession(session);
      if (version !== this.version) { disposeScene(resources); return false; }
      const raycaster = new THREE.Raycaster();
      const rayMatrix = new THREE.Matrix4();
      let touched = false;
      session.addEventListener('select', (event) => {
        if (version !== this.version || touched) return;
        if (!spirit.visible) {
          this.status('active', '공간 추적을 준비하고 있습니다. 잠시 기다리거나 AR을 닫고 다시 생성해 주세요.');
          return;
        }
        const reference = renderer.xr.getReferenceSpace();
        const viewerPose = event.frame.getViewerPose(reference);
        if (!viewerPose) return;
        const { x, z } = viewerPose.transform.position;
        const distance = Math.hypot(x - spirit.position.x, z - spirit.position.z);
        if (distance > this.policy.maxTouchDistanceMeters) {
          this.status('active', `정령까지 약 ${distance.toFixed(1)}m입니다. 조금 더 가까이 와 주세요.`);
          return;
        }
        const inputPose = event.frame.getPose(event.inputSource.targetRaySpace, reference);
        if (!inputPose) return;
        rayMatrix.fromArray(inputPose.transform.matrix);
        raycaster.ray.origin.setFromMatrixPosition(rayMatrix);
        raycaster.ray.direction.set(0, 0, -1).transformDirection(rayMatrix);
        if (!raycaster.intersectObject(spirit, true).length) {
          this.status('active', '정령을 가리키고 터치해 주세요.');
          return;
        }
        if (this.onTouch() === false) {
          this.status('active', '아직 만남을 진행할 수 없습니다. 연결과 도착 상태를 확인한 뒤 정령을 다시 터치해 주세요.');
          return;
        }
        touched = true;
        this.status('active', '정령과 만났습니다. 이야기를 이어갑니다.');
      });
      renderer.setAnimationLoop((_time, frame) => {
        if (!frame || version !== this.version) return;
        const reference = renderer.xr.getReferenceSpace();
        const pose = frame.getViewerPose(reference);
        if (pose && !spirit.visible) {
          placeSpiritAhead(THREE, spirit, { position: pose.transform.position, quaternion: pose.transform.orientation });
          this.status('active', `카메라 앞 ${this.policy.initialPlacement.distanceMeters}m에 정령을 생성했습니다. 정령을 직접 터치해 주세요.`);
        }
        renderer.render(scene, camera);
      });
      this.starting = false;
      this.status('active', '공간 추적을 준비하고 있습니다. 카메라 앞에 정령이 곧 나타납니다.');
      return true;
    } catch (error) {
      if (version === this.version) {
        const stoppedVersion = this.version + 1;
        await this.stop();
        if (this.version !== stoppedVersion) return false;
        const denied = ['NotAllowedError', 'SecurityError'].includes(error.name);
        this.status(denied ? 'denied' : 'error', denied
          ? '공간 AR 권한 요청이 허용되지 않았습니다. 카메라 2D로 진행하기를 눌러 주세요.'
          : error.name === 'NotSupportedError' ? '공간 AR을 실행할 수 없습니다. 카메라 2D로 진행하기를 눌러 주세요.'
          : '공간 AR을 시작하지 못했습니다. 카메라 2D로 진행하기를 눌러 주세요.');
      } else disposeScene(resources);
      return false;
    }
  }

  async stop() {
    const hadActive = this.starting || this.session || this.resources;
    const version = ++this.version;
    this.starting = false;
    const session = this.session;
    const resources = this.resources;
    this.session = null;
    this.resources = null;
    if (session) {
      try { await session.end(); } catch {}
    }
    disposeScene(resources);
    if (hadActive && version === this.version) this.status('stopped', '공간 AR을 닫았습니다.');
  }
}
