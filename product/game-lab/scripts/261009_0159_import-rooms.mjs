import { readFile } from 'node:fs/promises';
const path = process.argv[2];
const key = process.env.ROOM_ADMIN_KEY;
const base = process.env.ROOM_BASE_URL || 'http://localhost:8791';
if (!path || !key) throw new Error('기존 방 ID 파일과 ROOM_ADMIN_KEY를 지정해 주세요.');
const input = JSON.parse(await readFile(path, 'utf8'));
const field = Array.isArray(input.objectIds) ? 'objectIds' : 'roomIds';
const ids = input[field];
if (!Array.isArray(ids)) throw new Error('objectIds 또는 roomIds 배열이 필요합니다.');
let completed = 0, imported = 0, skipped = 0, failed = 0;
for (let offset = 0; offset < ids.length; offset += 20) {
  const response = await fetch(new URL('/api/admin/rooms/import', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ [field]: ids.slice(offset, offset + 20) })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '기존 방 목록을 등록하지 못했습니다.');
  imported += body.imported || 0; skipped += body.skipped || 0; failed += body.failed || 0;
  completed += Math.min(20, ids.length - offset);
  console.log(`기존 저장소 확인: ${completed}/${ids.length}`);
}
console.log(`목록 등록: ${imported}, 방 데이터 없음: ${skipped}, 조회 실패: ${failed}`);
if (failed) throw new Error('조회에 실패한 기존 방이 있습니다. 같은 파일로 다시 등록해 주세요.');
