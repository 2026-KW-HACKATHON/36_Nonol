import { createFloorRoute } from './261009_0355_floor-route.js';

// routeSpace must be a Mattercraft Group under the Immersal anchor.
// Its native element inherits the SDK's tracked child frame through appendChild.
export function createMattercraftRoute({ THREE, anchor, routeSpace, worldTracker, getCamera, config, trackingStatus, goodQuality, onStatus = _result => {}, onComplete = _result => {}, now = () => performance.now() }) {
  if (!anchor?.localized || !anchor?.status || typeof anchor?.onLocalize?.addListener !== 'function' || typeof anchor?.onLocalize?.removeListener !== 'function' || !routeSpace?.element?.isObject3D || !worldTracker?.quality || !worldTracker?.trackingEnabled || typeof getCamera !== 'function' || trackingStatus === undefined || goodQuality === undefined) throw new TypeError('Immersal 앵커와 실제 WorldTracker 및 카메라를 연결해 주세요.');
  if (routeSpace.parent !== anchor) throw new TypeError('경로 그룹을 Immersal 앵커의 바로 아래에 배치해 주세요.');
  if (config?.confirmed !== true || config.coordinateSystem !== 'immersal-map-local-metres' || typeof config.mapId !== 'string' || !config.mapId || config.mapId !== anchor.constructorProps?.mapID) throw new TypeError('스캔 Map ID와 확인한 맵 로컬 경로 설정이 필요합니다.');
  const element = routeSpace.element;
  if (element.position.lengthSq() > 1e-10 || element.quaternion.angleTo(new THREE.Quaternion()) > 1e-5 || element.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-5) throw new TypeError('경로 그룹의 위치와 회전은 0, 크기는 1로 설정해 주세요.');
  let disposed = false, previousStatus = '', needsRelocalization = !anchor.localized.value;
  const floor = createFloorRoute({ THREE, parent: element, config, onComplete: result => { if (!disposed) onComplete({ ...result, mapId: config.mapId, routeId: config.id }); } });
  const position = new THREE.Vector3();
  const trackingReady = () => !anchor.disposed && !routeSpace.disposed && !worldTracker.disposed && anchor.enabledResolved?.value && routeSpace.enabledResolved?.value && worldTracker.enabledResolved?.value && worldTracker.quality.value === goodQuality && worldTracker.trackingEnabled.value;
  const localized = () => { if (!disposed && anchor.localized.value && trackingReady()) needsRelocalization = false; };
  anchor.onLocalize.addListener(localized);
  function report(result) {
    const signature = `${result.state}:${result.nextIndex}`;
    if (!disposed && signature !== previousStatus) { previousStatus = signature; onStatus(result); }
    return result;
  }
  return {
    floor,
    tick() {
      if (disposed) return { state: 'disposed' };
      if (!anchor.localized.value) { needsRelocalization = true; return report(floor.suspend('localizing')); }
      if (!trackingReady() || anchor.status.value !== trackingStatus) { needsRelocalization = true; return report(floor.suspend()); }
      if (needsRelocalization) return report(floor.suspend('localizing'));
      const camera = getCamera();
      if (!camera?.isCamera) return report(floor.suspend('camera-missing'));
      element.updateWorldMatrix(true, false); camera.updateWorldMatrix(true, false);
      const determinant = element.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return report(floor.suspend());
      camera.getWorldPosition(position); element.worldToLocal(position);
      return report(floor.update(position.toArray(), { localized: true, tracking: true, at: now() }));
    },
    pause() { if (!disposed) { needsRelocalization = true; return report(floor.suspend()); } },
    reset() { if (disposed) return; previousStatus = ''; needsRelocalization = true; return report(floor.reset()); },
    dispose() { if (disposed) return; disposed = true; anchor.onLocalize.removeListener(localized); floor.dispose(); }
  };
}
