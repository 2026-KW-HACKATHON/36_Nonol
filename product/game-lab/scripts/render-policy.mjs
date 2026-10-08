// 공유 방 정책과 실험 초기화 정책의 문서를 각 원본에서 생성합니다.
import '../../game/scripts/render-policy.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import npcPolicy from '../public/261008_2228_npc-policy.js';
import campusTrack from '../public/261009_0536_campus-track.json' with { type: 'json' };

const policy = JSON.parse(await readFile(new URL('../public/test-track.json', import.meta.url), 'utf8'));
const directoryRules = policy.directoryRules.map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const registrationRules = (policy.registrationRules || []).map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const lobbyRules = policy.lobbyRules.map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const rules = policy.resetRules.map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const stageRules = policy.stageControlRules.map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const moduleRules = (policy.moduleRules || []).map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const courseRules = policy.courseRules.map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const modules = (policy.modules || []).map((module, index) => `| ${index + 1} | ${module.title} | ${module.purpose} | ${module.completion} |`).join('\n');
const versions = policy.versionHistory.map(item => `| ${item.version} | ${item.id} | ${item.change} |`).join('\n');
const photoRules = Object.entries(policy.photoRules).map(([target, rule]) => `| ${target} | ${rule.statement} |`).join('\n');
const photoMigrations = policy.photoTargetMigrations.map(rule => `| ${rule.beforeVersion} 미만 | ${rule.from} | ${policy.defaults.photoTarget} |`).join('\n');
const document = `# 테스트 방 초기화 정책 SSOT

정책 ID: ${policy.id}
정책 버전: ${policy.version}
사용자 확정 시각: ${policy.confirmedAt}
이전 정책 ID: ${policy.previousId}

원본은 product/game-lab/public/test-track.json이다. 서버는 원본의 정책 ID, 버전과 기본값을 읽는다. 이 문서는 game-lab에서 npm run policy:render로 생성한다. 변경 이력은 원본의 versionHistory와 Git 커밋에 남긴다.

## Test Lab 정의와 시작 절차

${policy.definition}

| ID | 정책 |
| --- | --- |
${lobbyRules}

대기실은 참가자와 준비 상태, 준비 완료 및 테스트 시작하기를 제공한다. 시작 후 팀장이 현재 모듈 안에서 설정을 저장하고 전원이 같은 조건으로 지도, 사진 인식, 신고, 정령과 개인 이야기, AR 길, 방향 탐색 및 벌점 정산을 시험한다.

## 모듈별 설정과 독립 검증

| ID | 정책 |
| --- | --- |
${moduleRules}

| 번호 | 모듈 | 검증 목적 | 완료 기준 |
| --- | --- | --- | --- |
${modules}

모듈 5의 실제 바닥 고정 AR은 공간 스캔과 프로젝트를 준비해 연결한다. 프로젝트 링크를 연 사실이나 수동 경유점 확인만으로 공간 AR 성공을 판정하지 않는다.

## 방 목록과 관리자 삭제

| ID | 정책 |
| --- | --- |
${directoryRules}

기본 주소에서 방 이름 검색, 목록 새로고침 및 방 입장을 제공한다. 관리자는 관리자 로그인 후 각 방의 삭제 버튼을 사용한다. 관리자는 삭제할 방의 이름과 삭제 내용을 확인하고 실행하며 삭제 완료 후 목록을 갱신한다. 관리자 역할은 게임 참가자 및 팀장 역할과 독립적이다.

## 신청 그룹과 개인 링크 및 노놀판 확인

| ID | 정책 |
| --- | --- |
${registrationRules}

## 확정한 초기화 정책

| ID | 정책 |
| --- | --- |
${rules}

## 테스트 단계 이동과 현재 단계 초기화

| ID | 정책 |
| --- | --- |
${stageRules}

모듈 직접 선택과 화면의 이전 테스트, 다음 테스트 및 현재 단계 초기화는 팀장에게 제공한다. 단계 제어는 새 실행 ID로 개인 이야기와 사진 입력 및 AR 실행을 다시 준비한다. 엔딩에서 이전 단계로 돌아온 실제 GPS 참가자는 위치 연결을 다시 눌러 새 위치를 받는다.

## 현재 위치에서 걸어가는 테스트 코스

| ID | 정책 |
| --- | --- |
${courseRules}

GPS 지도 단계에 진입하면 각 참가자의 실제 위치 연결을 시작한다. 위치 감시와 활성 화면에서의 새 측정 요청으로 위치를 갱신하고 측정 시각이 30초를 넘으면 도착 판정을 기다린다. 지도에서 출발 영역과 도착 영역을 구분하고 최신 위치가 도착 조건을 통과하면 도착 가능 표시를 제공한다. 도착했어요를 눌러 개인 완료를 확정하고 전원 완료 후 다음 단계로 함께 이동한다.

## 사진 인증 정책

| 대상 | 촬영 및 판정 기준 |
| --- | --- |
${photoRules}

${policy.photoArrivalRule}

${policy.photoReferenceRule}

| 이전 버전 | 이전 기본 대상 | 현재 기본 대상 |
| --- | --- | --- |
${photoMigrations}

이전 기본 대상 방은 참가자와 각 모듈의 설정을 유지하며 현재 기본 대상으로 변경한다. 직접 등록한 기준 물체는 유지한다. 새 정책의 사진 모듈에서는 이전 지도 완료 기록과 독립적으로 판정한다.

## 버전 이력

| 버전 | 정책 ID | 변경 |
| --- | --- | --- |
${versions}

## 적용 범위와 검증

별도 nonol-game-lab 테스트 사이트에 적용한다. 제품의 공유 대기실 정책 nonol-room-v1은 product/game/public/room-policy.json에서 관리한다.

초기화 전후 참가자와 설정, 새로운 첫 팀장, 오프라인 참가자의 복귀, 기존 토큰과 지연 요청 거절을 단위, 소켓 및 브라우저 시험으로 검증한다. 운영 코스의 좌표와 판정 규칙은 별도 합의 후 연결한다.
`;
await writeFile(new URL('../../game/docs/261008_2017_테스트방_초기화_정책_SSOT.md', import.meta.url), document);

const npcRules = npcPolicy.rules.map((rule, index) => `| NPC-${index + 1} | ${rule} |`).join('\n');
const environments = npcPolicy.environments.map(item => `| ${item.name} | ${item.behavior} | ${item.examples || '해당 기기의 지원 검사 결과'} |`).join('\n');
const npcDocument = `# 정령 공간 AR와 2D 정책 SSOT

정책 ID: ${npcPolicy.id}
정책 버전: ${npcPolicy.version}
사용자 확정 시각: ${npcPolicy.confirmedAt}

원본은 product/game-lab/public/261008_2228_npc-policy.js다. 공간 AR 코드는 필수 기능과 선택 기능, 터치 거리를 원본에서 읽는다. 이 문서는 game-lab에서 npm run policy:render로 생성한다. 테스트 트랙 정책은 v${policy.version}이며 참가자의 기존 진행은 유지한다.

## 표시와 진행

| ID | 정책 |
| --- | --- |
${npcRules}

WebXR은 ${npcPolicy.requiredXRFeatures.join(', ')} 기능을 필수 요청하며 ${npcPolicy.optionalXRFeatures.join(', ')}는 선택 기능이다. WebAR은 ${npcPolicy.webAR.package} ${npcPolicy.webAR.version}의 ${npcPolicy.webAR.chunk} 공간 추적 기능을 사용한다. 정령은 카메라 앞 ${npcPolicy.initialPlacement.distanceMeters}m, 높이 오프셋 ${npcPolicy.initialPlacement.heightOffsetMeters}m에 생성한다. 공간 터치 반경은 엔진 좌표 기준 ${npcPolicy.maxTouchDistanceMeters}m다. GPS 반경과 정확도 및 위치 측정 시각 조건은 기존 테스트 방 설정을 따른다.

## 지원 환경

| 기기와 브라우저 | 적용 | 예시 |
| --- | --- | --- |
${environments}

${npcPolicy.capabilityRule}

정령 생성하기를 누르면 카메라 준비 후 앞쪽에 정령이 자동 생성된다. WebAR의 초기 공간 추적 중에는 카메라 앞에 표시하고 추적이 준비되면 공간에 고정한다. 정령을 직접 터치하면 개인 이야기가 열린다. 2D 모드는 카메라 화면 위에 정령을 표시하고 같은 이야기와 전원 완료 규칙을 사용한다.

카카오톡 같은 앱 내부 브라우저에서 공간 AR 지원이 확인되지 않으면 2D로 진행하거나 iPhone은 외부 Safari, Android는 외부 Chrome에서 같은 초대 링크를 연다. 기기 모델 목록과 실제 AR 세션 성공을 구분한다.

## 확인 출처와 검증

- [Google WebXR 요구사항](${npcPolicy.environments[0].source})
- [Google ARCore 기기 목록](${npcPolicy.deviceListSource})
- [8th Wall SDK 연결 안내](${npcPolicy.webAR.source})
- [8th Wall 엔진 라이선스](${npcPolicy.webAR.license})
- [MDN WebXR 브라우저 호환성 원본](https://github.com/mdn/browser-compat-data/blob/main/api/XRSystem.json)
- [MDN 실제 세션 요청과 필수 기능](https://developer.mozilla.org/en-US/docs/Web/API/XRSystem/requestSession)

2026-10-08 확인 기준이다. 지원 검사, AR 요청 실패, 2D 전환과 단계 이동 및 초기화 시 정리를 단위와 브라우저 시험으로 검증한다. 자동 브라우저의 XR 모사 시험과 실제 Android 및 iPhone 기기의 카메라와 정령 생성 및 공간 고정 시험을 구분한다. 실제 휴대폰의 공간 고정과 터치는 현장에서 확인한다.

## 버전 이력

${npcPolicy.versionHistory.map(item => `- v${item.version}, ${item.confirmedAt}: ${item.change}`).join("\n")}
`;
await writeFile(new URL('../../game/docs/261008_2228_정령_AR와_2D_정책_SSOT.md', import.meta.url), npcDocument);

const campusMappings = campusTrack.mappings.map(item => `| ${item.campus} | ${item.game} | ${item.experience} |`).join('\n');
const campusRules = campusTrack.rules.map(rule => `| ${rule.id} | ${rule.statement} |`).join('\n');
const campusDocument = `# 캠퍼스 고정 트랙 정책 SSOT

트랙 ID: ${campusTrack.id}
정의 버전: ${campusTrack.version}
사용자 확정 시각: ${campusTrack.confirmedAt}
연결 Test Lab 정책: ${policy.id}

원본은 product/game-lab/public/261009_0536_campus-track.json이다. 이 문서는 npm run policy:render로 생성한다. 실제 등록 좌표, 사진 원본 및 설정 버전은 Test Lab의 비공개 SQLite 카탈로그에 저장한다.

## 장소 역할 대응

| 캠퍼스 시험 장소 | 묵언수행 장소 및 역할 | 시험 행동 |
| --- | --- | --- |
${campusMappings}

## 코스와 사용자 경험

| 순서 | 장소 또는 이동 | 화면과 사용 행동 | 함께 다음 화면으로 가는 조건 |
| --- | --- | --- | --- |
| 1 | 복지관 | 같은 방 링크로 입장하고 각자 준비 완료 | 전원 준비 후 팀장이 시작 |
| 2 | 복지관에서 광운스퀘어 | 2D 지도, 각자 위치와 목적지 원 표시 | 전원이 최신 GPS로 원 안에 도착하고 도착했어요 확인 |
| 3 | 광운스퀘어 | 고정 에어팟 원본을 보고 촬영 또는 이미지 선택 | 각자의 앞 단계 도착 기록과 실제 물체 인식 성공 |
| 4 | 광운스퀘어에서 묵언 준비 | 묵언 규칙을 읽고 산책 준비 | 전원이 묵언 산책 준비 확인 |
| 5 | 광운스퀘어에서 비마관 앞 | 바닥 AR 프로젝트 시험, 별도 카메라 방향 안내, 걷는 중 연속 신고 | 현재 시험은 전원의 GPS 경유점 확인, 실제 공간 AR 성공은 현장에서 별도 검증 |
| 6 | 비마관 앞 | 솥고집 정령 생성과 터치 후 각자 고정 대사 읽기 | 각자가 정령 접근과 터치 및 마지막 대화 완료 |
| 7 | 비마관 앞에서 풋살장 | 카페를 찾아 지도 없이 거리와 방향 및 색으로 탐색 | 전원이 최신 GPS로 풋살장 반경 안에서 도착 확인 |
| 8 | 풋살장, 카페 역할 | 개인 및 팀 벌점, 벌점 왕과 최종 결과 | 신고 기록 집계 결과를 함께 표시 |

팀장은 고정 코스에서도 이전 및 다음 단계와 현재 단계 초기화를 사용해 실패 구간을 반복한다. 사진 도착 선행 조건은 단계 건너뛰기로 충족되지 않는다.

## 고정 설정과 방의 역할

| ID | 정책 |
| --- | --- |
${campusRules}

관리자가 /tracks에서 네 기준점과 에어팟 원본을 저장한다. 저장마다 카탈로그 버전이 증가하며 새 방은 생성 당시 설정의 스냅샷을 보관한다. 해당 방의 장소, 기준 사진 및 스토리는 읽기 전용이고 새 설정은 새 방에 적용한다. 전체 초기화는 참가자와 진행을 비우고 고정 코스 설정과 사진 원본 및 버전을 보존한다. 관리자 삭제는 해당 방의 원본을 함께 삭제한다.

## 지도에서 장소 지정과 카카오 지도

최초 좌표는 등록 대기다. 이전 세 장소 카탈로그는 좌표, 사진과 공간 설정을 유지하며 풋살장 등록 대기로 이관한다. 이미 생성된 방의 스냅샷은 생성 당시 코스를 유지한다. [광운대학교 캠퍼스 안내](https://www.kw.ac.kr/ko/tour/tour01.jsp)는 장소를 확인하는 자료이며 비마관 앞의 실제 기준 좌표를 대신하지 않는다. 관리자는 지도에서 장소를 선택한 뒤 눌러 핀을 놓고 다시 눌러 조정한다. 현재 위치와 GPS 오차 범위를 함께 표시하고 내 위치 보기와 현재 위치로 장소 지정을 별도 행동으로 제공한다. 최신 GPS 갱신은 선택한 핀과 반경 입력 및 포커스를 유지한다. 도착 반경 입력은 유지하고 위도 및 경도 숫자를 별도로 입력하지 않는다. 현장에서 등록 지점을 확인한다.

카카오 JavaScript 키는 /tracks의 지도 설정 또는 서버 KAKAO_MAPS_JAVASCRIPT_KEY로 연결한다. SDK 도메인과 카카오맵 사용 설정은 [공식 시작 안내](https://apis.map.kakao.com/web/guide/) 및 [카카오맵 설정](https://developers.kakao.com/docs/ko/kakaomap/common)을 따른다. 키는 브라우저 공개 설정이고 관리자 비밀번호나 REST API 키를 사용하지 않는다. 연결 전에는 대체 지도로 위치와 원 판정을 시험한다.

## 검증 경계

사용자는 Immersal 가입과 앱 설치를 완료했다. 다음 단계는 광운스퀘어에서 비마관 앞까지의 10~20m 시험 구간을 Manual 모드로 촬영하는 것이다. [공식 촬영 기준](https://developers.immersal.com/docs/mapsmapping/howtomap/)에 따라 사진이 약 절반 겹치고 고정된 특징이 여러 각도에 담기도록 촬영한다. Mapper 2.0의 Manual 촬영은 기기에 저장한 뒤 업로드하고 Developer Portal의 done 상태 및 Map ID를 확인한다. 완성된 지도를 앱에서 내려받아 AR 재인식을 시험한다.

공간 스캔, Immersal Map ID 및 Mattercraft 프로젝트를 연결하기 전에는 바닥 AR 준비 상태를 표시한다. 현재 공유 흐름의 GPS 경유점 확인은 공간 AR 위치 인식 성공과 구분한다. 휴대폰의 GPS, 카메라 및 방향 센서와 실제 바닥 고정은 현장 시험으로 확인한다. 자동 시험의 GPS와 카메라 모사는 실제 현장 성능의 근거로 사용하지 않는다.
`;
await writeFile(new URL('../../game/docs/261009_0536_캠퍼스_고정트랙_정책_SSOT.md', import.meta.url), campusDocument);
