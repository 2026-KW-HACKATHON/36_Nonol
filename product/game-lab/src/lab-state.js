import track from '../public/test-track.json' with { type: 'json' };
import { routePoints } from '../public/route-course.js';
import { validWalkingCourse } from '../public/261008_2355_course-geo.js';
import { createRoomState } from './room-state.js';

const STAGES = track.stageControl.stages;
const CONFIG_KEYS = ['mode', 'start', 'destination', 'radius', 'photoTarget', 'reportCooldownMs'];
const MODULE_KEYS = Object.fromEntries(track.modules.map(module => [module.id, module.configuration]));
const STAGE_ACTIONS = ['lab:complete', 'lab:report', 'lab:npc-touch', 'lab:route-arrive', 'lab:stage-control', 'lab:select-stage', 'lab:configure-module'];
export const labPolicy = { id: track.id, version: track.version ?? 1 };

function moduleConfigs(config) {
  return Object.fromEntries(STAGES.map(stage => {
    const values = { ...structuredClone(config), mode: 'gps', reportCooldownMs: 0 };
    if (stage === 'finder') values.destination = structuredClone(config.start);
    if (stage === 'ar-route') Object.assign(values, { spatialProjectUrl: '', spatialMapId: '' });
    return [stage, values];
  }));
}

export function createLab() {
  const config = { ...structuredClone(track.defaults), mode: 'gps', reportCooldownMs: 0 };
  return {
    policyId: labPolicy.id, policyVersion: labPolicy.version, generation: 1,
    runId: crypto.randomUUID(), stage: 'map', config, moduleConfigs: moduleConfigs(config),
    completed: {}, positions: {}, arrivals: {}, penalties: {}, reports: [], npcTouched: {}, routeProgress: {}, evidence: {}, processedRequests: []
  };
}

export function upgradeLabPolicy(state) {
  if (state?.track !== 'lab' || !state.lab) return state;
  const previousVersion = state.lab.policyVersion ?? 1;
  if (previousVersion > labPolicy.version) return state;
  const missingModules = STAGES.some(stage => !state.lab.moduleConfigs?.[stage]);
  const needsFreshRun = previousVersion < 12 || state.lab.config.mode !== 'gps' ||
    Object.values(state.lab.moduleConfigs ?? {}).some(config => config.mode !== 'gps') ||
    Object.values(state.lab.positions ?? {}).some(position => position.source !== 'gps') ||
    Object.values(state.lab.evidence ?? {}).some(evidence => evidence.method === 'simulation') ||
    Object.values(state.lab.arrivals ?? {}).some(arrival => arrival.source !== 'gps');
  if (previousVersion === labPolicy.version && !needsFreshRun && !missingModules && state.lab.config.reportCooldownMs === 0) return state;
  const next = structuredClone(state);
  next.lab.arrivals ??= {};
  if (track.photoTargetMigrations.some(rule => state.lab.config.photoTarget === rule.from && previousVersion < rule.beforeVersion)) {
    next.lab.config.photoTarget = track.defaults.photoTarget;
    if (next.lab.moduleConfigs?.photo) next.lab.moduleConfigs.photo.photoTarget = track.defaults.photoTarget;
  }
  const inherited = moduleConfigs(next.lab.config);
  next.lab.moduleConfigs = { ...inherited, ...next.lab.moduleConfigs };
  for (const config of Object.values(next.lab.moduleConfigs)) { config.mode = 'gps'; config.reportCooldownMs = 0; }
  if (missingModules || needsFreshRun) next.lab.config = structuredClone(next.lab.moduleConfigs[next.lab.stage]);
  next.lab.config.mode = 'gps';
  next.lab.config.reportCooldownMs = 0;
  if (needsFreshRun) {
    next.lab.runId = crypto.randomUUID();
    next.lab.completed = {}; next.lab.positions = {}; next.lab.processedRequests = [];
    next.lab.npcTouched = {}; next.lab.routeProgress = {};
    next.lab.evidence = Object.fromEntries(Object.entries(next.lab.evidence ?? {}).filter(([, evidence]) => evidence.method === 'ai'));
    next.lab.arrivals = Object.fromEntries(Object.entries(next.lab.arrivals).filter(([, arrival]) => arrival.source === 'gps' && Number.isFinite(arrival.verifiedAt)));
  }
  next.lab.policyId = labPolicy.id; next.lab.policyVersion = labPolicy.version; next.revision++;
  return next;
}

function member(state, actorId) {
  if (!state.members.some(item => item.id === actorId)) throw new Error('방에 입장한 뒤 다시 시도해 주세요.');
}

function labRoom(state) {
  if (state.track !== 'lab' || !state.lab) throw new Error('테스트 트랙에서 실행해 주세요.');
}

function leader(state, actorId) {
  if (state.leaderId !== actorId) throw new Error('현재 팀장만 실행할 수 있습니다.');
}

function stagesFor(state) { return state.lab.stageOrder ?? STAGES; }

function mutableConfiguration(state) {
  if (state.lab.trackSnapshot) throw new Error('고정 트랙 방의 장소와 기준 사진은 생성할 때의 설정을 함께 사용합니다. 새 설정으로 방을 만들어 주세요.');
}

function coordinates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => key !== 'lat' && key !== 'lon') ||
    !Number.isFinite(value.lat) || Math.abs(value.lat) > 90 ||
    !Number.isFinite(value.lon) || Math.abs(value.lon) > 180) {
    throw new Error('위도와 경도 좌표를 확인해 주세요.');
  }
  return { lat: value.lat, lon: value.lon };
}

function requireWalkingCourse(config) {
  if (config.mode === 'gps' && !validWalkingCourse(config)) {
    throw new Error('GPS 모드는 출발점과 목적지 거리가 도착 반경의 두 배보다 멀어야 합니다. 목적지를 다시 선택해 주세요.');
  }
}

function configValues(previous, config, keys) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
    Object.keys(config).some(key => !keys.includes(key))) {
    throw new Error('테스트 설정을 확인해 주세요.');
  }
  const values = { ...previous, ...config };
  if (values.mode !== 'gps') throw new Error('실제 GPS 위치로 시험해 주세요.');
  values.start = coordinates(values.start);
  values.destination = coordinates(values.destination);
  if (!Number.isFinite(values.radius) || values.radius < 5 || values.radius > 100) throw new Error('도착 반경은 5m부터 100m로 설정해 주세요.');
  if (typeof values.photoTarget !== 'string' || !values.photoTarget.trim() || values.photoTarget.trim().length > 80) {
    throw new Error('촬영할 물체 이름은 1자부터 80자로 입력해 주세요.');
  }
  values.photoTarget = values.photoTarget.trim();
  if (!Number.isFinite(values.reportCooldownMs) || values.reportCooldownMs < 0) throw new Error('신고 대기 시간을 확인해 주세요.');
  values.reportCooldownMs = 0;
  if (keys.includes('spatialProjectUrl')) {
    if (typeof values.spatialProjectUrl !== 'string' || values.spatialProjectUrl.length > 1000) throw new Error('공간 AR 프로젝트 주소를 확인해 주세요.');
    values.spatialProjectUrl = values.spatialProjectUrl.trim();
    if (values.spatialProjectUrl) {
      let url;
      try { url = new URL(values.spatialProjectUrl); } catch { throw new Error('HTTPS 공간 AR 프로젝트 주소를 입력해 주세요.'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('HTTPS 공간 AR 프로젝트 주소를 입력해 주세요.');
      values.spatialProjectUrl = url.href;
    }
    if (typeof values.spatialMapId !== 'string' || values.spatialMapId.trim().length > 100) throw new Error('공간 스캔 Map ID는 100자까지 입력해 주세요.');
    values.spatialMapId = values.spatialMapId.trim();
  }
  return values;
}

export function configureLab(state, actorId, config) {
  labRoom(state);
  member(state, actorId);
  leader(state, actorId);
  mutableConfiguration(state);
  if (state.phase !== 'lobby') throw new Error('대기실에서 테스트 설정을 변경해 주세요.');
  const values = configValues(state.lab.config, config, CONFIG_KEYS);
  requireWalkingCourse(values);
  if (JSON.stringify(values) === JSON.stringify(state.lab.config)) return state;
  const next = structuredClone(state);
  next.lab.config = values;
  next.lab.moduleConfigs = moduleConfigs(values);
  if (values.photoTarget !== state.lab.config.photoTarget) delete next.lab.reference;
  next.revision++;
  return next;
}

export function startLab(state) {
  labRoom(state);
  if (state.phase !== 'started') throw new Error('준비 완료 후 트랙을 시작해 주세요.');
  if (state.screen !== 'track-start') return state;
  return { ...state, screen: state.lab.stage };
}

function running(state, actorId, runId) {
  labRoom(state);
  member(state, actorId);
  if (state.phase !== 'started') throw new Error('트랙을 시작한 뒤 실행해 주세요.');
  if (state.lab.runId !== runId) throw new Error('새 실행이 시작되었습니다. 현재 화면에서 다시 시도해 주세요.');
}

function distanceMeters(a, b) {
  const radians = value => value * Math.PI / 180;
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = radians(b.lon - a.lon);
  const angle = Math.pow(Math.sin(deltaLat / 2), 2) + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.pow(Math.sin(deltaLon / 2), 2);
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(angle), Math.sqrt(Math.max(0, 1 - angle)));
}

function nearby(state, actorId, now, waypoint) {
  const position = state.lab.positions[actorId];
  if (!position || now < position.at || now - position.at > 30_000) throw new Error('최근 위치를 확인한 뒤 다시 시도해 주세요.');
  if (position.accuracy > state.lab.config.radius) throw new Error('위치 정확도가 부족합니다. 더 정확한 위치를 기다려 주세요.');
  const destination = waypoint ?? state.lab.config.destination;
  if (distanceMeters(position, destination) > state.lab.config.radius) throw new Error('목적지에 가까이 도착한 뒤 다시 시도해 주세요.');
}

function clearEnteringProgress(lab, target) {
  if (target === 'photo') lab.evidence = {};
  if (target === 'npc') lab.npcTouched = {};
  if (target === 'ar-route') lab.routeProgress = {};
}

function finishMember(state, actorId) {
  state.lab.completed[actorId] = true;
  if (state.members.every(item => state.lab.completed[item.id])) {
    const previousMode = state.lab.config.mode;
    const stages = stagesFor(state);
    state.lab.stage = stages[stages.indexOf(state.lab.stage) + 1];
    state.lab.config = structuredClone(state.lab.moduleConfigs?.[state.lab.stage] ?? state.lab.config);
    if (state.lab.config.mode !== previousMode) state.lab.positions = {};
    state.screen = state.lab.stage;
    state.lab.completed = {};
    clearEnteringProgress(state.lab, state.lab.stage);
  }
}

function evidenceRecord(evidence, now) {
  const record = { method: evidence.method, verdict: evidence.verdict, at: now };
  if (typeof evidence.reason === 'string' && evidence.reason.trim()) record.reason = evidence.reason.trim().slice(0, 200);
  if (typeof evidence.referenceId === 'string' && evidence.referenceId.length <= 100) record.referenceId = evidence.referenceId;
  return record;
}

export function photoContext(state, actorId, runId, now = Date.now()) {
  running(state, actorId, runId);
  if (state.lab.stage !== 'photo') throw new Error('사진 인증 단계에서 촬영해 주세요.');
  if (state.lab.trackSnapshot && state.lab.arrivals?.[actorId]?.source !== 'gps') throw new Error('지도에서 광운스퀘어에 도착했음을 먼저 인증해 주세요.');
  return { target: state.lab.config.photoTarget, config: structuredClone(state.lab.config) };
}

export function completePhoto(state, actorId, runId, evidence, now = Date.now()) {
  running(state, actorId, runId);
  if (state.lab.stage !== 'photo') throw new Error('사진 인증 단계에서 촬영해 주세요.');
  if (state.lab.trackSnapshot && state.lab.arrivals?.[actorId]?.source !== 'gps') throw new Error('지도에서 광운스퀘어에 도착했음을 먼저 인증해 주세요.');
  if (!evidence || evidence.method !== 'ai' || typeof evidence.verdict !== 'boolean') throw new Error('사진 판정 결과를 확인해 주세요.');
  if (state.lab.completed[actorId]) return state;
  const next = structuredClone(state);
  next.lab.evidence[actorId] = evidenceRecord(evidence, now);
  if (evidence.verdict) finishMember(next, actorId);
  next.revision++;
  return next;
}

export function applyLabAction(state, actorId, action, now = Date.now()) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('요청을 확인해 주세요.');
  if (action.type === 'lab:configure') return configureLab(state, actorId, action.config);
  running(state, actorId, action.runId);
  if (typeof action.requestId !== 'string' || !action.requestId || action.requestId.length > 80) throw new Error('요청 ID를 확인해 주세요.');
  if (state.lab.processedRequests.some(item => item.actorId === actorId && item.requestId === action.requestId)) return state;
  if (STAGE_ACTIONS.includes(action.type) && action.stage !== state.lab.stage) throw new Error('현재 단계에서 다시 시도해 주세요.');
  if (action.type === 'lab:reset') {
    leader(state, actorId);
    const lab = createLab();
    if (state.lab.trackSnapshot) {
      lab.trackSnapshot = structuredClone(state.lab.trackSnapshot);
      lab.stageOrder = [...state.lab.stageOrder];
      lab.moduleConfigs = structuredClone(state.lab.moduleConfigs);
      lab.stage = lab.stageOrder[0];
      lab.config = structuredClone(lab.moduleConfigs[lab.stage]);
      lab.reference = structuredClone(state.lab.reference);
    }
    lab.generation = (state.lab.generation ?? 1) + 1;
    return { ...createRoomState({ id: state.id, title: state.title }), track: 'lab', lab, revision: state.revision + 1 };
  }
  if (action.type === 'lab:stage-control' || action.type === 'lab:select-stage' || action.type === 'lab:configure-module') {
    leader(state, actorId);
    if (action.type === 'lab:stage-control' && !track.stageControl.actions.includes(action.action)) throw new Error('이전 단계, 다음 단계 또는 현재 단계 초기화를 선택해 주세요.');
    const stages = stagesFor(state);
    const index = stages.indexOf(state.lab.stage);
    const offset = action.type === 'lab:stage-control' ? action.action === 'previous' ? -1 : action.action === 'next' ? 1 : 0 : 0;
    const target = action.type === 'lab:select-stage' ? action.target : stages[index + offset];
    if (action.type === 'lab:select-stage' && !stages.includes(target)) throw new Error('시험할 모듈을 선택해 주세요.');
    if (!target) throw new Error(offset < 0 ? '첫 단계입니다.' : '마지막 단계입니다.');
    const next = structuredClone(state);
    next.lab.moduleConfigs ??= moduleConfigs(state.lab.config);
    const previousConfig = state.lab.config;
    if (action.type === 'lab:configure-module') {
      mutableConfiguration(state);
      const values = configValues(next.lab.moduleConfigs[target], action.config, MODULE_KEYS[target]);
      if (target === 'map') requireWalkingCourse(values);
      next.lab.moduleConfigs[target] = values;
      if (target === 'photo' && values.photoTarget !== previousConfig.photoTarget) delete next.lab.reference;
    }
    next.lab.stage = target; next.screen = target;
    next.lab.config = structuredClone(next.lab.moduleConfigs[target]);
    if (next.lab.config.mode !== previousConfig.mode) next.lab.positions = {};
    next.lab.runId = crypto.randomUUID();
    next.lab.completed = {}; next.lab.processedRequests = [];
    clearEnteringProgress(next.lab, target);
    if (target === 'silence' && (action.action === 'reset' || action.type === 'lab:configure-module')) { next.lab.reports = []; next.lab.penalties = {}; }
    next.revision++;
    return next;
  }
  const next = structuredClone(state);
  switch (action.type) {
    case 'lab:location': {
      const point = coordinates({ lat: action.lat, lon: action.lon });
      if (!Number.isFinite(action.accuracy) || action.accuracy < 0 || action.accuracy > 10_000) throw new Error('위치 정확도를 확인해 주세요.');
      if (action.heading !== null && (!Number.isFinite(action.heading) || action.heading < 0 || action.heading > 360)) throw new Error('방향 값을 확인해 주세요.');
      const source = 'gps';
      if (action.source !== source) throw new Error('실제 GPS 위치를 연결해 주세요.');
      const measuredAt = action.measuredAt;
      if (!Number.isFinite(measuredAt) || measuredAt > now + 5000 || now - measuredAt > 30000) throw new Error('새 GPS 위치를 확인해 주세요.');
      next.lab.positions[actorId] = { ...point, accuracy: action.accuracy, heading: action.heading === 360 ? 0 : action.heading, source, at: Math.min(now, measuredAt) };
      break;
    }
    case 'lab:complete':
      if (state.lab.stage === 'photo') throw new Error('사진 인증을 완료해 주세요.');
      if (state.lab.stage === 'ar-route') throw new Error('경유점을 순서대로 확인해 주세요.');
      if (state.lab.stage === 'ending') throw new Error('이미 완주했습니다.');
      if (state.lab.stage === 'map') requireWalkingCourse(state.lab.config);
      if (state.lab.completed[actorId]) return state;
      if (state.lab.stage === 'map' || state.lab.stage === 'finder') nearby(state, actorId, now);
      if (state.lab.stage === 'map') {
        next.lab.arrivals ??= {};
        next.lab.arrivals[actorId] = { ...state.lab.positions[actorId], verifiedAt: now };
      }
      if (state.lab.stage === 'npc' && !state.lab.npcTouched[actorId]) throw new Error('정령을 터치한 뒤 이야기를 확인해 주세요.');
      finishMember(next, actorId);
      break;
    case 'lab:route-arrive': {
      if (state.lab.stage !== 'ar-route') throw new Error('AR 길 안내 단계에서 실행해 주세요.');
      if (state.lab.completed[actorId]) return state;
      const index = state.lab.routeProgress[actorId] ?? 0;
      if (action.waypoint !== index) throw new Error('현재 경유점을 확인한 뒤 다시 시도해 주세요.');
      const points = routePoints(state.lab.config);
      nearby(state, actorId, now, points[index]);
      next.lab.routeProgress[actorId] = index + 1;
      if (index + 1 === points.length) finishMember(next, actorId);
      break;
    }
    case 'lab:npc-touch':
      if (state.lab.stage !== 'npc') throw new Error('정령을 만나는 단계에서 실행해 주세요.');
      if (state.lab.npcTouched[actorId]) return state;
      nearby(state, actorId, now);
      next.lab.npcTouched[actorId] = true;
      break;
    case 'lab:report': {
      if (state.lab.stage !== 'silence' && !(state.lab.trackSnapshot && state.lab.stage === 'ar-route')) throw new Error('묵언 단계에서 신고해 주세요.');
      if (actorId === action.targetId) throw new Error('다른 팀원을 선택해 주세요.');
      if (!state.members.some(item => item.id === action.targetId)) throw new Error('신고할 팀원을 찾을 수 없습니다.');
      next.lab.reports.push({ actorId, targetId: action.targetId, at: now });
      next.lab.penalties[action.targetId] = (next.lab.penalties[action.targetId] ?? 0) + 1;
      break;
    }
    default:
      throw new Error('지원하지 않는 동작입니다.');
  }
  next.lab.processedRequests.push({ actorId, requestId: action.requestId });
  next.lab.processedRequests = next.lab.processedRequests.slice(-200);
  next.revision++;
  return next;
}
