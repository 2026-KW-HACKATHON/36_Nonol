# 묵언수행 알파 신청 페이지

친구와 식사하고 말없이 걸으며 숨겨진 카페를 찾아가는 트랙의 소개와 참가 신청 페이지다.

[배포 페이지 체험하기](https://nonol-alpha.1991knet.workers.dev/v2/)

## 구현된 기능

- 흰 배경에서 선글라스를 쓴 4명 사진과 큰 제목으로 묵언수행 콘셉트를 소개한다. 사진은 AI로 생성한 리소스다.
- 장소 1은 이층집, 장소 2는 비공개 빈칸, 장소 3은 기가 막힌 카페로 표시한다. 비공개 장소의 실제 상호와 좌표는 공개 데이터에 넣지 않는다.
- 이름, 연락처 및 인원으로 신청하며 Cloudflare D1에 저장한다. 같은 연락처의 동일 트랙 재신청은 중복 안내로 처리한다.
- 입력 오류를 안내하고 해당 입력으로 포커스를 이동한다. 신청이 완료되면 완료 화면으로 포커스를 이동한다.
- 추천인은 주소의 ?from= 값으로 전달한다. 이 트랙의 식별자는 wolgye-silent-01이다.

이번 구현 범위는 트랙 소개와 참가 신청이다. 게임 진행용 지도, 사진 인증, 참가자 간 벌점 신고, 엔딩 분기와 AR 길 안내는 후속 개발 항목이다.

## 로컬 실행

이 폴더에서 실행한다.

```sh
npm ci
npm run check
npm run dev
```

http://localhost:8789/ 에서 확인한다. 기본 주소는 신청 페이지인 /v2/로 자동 이동하며 추천인 등의 쿼리 값을 유지한다. 로컬 DB 스키마는 실행 전에 자동으로 적용된다. 이미 8789 포트를 사용하고 있으면 다음 명령으로 다른 포트에서 실행한다.

```sh
npm run db:migrate
npx wrangler dev --port 8796
```

이때는 http://localhost:8796/v2/ 에서 확인한다.

## 본인 계정에 배포

wrangler.jsonc의 DB 식별자는 로컬 테스트용 값이다. 본인 Cloudflare 계정에서 DB를 만든 후 반환된 식별자를 DB의 database_id에 설정한다.

```sh
npx wrangler d1 create nonol-alpha-hackathon
npm run deploy
```

Worker 이름은 nonol-alpha-hackathon이다. 공개된 체험 페이지와 별도 Worker로 배포된다. 별도 배포본을 공유할 때는 public/v2/index.html의 og:url과 og:image도 해당 배포 주소로 설정한다.

## 구조

| 경로 | 역할 |
| --- | --- |
| public/v2/index.html, style.css, app.js | 반응형 신청 페이지 |
| public/v2/track.json | 공개 트랙 소개와 장소 표시 |
| public/v2/assets/silent-hero-shh.png | 4명 단체 사진 |
| public/assets/logo.png, public/favicon.svg | 로고와 파비콘 |
| src/worker.js | POST /api/apply의 검증과 신청 저장 |
| migrations/0001_applications.sql | 신청 테이블과 제약 조건 |
| wrangler.jsonc | 로컬 실행과 별도 배포 설정 |

신청자의 이름과 연락처는 테스트 안내에 사용하며 테스트 종료 후 삭제한다. 신청 데이터와 비밀값은 코드 저장소 밖에서 관리한다.

## 검증과 작성 시기

신청 페이지와 API는 2026-10-08에 검증했다. 모바일과 데스크톱 화면, 입력 오류, 인원 선택, 신청 저장, 중복 신청, 완료 후 포커스 이동 및 실제 배포 파일을 확인했다.

해커톤 복사본에서도 문법 검사, 로컬 DB 적용, 신청 저장과 중복 처리 및 배포 파일 구성을 확인했다. npm audit에서 개발 도구 Wrangler의 간접 의존성에 높은 심각도 경고 4건이 보고됐다. 원본과 같은 의존성 버전을 사용하며 이 경고는 후속 업데이트 항목이다.

기존 신청 API와 DB 스키마는 2026-09-23에 작성했다. 묵언수행 v2 화면과 사진은 2026-10-08에 작성했다.
