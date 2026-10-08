import { guidance } from './geo.js';
import { validWalkingCourse } from './261008_2355_course-geo.js';
import { Sensors } from './lab-sensors.js';
import { NpcAR } from './npc-ar.js';
import { NpcWebAR } from './261008_2234_npc-webar.js';
import { RouteAR } from './route-ar.js';
import { routePoints } from './route-course.js';
import { ReferencePhoto, compressPhoto } from './261008_2138_reference-photo.js';
import { ModuleSettings } from './261009_0513_module-settings.js';
import { createMapView } from './261009_0536_map-provider.js';

const $ = selector => document.querySelector(selector);
const roomId = new URLSearchParams(location.search).get('room');
const lobbyUrl = `/?room=${encodeURIComponent(roomId || '')}`;
const storageKey = `nonol-room:${roomId}`;
let leavingRoom = false;
let identity;
try { identity = JSON.parse(localStorage.getItem(storageKey)); } catch { identity = null; }
if (!identity?.participantId) location.replace(lobbyUrl);
const defaultStages = ['map', 'photo', 'silence', 'npc', 'ar-route', 'finder', 'ending'];
let stages = [...defaultStages];
const labels = { map: '지도', photo: '사진', silence: '묵언', npc: '정령', 'ar-route': 'AR 길', finder: '탐색', ending: '벌점 정산' };
const copy = {
  map: ['다음 장소로, 같이.', '지도에서 내 위치와 팀원을 확인하세요. 다음 목적지에 도착하면 각자 도착했어요를 눌러 주세요.'],
  photo: ['같은 물체, 맞나요?', '기준 물체를 크게 찍어 주세요. 각자의 물체 인식이 끝나면 함께 다음 모듈로 이동합니다.'],
  silence: ['지금부터, 묵언.', '말은 아껴도 신고는 가능해요. 팀원끼리 벌점을 주고, 모두 묵언 구간을 마치면 정령을 만납니다.'],
  npc: ['솥고집 정령, 발견.', '목적지에 가까이 가서 정령을 터치하세요. 이야기는 각자 읽고, 모두 읽으면 함께 출발합니다.'],
  'ar-route': ['바닥에 붙는 길, 시험.', '공간 스캔과 연결한 AR 프로젝트에서 바닥 경로를 확인하세요. 카메라 방향 안내도 별도로 비교할 수 있어요.'],
  finder: ['지도 없이, 느낌대로.', '숫자는 가까워질수록 작아져요. 방향이 맞고 가까워지면 화면이 초록색으로 바뀝니다.'],
  ending: ['벌점 정산, 결과 공개.', '묵언 신고를 모아 팀과 개인의 최종 결과를 확인합니다.']
};
const defaultStory = ['밥은 든든히 먹었나? 나는 솥고집 정령. 말 대신 눈치로 여기까지 왔군.', '벌점은 내가 전부 보고 있었다. 많이 받았다고 지금 알려 주지는 않지.', '카메라로 두 경유점을 먼저 찾아 보게. 그다음 마지막 장소는 지도 없이 찾아야 할 거야.'];
let story = [...defaultStory];
let state = null, ws = null, connected = false, reconnectTimer, attempt = 0, lastMessageAt = 0;
let shownRun = null, shownStage = null, map = null, mapController = null, mapVersion = 0, mapDrawKey = null, photoData = null, photoBusy = false, fileVersion = 0;
let localPosition = null, localHeading = null, queuedPosition = null, lastPositionSent = 0, storyIndex = 0;
let photoController = null, photoGeneration = 0;
let photoPickerContext = null, photoMissionActive = false;
let npcSupport = null, npcMode = 'idle', npcChoiceVersion = 0, npcCameraStarting = false;
let gpsNeedsReconnect = false;
let stageControlError = '';
let npcCleanupNotice = '';
let reportMemberKey = null;
const pending = new Map();
const moduleSettings = new ModuleSettings({ getIdentity: () => identity, send });
const referencePhoto = new ReferencePhoto({ roomId, getIdentity: () => identity, onExpired: returnToEntry, onChange: renderPhotoCopy });
const sensors = new Sensors({ onPosition: position => { if (!state || !['map', 'npc', 'ar-route', 'finder'].includes(state.lab.stage) || position.source !== 'gps') return; gpsNeedsReconnect = false; localPosition = position; queuePosition(position); }, onHeading: heading => { localHeading = heading; updateGuidance(); }, onStatus: status => {
  if (status.sensor === 'heading' && status.state !== 'active') { localHeading = null; updateGuidance(); }
  const target = status.sensor === 'camera' ? '#camera-status' : status.sensor === 'ar' ? '#ar-status' : '#sensor-status';
  $(target).textContent = status.message;
  if (status.sensor === 'camera') $('#route-camera-status').textContent = status.message;
} });
const routeAR = new RouteAR({ container: $('#route-overlay'), marker: $('#route-marker'), distance: $('#route-distance'), direction: $('#route-direction'), status: $('#route-status') });
function onNpcARStatus(status) {
  if (leavingRoom || state?.lab.stage !== 'npc') return;
  $('#ar-status').textContent = status.message;
  if (status.state === 'active') npcMode = status.provider === 'webar' ? 'webar' : 'ar';
  else if (['denied', 'error', 'missing'].includes(status.state)) npcMode = 'fallback';
  else if (status.state === 'stopped' && ['ar', 'webar', 'starting'].includes(npcMode)) npcMode = 'idle';
  $('#ar-stop').hidden = !ar.session && !webar.active;
  updateNpcPresentation(); updateControls();
}
const touchNpc = () => near() && state?.lab.stage === 'npc' && send({ type: 'lab:npc-touch' });
const ar = new NpcAR({ onStatus: onNpcARStatus, onTouch: touchNpc });
const webar = new NpcWebAR({ onStatus: onNpcARStatus, onTouch: touchNpc, onFallback: startNpc2D });
function stopNpcAR() {
  const run = state?.lab.runId, choice = npcChoiceVersion;
  const warn = () => {
    if (leavingRoom || state?.lab.runId !== run || npcChoiceVersion !== choice) return;
    npcCleanupNotice = '정령 화면을 정리하지 못했습니다. 카메라가 남으면 새로고침해 주세요.';
    updateControls();
  };
  for (const provider of [ar, webar]) {
    try { Promise.resolve(provider.stop()).then(result => { if (result === false) warn(); }, warn); }
    catch { warn(); }
  }
}
async function prepareNpcAR(run) {
  const current = () => !leavingRoom && state?.lab.stage === 'npc' && state.lab.runId === run;
  const native = await ar.capability();
  if (!current()) return;
  let result = { ...native, provider: 'native' };
  if (!native.supported) {
    $('#ar-capability').textContent = '기본 공간 AR을 사용할 수 없어 WebAR 엔진을 준비하고 있습니다. 2D로 바로 진행할 수도 있어요.';
    result = { ...await webar.capability(), provider: 'webar' };
  }
  if (!current()) return;
  npcSupport = result;
  $('#ar-capability').textContent = result.message;
  updateNpcPresentation(); updateControls();
}
function setStageOrder(order = defaultStages) {
  const next = Array.isArray(order) && order.length && order.every(stage => defaultStages.includes(stage)) && new Set(order).size === order.length ? [...order] : [...defaultStages];
  if ($('#steps').children.length && JSON.stringify(next) === JSON.stringify(stages)) return;
  stages = next;
  $('#steps').replaceChildren(...stages.map((stage, index) => {
    const item = document.createElement('button'); item.type = 'button'; item.textContent = `${index + 1} ${labels[stage]}`; item.dataset.stage = stage;
    item.addEventListener('click', () => { if (!item.disabled && state?.leaderId === identity?.participantId && state.lab.stage !== stage) send({ type: 'lab:select-stage', target: stage }); });
    return item;
  }));
}
setStageOrder();
function canReport() { return state?.lab.stage === 'silence' || Boolean(state?.lab.trackSnapshot && state.lab.stage === 'ar-route'); }

function returnToEntry(deleted = false) {
  if (leavingRoom) return;
  leavingRoom = true; connected = false;
  npcChoiceVersion++; npcCameraStarting = false;
  referencePhoto.dispose(); moduleSettings.dispose();
  photoPickerContext = null; photoMissionActive = false;
  closePhotoSource();
  for (const control of document.querySelectorAll('button, input, select')) control.disabled = true;
  clearTimeout(reconnectTimer); pending.clear();
  const previous = ws; ws = null; previous?.close();
  queuedPosition = null; localPosition = null; localHeading = null;
  photoGeneration++; fileVersion++; photoData = null; photoBusy = false;
  photoController?.abort(); photoController = null;
  sensors.stop(); stopNpcAR(); routeAR.hide();
  mapVersion++; mapController?.abort(); map?.dispose(); map = null;
  try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (!saved || saved.token === identity?.token) localStorage.removeItem(storageKey); } catch {}
  try {
    const prefix = `nonol-lab-story:${roomId}:`;
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key);
  } catch {}
  try { sessionStorage.setItem(`nonol-lab-entry:${roomId}`, 'reset'); } catch {}
  identity = null; state = null;
  location.replace(deleted === true ? '/?deleted=1' : lobbyUrl);
}

function busy() { return [...pending.values()].some(type => !['lab:location', 'lab:report'].includes(type)); }
function stageControlPending() { return [...pending.values()].some(type => ['lab:stage-control', 'lab:select-stage', 'lab:configure-module'].includes(type)); }
function send(action) {
  if (leavingRoom || !connected || ws?.readyState !== WebSocket.OPEN || !state?.lab) return false;
  const control = ['lab:stage-control', 'lab:select-stage', 'lab:configure-module'].includes(action.type);
  if (control ? stageControlPending() : !['lab:location', 'lab:report'].includes(action.type) && busy()) return false;
  if (control) { stageControlError = ''; npcCleanupNotice = ''; }
  const requestId = crypto.randomUUID();
  pending.set(requestId, action.type);
  if (action.type !== 'lab:location') $('#error').textContent = '';
  ws.send(JSON.stringify({ ...action, requestId, runId: state.lab.runId, stage: state.lab.stage }));
  updateControls();
  return true;
}

function queuePosition(position) {
  if (leavingRoom || position.source !== 'gps') return;
  localPosition = { ...position, heading: localHeading ?? position.heading ?? null };
  queuedPosition = localPosition;
  flushPosition();
}
function flushPosition() {
  if (!queuedPosition || !connected || !state || Date.now() - lastPositionSent < 800) return;
  if (!Number.isFinite(queuedPosition.measuredAt) || queuedPosition.measuredAt > Date.now() + 5000 || Date.now() - queuedPosition.measuredAt > 30000) { queuedPosition = null; return; }
  if (send({ type: 'lab:location', ...queuedPosition })) { queuedPosition = null; lastPositionSent = Date.now(); }
}
setInterval(flushPosition, 900);


function storyKey() { return `nonol-lab-story:${roomId}:${state.lab.runId}`; }
function saveStory() { try { sessionStorage.setItem(storyKey(), String(storyIndex)); } catch {} }
function renderStory() {
  const touched = state.lab.npcTouched[identity.participantId];
  $('#story').hidden = !touched;
  $('#story-copy').textContent = story[storyIndex];
  $('#story-next').textContent = storyIndex === story.length - 1 ? '이야기를 다 읽었어요' : '다음 이야기';
}

function render(next) {
  if (leavingRoom) return;
  if (!next.members.some(member => member.id === identity?.participantId)) { returnToEntry(); return; }
  if (state && next.revision < state.revision) return;
  if (next.track !== 'lab' || next.phase !== 'started') { referencePhoto.dispose(); location.replace(lobbyUrl); return; }
  state = next;
  const lab = state.lab;
  setStageOrder(lab.stageOrder);
  story = Array.isArray(lab.trackSnapshot?.story) && lab.trackSnapshot.story.length ? lab.trackSnapshot.story : defaultStory;
  $('#lab-track-title').textContent = lab.trackSnapshot ? `${lab.trackSnapshot.title} / v${lab.trackSnapshot.version}` : '모바일 퀘스트 모듈 테스트';
  const changed = shownStage !== lab.stage || shownRun !== lab.runId;
  if (changed) {
    npcChoiceVersion++; npcCameraStarting = false;
    npcCleanupNotice = '';
    closePhotoSource(); photoPickerContext = null; fileVersion++;
    sensors.closeCamera(); stopNpcAR(); routeAR.hide();
    $('#ar-stop').hidden = true;
    if (shownRun !== lab.runId) {
      localPosition = null; queuedPosition = null; pending.clear();
      stageControlError = '';
      photoData = null; photoGeneration++; photoController?.abort(); photoController = null; photoBusy = false;
      $('#photo-file').value = ''; $('#photo-camera-file').value = ''; $('#photo-preview').hidden = true; $('#photo-status').textContent = '';
    }
    localHeading = null; sensors.stopHeading(); sensors.stopGPS();
    localPosition = null; queuedPosition = null; gpsNeedsReconnect = true;
    shownRun = lab.runId; shownStage = lab.stage;
    for (const stage of defaultStages) $(`#${stage}-panel`).hidden = stage !== lab.stage;
    mapVersion++; mapController?.abort(); map?.dispose(); map = null;
    for (const item of $('#steps').children) { if (item.dataset.stage === lab.stage) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current'); }
    $('#stage-number').textContent = `TEST ${stages.indexOf(lab.stage) + 1} / ${stages.length}`;
    $('#mission-heading').textContent = copy[lab.stage][0];
    $('#mission-copy').textContent = copy[lab.stage][1];
    if (lab.trackSnapshot && lab.stage === 'silence') $('#mission-copy').textContent = '이제부터 정령 장소까지 말없이 걸어갑니다. 말한 팀원을 신고하면 벌점 1점이 쌓여요. 모두 준비되면 산책을 시작합니다.';
    if (lab.trackSnapshot && lab.stage === 'ar-route') $('#mission-copy').textContent = '말을 아끼며 정령 장소까지 걸어갑니다. 걷는 중에도 팀원을 신고할 수 있어요. 바닥 고정 AR은 연결된 공간 프로젝트에서 시험합니다.';
    if (lab.trackSnapshot && lab.stage === 'finder') {
      $('#mission-heading').textContent = lab.trackSnapshot.ending === 'cafe' ? '정령이 추천한 카페로.' : '지도 없이, 느낌대로.';
      $('#mission-copy').textContent = lab.trackSnapshot.ending === 'cafe' ? '카페의 위치는 숨겨져 있어요. 거리와 방향, 색을 따라 찾아가세요. 전원이 도착하면 함께 결과를 확인해요.' : '거리와 방향 안내를 따라 복지관으로 돌아갑니다. 전원이 도착하면 함께 결과를 확인해요.';
    }
    if (lab.trackSnapshot && lab.stage === 'photo') $('#mission-copy').textContent = '지도에서 확인한 도착 기록과 이 트랙의 기준 물체 사진으로 인증합니다.';
    $('#mission-heading').focus();
    if (lab.stage === 'map') setupMap();
    if (['map', 'npc', 'ar-route', 'finder'].includes(lab.stage)) sensors.startGPS();
    if (canReport()) setupReports();
    if (lab.stage === 'npc') {
      npcSupport = null; npcMode = 'idle';
      $('#ar-status').textContent = ''; $('#camera-status').textContent = '';
      $('#ar-capability').textContent = '공간 AR 지원 여부를 확인하고 있습니다.';
      updateNpcPresentation();
      try { storyIndex = Math.min(story.length - 1, Math.max(0, Number(sessionStorage.getItem(storyKey())) || 0)); } catch { storyIndex = 0; }
      const run = lab.runId;
      prepareNpcAR(run);
    }
    if (lab.stage === 'ending') { renderEnding(); sensors.stop(); }
  }
  const locationModule = ['map', 'npc', 'ar-route', 'finder'].includes(lab.stage);
  const modeCopy = lab.stage === 'photo' ? '물체 인식을 위치 확인과 별도로 시험합니다.' : lab.stage === 'silence' ? '연속 신고와 벌점 반영을 시험합니다.' : lab.stage === 'ending' ? '팀 및 개인의 최종 결과를 확인합니다.' : '실제 GPS, 모듈별 도착 범위를 시험합니다.';
  $('#mode-label').textContent = `TEST v${lab.policyVersion} / ${modeCopy}`;
  $('#gps-start').hidden = !locationModule;
  $('#location-status').hidden = $('#sensor-status').hidden = !locationModule;
  $('#reset').hidden = state.leaderId !== identity.participantId;
  $('#stage-controls').hidden = state.leaderId !== identity.participantId;
  const count = Object.keys(lab.completed).length;
  moduleSettings.update(next, connected && !stageControlPending());
  $('#team-progress').textContent = lab.stage === 'ending' ? '현재 팀의 벌점과 최종 결과입니다.' : `${count}/${state.members.length}명 완료. 모두 마치면 함께 다음 단계로 이동해요.`;
  $('#team-status').replaceChildren(...state.members.map(member => { const item = document.createElement('li'); item.textContent = `${member.name}: ${lab.completed[member.id] ? '완료' : member.connected ? '진행 중' : '연결 대기'}`; return item; }));
  if (lab.stage === 'map') renderMap();
  const reportConsole = $('#report-console');
  if (lab.trackSnapshot && lab.stage === 'ar-route') { if (reportConsole.parentElement !== $('#ar-route-panel')) $('#ar-route-panel').append(reportConsole); }
  else if (reportConsole.parentElement !== $('#silence-panel')) $('#silence-panel').insertBefore(reportConsole, $('#silence-complete'));
  reportConsole.hidden = !canReport();
  if (canReport()) updateReports();
  if (lab.stage === 'npc') { renderStory(); if (lab.npcTouched[identity.participantId] && (ar.session || ar.starting || webar.active || webar.starting)) { stopNpcAR(); $('#ar-stop').hidden = true; } }
  if (lab.stage === 'npc') updateNpcPresentation();
  referencePhoto.update(next, connected && !busy());
  renderPhotoCopy(); updateGuidance(); updateControls();
}

function renderPhotoCopy() {
  if (state?.lab.stage !== 'photo') return;
  const target = state.lab.config.photoTarget;
  $('#mission-copy').textContent = `이번 인증 대상: ${target}. ${referencePhoto.reference ? '기준 사진의 물체와 비교해 인증합니다. ' : target === '500ml 생수병' ? '용량 표시가 선명하게 보이도록 찍어 주세요. ' : ''}${state.lab.trackSnapshot ? '지도에서 확인한 도착 기록과 기준 물체 사진을 함께 인증합니다.' : copy.photo[1]}`;
}

function updateNpcPresentation() {
  if (state?.lab.stage !== 'npc') return;
  const touched = state.lab.npcTouched[identity.participantId];
  const spatial = ['ar', 'webar'].includes(npcMode), providerName = npcSupport?.provider === 'webar' ? 'WebAR' : '공간 AR';
  $('#npc-mode').textContent = touched ? '정령과 만났습니다. 이야기를 이어 주세요.' : spatial ? `${npcMode === 'webar' ? 'WebAR' : '공간 AR'} / 이 기기에 정령 생성` : npcMode === 'starting' ? `${providerName}을 연결하고 있습니다.` : npcMode === '2d' ? '카메라 2D / 화면의 정령 터치' : npcMode === 'fallback' ? '공간 AR을 실행하지 못했습니다. 2D로 진행할 수 있어요.' : npcSupport ? npcSupport.supported ? `${providerName} 사용 가능` : '카메라 2D로 진행' : '공간 AR 지원 확인 중';
  $('#ar-start').textContent = '정령 생성하기';
  $('#npc-instructions').textContent = spatial ? '카메라 앞에 나타난 정령을 직접 터치해 주세요. 이 기기에서 생성한 위치에 정령이 놓입니다.' : npcMode === 'fallback' ? '카메라 2D로 진행하기를 눌러 주세요. 카메라를 사용할 수 없어도 화면의 정령을 터치할 수 있어요.' : npcMode === '2d' ? '화면의 정령을 터치해 이야기를 시작하세요. 카메라 권한이 꺼져 있어도 정령을 만날 수 있어요.' : '정령 생성하기를 누르면 이 기기에서 가능한 모드로 정령을 바로 보여드립니다. 카메라 2D로 진행하기도 선택할 수 있어요.';
  $('#npc-camera').hidden = spatial;
  $('#npc-touch').hidden = npcMode !== '2d' || Boolean(touched);
  if (!touched && !near()) $('#npc-instructions').textContent = `먼저 지정한 정령 장소의 ${state.lab.config.radius}m 범위 안으로 이동해 주세요. 범위 안에서 정령을 생성하고 터치하면 이야기가 시작됩니다.`;
  $('#npc-placement-note').textContent = `지정한 장소의 ${state.lab.config.radius}m 범위에서 생성합니다. 공간 AR은 카메라 앞 약 ${ar.policy.initialPlacement.distanceMeters}m에 정령을 놓습니다. 정령은 이 기기에만 놓이며 GPS 좌표에 고정하는 방식은 아닙니다.`;
}

function currentPosition() { const position = state?.lab.positions[identity.participantId]; return position?.source === 'gps' ? position : null; }
function targetPosition() {
  if (state.lab.stage === 'ar-route') {
    const points = routePoints(state.lab.config);
    return points[Math.min(state.lab.routeProgress[identity.participantId] ?? 0, points.length - 1)];
  }
  return state.lab.config.destination;
}
function near() { const position = currentPosition(); return Boolean(!gpsNeedsReconnect && (state?.lab.stage !== 'map' || validWalkingCourse(state.lab.config)) && position && position.at <= Date.now() + 5000 && Date.now() - position.at <= 30000 && position.accuracy <= state.lab.config.radius && guidance(position, targetPosition()).distance <= state.lab.config.radius); }
function updateControls() {
  if (!state) return;
  const complete = Boolean(state.lab.completed[identity.participantId]);
  const blocked = !connected || ws?.readyState !== WebSocket.OPEN || busy();
  referencePhoto.update(state, !blocked);
  moduleSettings.update(state, connected && ws?.readyState === WebSocket.OPEN && !stageControlPending());
  for (const button of document.querySelectorAll('[data-complete]')) { button.disabled = blocked || complete || (['map', 'finder'].includes(button.dataset.complete) && !near()); button.textContent = complete ? '완료했어요. 팀원을 기다리는 중' : { map: '도착했어요', silence: '묵언 구간을 걸었어요', finder: '숨은 목적지를 찾았어요' }[button.dataset.complete]; }
  if (state.lab.trackSnapshot && !complete) $('#silence-complete').textContent = '묵언 산책 준비됐어요';
  if (state.lab.trackSnapshot?.ending === 'cafe' && !complete) $('#finder-complete').textContent = '추천한 카페를 찾았어요';
  $('#npc-touch').disabled = blocked || !near() || Boolean(state.lab.npcTouched[identity.participantId]);
  $('#ar-start').disabled = blocked || !near() || !npcSupport || ar.starting || webar.starting || npcCameraStarting || Boolean(ar.session) || webar.active || Boolean(state.lab.npcTouched[identity.participantId]);
  $('#camera-start').disabled = blocked || npcCameraStarting || !near() || Boolean(state.lab.npcTouched[identity.participantId]);
  $('#story-next').disabled = blocked || complete;
  const photoMissionValid = !leavingRoom && state.lab.stage === 'photo' && !complete;
  if (!photoMissionValid) { photoPickerContext = null; if (photoMissionActive) fileVersion++; }
  photoMissionActive = photoMissionValid;
  const canPickPhoto = photoMissionValid && !blocked && !photoBusy;
  if (!canPickPhoto) closePhotoSource();
  $('#photo-pick').disabled = !canPickPhoto;
  $('#photo-camera-pick').disabled = $('#photo-library-pick').disabled = $('#photo-pick').disabled;
  $('#photo-submit').disabled = blocked || !photoData || photoBusy || complete;
  $('#reset').disabled = blocked;
  const online = connected && ws?.readyState === WebSocket.OPEN;
  const controllingStage = stageControlPending();
  const canControlStage = online && !controllingStage && state.leaderId === identity.participantId;
  for (const item of $('#steps').children) { item.disabled = !canControlStage || item.dataset.stage === state.lab.stage; item.title = state.leaderId === identity.participantId ? '팀 전체가 이 모듈로 이동합니다.' : '팀장이 모듈을 선택합니다.'; }
  $('#stage-previous').disabled = !canControlStage || state.lab.stage === stages[0];
  $('#stage-next').disabled = !canControlStage || state.lab.stage === stages.at(-1);
  $('#stage-reset').disabled = !canControlStage;
  $('#stage-control-status').textContent = !online ? '팀에 다시 연결되면 단계 조작을 사용할 수 있어요.' : controllingStage ? '팀 전체의 단계를 변경하고 있습니다.' : stageControlError || npcCleanupNotice || (state.lab.stage === stages[0] ? '첫 단계입니다. 다음 단계로 이동하거나 현재 단계를 초기화할 수 있어요.' : state.lab.stage === stages.at(-1) ? '마지막 단계입니다. 이전 단계로 이동하거나 현재 단계를 초기화할 수 있어요.' : '팀장만 팀 전체의 단계를 변경할 수 있어요. 미션 응답 대기 중에도 사용할 수 있습니다.');
  $('#route-arrive').disabled = blocked || complete || !near();
  $('#route-arrive').textContent = complete ? '경로를 마쳤어요. 팀원을 기다리는 중' : (state.lab.routeProgress[identity.participantId] ?? 0) === 1 ? 'AR 경로를 마쳤어요' : '이 경유점에 도착했어요';
  if (canReport()) updateReports();
}

function updateGuidance() {
  if (!state) return;
  const position = currentPosition();
  const reconnectGPS = gpsNeedsReconnect;
  const stale = reconnectGPS || !position || position.at > Date.now() + 5000 || Date.now() - position.at > 30000;
  const heading = localHeading;
  const result = guidance(stale ? null : position, targetPosition(), heading, state.lab.config.radius);
  if (state.lab.stage === 'map') {
    const arrival = $('#map-arrival-status');
    const complete = Boolean(state.lab.completed[identity.participantId]);
    const validCourse = validWalkingCourse(state.lab.config);
    const arrived = near();
    const inaccurate = position && position.accuracy > state.lab.config.radius;
    arrival.dataset.state = complete ? 'complete' : !validCourse ? 'invalid' : stale || inaccurate ? 'waiting' : arrived ? 'arrived' : 'walking';
    arrival.textContent = complete ? '도착 완료. 팀원을 기다리고 있어요.'
      : !validCourse ? '출발과 도착 범위가 겹쳐요. 팀장이 이 모듈의 출발과 목적지를 다시 설정해 주세요.'
      : stale ? '현재 위치를 확인하고 있어요. 위치 연결 상태를 확인해 주세요.'
      : inaccurate ? `위치 오차 ${Math.round(position.accuracy)}m입니다. ${state.lab.config.radius}m 이내의 정확한 위치를 기다리고 있어요.`
      : arrived ? '도착 범위에 들어왔어요. 도착했어요를 눌러 완료해 주세요.'
      : `목적지까지 약 ${Math.round(result.distance)}m 남았어요. 도착 반경은 ${state.lab.config.radius}m입니다.`;
  }
  $('#location-status').dataset.measuredAt = position?.at ?? '';
  $('#location-status').dataset.fresh = String(!stale);
  $('#location-status').textContent = reconnectGPS ? '새 GPS 측정값을 기다리고 있어요. 연결이 지연되면 실제 위치 연결하기를 눌러 주세요.' : !position ? '위치를 연결해 주세요.' : stale ? `마지막 GPS는 ${Math.max(0, Math.floor((Date.now() - position.at) / 1000))}초 전 측정입니다. 새 위치를 기다리고 있어요.` : `GPS / ${Math.max(0, Math.floor((Date.now() - position.at) / 1000))}초 전 측정 / 목적지 약 ${Math.round(result.distance)}m / 위치 오차 약 ${Math.round(position.accuracy)}m${position.accuracy > state.lab.config.radius ? ' (도착 판정에 필요한 정확도보다 낮아요)' : ''}`;
  if (state.lab.stage === 'ar-route') {
    routeAR.update(stale ? null : position, targetPosition(), { heading, radius: state.lab.config.radius, maxAccuracy: state.lab.config.radius, mode: 'gps' });
    const progress = state.lab.routeProgress[identity.participantId] ?? 0;
    $('#route-progress').textContent = progress >= 2 ? '경유점 2/2 확인 완료' : `다음 경유점 ${progress + 1}/2 / ${progress === 0 ? '출발과 도착의 중간' : '도착 위치로 이동하기'}`;
  }
  if (state.lab.stage === 'finder') {
    const inaccurate = position && position.accuracy > state.lab.config.radius;
    $('#finder').style.background = inaccurate ? '#eef0eb' : result.color;
    $('#finder-distance').textContent = result.distance === null ? '?' : String(Math.round(result.distance));
    $('#finder-arrow').style.transform = `rotate(${result.turn ?? 0}deg)`;
    $('#finder-arrow').hidden = result.turn === null || inaccurate;
    $('#finder-direction').textContent = inaccurate ? '위치 오차가 커요. 정확한 위치를 기다려 주세요.' : result.label;
    $('#finder-status').textContent = result.turn === null ? '방향 센서가 없으면 거리만 안내합니다.' : '휴대폰을 수평으로 들고 방향을 비교해 주세요.';
  }
}

async function setupMap() {
  const version = ++mapVersion, run = state.lab.runId;
  mapController?.abort(); map?.dispose(); map = null;
  const controller = new AbortController(); mapController = controller;
  try {
    const view = await createMapView($('#map'), {
      center: state.lab.config.destination, signal: controller.signal,
      onStatus: message => { if (!leavingRoom && version === mapVersion) $('#map-status').textContent = message; },
    });
    if (leavingRoom || version !== mapVersion || state?.lab.stage !== 'map' || state.lab.runId !== run) { view.dispose(); return; }
    map = view; mapDrawKey = null; map.fit([state.lab.config.start, state.lab.config.destination]); renderMap();
    requestAnimationFrame(() => { if (!leavingRoom && version === mapVersion) map?.invalidate(); });
  } catch (error) { if (version === mapVersion && error.name !== 'AbortError') $('#map-status').textContent = error.message; }
}
function renderMap() {
  if (!map) return;
  const members = state.members.map(member => {
    const position = state.lab.positions[member.id];
    return position?.source === 'gps' && Date.now() - position.at <= 30000 && position.at <= Date.now() + 5000 ? { ...position, id: member.id, name: member.name, mine: member.id === identity.participantId } : null;
  }).filter(Boolean);
  const drawing = { ...state.lab.config, members };
  const key = JSON.stringify(drawing);
  if (key !== mapDrawKey) { mapDrawKey = key; map.draw(drawing); }
}

function setupReports() {
  reportMemberKey = JSON.stringify(state.members.filter(member => member.id !== identity.participantId).map(member => member.id));
  $('#report-members').replaceChildren(...state.members.filter(member => member.id !== identity.participantId).map(member => { const button = document.createElement('button'); button.dataset.report = member.id; button.addEventListener('click', () => send({ type: 'lab:report', targetId: member.id })); return button; }));
}
function updateReports() {
  const key = JSON.stringify(state.members.filter(member => member.id !== identity.participantId).map(member => member.id));
  if (key !== reportMemberKey) setupReports();
  for (const button of $('#report-members').children) {
    const member = state.members.find(member => member.id === button.dataset.report);
    if (!member) continue;
    button.textContent = `${member.name} 신고하기 / 벌점 ${state.lab.penalties[member.id] || 0}`;
    button.disabled = !connected || ws?.readyState !== WebSocket.OPEN || !canReport();
  }
  $('#report-status').textContent = state.members.length === 1 ? '혼자 시험 중입니다. 다른 브라우저로 같은 링크에 입장하면 상호 신고를 시험할 수 있어요.' : `팀 전체 신고 ${state.lab.reports.length}건`;
}
function renderEnding() {
  const total = Object.values(state.lab.penalties).reduce((sum, value) => sum + value, 0);
  $('#ending-total').textContent = `팀 전체 벌점 ${total}점 / 신고 ${state.lab.reports.length}건`;
  const highest = Math.max(0, ...Object.values(state.lab.penalties));
  const kings = state.members.filter(member => (state.lab.penalties[member.id] || 0) === highest);
  $('#ending-story').textContent = highest ? `오늘의 벌점 왕: ${kings.map(member => member.name).join(', ')}. 정령이 명단을 챙겼습니다. 다음 식사 때 숟가락을 조심하세요. (시험용 엔딩)` : '아무도 신고하지 않았다니. 진짜 묵언의 고수이거나, 서로 봐준 팀이군요. 정령이 고개를 끄덕입니다. (시험용 엔딩)';
  if (state.lab.trackSnapshot?.ending === 'cafe') $('#ending-story').textContent = `정령이 추천한 카페에 도착했어요. ${$('#ending-story').textContent}`;
  $('#scoreboard').replaceChildren(...state.members.map(member => { const item = document.createElement('li'); item.className = 'member'; item.textContent = `${member.name}: 벌점 ${state.lab.penalties[member.id] || 0}점`; return item; }));
}

async function preparePhoto(file) {
  const version = ++fileVersion; photoData = null; $('#photo-status').textContent = '사진을 준비하고 있습니다.'; updateControls();
  try {
    const data = await compressPhoto(file);
    if (version !== fileVersion || leavingRoom || state?.lab.stage !== 'photo' || state.lab.completed[identity?.participantId]) return;
    photoData = data; $('#photo-preview').src = data; $('#photo-preview').hidden = false; $('#photo-status').textContent = '사진을 확인하고 인증하기를 눌러 주세요.';
  } catch (error) { if (version === fileVersion && !leavingRoom && state?.lab.stage === 'photo' && !state.lab.completed[identity?.participantId]) { $('#photo-status').textContent = error.message || '사진을 읽지 못했습니다.'; $('#photo-preview').hidden = true; } }
  finally { updateControls(); }
}
function closePhotoSource() { if ($('#photo-source-dialog').open) $('#photo-source-dialog').close(); }
$('#photo-pick').addEventListener('click', () => { if (!$('#photo-pick').disabled && !$('#photo-source-dialog').open) $('#photo-source-dialog').showModal(); });
$('#photo-source-cancel').addEventListener('click', closePhotoSource);
$('#photo-source-dialog').addEventListener('close', () => {
  if (!leavingRoom && state?.lab.stage === 'photo' && !$('#photo-panel').hidden) ($('#photo-pick').disabled ? $('#mission-heading') : $('#photo-pick')).focus({ preventScroll: true });
});
$('#photo-source-dialog').addEventListener('click', event => {
  if (event.target !== $('#photo-source-dialog')) return;
  const bounds = event.target.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePhotoSource();
});
for (const [button, input] of [['#photo-camera-pick', '#photo-camera-file'], ['#photo-library-pick', '#photo-file']]) {
  $(button).addEventListener('click', () => {
    if ($('#photo-pick').disabled || leavingRoom || state?.lab.stage !== 'photo') return;
    photoPickerContext = { runId: state.lab.runId, participantId: identity.participantId, inputId: $(input).id };
    closePhotoSource(); $(input).value = ''; $(input).click();
  });
  $(input).addEventListener('change', event => {
    const file = event.target.files?.[0], context = photoPickerContext; photoPickerContext = null;
    if (file && context?.inputId === event.target.id && context.runId === state?.lab.runId && context.participantId === identity?.participantId && !leavingRoom && state?.lab.stage === 'photo' && !state.lab.completed[identity?.participantId]) preparePhoto(file);
  });
  $(input).addEventListener('cancel', () => { if (photoPickerContext?.inputId === $(input).id) photoPickerContext = null; });
}
$('#photo-submit').addEventListener('click', async () => {
  if (!photoData || photoBusy || !connected) return;
  const runId = state.lab.runId;
  const generation = ++photoGeneration;
  const controller = new AbortController(); photoController = controller;
  const timeout = setTimeout(() => controller.abort(), 60000);
  photoBusy = true; $('#photo-status').textContent = '물체를 확인하고 있습니다. 잠시만요.'; updateControls();
  try {
    const response = await fetch(`/api/rooms/${roomId}/photo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ runId, image: photoData }), signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '사진 판정을 완료하지 못했습니다.');
    if (!leavingRoom && generation === photoGeneration && state?.lab.runId === runId) $('#photo-status').textContent = result.reason;
  } catch (error) { if (!leavingRoom && generation === photoGeneration && state?.lab.runId === runId) $('#photo-status').textContent = error.name === 'AbortError' ? '판정 응답이 늦습니다. 팀 진행 상태를 확인한 뒤 다시 시도해 주세요.' : error.message; }
  finally { clearTimeout(timeout); if (generation === photoGeneration) { photoBusy = false; photoController = null; updateControls(); } }
});
for (const button of document.querySelectorAll('[data-complete]')) button.addEventListener('click', () => send({ type: 'lab:complete' }));
$('#npc-touch').addEventListener('click', () => send({ type: 'lab:npc-touch' }));
$('#story-next').addEventListener('click', () => { if (storyIndex < story.length - 1) { storyIndex++; saveStory(); renderStory(); } else send({ type: 'lab:complete' }); });
function startNpc2D() {
  if ($('#camera-start').disabled || leavingRoom || state?.lab.stage !== 'npc') return;
  const run = state.lab.runId, version = ++npcChoiceVersion;
  stopNpcAR(); npcMode = '2d'; npcCameraStarting = true;
  const opening = sensors.openCamera($('#camera'));
  updateNpcPresentation(); updateControls();
  opening.finally(() => { if (!leavingRoom && state?.lab.stage === 'npc' && state.lab.runId === run && version === npcChoiceVersion) { npcCameraStarting = false; updateNpcPresentation(); updateControls(); } });
}
$('#camera-start').addEventListener('click', startNpc2D);
$('#ar-start').addEventListener('click', async () => {
  if ($('#ar-start').disabled || leavingRoom || state?.lab.stage !== 'npc' || ar.starting || ar.session || webar.starting || webar.active) return;
  if (!npcSupport?.supported) { startNpc2D(); return; }
  const run = state.lab.runId, version = ++npcChoiceVersion;
  const provider = npcSupport.provider === 'webar' ? webar : ar;
  npcMode = 'starting'; npcCameraStarting = false;
  sensors.closeCamera();
  try {
    const opening = provider.start($('#ar-container'));
    updateControls();
    const active = await opening;
    if (!active) return;
    if (!leavingRoom && state?.lab.stage === 'npc' && state?.lab.runId === run && version === npcChoiceVersion) { npcMode = provider === webar ? 'webar' : 'ar'; $('#ar-stop').hidden = false; updateNpcPresentation(); }
    else provider.stop();
  } catch (error) { if (!leavingRoom && state?.lab.runId === run && state.lab.stage === 'npc' && version === npcChoiceVersion) { npcMode = 'fallback'; $('#ar-status').textContent = error.message || '공간 AR을 시작하지 못했습니다. 카메라 2D로 진행하기를 눌러 주세요.'; } }
  finally { if (!leavingRoom && state?.lab.runId === run && state.lab.stage === 'npc' && version === npcChoiceVersion) { updateNpcPresentation(); updateControls(); } }
});
$('#ar-stop').addEventListener('click', () => { npcChoiceVersion++; npcMode = 'idle'; stopNpcAR(); $('#ar-stop').hidden = true; updateNpcPresentation(); updateControls(); });
$('#gps-start').addEventListener('click', () => sensors.startGPS());
$('#heading-start').addEventListener('click', () => sensors.startHeading());
$('#route-heading-start').addEventListener('click', () => sensors.startHeading());
$('#route-camera-start').addEventListener('click', () => sensors.openCamera($('#route-video')));
$('#route-arrive').addEventListener('click', () => send({ type: 'lab:route-arrive', waypoint: state.lab.routeProgress[identity.participantId] ?? 0 }));
$('#reset').addEventListener('click', () => { if (confirm('방 전체를 초기화할까요?\n참가자와 팀장, 준비 상태, 코스 설정, 진행 기록과 벌점이 모두 삭제됩니다.\n모두 같은 초대 링크에서 닉네임을 입력해 다시 입장합니다. 처음 재입장한 사람이 새 팀장이 됩니다.')) send({ type: 'lab:reset' }); });
for (const button of document.querySelectorAll('[data-stage-control]')) button.addEventListener('click', () => { if (!button.disabled && state?.leaderId === identity?.participantId) send({ type: 'lab:stage-control', action: button.dataset.stageControl }); });

function connection(value) { connected = value; $('#connection').textContent = value ? '팀과 연결됨' : '다시 연결하는 중'; $('#connection').classList.toggle('connected', value); updateControls(); }
function connect() {
  if (leavingRoom || !identity?.participantId) return;
  clearTimeout(reconnectTimer);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${roomId}/socket`); ws = socket;
  socket.addEventListener('open', () => { if (socket === ws && identity?.token && !leavingRoom) socket.send(JSON.stringify({ type: 'hello', token: identity.token })); });
  socket.addEventListener('message', event => {
    if (socket !== ws) return; lastMessageAt = Date.now();
    if (event.data === 'pong') return;
    const message = JSON.parse(event.data);
    if (message.type === 'room-deleted' || message.code === 'ROOM_DELETED') { returnToEntry(true); return; }
    if (message.type === 'room-reset' || message.code === 'ROOM_IDENTITY_EXPIRED' || message.code === 'ROOM_RESET') { returnToEntry(); return; }
    if (message.type === 'state') { attempt = 0; connection(true); render(message.state); flushPosition(); }
    if (message.type === 'ack' || message.type === 'error') {
      const type = pending.get(message.requestId); pending.delete(message.requestId);
      if (['lab:stage-control', 'lab:select-stage', 'lab:configure-module'].includes(type)) stageControlError = message.type === 'error' ? message.message : '';
      if (message.type === 'error') $('#error').textContent = message.message;
      updateControls();
    }
  });
  socket.addEventListener('close', async event => {
    if (socket !== ws || leavingRoom) return;
    if (event.code === 4404) { returnToEntry(true); return; }
    pending.clear(); connection(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`/api/rooms/${roomId}`, { cache: 'no-store', signal: controller.signal });
      if (socket !== ws || leavingRoom) return;
      if (response.status === 404) { returnToEntry(true); return; }
    } catch {}
    finally { clearTimeout(timer); }
    if (socket !== ws || leavingRoom) return;
    reconnectTimer = setTimeout(connect, Math.min(500 * Math.pow(2, attempt++), 8000));
  });
  socket.addEventListener('error', () => { if (socket === ws) connection(false); });
}
setInterval(() => { if (ws?.readyState === WebSocket.OPEN) { if (Date.now() - lastMessageAt > 45000) ws.close(); else ws.send('ping'); } if (state) { updateGuidance(); updateControls(); } }, 5000);
setInterval(() => { if (state && !leavingRoom) { updateGuidance(); updateControls(); if (state.lab.stage === 'map') renderMap(); } }, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!leavingRoom && state && ['map', 'npc', 'ar-route', 'finder'].includes(state.lab.stage)) { localHeading = null; sensors.stopHeading(); gpsNeedsReconnect = true; sensors.startGPS(); }
  if (ws?.readyState === WebSocket.OPEN) { if (Date.now() - lastMessageAt > 30000) ws.close(); else ws.send('ping'); }
  else if (ws?.readyState !== WebSocket.CONNECTING) connect();
});
window.addEventListener('offline', () => { connection(false); ws?.close(); });
window.addEventListener('online', () => { if (ws?.readyState !== WebSocket.OPEN && ws?.readyState !== WebSocket.CONNECTING) connect(); });
window.addEventListener('pagehide', () => { closePhotoSource(); localHeading = null; sensors.stop(); stopNpcAR(); routeAR.hide(); });
connect();
