# product/

역할: 참가자가 쓰는 제품과 그 설계를 담는다.

## 지금 들어 있는 것

| 경로 | 내용 |
| --- | --- |
| [wireframe/](wireframe/) | 와이어프레임(새_플로우_1.html), 기능명세, 유저플로우. 매니패스트로 받은 초안, 팀 기준으로 교정한 판, 교정 기록, 화면 캡처 15장. 검토용 시안이다 |
| [alpha/](alpha/) | 묵언수행 트랙 소개와 참가 신청. 4명 사진, 비공개 장소 표시, 신청 API와 DB 스키마를 포함한다. [배포 페이지](https://nonol-alpha.1991knet.workers.dev/v2/) |
| [game-lab/](game-lab/) | 팀 모바일 퀘스트 시험 사이트의 실행 코드. [Test Lab](https://nonol-game-lab.1991knet.workers.dev)에서 독립 모듈을 시험하고 [/tracks](https://nonol-game-lab.1991knet.workers.dev/tracks)에서 고정 코스를 연결한다 |
| [game/](game/) | 공유 팀 방 정책과 상태 로직, 확정 게임 기획, 서비스 흐름 SSOT, 개발 순서 및 QA 안내 |

## Test Lab의 두 시험 공간

| 공간 | 사용하는 방법 |
| --- | --- |
| 독립 모듈 시험 | 같은 방 입장, 전원 준비, 팀장 시작 후 원하는 모듈로 이동한다. 팀장이 모듈 안에서 지도 핀, 반경 또는 기준 사진을 설정하고 팀원과 함께 시험한다. 한 명도 시작할 수 있다 |
| 고정 코스 시험 | 관리자가 지도에서 네 장소와 에어팟 원본을 등록한다. 새 방은 등록 당시 장소, 사진과 스토리를 보관하고 같은 코스로 반복 시험한다 |

고정 코스의 장소 대응은 복지관이 이층집, 광운스퀘어가 우이천 초입, 광운스퀘어에서 비마관 앞까지가 우이천, 비마관 앞이 솥고집 정령 지점, 풋살장이 카페다.

## 핵심 파일과 정책 원본

| 경로 | 역할 |
| --- | --- |
| game/public/room-policy.json, game/src/room-state.js | 입장, 준비, 첫 팀장, 권한 양도와 공동 시작의 공유 정책 및 상태 로직 |
| game-lab/public/test-track.json | 모듈 시험 정책과 버전 이력 |
| game-lab/src/lab-state.js, game-lab/src/game-room.js | 단계, 위치, 사진, 신고와 벌점 상태 및 팀 소켓 동기화 |
| game-lab/public/261009_0536_campus-track.json | 고정 코스의 장소 역할, 순서, 스토리와 정책 |
| game-lab/public/261009_0536_map-provider.js | 카카오 지도와 연결 실패 시 대체 지도 |
| [game/docs/261009_0313_서비스흐름_정책_SSOT.md](game/docs/261009_0313_서비스흐름_정책_SSOT.md) | 그룹 신청부터 묵언수행 완주까지 확정된 사용자 경험 |

game 폴더는 공유 정책과 기획을 제공한다. 이 공개 범위에는 운영 게임 UI와 Worker가 포함되지 않는다. Test Lab 실행, 설정과 검증 명령은 [game-lab/README.md](game-lab/README.md), 공개 작업 기록은 [game-lab/WORKLOG.md](game-lab/WORKLOG.md)를 따른다.

## 앞으로 들어올 것

| 무엇 | 하는 일 |
| --- | --- |
| 운영 트랙 연결 | 현장에서 검증한 Test Lab 모듈을 실제 장소, 신청 정보와 노놀판(NFC)에 연결한다 |
| 스탬프 발행 | 완주 도장을 본인만 갖는 토큰으로 발행한다 |
