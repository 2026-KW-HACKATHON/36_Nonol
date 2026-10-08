const $ = selector => document.querySelector(selector);
let pending = false, authorized = false;

async function request(path, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || '요청을 처리하지 못했습니다.'), { status: response.status });
    return body;
  } catch (error) {
    if (error.status) throw error;
    throw new Error('연결을 확인하지 못했습니다. 다시 시도해 주세요.');
  } finally { clearTimeout(timer); }
}

function controls() {
  for (const control of $('#groups-form').elements) control.disabled = pending || !authorized;
  $('#groups-auth-retry').disabled = pending;
}

async function checkAdmin() {
  if (pending) return;
  pending = true; controls();
  $('#groups-auth-status').textContent = '관리자 권한을 확인하고 있습니다.';
  $('#groups-error').textContent = '';
  try {
    const data = await request('/api/admin/session');
    authorized = data.admin === true;
    $('#groups-form').hidden = !authorized;
    $('#groups-login').hidden = authorized;
    $('#groups-auth-retry').hidden = true;
    $('#groups-auth-status').textContent = authorized ? '관리자로 로그인했습니다. 신청자 정보를 입력해 주세요.' : '홈에서 관리자 로그인 후 이 화면을 다시 열어 주세요.';
    $('#groups-connection').textContent = authorized ? '관리자 연결됨' : '관리자 로그인 필요';
    $('#groups-connection').classList.toggle('connected', authorized);
  } catch (error) {
    $('#groups-error').textContent = error.message;
    $('#groups-auth-retry').hidden = false;
    $('#groups-connection').textContent = '연결 확인 필요';
  } finally { pending = false; controls(); }
}

function linkField(url, label) {
  const parsed = new URL(url, location.origin);
  if (parsed.origin !== location.origin) throw new Error('같은 테스트 사이트의 링크를 확인해 주세요.');
  const row = document.createElement('div'); row.className = 'registration-copy';
  const input = document.createElement('input'); input.type = 'text'; input.readOnly = true; input.value = parsed.href; input.setAttribute('aria-label', label); input.autocomplete = 'off'; input.spellcheck = false;
  const button = document.createElement('button'); button.type = 'button'; button.textContent = '링크 복사'; button.setAttribute('aria-label', `${label} 복사`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(input.value);
      $('#groups-copy-status').textContent = `${label}를 복사했습니다.`;
    } catch {
      input.focus(); input.select();
      $('#groups-copy-status').textContent = '자동 복사가 되지 않았습니다. 선택된 주소를 길게 눌러 직접 복사해 주세요.';
    } finally { button.disabled = false; }
  });
  row.append(input, button);
  return row;
}

function showResult(data, title, date, time) {
  const rows = data.participants.map(person => {
    const item = document.createElement('li');
    const name = document.createElement('h3'); name.textContent = person.name;
    item.append(name, linkField(person.inviteUrl, `${person.name}님의 개인 링크`));
    return item;
  });
  const board = linkField(data.boardUrl, '노놀판 링크');
  const room = linkField(data.inviteUrl, '공통 대기실 링크');
  $('#groups-participants').replaceChildren(...rows);
  $('#groups-board-link').replaceChildren(board);
  $('#groups-room-link').replaceChildren(room);
  $('#groups-result-summary').textContent = `${title} / ${date} ${time} / ${data.participants.length}명`;
  $('#groups-result').hidden = false;
  $('#groups-result-heading').focus();
}

$('#groups-auth-retry').addEventListener('click', checkAdmin);
$('#groups-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (pending || !authorized) return;
  const title = $('#groups-title').value.trim(), date = $('#groups-date').value, time = $('#groups-time').value;
  const names = $('#groups-names').value.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  $('#groups-error').textContent = ''; $('#groups-copy-status').textContent = '';
  if (!title || title.length > 80 || !date || !time || names.length < 2 || names.some(name => name.length > 24)) {
    $('#groups-error').textContent = '팀 이름과 날짜, 시간을 입력하고 24자 이내의 신청자 이름을 2명 이상 넣어 주세요.';
    return;
  }
  pending = true; controls(); $('#groups-status').textContent = '개인 링크를 발급하고 있습니다.';
  try {
    const data = await request('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, date, time, names }) });
    showResult(data, title, date, time);
    $('#groups-status').textContent = '개인 링크를 발급했습니다. 각 신청자에게 해당 링크를 전달해 주세요.';
  } catch (error) {
    $('#groups-status').textContent = '';
    $('#groups-error').textContent = error.message;
    if (error.status === 401 || error.status === 403) {
      authorized = false; $('#groups-form').hidden = true; $('#groups-login').hidden = false;
      $('#groups-auth-status').textContent = '관리자 로그인을 다시 확인해 주세요.';
    }
  } finally { pending = false; controls(); }
});
checkAdmin();
