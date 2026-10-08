import { validWalkingCourse } from './261008_2355_course-geo.js';
import { validPosition } from './geo.js';
import { createMapView } from './261009_0536_map-provider.js';

const labels = { map: '지도', photo: '사진 인식', silence: '묵언 신고', npc: '정령', 'ar-route': 'AR 길', finder: '탐색', ending: '벌점 정산' };
const locationStages = ['map', 'npc', 'ar-route', 'finder'];
const startStages = ['map', 'ar-route'];
const $ = selector => document.querySelector(selector);
const pointLabel = role => role === 'start' ? '출발지' : '목적지';

export class ModuleSettings {
  constructor({ getIdentity, send }) {
    this.getIdentity = getIdentity; this.send = send;
    this.root = $('#module-settings'); this.form = $('#module-config-form');
    this.state = null; this.key = null; this.map = null; this.mapController = null; this.mapVersion = 0; this.stage = null; this.gpsVersion = 0;
    this.points = {}; this.role = 'destination'; this.mapInteracted = false; this.centeredOnGps = false;
    this.form.addEventListener('submit', event => {
      event.preventDefault();
      if (!this.canEdit || $('#module-config-save').disabled) return;
      try {
        const config = this.draft();
        if (locationStages.includes(this.stage) && !validPosition(config.destination)) throw new Error('지도에서 목적지를 지정해 주세요.');
        if (startStages.includes(this.stage) && !validPosition(config.start)) throw new Error('지도에서 출발지를 지정해 주세요.');
        if (this.stage === 'map' && !validWalkingCourse({ ...config, mode: 'gps' })) throw new Error('출발과 도착 범위가 겹쳐요. 목적지를 더 멀리 골라 주세요.');
        if (config.spatialProjectUrl) {
          const url = new URL(config.spatialProjectUrl);
          if (url.protocol !== 'https:') throw new Error('공간 AR 프로젝트는 https 주소로 입력해 주세요.');
        }
        if (this.send({ type: 'lab:configure-module', config })) $('#module-config-status').textContent = '팀 전체의 설정을 저장하고 현재 모듈을 다시 시작합니다.';
      } catch (error) { $('#module-config-status').textContent = error.message; }
    });
    this.form.addEventListener('input', () => this.renderDraft());
    this.form.addEventListener('change', () => this.renderDraft());
    for (const button of $('#module-location-role').querySelectorAll('[data-location-role]')) button.addEventListener('click', () => {
      if (!this.canEdit || !this.available) return;
      this.role = button.dataset.locationRole; this.gpsVersion++; this.renderPointState();
    });
    $('#module-current-start').addEventListener('click', () => this.currentPoint(false));
    $('#module-map-current').addEventListener('click', () => this.currentPoint(true));
    $('#module-map-fit').addEventListener('click', () => { this.mapInteracted = true; this.renderDraft(true); });
    $('#module-settings-editor').addEventListener('toggle', () => {
      if ($('#module-settings-editor').open && this.map) requestAnimationFrame(() => this.map?.invalidate());
    });
    this.freshnessTimer = setInterval(() => { if (this.map && this.canEdit) this.renderDraft(); }, 1000);
  }

  fields() { return [...this.form.querySelectorAll('[data-config]')]; }

  draft() {
    const config = {};
    for (const input of this.fields()) {
      if (input.closest('[data-module-field]').hidden) continue;
      config[input.dataset.config] = input.type === 'number' ? Number(input.value) : input.value.trim();
    }
    if (locationStages.includes(this.stage)) config.destination = this.points.destination ? { ...this.points.destination } : null;
    if (startStages.includes(this.stage)) config.start = this.points.start ? { ...this.points.start } : null;
    return config;
  }

  currentPosition() {
    const positions = [this.state?.lab.positions[this.getIdentity()?.participantId], this.localFix].filter(position => {
      const age = Date.now() - position?.at;
      return position?.source === 'gps' && validPosition(position) && Number.isFinite(position.accuracy) && position.accuracy >= 0 && Number.isFinite(age) && age >= -5000 && age <= 30000;
    });
    return positions.sort((a, b) => b.at - a.at)[0] ?? null;
  }

  update(state, available) {
    const previousCanEdit = this.canEdit;
    this.state = state; this.available = available; this.canEdit = !state.lab.trackSnapshot && state.leaderId === this.getIdentity()?.participantId;
    const { stage, config, runId } = state.lab;
    const key = JSON.stringify([stage, runId, config]);
    if (key !== this.key) {
      const changedStage = this.stage !== stage;
      this.key = key; this.stage = stage; this.gpsVersion++; this.localFix = null;
      this.points = Object.fromEntries(['start', 'destination'].filter(name => validPosition(config[name])).map(name => [name, { lat: config[name].lat, lon: config[name].lon }]));
      this.role = startStages.includes(stage) ? 'start' : 'destination';
      $(`#${stage}-panel`).prepend(this.root);
      $('#module-settings-heading').textContent = `${labels[stage]} ${state.lab.trackSnapshot ? '트랙 설정' : '테스트 설정'}`;
      for (const field of this.form.querySelectorAll('[data-module-field]')) field.hidden = !field.dataset.moduleField.split(' ').includes(stage);
      for (const input of this.fields()) input.value = config[input.dataset.config] ?? '';
      if (changedStage) { $('#module-settings-editor').open = false; $('#module-config-status').textContent = ''; }
      this.setupMap();
    } else if (previousCanEdit !== this.canEdit) { this.gpsVersion++; this.localFix = null; this.setupMap(); }
    const editable = !['silence', 'ending'].includes(stage);
    $('#module-settings-editor').hidden = !this.canEdit || !editable;
    if (!this.canEdit) $('#module-settings-editor').open = false;
    $('#module-config-summary').textContent = this.summary(stage, config);
    $('#module-settings-note').textContent = state.lab.trackSnapshot ? '이 트랙에 등록된 장소와 기준을 팀 전체가 함께 사용합니다.' : editable ? this.canEdit ? locationStages.includes(stage) ? '지도에서 지점을 고르고 저장하면 팀장과 팀원이 같은 설정으로 시험합니다.' : '기준 물체와 사진을 저장하면 팀장과 팀원이 같은 설정으로 시험합니다.' : '팀장이 저장한 설정으로 함께 시험합니다.' : stage === 'silence' ? '같은 팀원을 연속으로 신고할 수 있습니다. 신고 한 번마다 벌점 1점이 쌓입니다.' : '묵언 모듈에서 쌓인 팀 및 개인 벌점을 집계합니다.';
    for (const input of this.fields()) input.disabled = !this.canEdit || !available || input.closest('[data-module-field]').hidden;
    for (const button of this.form.querySelectorAll('button')) button.disabled = !this.canEdit || !available;
    this.renderPointState(); this.renderDraft();
    if (stage === 'ar-route') {
      const ready = Boolean(config.spatialProjectUrl && config.spatialMapId);
      $('#spatial-project-open').hidden = !ready;
      if (ready) $('#spatial-project-open').href = config.spatialProjectUrl;
      else $('#spatial-project-open').removeAttribute('href');
      $('#spatial-project-status').textContent = ready ? `등록된 공간 AR 프로젝트 / Map ID: ${config.spatialMapId}. 프로젝트에서 현장 인식과 바닥 경로를 시험해 주세요.` : '바닥 고정 경로는 공간 스캔과 Mattercraft 프로젝트를 연결한 뒤 시험할 수 있습니다.';
    }
  }

  summary(stage, config) {
    if (stage === 'finder' && this.state?.lab.trackSnapshot) return `실제 GPS / 숨은 목적지 탐색 / 도착 반경 ${config.radius}m`;
    if (stage === 'photo') return `인식 대상: ${config.photoTarget}`;
    if (stage === 'silence') return '신고 간격 제한 없음 / 신고 1건 = 벌점 1점';
    if (stage === 'ending') return '팀 전체 신고 수, 개인 벌점, 벌점 왕 및 최종 결과';
    return `${startStages.includes(stage) ? '출발지와 목적지' : '목적지'} 지정됨 / 도착 반경 ${config.radius}m`;
  }

  renderPointState() {
    for (const button of $('#module-location-role').querySelectorAll('[data-location-role]')) {
      button.hidden = button.dataset.locationRole === 'start' && !startStages.includes(this.stage);
      button.setAttribute('aria-pressed', String(button.dataset.locationRole === this.role));
    }
    $('#module-start-status').hidden = !startStages.includes(this.stage);
    for (const name of ['start', 'destination']) $(`#module-${name}-status`).textContent = `${pointLabel(name)}: ${validPosition(this.points[name]) ? '지정됨' : '지도에서 선택해 주세요'}`;
    $('#module-current-start').textContent = `현재 위치를 ${pointLabel(this.role)}로 지정`;
    $('#module-location-map').dataset.selectedRole = this.role;
  }

  async setupMap() {
    this.mapController?.abort(); this.map?.dispose(); this.map = null;
    const version = ++this.mapVersion; this.mapInteracted = false; this.centeredOnGps = false; this.mapDrawKey = null;
    if (!locationStages.includes(this.stage) || !this.canEdit) return;
    const controller = new AbortController(); this.mapController = controller;
    try {
      const map = await createMapView($('#module-location-map'), {
        center: this.currentPosition() ?? this.points.destination ?? this.points.start, signal: controller.signal,
        onStatus: message => { if (version === this.mapVersion) $('#module-location-hint').textContent = `지점을 고르고 지도를 눌러 핀을 놓습니다. ${message}`; },
        onClick: point => {
          if (!this.canEdit || !this.available || version !== this.mapVersion) return;
          this.gpsVersion++; this.mapInteracted = true;
          this.points[this.role] = { lat: point.lat, lon: point.lon };
          this.renderDraft(); this.renderPointState();
          $('#module-config-status').textContent = `${pointLabel(this.role)}를 골랐어요. 다른 위치를 누르면 핀이 이동합니다. 저장하면 팀 전체에 적용됩니다.`;
        },
      });
      if (version !== this.mapVersion || controller.signal.aborted) { map.dispose(); return; }
      this.map = map; this.renderDraft();
      if (!this.currentPosition()) this.renderDraft(true);
      if ($('#module-settings-editor').open) requestAnimationFrame(() => this.map?.invalidate());
    } catch (error) { if (version === this.mapVersion && error.name !== 'AbortError') $('#module-location-hint').textContent = error.message; }
  }

  renderDraft(fit = false) {
    if (!this.map) return;
    const config = this.draft(), mine = this.currentPosition();
    const members = mine ? [{ lat: mine.lat, lon: mine.lon, accuracy: mine.accuracy, id: 'current', name: '현재 위치', mine: true }] : [];
    const drawKey = JSON.stringify([config.start, config.destination, config.radius, members]);
    if (drawKey !== this.mapDrawKey) { this.mapDrawKey = drawKey; this.map.draw({ ...config, members }); }
    $('#module-location-map').dataset.currentLocation = mine ? 'gps' : 'unavailable';
    $('#module-map-gps-status').textContent = mine ? `내 위치가 지도에 표시돼 있어요. 오차 약 ${Math.round(mine.accuracy)}m / ${Math.max(0, Math.floor((Date.now() - mine.at) / 1000))}초 전 측정` : '현재 위치를 확인하고 있습니다. 위치 권한을 허용하거나 지도를 직접 눌러 지점을 골라 주세요.';
    if (fit) {
      this.map.fit([config.start, config.destination, mine].filter(validPosition));
    } else if (mine && !this.centeredOnGps && !this.mapInteracted) {
      this.map.setView(mine, 18); this.centeredOnGps = true;
    }
  }

  currentPoint(centerOnly) {
    if (!this.canEdit || !this.available) return;
    const version = ++this.gpsVersion, role = this.role;
    const apply = ({ lat, lon, accuracy, measuredAt }) => {
      if (version !== this.gpsVersion || !this.canEdit || !this.available) return;
      const age = Date.now() - measuredAt;
      if (!validPosition({ lat, lon }) || !Number.isFinite(accuracy) || accuracy < 0 || !Number.isFinite(measuredAt) || age > 30000 || age < -5000) { $('#module-config-status').textContent = '새 GPS를 확인하지 못했습니다. 다시 눌러 주세요.'; return; }
      this.localFix = { lat, lon, accuracy, at: measuredAt, source: 'gps' };
      if (!centerOnly) this.points[role] = { lat, lon };
      this.mapInteracted = true; this.centeredOnGps = true;
      this.renderDraft(); this.renderPointState(); this.map?.setView({ lat, lon }, 18);
      $('#module-config-status').textContent = centerOnly ? '현재 위치를 중심으로 지도를 보여드립니다. 지정할 지점을 고르고 지도를 눌러 주세요.' : `${pointLabel(role)}를 현재 위치로 지정했어요. 지도에서 조정한 뒤 저장해 주세요.`;
    };
    const latest = this.currentPosition();
    if (latest) { apply({ ...latest, measuredAt: latest.at }); return; }
    if (!navigator.geolocation) { $('#module-config-status').textContent = '이 브라우저에서 GPS를 사용할 수 없습니다. 지도에서 직접 선택해 주세요.'; return; }
    $('#module-config-status').textContent = '현재 GPS를 확인하고 있습니다.';
    navigator.geolocation.getCurrentPosition(position => apply({ lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy, measuredAt: position.timestamp }), error => { if (version === this.gpsVersion) $('#module-config-status').textContent = error.code === 1 ? '위치 권한을 허용하거나 지도에서 직접 선택해 주세요.' : '현재 위치를 확인하지 못했습니다. 지도에서 선택하거나 다시 눌러 주세요.'; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  dispose() { this.gpsVersion++; this.mapVersion++; this.localFix = null; clearInterval(this.freshnessTimer); this.mapController?.abort(); this.map?.dispose(); this.map = null; }
}
