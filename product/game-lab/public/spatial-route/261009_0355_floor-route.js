// The coordinates are metres in the scanned map's local frame.
export function validateFloorRoute(config) {
  if (!config || !Array.isArray(config.points) || config.points.length < 2 || config.points.length > 256) throw new TypeError('경로 지점을 2개부터 256개까지 지정해 주세요.');
  const points = config.points.map(point => {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) throw new TypeError('경로 좌표는 유한한 x, y, z 값이어야 합니다.');
    return [...point];
  });
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    if (Math.abs(points[index][1] - points[0][1]) > 0.02) throw new TypeError('첫 시험은 같은 높이의 평평한 바닥 경로를 사용해 주세요.');
    const segment = Math.hypot(points[index][0] - points[index - 1][0], points[index][2] - points[index - 1][2]);
    if (segment < 0.05) throw new TypeError('연속 경로 지점은 5cm 이상 떨어져야 합니다.');
    length += segment;
  }
  if (!Number.isFinite(length) || length > 2000) throw new TypeError('시험 경로는 2km 이내로 지정해 주세요.');
  const arrivalRadius = config.arrivalRadius ?? 0.8, arrivalHoldMs = config.arrivalHoldMs ?? 1500, width = config.width ?? 0.35;
  if (![arrivalRadius, arrivalHoldMs, width].every(value => Number.isFinite(value) && value > 0) || width > 2 || arrivalRadius > 5 || arrivalHoldMs > 30000) throw new TypeError('도착 반경, 유지 시간과 길 너비를 확인해 주세요.');
  return { points, arrivalRadius, arrivalHoldMs, width, length };
}

export function createFloorRoute({ THREE, parent, config, onComplete = _result => {} }) {
  const route = validateFloorRoute(config);
  if (!parent?.isObject3D) throw new TypeError('경로를 담을 공간 그룹이 필요합니다.');
  const group = new THREE.Group(); group.name = 'nonol-floor-route'; group.visible = false;
  const material = new THREE.MeshBasicMaterial({ color: 0xd9fc7c, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0x20251d, side: THREE.DoubleSide });
  const segments = [];
  function mesh(vertices, indices, appearance) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices); geometry.computeBoundingSphere();
    return new THREE.Mesh(geometry, appearance);
  }
  for (let index = 1; index < route.points.length; index++) {
    const a = route.points[index - 1], b = route.points[index], distance = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const dx = (b[0] - a[0]) / distance, dz = (b[2] - a[2]) / distance;
    const nx = -dz * route.width / 2, nz = dx * route.width / 2;
    const y = route.points[0][1] + 0.02;
    const segment = new THREE.Group();
    segment.add(mesh([a[0] + nx, y, a[2] + nz, a[0] - nx, y, a[2] - nz, b[0] + nx, y, b[2] + nz, b[0] - nx, y, b[2] - nz], [0, 1, 2, 2, 1, 3], material));
    const cx = (a[0] + b[0]) / 2, cz = (a[2] + b[2]) / 2, size = Math.min(0.25, distance / 4, route.width / 2);
    segment.add(mesh([cx + dx * size, y + 0.005, cz + dz * size, cx - dx * size - dz * size, y + 0.005, cz - dz * size + dx * size, cx - dx * size + dz * size, y + 0.005, cz - dz * size - dx * size], [0, 1, 2], arrowMaterial));
    segments.push(segment); group.add(segment);
  }
  parent.add(group);
  let nextIndex = 1, enteredAt = null, lastAt = null, complete = false, disposed = false;
  function snapshot(state, distance = null) { return { state, nextIndex, waypointCount: route.points.length - 1, distance, completed: complete }; }
  function suspend(state = 'tracking-lost') { group.visible = false; enteredAt = null; lastAt = null; return snapshot(state); }
  function update(position, { localized = false, tracking = false, at = performance.now() } = {}) {
    if (disposed) return snapshot('disposed');
    if (!localized) return suspend('localizing');
    if (!tracking || !Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite) || !Number.isFinite(at)) return suspend();
    if (lastAt !== null && (at < lastAt || at - lastAt > 1000)) enteredAt = null;
    lastAt = at;
    group.visible = !complete;
    if (complete) return snapshot('completed', 0);
    const target = route.points[nextIndex], distance = Math.hypot(position[0] - target[0], position[2] - target[2]);
    if (distance > route.arrivalRadius) enteredAt = null;
    else {
      enteredAt ??= at;
      if (at - enteredAt >= route.arrivalHoldMs) {
        segments[nextIndex - 1].visible = false; nextIndex++; enteredAt = null;
        complete = nextIndex === route.points.length;
        if (complete) { group.visible = false; onComplete({ completed: true, waypointCount: route.points.length - 1 }); return snapshot('completed', 0); }
      }
    }
    return snapshot(enteredAt === null ? 'tracking' : 'arriving', distance);
  }
  return {
    group, update, suspend,
    reset() { if (disposed) return snapshot('disposed'); nextIndex = 1; complete = false; segments.forEach(segment => { segment.visible = true; }); return suspend('localizing'); },
    dispose() { if (disposed) return; disposed = true; group.removeFromParent(); group.traverse(object => object.geometry?.dispose()); material.dispose(); arrowMaterial.dispose(); }
  };
}
