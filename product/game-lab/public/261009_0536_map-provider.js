import { validPosition } from './geo.js';

let sdkPromise = null, sdkKey = null;
const validPoints = points => points.filter(validPosition);
const leafletZoom = zoom => Math.min(19, Math.max(3, Number.isFinite(zoom) ? zoom : 18));
const kakaoLevel = zoom => Math.min(14, Math.max(1, 21 - leafletZoom(zoom)));

async function mapConfiguration() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch('/api/map-config', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('map configuration unavailable');
    const config = await response.json();
    return /^[a-f0-9]{32}$/i.test(config.kakaoJavascriptKey || '') ? config.kakaoJavascriptKey : null;
  } finally { clearTimeout(timeout); }
}

async function loadKakaoSDK(key) {
  if (sdkKey && sdkKey !== key) throw Object.assign(new Error('map key changed'), { code: 'MAP_KEY_CHANGED' });
  if (globalThis.kakao?.maps?.Map) return globalThis.kakao.maps;
  if (!sdkPromise) { sdkKey = key; sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else resolve(globalThis.kakao.maps);
    };
    const timeout = setTimeout(() => finish(new Error('map SDK timeout')), 8000);
    script.onerror = () => finish(new Error('map SDK unavailable'));
    script.onload = () => {
      try {
        if (!globalThis.kakao?.maps?.load) throw new Error('map SDK unavailable');
        globalThis.kakao.maps.load(() => globalThis.kakao?.maps?.Map ? finish() : finish(new Error('map SDK unavailable')));
      } catch (error) { finish(error); }
    };
    document.head.appendChild(script);
  }).catch(error => { sdkPromise = null; sdkKey = null; throw error; }); }
  return sdkPromise;
}

function pointLabel(name, mine = false) {
  const content = document.createElement('span');
  content.className = `map-point-label${mine ? ' map-point-mine' : ''}`;
  content.textContent = name;
  return content;
}

function createKakaoMap(container, { center, zoom, onClick, onStatus }, maps) {
  const map = new maps.Map(container, { center: new maps.LatLng(center.lat, center.lon), level: kakaoLevel(zoom) });
  let disposed = false, overlays = [];
  const latLng = point => new maps.LatLng(point.lat, point.lon);
  const add = overlay => { overlay.setMap(map); overlays.push(overlay); };
  const clear = () => { for (const overlay of overlays) overlay.setMap(null); overlays = []; };
  const click = event => { if (!disposed && onClick) onClick({ lat: event.latLng.getLat(), lon: event.latLng.getLng() }); };
  if (onClick) maps.event.addListener(map, 'click', click);
  container.dataset.mapProvider = 'kakao';
  onStatus?.('카카오 지도 / 연결선과 도착 범위를 표시합니다. 실제 보행 경로는 현장에서 확인해 주세요.');
  const dot = (point, name, mine) => add(new maps.CustomOverlay({ position: latLng(point), content: pointLabel(name, mine), yAnchor: .5, zIndex: mine ? 4 : 3 }));
  return {
    provider: 'kakao',
    draw({ start, destination, radius, members = [] }) {
      if (disposed) return;
      clear();
      if (validPosition(start) && validPosition(destination)) add(new maps.Polyline({ path: [latLng(start), latLng(destination)], strokeWeight: 2, strokeColor: '#386319', strokeOpacity: 1, strokeStyle: 'dash' }));
      if (validPosition(destination)) {
        if (Number.isFinite(radius) && radius > 0) add(new maps.Circle({ center: latLng(destination), radius, strokeWeight: 2, strokeColor: '#386319', fillColor: '#d7fb78', fillOpacity: .25 }));
        dot(destination, '목적지', false);
      }
      if (validPosition(start)) dot(start, '출발', true);
      for (const member of members.filter(validPosition)) {
        dot(member, `${member.name}${member.mine ? ' (나)' : ''}`, member.mine);
        if (member.mine && Number.isFinite(member.accuracy) && member.accuracy >= 0) add(new maps.Circle({ center: latLng(member), radius: member.accuracy, strokeWeight: 1, strokeColor: '#171b16', fillColor: '#171b16', fillOpacity: .08 }));
      }
    },
    setView(point, nextZoom = zoom) { if (!disposed && validPosition(point)) { map.setCenter(latLng(point)); map.setLevel(kakaoLevel(nextZoom)); } },
    fit(points) {
      if (disposed) return;
      const usable = validPoints(points);
      if (!usable.length) return;
      if (usable.length === 1) { this.setView(usable[0]); return; }
      const bounds = new maps.LatLngBounds();
      usable.forEach(point => bounds.extend(latLng(point)));
      map.setBounds(bounds, 35, 35, 35, 35);
    },
    invalidate() { if (!disposed) map.relayout(); },
    dispose() {
      if (disposed) return;
      disposed = true; clear();
      if (onClick) maps.event.removeListener(map, 'click', click);
      container.replaceChildren(); delete container.dataset.mapProvider;
    },
  };
}

function createLeafletMap(container, { center, zoom, onClick, onStatus }, notice) {
  const L = globalThis.L;
  if (!L?.map) throw new Error('지도를 불러오지 못했습니다. 새로고침해 주세요.');
  let disposed = false;
  const map = L.map(container, { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([center.lat, center.lon], leafletZoom(zoom), { animate: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'strict-origin', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map)
    .on('tileerror', () => { if (!disposed) onStatus?.(`${notice} 지도 배경 연결도 지연되고 있습니다. 좌표와 도착 범위는 표시합니다.`); });
  const layers = L.layerGroup().addTo(map);
  const click = event => { if (!disposed) onClick?.({ lat: event.latlng.lat, lon: event.latlng.lng }); };
  if (onClick) map.on('click', click);
  container.dataset.mapProvider = 'leaflet'; onStatus?.(notice);
  const marker = (point, name, mine) => L.circleMarker([point.lat, point.lon], { radius: mine ? 9 : 7, color: '#fff', fillColor: mine ? '#171b16' : '#386319', fillOpacity: 1, weight: 2 }).bindTooltip(pointLabel(name, mine)).addTo(layers);
  return {
    provider: 'leaflet',
    draw({ start, destination, radius, members = [] }) {
      if (disposed) return;
      layers.clearLayers();
      if (validPosition(start) && validPosition(destination)) L.polyline([[start.lat, start.lon], [destination.lat, destination.lon]], { color: '#386319', dashArray: '6 8' }).addTo(layers);
      if (validPosition(destination)) {
        if (Number.isFinite(radius) && radius > 0) L.circle([destination.lat, destination.lon], { radius, color: '#386319', fillColor: '#d7fb78', fillOpacity: .25 }).addTo(layers);
        marker(destination, '목적지', false);
      }
      if (validPosition(start)) marker(start, '출발', true);
      for (const member of members.filter(validPosition)) {
        marker(member, `${member.name}${member.mine ? ' (나)' : ''}`, member.mine);
        if (member.mine && Number.isFinite(member.accuracy) && member.accuracy >= 0) L.circle([member.lat, member.lon], { radius: member.accuracy, color: '#171b16', weight: 1, fillOpacity: .08 }).addTo(layers);
      }
    },
    setView(point, nextZoom = zoom) { if (!disposed && validPosition(point)) map.setView([point.lat, point.lon], leafletZoom(nextZoom), { animate: false }); },
    fit(points) { const usable = validPoints(points); if (!disposed && usable.length) map.fitBounds(usable.map(point => [point.lat, point.lon]), { padding: [35, 35], maxZoom: 18, animate: false }); },
    invalidate() { if (!disposed) map.invalidateSize({ animate: false, pan: false }); },
    dispose() { if (disposed) return; disposed = true; map.stop?.(); map.remove(); delete container.dataset.mapProvider; },
  };
}

export async function createMapView(container, { center, zoom = 18, onClick, onStatus, signal } = {}) {
  if (!container || !validPosition(center)) throw new TypeError('지도를 표시할 요소와 유효한 중심 좌표가 필요합니다.');
  onStatus?.('카카오 지도 설정을 확인하고 있습니다.');
  let maps, notice = '카카오 지도 키를 연결하면 카카오 지도가 표시됩니다. 현재는 대체 지도로 좌표와 도착 범위를 시험합니다.';
  try {
    const key = await mapConfiguration();
    if (key) maps = await loadKakaoSDK(key);
  } catch (error) { notice = error.code === 'MAP_KEY_CHANGED' ? '카카오 지도 키가 변경됐습니다. 새로고침하면 새 키로 연결합니다. 현재는 대체 지도를 표시합니다.' : '카카오 지도 연결을 확인하지 못해 대체 지도를 표시합니다. 키와 허용된 웹 도메인을 확인해 주세요.'; }
  if (signal?.aborted) throw new DOMException('지도 표시를 취소했습니다.', 'AbortError');
  if (maps) {
    try { return createKakaoMap(container, { center, zoom, onClick, onStatus }, maps); }
    catch { container.replaceChildren(); notice = '카카오 지도 화면을 초기화하지 못해 대체 지도를 표시합니다. 새로고침 후 다시 확인해 주세요.'; }
  }
  return createLeafletMap(container, { center, zoom, onClick, onStatus }, notice);
}
