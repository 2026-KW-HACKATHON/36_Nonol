const $ = selector => document.querySelector(selector);
const roomId = new URLSearchParams(location.search).get('room');
const storageKey = `nonol-room:${roomId}`;
let identity = null, socket = null, state = null, pending = null, reconnectTimer = null;
let attempt = 0, lastMessageAt = 0, connected = false;
let pendingAction = null;
let navigating = false;
let generationId = null;
let personalInfo = null, registrationRequired = false;
let personalInvite = '';
try {
  const supplied = new URLSearchParams(location.hash.slice(1)).get('invite');
  personalInvite = supplied || sessionStorage.getItem(`nonol-personal-invite:${roomId}`) || '';
  if (supplied) { sessionStorage.setItem(`nonol-personal-invite:${roomId}`, supplied); history.replaceState(null, '', `${location.pathname}${location.search}`); }
} catch { personalInvite = new URLSearchParams(location.hash.slice(1)).get('invite') || ''; }

function savedIdentity() {
  try { return JSON.parse(localStorage.getItem(storageKey)); }
  catch { return null; }
}

function clearRoomIdentity() {
  try { const saved = savedIdentity(); if (!saved || !identity?.token || saved.token === identity.token) localStorage.removeItem(storageKey); } catch {}
  try {
    const prefix = `nonol-lab-story:${roomId}:`;
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key);
  } catch {}
  try { const active = JSON.parse(localStorage.getItem('nonol-registered-room')); if (active?.roomId === roomId && (!identity?.token || active.token === identity.token)) localStorage.removeItem('nonol-registered-room'); } catch {}
  identity = null; pending = null; pendingAction = null;
  clearTimeout(reconnectTimer);
  const previous = socket; socket = null; previous?.close();
  connected = false; state = null;
  $('#nickname').value = '';
}

function returnToEntry(deleted = false) {
  if (navigating) return;
  navigating = true;
  for (const control of document.querySelectorAll('button, input, select')) control.disabled = true;
  clearRoomIdentity();
  if (deleted === true) { try { sessionStorage.removeItem(`nonol-personal-invite:${roomId}`); } catch {} }
  try { sessionStorage.setItem(`nonol-lab-entry:${roomId}`, 'reset'); } catch {}
  location.replace(deleted === true ? '/?deleted=1' : `/?room=${encodeURIComponent(roomId)}`);
}

function showEntry(message = '') {
  connection('닉네임으로 입장해요');
  $('#entry').hidden = false; $('#lobby').hidden = true; $('#started').hidden = true;
  $('#join-form').hidden = false; $('#retry-button').hidden = true;
  $('#error').textContent = message;
  if (personalInfo) { $('#nickname').value = personalInfo.name; $('#nickname').readOnly = true; }
  if (registrationRequired && !personalInfo) { $('#join-form').hidden = true; $('#entry-note').textContent = '이 그룹은 신청자별 개인 링크로 입장합니다. 전달받은 본인의 개인 링크를 열어 주세요.'; }
}

function saveRegisteredIdentity() {
  if (registrationRequired && identity?.participantId) localStorage.setItem('nonol-registered-room', JSON.stringify({ roomId, ...identity }));
}

function connection(label) {
  $('#connection').textContent = label;
  $('#connection').classList.remove('connected');
  connected = false;
  if (state) render(state);
}

async function request(path, payload) {
  let response;
  try { response = await fetch(path, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}); }
  catch { throw new Error('연결하지 못했습니다. 다시 시도해 주세요.'); }
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || '연결하지 못했습니다. 다시 시도해 주세요.'), { status: response.status, code: body.code });
  return body;
}

function render(next) {
  if (navigating) return;
  if (next.track === 'lab' && identity?.participantId && !next.members.some(member => member.id === identity.participantId)) { returnToEntry(); return; }
  if (state && next.revision < state.revision) return;
  const wasStarted = state?.phase === 'started';
  const wasLobby = state?.phase === 'lobby';
  const wasLeader = state?.leaderId === identity?.participantId;
  state = next;
  $('#entry').hidden = true;
  $('#lobby').hidden = next.phase !== 'lobby';
  $('#started').hidden = next.phase !== 'started';
  if (next.phase === 'started') {
    if (next.track === 'lab') { if (!navigating) { navigating = true; socket?.close(); location.replace(`/lab?room=${encodeURIComponent(roomId)}`); } return; }
    $('#started-members').textContent = next.members.map(member => member.name).join(', ');
    if (!wasStarted) $('#started-heading').focus();
    return;
  }
  const self = next.members.find(member => member.id === identity?.participantId);
  const isLeader = next.leaderId === self?.id;
  const readyCount = next.members.filter(member => member.ready).length;
  const isLab = next.track === 'lab';
  const solo = isLab && next.members.length === 1 && !next.registration;
  const awaitingTags = Boolean(next.registration && !next.registration.allTagged);
  const allReady = next.members.length > 0 && readyCount === next.members.length;
  $('#lab-settings').hidden = !isLab;
  $('#room-title').textContent = next.title;
  $('#ready-count').textContent = `${readyCount}/${next.members.length}`;
  $('#member-count').textContent = `${next.members.length}명 입장`;
  $('#ready-message').textContent = !connected ? '다시 연결한 뒤 준비와 시작을 진행할 수 있어요.'
    : awaitingTags ? `노놀판 ${next.registration.taggedCount}/${next.registration.total}명 확인. 신청자 전원의 확인이 필요해요.`
    : allReady ? (isLeader ? (solo ? '준비됐어요. 혼자 테스트를 시작할 수 있어요.' : '전원 준비됐어요. 테스트를 시작해 주세요.') : '전원 준비됐어요. 팀장이 시작하면 함께 이동해요.')
    : solo ? '혼자 시험할 수 있어요. 준비 완료를 눌러 주세요.'
    : self?.ready ? `다른 참가자의 준비를 기다리고 있어요. ${next.members.length - readyCount}명 남았어요.` : '각자 준비 완료를 눌러 주세요. 팀장도 준비가 필요해요.';
  $('#ready-button').setAttribute('aria-pressed', String(Boolean(self?.ready)));
  $('#ready-button').replaceChildren(document.createTextNode(self?.ready ? '준비 취소하기' : '준비 완료'), makeSpan(self?.ready ? '↶' : '✓'));
  $('#ready-button').disabled = !connected || Boolean(pending);
  $('#start-button').hidden = !isLeader;
  $('#start-button').replaceChildren(document.createTextNode(isLab ? '테스트 시작하기' : '트랙 시작하기'), makeSpan('↗'));
  $('#start-button').disabled = !connected || Boolean(pending) || !allReady || awaitingTags;
  $('#registration-panel').hidden = !next.registration;
  if (next.registration) {
    $('#lobby-guide').textContent = '각자 개인 링크로 입장하고 준비해 주세요. 식사 후 전원이 노놀판을 확인하면 팀장이 시작합니다.';
    $('#registration-progress').textContent = `${next.registration.date} ${next.registration.time} / 노놀판 ${next.registration.taggedCount}/${next.registration.total}명 확인${next.registration.allTagged ? ' / 전원 확인 완료' : ''}`;
    $('#registration-people').replaceChildren(...next.registration.people.map(person => { const row = document.createElement('li'); row.textContent = `${person.name}: ${person.tagged ? '노놀판 확인 완료' : person.joined ? '노놀판 확인 대기' : '개인 링크 입장 대기'}`; return row; }));
    $('#registration-board').href = `/board?board=${encodeURIComponent(next.registration.boardId)}`;
  }
  $('#leader-note').textContent = isLeader ? (solo ? '현재 팀장은 나입니다. 팀원이 입장하면 팀장을 넘길 수 있어요.' : '현재 팀장은 나입니다. 전원이 준비하면 시작할 수 있어요.') : '팀장이 시작하면 전원이 같은 테스트 단계로 이동해요.';
  const focusTarget = document.activeElement?.dataset.transfer;
  const focusedStart = document.activeElement === $('#start-button');
  const rows = next.members.map((member, index) => {
    const row = document.createElement('li');
    row.className = `member${member.ready ? ' is-ready' : ''}`;
    row.dataset.memberId = member.id;
    const avatar = makeSpan(member.ready ? '✓' : String(index + 1));
    avatar.className = 'avatar';
    const info = document.createElement('div'); info.className = 'member-info';
    const name = document.createElement('p'); name.className = 'member-name'; name.textContent = member.name;
    const label = document.createElement('span'); label.className = 'member-label';
    label.textContent = [member.id === identity?.participantId ? '나' : '', member.id === next.leaderId ? '팀장' : '', member.connected ? '접속 중' : '다시 연결하는 중'].filter(Boolean).join(' / ');
    info.append(name, label);
    const status = document.createElement('span'); status.className = 'member-state'; status.textContent = member.ready ? '준비 완료' : '준비 전';
    row.append(avatar, info, status);
    if (isLeader && member.id !== self.id) {
      const button = document.createElement('button'); button.className = 'transfer'; button.dataset.transfer = member.id;
      button.textContent = '팀장 넘기기'; button.setAttribute('aria-label', `${member.name}님에게 팀장 넘기기`);
      button.disabled = !connected || Boolean(pending);
      button.addEventListener('click', () => send({ type: 'transfer', targetId: member.id }));
      row.append(button);
    }
    return row;
  });
  $('#members').replaceChildren(...rows);
  if (focusTarget) {
    const same = [...$('#members').querySelectorAll('[data-transfer]')].find(element => element.dataset.transfer === focusTarget);
    if (same && !same.disabled) same.focus();
    else if (!pending) $('#ready-button').focus();
  }
  if (focusedStart && !isLeader) $('#ready-button').focus();
  if (!wasLobby) $('#lobby-heading').focus();
}

function makeSpan(text) { const span = document.createElement('span'); span.textContent = text; span.setAttribute('aria-hidden', 'true'); return span; }

function send(action) {
  if (!connected || pending || socket?.readyState !== WebSocket.OPEN) return;
  pending = crypto.randomUUID();
  pendingAction = action.type;
  $('#error').textContent = '';
  socket.send(JSON.stringify({ ...action, requestId: pending }));
  render(state);
}

function connect() {
  if (navigating || !identity?.participantId) return;
  clearTimeout(reconnectTimer);
  connection(attempt ? '다시 연결하는 중' : '대기실 연결 중');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${roomId}/socket`);
  socket = ws;
  ws.addEventListener('open', () => { if (ws === socket && identity?.token && !navigating) ws.send(JSON.stringify({ type: 'hello', token: identity.token })); });
  ws.addEventListener('message', event => {
    if (ws !== socket) return;
    lastMessageAt = Date.now();
    if (event.data === 'pong') return;
    const message = JSON.parse(event.data);
    if (message.type === 'room-deleted' || message.code === 'ROOM_DELETED') { returnToEntry(true); return; }
    if (message.type === 'room-reset' || message.code === 'ROOM_IDENTITY_EXPIRED' || message.code === 'ROOM_RESET') { returnToEntry(); return; }
    if (message.type === 'state') {
      attempt = 0;
      connected = true;
      $('#connection').textContent = '연결됨'; $('#connection').classList.add('connected');
      render(message.state);
    } else if (message.type === 'ack' || message.type === 'error') {
      const completedAction = message.requestId === pending ? pendingAction : null;
      if (message.requestId === pending) { pending = null; pendingAction = null; }
      if (message.type === 'error') $('#error').textContent = message.message;
      if (state) render(state);
      if (completedAction === 'transfer' && state?.phase === 'lobby') $('#ready-button').focus();
    }
  });
  ws.addEventListener('close', async event => {
    if (ws !== socket) return;
    if (event.code === 4404) { returnToEntry(true); return; }
    pending = null; pendingAction = null;
    connection('다시 연결하는 중');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`/api/rooms/${roomId}`, { cache: 'no-store', signal: controller.signal });
      if (ws !== socket || navigating) return;
      if (response.status === 404) { returnToEntry(true); return; }
    } catch {}
    finally { clearTimeout(timer); }
    if (ws !== socket || navigating) return;
    reconnectTimer = setTimeout(connect, Math.min(500 * Math.pow(2, attempt++), 8000));
  });
  ws.addEventListener('error', () => { if (ws === socket) connection('다시 연결하는 중'); });
}

$('#ready-button').addEventListener('click', () => send({ type: 'ready', ready: !state.members.find(member => member.id === identity.participantId).ready }));
$('#start-button').addEventListener('click', () => send({ type: 'start' }));
$('#join-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#nickname').value.trim();
  if (!name || $('#join-button').disabled) return;
  $('#join-button').disabled = true; $('#error').textContent = '';
  try {
    if (personalInvite) {
      const previousRoom = localStorage.getItem(storageKey), previousActive = localStorage.getItem('nonol-registered-room');
      const joined = await request(`/api/rooms/${roomId}/join`, { invite: personalInvite, expectedGeneration: generationId });
      if (localStorage.getItem(storageKey) !== previousRoom || localStorage.getItem('nonol-registered-room') !== previousActive) { showEntry('다른 탭에서 입장 정보가 변경되었습니다. 본인의 개인 링크를 다시 열어 주세요.'); return; }
      identity = joined; localStorage.setItem(storageKey, JSON.stringify(identity)); saveRegisteredIdentity();
      $('#join-form').hidden = true; $('#entry-note').textContent = '신청 그룹에 연결하고 있습니다.'; connect(); return;
    }
    const reserveIdentity = () => {
      identity = savedIdentity();
      if (identity && !identity.participantId && identity.generationId && identity.generationId !== generationId) clearRoomIdentity();
      identity ||= { token: crypto.randomUUID(), name, generationId };
      localStorage.setItem(storageKey, JSON.stringify(identity));
    };
    if (navigator.locks) await navigator.locks.request(storageKey, reserveIdentity);
    else reserveIdentity();
    const reserved = identity;
    const joined = await request(`/api/rooms/${roomId}/join`, reserved.participantId || (generationId && !reserved.generationId) ? { token: reserved.token } : { name: reserved.name || name, joinKey: reserved.token, expectedGeneration: reserved.generationId });
    if (savedIdentity()?.token !== reserved.token) { identity = null; await init(true); return; }
    identity = joined;
    localStorage.setItem(storageKey, JSON.stringify(identity));
    saveRegisteredIdentity();
    $('#join-form').hidden = true;
    $('#entry-note').textContent = '테스트 대기실에 연결하고 있습니다.';
    connect();
  } catch (error) {
    if (error.status === 401 || error.code === 'ROOM_IDENTITY_EXPIRED' || error.code === 'ROOM_RESET') {
      clearRoomIdentity();
      await init(true);
      if (!$('#join-form').hidden) $('#error').textContent = '방이 초기화되었습니다. 닉네임을 입력하고 다시 입장해 주세요.';
    } else $('#error').textContent = error.name === 'QuotaExceededError' || error.name === 'SecurityError' ? '입장 정보를 저장할 수 없습니다. 일반 브라우저에서 링크를 열어 주세요.' : error.message;
  }
  finally { $('#join-button').disabled = false; }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !identity?.participantId) return;
  if (socket?.readyState === WebSocket.OPEN) {
    if (Date.now() - lastMessageAt > 30000) socket.close();
    else socket.send('ping');
  } else if (socket?.readyState !== WebSocket.CONNECTING) connect();
});
setInterval(() => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastMessageAt > 45000) socket.close();
  else socket.send('ping');
}, 20000);

async function init(forceEntry = false) {
  if (!roomId) {
    $('#entry').hidden = true;
    const { initHome } = await import('./261009_0159_home.js');
    await initHome();
    return;
  }
  const retrying = !$('#retry-button').hidden;
  $('#retry-button').hidden = true;
  $('#error').textContent = '';
  try {
    const summary = await request(`/api/rooms/${roomId}`);
    generationId = summary.generationId;
    registrationRequired = Boolean(summary.registrationRequired);
    if (registrationRequired && personalInvite) {
      const previousRoom = localStorage.getItem(storageKey);
      personalInfo = await request(`/api/rooms/${roomId}/invite`, { invite: personalInvite });
      const saved = savedIdentity();
      if (saved?.participantId && saved.participantId !== personalInfo.participantId) {
        if (localStorage.getItem(storageKey) !== previousRoom) { showEntry('다른 탭에서 입장 정보가 변경되었습니다. 본인의 개인 링크를 다시 열어 주세요.'); return; }
        clearRoomIdentity();
      }
      $('#nickname').value = personalInfo.name; $('#nickname').readOnly = true;
      document.querySelector('label[for="nickname"]').textContent = '신청한 이름';
      $('#personal-browser-guide').hidden = !/kakaotalk/i.test(navigator.userAgent);
    }
    $('#entry-note').textContent = '이 링크는 함께 테스트하는 팀원끼리만 사용해 주세요.';
    if (personalInfo) $('#entry-note').textContent = `${personalInfo.name}님의 개인 링크입니다. 다른 사람에게 전달하지 말아 주세요.`;
    document.title = `${summary.title} 대기실 | 노놀`;
    try { if (sessionStorage.getItem(`nonol-lab-entry:${roomId}`)) { forceEntry = true; sessionStorage.removeItem(`nonol-lab-entry:${roomId}`); } } catch {}
    if (forceEntry) { showEntry(); return; }
    const saved = savedIdentity();
    if (saved?.token) {
      identity = saved;
      if (!saved.participantId && saved.generationId && saved.generationId !== generationId) {
        clearRoomIdentity(); showEntry('방이 초기화되었습니다. 닉네임을 입력하고 다시 입장해 주세요.'); return;
      }
      const joined = await request(`/api/rooms/${roomId}/join`, saved.participantId || (generationId && !saved.generationId) ? { token: saved.token } : { name: saved.name, joinKey: saved.token, expectedGeneration: saved.generationId });
      if (savedIdentity()?.token !== saved.token) { identity = null; await init(true); return; }
      identity = joined;
      localStorage.setItem(storageKey, JSON.stringify(identity));
      saveRegisteredIdentity();
      connect();
    } else {
      showEntry();
      if (retrying) $('#nickname').focus();
    }
  } catch (error) {
    if (error.status === 404) {
      clearRoomIdentity(); showEntry('이 방은 삭제되었거나 존재하지 않습니다. 방 목록에서 다른 방을 선택해 주세요.');
      $('#join-form').hidden = true;
      $('#entry-note').textContent = '아래 전체 테스트 방 보기를 눌러 주세요.';
      connection('방을 찾을 수 없어요');
      return;
    }
    if (error.status === 401 || error.code === 'ROOM_IDENTITY_EXPIRED' || error.code === 'ROOM_RESET') {
      clearRoomIdentity(); showEntry('방이 초기화되었습니다. 닉네임을 입력하고 다시 입장해 주세요.'); return;
    }
    connection('다시 연결해 주세요');
    $('#error').textContent = error.message;
    $('#retry-button').hidden = false;
    $('#retry-button').focus();
  }
}
$('#retry-button').addEventListener('click', () => init());
init();
