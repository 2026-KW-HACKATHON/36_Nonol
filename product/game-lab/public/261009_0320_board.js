const $ = selector => document.querySelector(selector);
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVITE = /^[0-9a-f]{64}$/;
const registrationKey = 'nonol-registered-room';
const boardId = new URLSearchParams(location.search).get('board') || 'icheungjip-lab';
let identity = null, pending = false, joinAttempt = null;

function readStored(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function validIdentity(value) {
  return value && ROOM_ID.test(value.roomId) && ROOM_ID.test(value.participantId) && ROOM_ID.test(value.token) && ROOM_ID.test(value.generationId);
}
async function request(path, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || '요청을 처리하지 못했습니다.'), { status: response.status, code: body.code });
    return body;
  } catch (error) {
    if (error.status) throw error;
    throw new Error('연결하지 못했습니다. 같은 버튼으로 다시 시도해 주세요.');
  } finally { clearTimeout(timer); }
}
function controls() {
  $('#board-submit').disabled = pending || !identity || boardId !== 'icheungjip-lab';
  $('#board-change').disabled = pending;
  for (const control of $('#board-link-form').elements) control.disabled = pending;
  $('#board-retry').disabled = pending;
}
function forgetIdentity(expected) {
  if (expected) {
    for (const key of [registrationKey, `nonol-room:${expected.roomId}`]) {
      try { if (readStored(key)?.token === expected.token) localStorage.removeItem(key); } catch {}
    }
  }
  identity = null;
  $('#board-person').hidden = true; $('#board-result').hidden = true;
  $('#board-link-form').hidden = false; $('#board-retry').hidden = true;
}
function saveIdentity(roomId, joined) {
  const next = { roomId, participantId: joined.participantId, token: joined.token, generationId: joined.generationId, name: joined.name };
  if (!validIdentity(next) || typeof next.name !== 'string' || !next.name.trim()) throw new Error('개인 입장 정보를 확인하지 못했습니다. 개인 링크를 다시 확인해 주세요.');
  const roomKey = `nonol-room:${roomId}`;
  let oldRoom;
  try {
    oldRoom = localStorage.getItem(roomKey);
    localStorage.setItem(roomKey, JSON.stringify({ participantId: next.participantId, token: next.token, generationId: next.generationId, name: next.name }));
    localStorage.setItem(registrationKey, JSON.stringify(next));
  } catch {
    try { if (oldRoom === null) localStorage.removeItem(roomKey); else if (oldRoom !== undefined) localStorage.setItem(roomKey, oldRoom); } catch {}
    throw new Error('입장 정보를 저장할 수 없습니다. 일반 브라우저에서 개인 링크를 다시 열어 주세요.');
  }
  identity = next;
  $('#board-result').hidden = true;
  $('#board-name').textContent = `${next.name}님`;
  $('#board-person').hidden = false; $('#board-link-form').hidden = true; $('#board-retry').hidden = true;
  $('#board-connection').textContent = '개인 입장 확인됨'; $('#board-connection').classList.add('connected');
  $('#board-status').textContent = '본인 이름이 맞으면 노놀판 확인하기를 눌러 주세요.';
  $('#board-invite').value = '';
  controls();
}
function identityExpired(error) {
  return error.status === 401 || error.status === 404 || error.code === 'ROOM_IDENTITY_EXPIRED' || error.code === 'ROOM_RESET' || error.code === 'ROOM_DELETED';
}
async function restoreIdentity() {
  if (pending) return;
  const stored = readStored(registrationKey);
  if (!validIdentity(stored)) { forgetIdentity(stored); $('#board-connection').textContent = '개인 링크 확인 필요'; $('#board-status').textContent = '이 브라우저에서 사용할 본인의 개인 링크를 입력해 주세요.'; return; }
  pending = true; controls(); $('#board-error').textContent = ''; $('#board-status').textContent = '본인의 입장 정보를 확인하고 있습니다.';
  try {
    const joined = await request(`/api/rooms/${stored.roomId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: stored.token }) });
    if (joined.participantId !== stored.participantId) throw new Error('개인 정보가 일치하지 않습니다. 본인의 개인 링크를 다시 확인해 주세요.');
    if (readStored(registrationKey)?.token !== stored.token) { forgetIdentity(null); $('#board-status').textContent = '다른 탭에서 입장 정보가 바뀌었습니다. 본인의 개인 링크를 다시 확인해 주세요.'; return; }
    saveIdentity(stored.roomId, joined);
  } catch (error) {
    $('#board-error').textContent = error.message;
    if (identityExpired(error)) { forgetIdentity(stored); $('#board-status').textContent = '입장 정보가 만료되었습니다. 본인의 개인 링크를 다시 확인해 주세요.'; }
    else { $('#board-retry').hidden = false; $('#board-link-form').hidden = false; }
    $('#board-connection').textContent = '개인 링크 확인 필요';
  } finally { pending = false; controls(); }
}

function personalLink(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('전달받은 개인 초대 링크 전체를 붙여 넣어 주세요.'); }
  const roomId = url.searchParams.get('room'), invite = new URLSearchParams(url.hash.slice(1)).get('invite');
  if (url.origin !== location.origin || url.pathname !== '/' || !ROOM_ID.test(roomId) || !INVITE.test(invite)) throw new Error('이 테스트 사이트에서 발급된 개인 초대 링크를 입력해 주세요.');
  return { roomId, invite };
}
$('#board-link-form').addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return;
  $('#board-error').textContent = '';
  let link;
  try { link = personalLink($('#board-invite').value.trim()); }
  catch (error) { $('#board-error').textContent = error.message; return; }
  if (!joinAttempt || joinAttempt.roomId !== link.roomId || joinAttempt.invite !== link.invite) joinAttempt = { ...link, joinKey: crypto.randomUUID() };
  const previousToken = readStored(registrationKey)?.token || null;
  let joinedSuccessfully = false;
  pending = true; controls(); $('#board-status').textContent = '개인 링크의 신청자를 확인하고 있습니다.';
  try {
    const summary = await request(`/api/rooms/${link.roomId}`);
    const joined = await request(`/api/rooms/${link.roomId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: link.invite, joinKey: joinAttempt.joinKey, expectedGeneration: summary.generationId }) });
    if ((readStored(registrationKey)?.token || null) !== previousToken) { forgetIdentity(null); $('#board-status').textContent = '다른 탭에서 입장 정보가 바뀌었습니다. 본인의 개인 링크를 다시 확인해 주세요.'; return; }
    saveIdentity(link.roomId, joined);
    try { sessionStorage.setItem(`nonol-personal-invite:${link.roomId}`, link.invite); }
    catch {
      try { sessionStorage.removeItem(`nonol-personal-invite:${link.roomId}`); } catch {}
      $('#board-status').textContent = '입장은 확인했습니다. 개인 링크 보관을 위해 일반 브라우저에서 다시 열어 주세요.';
    }
    joinAttempt = null;
    joinedSuccessfully = true;
  } catch (error) {
    $('#board-error').textContent = error.message;
    $('#board-status').textContent = '본인의 개인 링크를 확인하고 다시 시도해 주세요.';
  } finally { pending = false; controls(); if (joinedSuccessfully) $('#board-submit').focus(); }
});

function showRegistration(data) {
  const registration = data.registration;
  $('#board-result-summary').textContent = `${registration.date} ${registration.time} / ${registration.taggedCount}/${registration.total}명 확인${registration.allTagged ? ' / 전원 확인 완료' : ''}`;
  const rows = registration.people.map(person => {
    const item = document.createElement('li');
    const name = document.createElement('span'); name.textContent = person.name;
    const status = document.createElement('span'); status.textContent = person.tagged ? '확인 완료' : person.joined ? '입장 완료 / 확인 대기' : '입장 대기';
    item.dataset.tagged = String(Boolean(person.tagged)); item.append(name, status); return item;
  });
  $('#board-people').replaceChildren(...rows);
  $('#board-lobby').href = `/?room=${encodeURIComponent(identity.roomId)}`;
  $('#board-result').hidden = false; $('#board-result-heading').focus();
  $('#board-status').textContent = data.duplicate ? '이미 본인의 노놀판 확인을 완료했습니다. 현재 팀 상태를 다시 확인했어요.' : '본인의 노놀판 확인을 완료했습니다. 대기실에서 팀원들과 준비해 주세요.';
}
$('#board-submit').addEventListener('click', async () => {
  if (pending || !identity || boardId !== 'icheungjip-lab') return;
  const current = identity;
  if (readStored(registrationKey)?.token !== current.token) { forgetIdentity(null); $('#board-status').textContent = '다른 탭에서 입장 정보가 바뀌었습니다. 본인의 개인 링크를 다시 확인해 주세요.'; controls(); return; }
  pending = true; controls(); $('#board-error').textContent = ''; $('#board-status').textContent = '노놀판 확인을 기록하고 있습니다.';
  try {
    const data = await request(`/api/rooms/${current.roomId}/board`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.token}` }, body: JSON.stringify({ boardId, generationId: current.generationId }) });
    if (readStored(registrationKey)?.token !== current.token) { forgetIdentity(null); $('#board-status').textContent = '다른 탭에서 입장 정보가 바뀌었습니다. 본인의 개인 링크를 다시 확인해 주세요.'; return; }
    showRegistration(data);
  } catch (error) {
    $('#board-error').textContent = error.message;
    if (identityExpired(error)) { forgetIdentity(current); $('#board-status').textContent = '입장 정보가 만료되었습니다. 본인의 개인 링크를 다시 확인해 주세요.'; }
    else if (error.status === 409) { forgetIdentity(null); $('#board-status').textContent = '방의 진행 상태가 바뀌었습니다. 본인의 개인 링크를 다시 확인해 주세요.'; }
  } finally { pending = false; controls(); }
});
$('#board-change').addEventListener('click', () => { if (pending) return; $('#board-link-form').hidden = false; $('#board-invite').focus(); });
$('#board-retry').addEventListener('click', restoreIdentity);
if (boardId !== 'icheungjip-lab') { $('#board-connection').textContent = '노놀판 링크 확인 필요'; $('#board-error').textContent = '발급된 노놀판 링크를 다시 열어 주세요.'; controls(); }
else restoreIdentity();
