import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = process.env.ROOM_BASE_URL || 'http://localhost:8791';
const key = process.env.ROOM_ADMIN_KEY;
if (!key) throw new Error('ROOM_ADMIN_KEY 환경 변수를 설정해 주세요.');
const title = process.argv.slice(2).join(' ').trim() || '묵언수행';
const track = process.env.ROOM_TRACK || 'lab';
const response = await fetch(new URL('/api/rooms', baseUrl), {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ title, track })
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || '방 생성에 실패했습니다.');
const directory = resolve(import.meta.dirname, '../../../.local/game-lab-rooms');
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(resolve(directory, `${result.roomId}.json`), JSON.stringify({ ...result, title, track, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
console.log(result.inviteUrl);
