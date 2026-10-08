import { readFile, mkdir, writeFile } from 'node:fs/promises';
const policy = JSON.parse(await readFile(new URL('../public/room-policy.json', import.meta.url), 'utf8'));
const rows = Object.values(policy.rules).map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const document = `# 팀 대기실 정책 SSOT\n\n정책 ID: ${policy.id}\n사용자 확정 시각: ${policy.confirmedAt}\n\n정책 원본은 public/room-policy.json이다. 서버가 이 파일을 직접 사용하고, 이 문서는 npm run policy:render로 원본에서 생성한다. 정책 수정은 사용자 합의 후 원본에 적용하고 문서를 다시 생성한다.\n\n## 확정한 정책\n\n| ID | 정책 |\n| --- | --- |\n${rows}\n\n## 적용 범위\n\n첫 개발은 팀 링크 입장, 준비 상태, 팀장 양도, 트랙 시작 및 재접속 복구다. 카카오톡 자동 발송, 위치 지도, 사진 판정, AR 및 후속 미션은 이번 코드에 포함하지 않는다.\n\n## 확인 대기\n\n게임 시작 후 신규 참가자 입장 정책은 사용자 답변을 기다리고 있다. 이번 개발은 시작 전 신규 입장과 기존 참가자의 재접속을 제공하며, 시작 후 신규 입장은 아직 구현 범위에 포함하지 않는다.\n\n## 변경 검증\n\n정책을 바꾸면 상태 단위 테스트, 실제 WebSocket 통합 테스트 및 브라우저 사용 흐름을 확인한다. 참가 인원은 고정된 숫자 대신 방에 등록된 참가자를 기준으로 계산한다.\n`;
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/261008_1237_팀대기실_정책_SSOT.md', import.meta.url), document);
