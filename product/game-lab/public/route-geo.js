import { distanceMeters, bearingDegrees, validPosition } from './geo.js';

export function projectRoute(position, target, {
  mode = 'gps', heading = null, radius = 25, horizontalFov = 60,
  maxAccuracy = 100, positionStale = false, headingStale = false
} = {}) {
  if (!Number.isFinite(radius) || radius <= 0) throw new TypeError('도착 반경은 양수여야 합니다.');
  if (!Number.isFinite(horizontalFov) || horizontalFov <= 0 || horizontalFov >= 180) {
    throw new TypeError('화면 시야각은 0도보다 크고 180도보다 작아야 합니다.');
  }
  if (!Number.isFinite(maxAccuracy) || maxAccuracy <= 0) throw new TypeError('위치 정확도 기준은 양수여야 합니다.');
  const result = {
    mode: mode === 'simulation' ? 'simulation' : 'gps',
    state: 'missing-position', distance: null, bearing: null, turn: null,
    arrived: false, markerVisible: false, onScreen: false, markerPercent: 50,
    edge: null, direction: '위치를 연결해 주세요.', message: '현재 위치를 기다리고 있어요.'
  };
  if (!validPosition(target)) {
    return { ...result, state: 'missing-target', direction: '경유점 정보를 확인해 주세요.', message: '경유점 위치를 사용할 수 없어요.' };
  }
  if (!validPosition(position) || positionStale) return result;
  if (result.mode === 'gps' && (!Number.isFinite(position.accuracy) || position.accuracy < 0 || position.accuracy > maxAccuracy)) {
    return { ...result, state: 'inaccurate-position', direction: '위치가 정확해질 때까지 기다려 주세요.', message: 'GPS 정확도가 부족해 방향과 거리를 잠시 숨겼어요.' };
  }
  result.distance = distanceMeters(position, target);
  result.bearing = bearingDegrees(position, target);
  result.arrived = result.distance <= radius;
  if (result.arrived) {
    return { ...result, state: 'arrived', direction: '도착 반경 안이에요.', message: '주변을 확인하고 경유점 도착 버튼을 눌러 주세요.' };
  }
  if (!Number.isFinite(heading) || headingStale) {
    return { ...result, state: 'missing-heading', direction: '거리만 확인할 수 있어요.', message: '방향 센서를 연결하거나 다시 방향을 측정해 주세요.' };
  }
  const turn = ((result.bearing - heading % 360 + 540) % 360 + 360) % 360 - 180;
  const halfFov = horizontalFov / 2;
  const onScreen = Math.abs(turn) <= halfFov;
  const offset = onScreen ? Math.tan(turn * Math.PI / 180) / Math.tan(halfFov * Math.PI / 180) : Math.sign(turn);
  const markerPercent = Math.max(8, Math.min(92, 50 + offset * 42));
  let direction = '정면으로 이동해 주세요.';
  if (Math.abs(turn) > 12) direction = turn > 0 ? '오른쪽으로 돌아 주세요.' : '왼쪽으로 돌아 주세요.';
  if (Math.abs(turn) >= 150) direction = turn > 0 ? '뒤쪽이에요. 오른쪽으로 돌아 주세요.' : '뒤쪽이에요. 왼쪽으로 돌아 주세요.';
  return {
    ...result, state: 'ready', turn, onScreen, markerPercent, markerVisible: true,
    edge: onScreen ? null : turn > 0 ? 'right' : 'left', direction,
    message: result.mode === 'simulation'
      ? '가상 위치와 방향으로 카메라 위 안내를 시험하고 있어요.'
      : 'GPS와 방향 센서로 카메라 위에 경유점 방향을 표시해요.'
  };
}
