const EARTH_RADIUS = 6371008.8;
const radians = (degrees) => degrees * Math.PI / 180;
const degrees = (angle) => angle * 180 / Math.PI;
const normalize = (angle) => ((angle % 360) + 360) % 360;

export function validPosition(position) {
  return position && Number.isFinite(position.lat) && Math.abs(position.lat) <= 90
    && Number.isFinite(position.lon) && Math.abs(position.lon) <= 180;
}

function requirePositions(a, b) {
  if (!validPosition(a) || !validPosition(b)) throw new TypeError('유효한 위도와 경도가 필요합니다.');
}

export function distanceMeters(a, b) {
  requirePositions(a, b);
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = radians(b.lon - a.lon);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const haversine = sinLat * sinLat + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * sinLon * sinLon;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(Math.min(1, haversine)), Math.sqrt(Math.max(0, 1 - haversine)));
}

export function bearingDegrees(a, b) {
  requirePositions(a, b);
  const deltaLon = radians(b.lon - a.lon);
  const y = Math.sin(deltaLon) * Math.cos(radians(b.lat));
  const x = Math.cos(radians(a.lat)) * Math.sin(radians(b.lat))
    - Math.sin(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.cos(deltaLon);
  return normalize(degrees(Math.atan2(y, x)));
}

export function angleDifference(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError('유효한 각도가 필요합니다.');
  return Math.abs(((normalize(a) - normalize(b) + 540) % 360) - 180);
}

export function guidance(position, target, heading = null, radius = 25) {
  if (!Number.isFinite(radius) || radius <= 0) throw new TypeError('도착 반경은 양수여야 합니다.');
  if (!validPosition(position) || !validPosition(target)) {
    return { distance: null, bearing: null, turn: null, aligned: null, color: '#8c9390', label: '위치를 먼저 연결해 주세요.' };
  }
  const distance = distanceMeters(position, target);
  const bearing = bearingDegrees(position, target);
  const hasHeading = Number.isFinite(heading);
  const turn = hasHeading ? ((bearing - normalize(heading) + 540) % 360) - 180 : null;
  const aligned = hasHeading ? Math.abs(turn) <= 25 : null;
  const proximity = Math.max(0, 1 - Math.max(0, distance - radius) / (radius * 7));
  const alignment = hasHeading ? Math.max(0, 1 - Math.abs(turn) / 90) : 0;
  const hue = Math.round(120 * proximity * alignment);
  const color = hasHeading ? `hsl(${hue} 65% 50%)` : '#e9ab48';
  let label;
  if (!hasHeading) label = distance <= radius ? '도착 반경 안이에요. 방향 센서를 연결해 주세요.' : '거리만 확인 중이에요. 방향 센서를 연결해 주세요.';
  else if (distance <= radius && aligned) label = '가까워요. 정면에서 목적지를 확인해 주세요.';
  else if (aligned) label = '방향이 맞아요. 가까워질수록 초록색으로 바뀝니다.';
  else label = turn > 0 ? '오른쪽으로 돌아 방향을 맞춰 주세요.' : '왼쪽으로 돌아 방향을 맞춰 주세요.';
  return { distance, bearing, turn, aligned, color, label };
}
