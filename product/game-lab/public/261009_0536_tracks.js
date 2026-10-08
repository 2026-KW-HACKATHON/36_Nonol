import { compressPhoto } from './261008_2138_reference-photo.js';
import { createMapView } from './261009_0536_map-provider.js';
import { Sensors } from './lab-sensors.js';

const $ = selector => document.querySelector(selector);
const placeNames = { welfare: '복지관', square: '광운스퀘어', bima: '비마관 앞', futsal: '풋살장' };
const placeRoles = { welfare: '이층집 역할 / 식사 후 출발', square: '우이천 초입 역할 / 도착과 사진 인증', bima: '솥고집 정령 역할 / 캐릭터와 대화', futsal: '카페 역할 / 탐색 도착과 벌점 정산' };
let track = null, admin = false, busy = false, referenceImage = null, preparing = false, map = null, fileVersion = 0;
let savedDraft = '', mapController = null, draftPlaces = {}, currentGPS = null, gpsState = 'requesting', gpsMessage = '', initialView = false, disposed = false;
const validPoint = point => point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
const freshGPS = () => currentGPS && currentGPS.measuredAt <= Date.now() + 5000 && Date.now() - currentGPS.measuredAt <= 30000;
const sensors = new Sensors({
  onPosition: position => {
    if (disposed || document.visibilityState === 'hidden') return;
    currentGPS = position;
    if (map && !initialView) { map.setView(position, 18); initialView = true; }
    renderGPS(); draw(); controls();
  },
  onStatus: ({ sensor, state, message }) => {
    if (sensor !== 'gps' || disposed) return;
    gpsState = state; gpsMessage = message;
    if (['denied', 'missing'].includes(state)) currentGPS = null;
    renderGPS(); draw(); controls();
  },
});
for (const [id, name] of Object.entries(placeNames)) {
  const row = document.createElement('section'); row.className = 'place-row';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'place-select'; button.dataset.place = id;
  const heading = document.createElement('span'); heading.className = 'place-name'; heading.textContent = name; button.append(heading);
  const status = document.createElement('span'); status.id = `track-${id}-status`; status.className = 'place-status'; button.append(status);
  button.addEventListener('click', () => { $('#track-active-place').value = id; selectPlace(); }); row.append(button);
  const role = document.createElement('p'); role.className = 'place-role'; role.textContent = placeRoles[id]; row.append(role);
  const label = document.createElement('label'); label.textContent = '도착 반경 (m)'; label.htmlFor = `track-${id}-radius`;
  const input = document.createElement('input'); input.id = label.htmlFor; input.type = 'number'; input.step = '1'; input.min = '5'; input.max = '100';
  input.addEventListener('input', () => { draw(); controls(); }); label.append(input); row.append(label); $('#track-place-fields').append(row);
}

async function request(path, method = 'GET', payload) {
  const response = await fetch(path, { method, cache: 'no-store', headers: payload ? { 'Content-Type': 'application/json' } : {}, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || '요청을 처리하지 못했습니다.'), { status: response.status });
  return body;
}

function draft() {
  const places = Object.fromEntries(Object.keys(placeNames).map(id => {
    const radius = $(`#track-${id}-radius`).value.trim();
    return [id, { lat: draftPlaces[id]?.lat ?? null, lon: draftPlaces[id]?.lon ?? null, radius: radius === '' ? null : Number(radius) }];
  }));
  return { places, reference: { label: '에어팟', image: referenceImage }, ending: 'cafe', spatial: { projectUrl: $('#track-spatial-url').value.trim(), mapId: $('#track-spatial-map-id').value.trim() } };
}

function controls() {
  const available = admin && !busy && !preparing;
  for (const input of $('#track-form').querySelectorAll('input, select, button')) input.disabled = !available;
  $('#track-location-connect').disabled = busy || disposed || document.visibilityState === 'hidden';
  $('#track-center-gps').disabled = !map || !freshGPS() || busy;
  $('#track-current-gps').disabled = !available || !freshGPS();
  for (const input of $('#kakao-form').querySelectorAll('input, button')) input.disabled = !admin || busy;
  $('#track-create-room').disabled = !available || track?.status !== 'ready' || savedDraft !== JSON.stringify(draft());
  $('#track-room-title').disabled = !admin || busy;
  $('#track-admin-open').hidden = admin; $('#track-admin-logout').hidden = !admin;
  $('#track-admin-logout').disabled = busy || preparing;
  $('#track-admin-note').textContent = admin ? '관리자 권한으로 코스를 등록합니다.' : '설정과 새 방 생성은 관리자 로그인 후 사용할 수 있습니다.';
}

function showTrack(value) {
  track = value; fileVersion++; preparing = false;
  referenceImage = value.reference.image || null;
  draftPlaces = Object.fromEntries(Object.keys(placeNames).map(id => [id, { lat: value.places[id]?.lat ?? null, lon: value.places[id]?.lon ?? null }]));
  for (const id of Object.keys(placeNames)) $(`#track-${id}-radius`).value = value.places[id]?.radius ?? '';
  $('#track-spatial-url').value = value.spatial.projectUrl; $('#track-spatial-map-id').value = value.spatial.mapId;
  $('#track-reference-file').value = ''; renderReference();
  const missing = Object.keys(placeNames).filter(id => !Number.isFinite(value.places[id]?.lat) || !Number.isFinite(value.places[id]?.lon)).map(id => placeNames[id]);
  const photoMissing = !referenceImage && !value.reference.configured;
  $('#track-state').textContent = value.status === 'ready' ? `${value.title} / v${value.version} / 새 테스트 방을 만들 수 있습니다.` : `${value.title} / 등록 대기: ${[...missing, ...(photoMissing ? ['에어팟 기준 사진'] : [])].join(', ') || '설정 확인'}`;
  $('#track-room-status').textContent = value.status === 'ready' ? '지금 저장한 버전으로 새 방을 만듭니다. 기존 방의 설정은 유지됩니다.' : '네 장소의 기준점과 에어팟 사진을 먼저 저장해 주세요.';
  savedDraft = JSON.stringify(draft()); renderPlaces(); draw(true); controls();
}

function renderPlaces() {
  const active = $('#track-active-place').value;
  for (const id of Object.keys(placeNames)) {
    const assigned = Boolean(validPoint(draftPlaces[id]));
    const status = $(`#track-${id}-status`); status.textContent = assigned ? '지정됨' : '미지정'; status.dataset.assigned = String(assigned);
    $(`[data-place="${id}"]`).setAttribute('aria-pressed', String(id === active));
  }
  $('#track-place-status').textContent = `${placeNames[active]} / ${validPoint(draftPlaces[active]) ? '지정됨. 지도를 다시 눌러 위치를 옮길 수 있어요.' : '미지정. 지도에서 이 장소의 위치를 눌러 주세요.'}`;
}

function selectPlace() {
  renderPlaces(); draw();
  const point = draftPlaces[$('#track-active-place').value];
  if (map && validPoint(point)) { map.setView(point, 18); initialView = true; }
}

function assignPlace(point, source) {
  if (!admin || busy || preparing || disposed || !validPoint(point)) return;
  const id = $('#track-active-place').value;
  draftPlaces[id] = { lat: point.lat, lon: point.lon };
  initialView = true;
  $('#track-place-feedback').textContent = `${placeNames[id]} 위치를 ${source} 지정했습니다. 트랙 설정을 저장해 주세요.`;
  renderPlaces(); draw(); controls();
}

function renderGPS() {
  const fresh = Boolean(freshGPS());
  const status = $('#track-gps-status');
  status.dataset.fresh = String(fresh); status.dataset.measuredAt = currentGPS?.measuredAt ?? '';
  status.textContent = fresh ? `현재 위치가 지도에 표시됩니다. GPS 오차 약 ${Math.round(currentGPS.accuracy)}m / ${Math.max(0, Math.floor((Date.now() - currentGPS.measuredAt) / 1000))}초 전 측정.`
    : currentGPS ? '최신 위치를 기다리고 있습니다. 위치를 다시 연결하거나 지도에서 직접 장소를 지정해 주세요.'
    : `${gpsMessage || '현재 위치를 확인하고 있습니다.'} 지도에서 직접 장소를 지정할 수 있습니다.`;
  $('#track-location-connect').textContent = gpsState === 'requesting' ? '위치 다시 확인' : '현재 위치 다시 연결';
}

function startGPS() {
  if (disposed || document.visibilityState === 'hidden') return;
  currentGPS = null; sensors.startGPS(); renderGPS(); draw(); controls();
}

function renderReference() {
  $('#track-reference-preview').hidden = !referenceImage;
  if (referenceImage) $('#track-reference-preview').src = referenceImage;
  else $('#track-reference-preview').removeAttribute('src');
  $('#track-reference-status').textContent = referenceImage ? '모든 새 방에서 이 원본을 사용합니다.' : track?.reference.configured ? '기준 사진이 저장돼 있습니다. 관리자 로그인 후 원본을 확인할 수 있습니다.' : '등록된 에어팟 기준 원본이 없습니다.';
}

function draw(fit = false) {
  if (!map || !track) return;
  const places = draft().places, active = $('#track-active-place').value;
  const selected = places[active];
  const members = Object.entries(places).filter(([, point]) => validPoint(point)).map(([id, point]) => ({ ...point, id, name: placeNames[id] }));
  if (freshGPS()) members.push({ ...currentGPS, id: 'current-location', name: '현재 위치', mine: true });
  map.draw({ destination: validPoint(selected) ? selected : undefined, radius: selected.radius, members });
  $('#track-map').dataset.gpsMarker = String(Boolean(freshGPS()));
  if (fit) {
    const points = Object.values(places).filter(validPoint);
    if (points.length) { map.fit(points); initialView = true; }
    else if (freshGPS()) { map.setView(currentGPS, 18); initialView = true; }
  }
}

async function openMap() {
  if (disposed) return;
  mapController?.abort();
  const controller = new AbortController(); mapController = controller;
  map?.dispose(); map = null; initialView = false;
  let next;
  try { next = await createMapView($('#track-map'), { signal: controller.signal, center: { lat: 37.619, lon: 127.059 }, zoom: 17,
    onStatus: message => { if (!controller.signal.aborted && !disposed) $('#track-map-status').textContent = message; },
    onClick: point => {
      if (!controller.signal.aborted) assignPlace(point, '지도에서');
    }
  }); } catch (error) { if (controller.signal.aborted) return; throw error; }
  if (controller.signal.aborted) { next?.dispose(); return; }
  map = next;
  draw(true);
}

async function refresh() {
  const [session, data, mapConfig] = await Promise.all([request('/api/admin/session'), request('/api/lab-tracks/kw-silence'), request('/api/map-config')]);
  if (disposed) return;
  admin = session.admin; showTrack(data.track);
  $('#kakao-state').textContent = mapConfig.kakaoJavascriptKey ? 'JavaScript 키가 등록되어 있습니다. 실제 지도 연결 상태는 위 지도에서 확인해 주세요.' : 'JavaScript 키와 SDK 도메인 등록이 필요합니다. 현재는 기존 지도로 표시합니다.';
  $('#kakao-js-key').value = '';
}

$('#track-active-place').addEventListener('change', selectPlace);
$('#track-spatial-url').addEventListener('input', controls); $('#track-spatial-map-id').addEventListener('input', controls);
$('#track-location-connect').addEventListener('click', startGPS);
$('#track-center-gps').addEventListener('click', () => { if (map && freshGPS() && !busy) { map.setView(currentGPS, 18); initialView = true; } });
$('#track-current-gps').addEventListener('click', () => { if (freshGPS()) assignPlace(currentGPS, '현재 위치에'); });

$('#track-reference-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file || !admin) return;
  const version = ++fileVersion; preparing = true; controls(); $('#track-reference-status').textContent = '기준 원본을 준비하고 있습니다.';
  try {
    const image = await compressPhoto(file);
    if (version !== fileVersion || !admin) return;
    referenceImage = image; renderReference(); $('#track-save-status').textContent = '사진을 확인하고 트랙 설정을 저장해 주세요.';
  } catch (error) { if (version === fileVersion) $('#track-reference-status').textContent = error.message; }
  finally { if (version === fileVersion) { preparing = false; controls(); } }
});

$('#track-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!admin || busy || preparing) return;
  busy = true; controls(); $('#track-error').textContent = ''; $('#track-save-status').textContent = '고정 트랙을 저장하고 있습니다.';
  try { const data = await request('/api/lab-tracks/kw-silence', 'PUT', { ...draft(), expectedVersion: track.version }); if (!admin) return; showTrack(data.track); $('#track-save-status').textContent = `v${data.track.version} 설정을 저장했습니다. 기존 방은 이전 코스를 유지합니다.`; }
  catch (error) { $('#track-save-status').textContent = error.message; }
  finally { busy = false; controls(); }
});

$('#track-room-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('#track-create-room').disabled) return;
  busy = true; controls(); $('#track-room-status').textContent = '저장된 버전으로 테스트 방을 만들고 있습니다.';
  try {
    const room = await request('/api/lab-tracks/kw-silence/rooms', 'POST', { title: $('#track-room-title').value.trim(), expectedVersion: track.version });
    if (!admin) return;
    $('#track-room-link').href = room.inviteUrl; $('#track-room-url').value = room.inviteUrl; $('#track-room-result').hidden = false;
    $('#track-room-status').textContent = `고정 코스 v${room.trackVersion} 방을 만들었습니다. 같은 링크를 팀원들에게 공유해 주세요.`; $('#track-room-link').focus();
  } catch (error) { $('#track-room-status').textContent = error.message; }
  finally { busy = false; controls(); }
});
$('#track-copy-link').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#track-room-url').value); $('#track-room-status').textContent = '방 링크를 복사했습니다.'; } catch { $('#track-room-url').focus(); $('#track-room-url').select(); $('#track-room-status').textContent = '선택된 링크를 복사해 주세요.'; } });

$('#kakao-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!admin || busy) return;
  const key = $('#kakao-js-key').value.trim().toLowerCase();
  if (!/^([a-f0-9]{32})?$/.test(key)) { $('#kakao-save-status').textContent = '발급한 JavaScript 키 32자를 입력해 주세요.'; return; }
  busy = true; controls();
  try { const config = await request('/api/map-config', 'PUT', { kakaoJavascriptKey: key }); $('#kakao-js-key').value = ''; $('#kakao-state').textContent = config.configured ? 'JavaScript 키가 등록되어 있습니다. 실제 지도 연결 상태는 위 지도에서 확인해 주세요.' : 'JavaScript 키와 SDK 도메인 등록이 필요합니다. 현재는 기존 지도로 표시합니다.'; $('#kakao-save-status').textContent = key ? '지도 키를 저장했습니다. SDK 도메인과 카카오맵 사용 설정도 확인해 주세요.' : '저장된 지도 키를 해제했습니다.'; await openMap(); }
  catch (error) { $('#kakao-save-status').textContent = error.message; }
  finally { busy = false; controls(); }
});

$('#track-admin-open').addEventListener('click', () => { $('#track-admin-password').value = ''; $('#track-admin-error').textContent = ''; $('#track-admin-dialog').showModal(); $('#track-admin-password').focus(); });
$('#track-admin-close').addEventListener('click', () => $('#track-admin-dialog').close());
$('#track-admin-login').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { await request('/api/admin/session', 'POST', { password: $('#track-admin-password').value }); $('#track-admin-password').value = ''; $('#track-admin-dialog').close(); await refresh(); }
  catch (error) { $('#track-admin-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#track-admin-logout').addEventListener('click', async () => {
  if (busy || preparing) return;
  busy = true; controls();
  try {
    await request('/api/admin/session', 'DELETE');
    admin = false; referenceImage = null; fileVersion++; sensors.stopGPS(); currentGPS = null; gpsState = 'paused'; gpsMessage = '현재 위치 연결을 종료했습니다.';
    renderReference(); renderGPS(); draw(); await refresh();
  } catch (error) { $('#track-error').textContent = error.message; }
  finally { busy = false; controls(); }
});
document.addEventListener('visibilitychange', () => {
  if (disposed) return;
  if (document.visibilityState === 'hidden') { sensors.stopGPS(); currentGPS = null; gpsState = 'paused'; gpsMessage = '화면이 다시 열리면 현재 위치를 새로 확인합니다.'; renderGPS(); draw(); controls(); }
  else startGPS();
});
const freshnessTimer = setInterval(() => {
  if (disposed || document.visibilityState === 'hidden') return;
  const wasFresh = $('#track-gps-status').dataset.fresh === 'true';
  renderGPS(); controls();
  if (wasFresh !== Boolean(freshGPS())) draw();
}, 1000);
window.addEventListener('pagehide', () => { disposed = true; currentGPS = null; sensors.stopGPS(); clearInterval(freshnessTimer); fileVersion++; mapController?.abort(); map?.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
startGPS();
try { await refresh(); await openMap(); } catch (error) { $('#track-error').textContent = error.message; controls(); }
