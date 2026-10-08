export default {
  id: 'nonol-npc-presentation-v2',
  version: 2,
  confirmedAt: '2026-10-08 23:05:59 KST',
  preferred: 'spatial-ar',
  fallback: 'camera-2d',
  requiredXRFeatures: ['local'],
  optionalXRFeatures: ['dom-overlay'],
  maxTouchDistanceMeters: 1.5,
  placement: 'camera-forward',
  initialPlacement: { distanceMeters: 1, heightOffsetMeters: -0.35 },
  versionHistory: [
    { version: 1, confirmedAt: '2026-10-08 22:34:47 KST', change: '수평면을 인식한 초록 원을 터치해 정령을 배치한다. iPhone WebAR와 2D 대체를 제공한다.' },
    { version: 2, confirmedAt: '2026-10-08 23:05:59 KST', change: '정령 생성하기를 누르면 카메라 앞에 자동 생성한다. 바닥 인식과 배치 터치를 생성 조건에서 제외한다.' }
  ],
  webAR: {
    name: '8th Wall',
    package: '@8thwall/engine-binary',
    version: '1.0.0',
    script: '/vendor/8thwall/xr.js',
    chunk: 'slam',
    license: 'https://github.com/8thwall/engine/blob/main/LICENSE',
    source: 'https://8thwall.org/docs/engine/overview'
  },
  rules: [
    '정령 단계는 현재 기기와 브라우저의 공간 AR 지원 결과와 선택된 모드를 표시한다.',
    '사용자가 정령 생성하기를 누르면 WebXR 지원 기기는 공간 AR을 시작하고, 기본 WebXR을 지원하지 않는 모바일 브라우저는 8th Wall 공간 추적 AR을 시도한다.',
    '공간 AR 세션, SDK 준비, 카메라 또는 추적 기능 실행이 실패하면 2D 정령과 전환 안내를 제공한다. 카메라는 사용자의 2D 버튼으로 다시 요청할 수 있다.',
    '참가자는 공간 AR 지원 여부와 관계없이 2D 정령으로 진행할 수 있다.',
    '카메라가 준비되면 앞쪽 약 1m에 정령을 자동 생성한다. WebAR 초기 공간 추적 중에는 카메라 앞 위치를 유지하고 추적이 준비되면 공간에 고정한다. 정령을 직접 터치하면 이야기를 시작한다.',
    '정령은 기기별로 배치한다. SDK의 거리와 공간 추적 정확도는 실기기에서 확인하며 팀 공통 GPS 지리 앵커는 후속 개발 범위다.',
    '정령 만남은 기존 서버 GPS 근접 조건과 개인 이야기 및 전원 완료 조건을 유지한다.'
  ],
  environments: [
    { name: 'ARCore 지원 Android + Chrome', behavior: 'WebXR 공간 AR을 우선 사용한다. Google Play Services for AR 설치 및 활성화가 필요하다.', examples: 'Pixel 8, Galaxy S24, Galaxy S25 Ultra', source: 'https://developers.google.com/ar/develop/webxr/requirements' },
    { name: 'iPhone 및 iPad Safari', behavior: '기본 WebXR 대신 8th Wall SDK의 카메라와 공간 추적 AR을 시도한다. 실행이 실패하면 2D로 진행한다.', examples: '카메라 및 필요한 센서 권한을 허용한 Safari', source: 'https://8thwall.org/docs/engine/overview' },
    { name: '기타 기기 및 브라우저', behavior: '현재 브라우저와 AR 엔진의 실행 결과를 따른다. 지원하지 않거나 실패하면 2D 정령으로 진행한다.', examples: '', source: 'https://developer.mozilla.org/en-US/docs/Web/API/XRSystem/isSessionSupported' }
  ],
  deviceListSource: 'https://developers.google.com/ar/devices',
  capabilityRule: '기기 목록은 참고 자료다. 보안 환경과 immersive-ar 지원을 확인하고 WebXR은 local 필수 기능, WebAR SDK는 카메라와 공간 추적 기능의 실행 성공 여부로 결정한다.'
};
