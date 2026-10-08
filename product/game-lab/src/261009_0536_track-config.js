import template from '../public/261009_0536_campus-track.json' with { type: 'json' };
import { imageBytes } from './photo-verification.js';
import { validWalkingCourse } from '../public/261008_2355_course-geo.js';

export const campusTrackId = 'kw-silence';
const PLACE_IDS = Object.keys(template.places);
const error = message => Object.assign(new Error(message), { status: 400 });

function object(value, keys, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw error(`${description} 입력을 확인해 주세요.`);
  return value;
}

function place(value, name) {
  object(value, ['lat', 'lon', 'radius'], name);
  if (value.lat === null && value.lon === null) {
    if (!Number.isFinite(value.radius) || value.radius < 5 || value.radius > 100) throw error('도착 반경은 5m부터 100m로 입력해 주세요.');
    return { name, lat: null, lon: null, radius: value.radius };
  }
  if (!Number.isFinite(value.lat) || Math.abs(value.lat) > 90 || !Number.isFinite(value.lon) || Math.abs(value.lon) > 180) throw error(`${name}의 위도와 경도를 확인해 주세요.`);
  if (!Number.isFinite(value.radius) || value.radius < 5 || value.radius > 100) throw error('도착 반경은 5m부터 100m로 입력해 주세요.');
  return { name, lat: value.lat, lon: value.lon, radius: value.radius };
}

function spatial(value) {
  object(value, ['projectUrl', 'mapId'], '공간 AR');
  if (typeof value.projectUrl !== 'string' || value.projectUrl.length > 1000 || typeof value.mapId !== 'string' || value.mapId.trim().length > 100) throw error('공간 AR 프로젝트 주소와 Map ID를 확인해 주세요.');
  let projectUrl = value.projectUrl.trim();
  if (projectUrl) {
    let url;
    try { url = new URL(projectUrl); } catch { throw error('HTTPS 공간 AR 프로젝트 주소를 입력해 주세요.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw error('HTTPS 공간 AR 프로젝트 주소를 입력해 주세요.');
    projectUrl = url.href;
  }
  return { projectUrl, mapId: value.mapId.trim() };
}

export function validateCampusTrack(input, version = 1, now = Date.now()) {
  object(input, ['places', 'reference', 'ending', 'spatial'], '트랙 설정');
  object(input.places, PLACE_IDS, '장소');
  const places = Object.fromEntries(PLACE_IDS.map(id => [id, place(input.places[id], template.places[id].name)]));
  object(input.reference, ['label', 'image'], '기준 사진');
  if (typeof input.reference.label !== 'string' || !input.reference.label.trim() || input.reference.label.trim().length > 80) throw error('기준 물체 이름은 1자부터 80자로 입력해 주세요.');
  if (input.reference.label.trim() !== template.reference.label) throw error('이번 트랙의 기준 물체는 에어팟입니다.');
  if (input.reference.image !== null) imageBytes(input.reference.image);
  if (![null, template.ending].includes(input.ending)) throw error('이번 트랙은 풋살장 카페 지점에서 마무리합니다.');
  const route = spatial(input.spatial);
  const configuredPlaces = PLACE_IDS.every(id => places[id].lat !== null);
  const configured = configuredPlaces && Boolean(input.reference.image) && input.ending !== null;
  if (configuredPlaces && !validWalkingCourse({ mode: 'gps', start: places.welfare, destination: places.square, radius: places.square.radius })) throw error('출발점과 첫 목적지는 도착 반경의 두 배보다 멀게 지정해 주세요.');
  return {
    id: campusTrackId, title: template.title, definitionVersion: template.version, version, status: configured ? 'ready' : 'draft', updatedAt: now,
    places, reference: { label: input.reference.label.trim(), image: input.reference.image },
    ending: input.ending, spatial: route, story: structuredClone(template.story), mappings: structuredClone(template.mappings ?? {}),
    stageOrder: ['map', 'photo', 'silence', 'ar-route', 'npc', 'finder', 'ending']
  };
}

export function defaultCampusTrack() {
  return validateCampusTrack({
    places: Object.fromEntries(PLACE_IDS.map(id => [id, { lat: null, lon: null, radius: template.places[id].radius }])),
    reference: { label: template.reference.label, image: null }, ending: template.ending, spatial: { projectUrl: '', mapId: '' }
  }, 0, null);
}

export function upgradeCampusTrack(track) {
  if ((track.definitionVersion ?? 1) >= template.version) return track;
  return validateCampusTrack({
    places: Object.fromEntries(PLACE_IDS.map(id => [id, {
      lat: track.places[id]?.lat ?? null, lon: track.places[id]?.lon ?? null,
      radius: track.places[id]?.radius ?? template.places[id].radius
    }])),
    reference: { label: track.reference.label, image: track.reference.image },
    ending: template.ending, spatial: track.spatial
  }, track.version + 1);
}

export function campusTrackDetails(track, admin = false) {
  const result = structuredClone(track);
  if (!admin) {
    delete result.reference.image;
    result.reference.configured = Boolean(track.reference.image);
  }
  return result;
}

export function campusTrackSummary(track) {
  return { id: track.id, title: track.title, definitionVersion: track.definitionVersion, version: track.version, status: track.status, updatedAt: track.updatedAt };
}

export function applyCampusTrack(lab, track, referenceId) {
  if (track.id !== campusTrackId || track.status !== 'ready') throw Object.assign(new Error('모든 장소의 GPS와 기준 사진 및 종료 장소를 저장한 뒤 방을 만들어 주세요.'), { status: 409 });
  const point = place => ({ lat: place.lat, lon: place.lon });
  const { welfare, square, bima, futsal } = track.places;
  const finalPlace = track.ending === 'cafe' ? futsal : welfare;
  const settings = {
    map: { start: point(welfare), destination: point(square), radius: square.radius },
    photo: { photoTarget: track.reference.label },
    'ar-route': { start: point(square), destination: point(bima), radius: bima.radius, spatialProjectUrl: track.spatial.projectUrl, spatialMapId: track.spatial.mapId },
    npc: { destination: point(bima), radius: bima.radius },
    finder: { start: point(bima), destination: point(finalPlace), radius: finalPlace.radius }
  };
  for (const [stage, values] of Object.entries(settings)) Object.assign(lab.moduleConfigs[stage], values, { mode: 'gps' });
  lab.config = structuredClone(lab.moduleConfigs.map);
  lab.stageOrder = [...track.stageOrder];
  lab.trackSnapshot = campusTrackDetails(track);
  lab.trackSnapshot.reference = { id: referenceId, label: track.reference.label };
  return lab;
}

export function validateKakaoJavascriptKey(body) {
  object(body, ['kakaoJavascriptKey'], '지도 설정');
  if (typeof body.kakaoJavascriptKey !== 'string' || !/^([0-9a-f]{32})?$/.test(body.kakaoJavascriptKey)) throw error('카카오 JavaScript 키 32자를 입력해 주세요.');
  return body.kakaoJavascriptKey;
}
