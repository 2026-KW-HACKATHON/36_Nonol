const checks = [...document.querySelectorAll('[data-check]')];
const storageKey = 'nonol-spatial-route-preparation:v1';
const storageStatus = document.querySelector('#spatial-storage-status');

function apply(value) {
  for (const check of checks) check.checked = value?.[check.dataset.check] === true;
}
function render() {
  const count = checks.filter(check => check.checked).length;
  document.querySelector('#spatial-progress').textContent = `${count}/${checks.length} 표시`;
  document.querySelector('#spatial-check-status').textContent = count === checks.length ? '모든 항목에 표시했습니다. 이 기록은 직접 확인한 준비 체크이며 이 페이지가 AR 동작을 검증하지는 않습니다.' : '직접 확인한 항목에 체크해 주세요. 표시를 이 브라우저에 보관합니다.';
}
try { apply(JSON.parse(localStorage.getItem(storageKey))); }
catch { storageStatus.textContent = '이전 체크 기록을 읽지 못했습니다. 지금 체크하며 계속 사용할 수 있어요.'; }
for (const check of checks) check.addEventListener('change', () => {
  render();
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(checks.map(item => [item.dataset.check, item.checked]))));
    storageStatus.textContent = '';
  } catch { storageStatus.textContent = '체크 기록을 저장하지 못했습니다. 현재 화면에서는 계속 사용할 수 있어요.'; }
});
render();
