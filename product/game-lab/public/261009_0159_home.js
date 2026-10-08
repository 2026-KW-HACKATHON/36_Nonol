const $ = selector => document.querySelector(selector);
const stages = { map: '지도', photo: '사진 인증', silence: '묵언 신고', npc: '정령', 'ar-route': 'AR 길', finder: '방향 탐색', ending: '엔딩' };
let rooms = [], admin = false, cursor = null, total = 0, loading = false, query = '', version = 0;
const deleting = new Set();
let authVersion = 0;

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || '요청을 처리하지 못했습니다.'), { status: response.status });
  return body;
}
function adminState(value) {
  admin = value;
  $('#admin-open').hidden = value; $('#admin-logout').hidden = !value;
  $('#groups-open').hidden = !value;
  $('#admin-status').textContent = value ? '관리자 모드: 모든 테스트 방을 삭제할 수 있습니다.' : '';
  renderRooms();
}
function renderRooms() {
  const active = document.activeElement?.closest('[data-room-id]');
  const activeRoom = active?.dataset.roomId;
  const activeDelete = document.activeElement?.classList.contains('room-delete');
  const fragment = document.createDocumentFragment();
  for (const room of rooms) {
    const row = document.createElement('li'); row.className = 'room-item'; row.dataset.roomId = room.id;
    const title = document.createElement('h2'); title.textContent = room.title;
    const info = document.createElement('p'); info.className = 'room-info';
    const phase = room.phase === 'started' ? `진행 중 / ${stages[room.stage] || '시작'}` : '대기 중';
    info.textContent = `${phase} / ${room.memberCount ?? 0}명 / ${room.track === 'lab' ? '모듈 테스트' : '대기실 테스트'}`;
    const actions = document.createElement('div'); actions.className = 'room-actions';
    const enter = document.createElement('a'); enter.className = 'room-enter'; enter.href = `/?room=${encodeURIComponent(room.id)}`; enter.textContent = '방 들어가기 ↗'; enter.setAttribute('aria-label', `${room.title} 방 들어가기`); actions.append(enter);
    if (admin) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'room-delete'; remove.textContent = deleting.has(room.id) ? '삭제 중' : '방 삭제'; remove.disabled = deleting.has(room.id); remove.setAttribute('aria-label', `${room.title} 방 삭제`);
      remove.addEventListener('click', () => deleteRoom(room)); actions.append(remove);
    }
    row.append(title, info, actions); fragment.append(row);
  }
  $('#room-list').replaceChildren(fragment);
  $('#rooms-more').hidden = !cursor; $('#rooms-more').disabled = loading;
  $('#rooms-status').textContent = loading ? '방 목록을 불러오고 있습니다.' : rooms.length ? `${total}개 방 중 ${rooms.length}개 표시${query ? ' / 검색 결과' : ''}` : query ? '이 이름의 테스트 방이 없습니다.' : '현재 테스트 방이 없습니다. 팀에서 방을 발급하면 여기에 표시됩니다.';
  if (activeRoom) {
    const row = [...$('#room-list').children].find(item => item.dataset.roomId === activeRoom);
    const target = row?.querySelector(activeDelete && admin ? '.room-delete' : '.room-enter');
    if (target && !target.disabled) target.focus();
    else $('#rooms-refresh').focus();
  }
}
async function loadRooms(append = false) {
  if (append && loading) return;
  const current = ++version;
  loading = true; $('#rooms-error').textContent = ''; renderRooms();
  try {
    const params = new URLSearchParams({ limit: '25' });
    if (query) params.set('q', query);
    if (append && cursor) params.set('cursor', cursor);
    const data = await request(`/api/rooms?${params}`);
    if (current !== version) return;
    rooms = append ? [...rooms, ...data.rooms.filter(room => !rooms.some(existing => existing.id === room.id))] : data.rooms;
    cursor = data.nextCursor || null; total = data.total ?? rooms.length;
    $('#connection').textContent = '목록 연결됨'; $('#connection').classList.add('connected');
  } catch (error) {
    if (current !== version) return;
    $('#rooms-error').textContent = `${error.message} 목록 새로고침으로 다시 시도해 주세요.`;
    $('#connection').textContent = '목록 연결 확인'; $('#connection').classList.remove('connected');
  } finally { if (current === version) { loading = false; renderRooms(); } }
}
async function deleteRoom(room) {
  if (!admin || deleting.has(room.id)) return;
  if (!confirm(`“${room.title}” 방을 삭제할까요? 참가자와 진행 및 기준 사진 데이터가 지워지고 접속 중인 전원은 방 목록으로 돌아갑니다.`)) return;
  deleting.add(room.id); renderRooms(); $('#rooms-error').textContent = '';
  try {
    await request(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
    $('#home-notice').textContent = `“${room.title}” 방을 삭제했습니다.`;
    await loadRooms();
  } catch (error) {
    if (error.status === 401 || error.status === 403) adminState(false);
    $('#rooms-error').textContent = error.message;
  } finally { deleting.delete(room.id); renderRooms(); }
}
export async function initHome() {
  $('#home').hidden = false; $('#entry').hidden = true;
  document.title = '테스트 방 목록 | 노놀 Test Lab';
  $('#connection').textContent = '목록 연결 중';
  if (new URLSearchParams(location.search).has('deleted')) $('#home-notice').textContent = '관리자가 방을 삭제했습니다. 다른 테스트 방에 입장해 주세요.';
  $('#rooms-refresh').addEventListener('click', () => loadRooms());
  $('#rooms-more').addEventListener('click', () => loadRooms(true));
  $('#rooms-search').addEventListener('submit', event => { event.preventDefault(); query = $('#rooms-query').value.trim(); loadRooms(); });
  $('#admin-open').addEventListener('click', () => { $('#admin-error').textContent = ''; $('#admin-dialog').showModal(); $('#admin-password').focus(); });
  $('#admin-cancel').addEventListener('click', () => $('#admin-dialog').close());
  $('#admin-dialog').addEventListener('close', () => { $('#admin-password').value = ''; $('#admin-open').focus(); });
  $('#admin-login').addEventListener('submit', async event => {
    event.preventDefault(); if ($('#admin-submit').disabled) return;
    authVersion++;
    $('#admin-submit').disabled = true; $('#admin-error').textContent = '';
    try {
      const password = $('#admin-password').value;
      await request('/api/admin/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      adminState(true); $('#admin-dialog').close(); $('#admin-logout').focus();
    } catch (error) { $('#admin-error').textContent = error.message; }
    finally { $('#admin-password').value = ''; $('#admin-submit').disabled = false; }
  });
  $('#admin-logout').addEventListener('click', async () => {
    authVersion++;
    $('#admin-logout').disabled = true;
    try { await request('/api/admin/session', { method: 'DELETE' }); adminState(false); $('#admin-open').focus(); }
    catch (error) { $('#rooms-error').textContent = error.message; }
    finally { $('#admin-logout').disabled = false; }
  });
  const initialAuthVersion = authVersion;
  await Promise.allSettled([loadRooms(), request('/api/admin/session').then(data => { if (initialAuthVersion === authVersion) adminState(data.admin === true); }).catch(error => { if (initialAuthVersion === authVersion) $('#rooms-error').textContent = error.message; })]);
}
