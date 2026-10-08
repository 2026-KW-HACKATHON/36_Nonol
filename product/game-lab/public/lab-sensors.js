const normalized = (value) => ((value % 360) + 360) % 360;
const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());

export class Sensors {
  constructor({ onPosition = () => {}, onHeading = () => {}, onStatus = () => {} } = {}) {
    this.onPosition = onPosition;
    this.onHeading = onHeading;
    this.onStatus = onStatus;
    this.gpsVersion = 0;
    this.headingVersion = 0;
    this.cameraVersion = 0;
    this.watchId = null;
    this.gpsRefreshTimer = null;
    this.gpsRefreshing = false;
    this.gpsLastFixAt = 0;
    this.headingListener = null;
    this.headingTimer = null;
    this.stream = null;
    this.video = null;
  }

  status(sensor, state, message) {
    this.onStatus({ sensor, state, message });
  }

  startGPS() {
    this.stopGPS();
    const geolocation = globalThis.navigator?.geolocation;
    if (!geolocation) {
      this.status('gps', 'missing', '이 브라우저에서 위치를 사용할 수 없습니다. 위치 권한과 브라우저 지원을 확인해 주세요.');
      return false;
    }
    const version = this.gpsVersion;
    this.status('gps', 'requesting', '위치 권한과 현재 위치를 확인하고 있습니다.');
    const options = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
    const receive = (position) => {
      if (version !== this.gpsVersion) return;
      const { latitude: lat, longitude: lon, accuracy } = position.coords;
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180
        || !Number.isFinite(accuracy) || accuracy < 0 || !Number.isFinite(position.timestamp) || position.timestamp < 0) {
        this.status('gps', 'error', '위치 센서에서 유효한 좌표를 받지 못했습니다.');
        return;
      }
      const measuredAge = Date.now() - position.timestamp;
      if (measuredAge > 30000 || measuredAge < -5000) {
        this.status('gps', 'error', '새 GPS 위치를 기다리고 있습니다. 오래된 측정값은 도착 판정에 사용하지 않습니다.');
        return;
      }
      if (position.timestamp < this.gpsLastFixAt) return;
      this.gpsLastFixAt = position.timestamp;
      this.onPosition({ lat, lon, accuracy, heading: null, source: 'gps', measuredAt: position.timestamp });
      this.status('gps', 'active', `실제 위치 연결됨. 오차 범위 약 ${Math.round(accuracy)}m입니다.`);
    };
    const fail = (error) => {
      if (version !== this.gpsVersion) return;
      if (error.code === 1) {
        this.stopGPS();
        this.status('gps', 'denied', '위치 권한이 꺼져 있습니다. 브라우저 설정에서 위치 권한을 허용한 뒤 다시 연결해 주세요.');
      } else if (error.code === 3) this.status('gps', 'error', '위치 확인 시간이 초과됐습니다. 창가나 실외에서 다시 확인해 주세요.');
      else this.status('gps', 'error', '현재 위치를 찾지 못했습니다. 잠시 후 다시 확인해 주세요.');
    };
    try {
      this.watchId = geolocation.watchPosition(receive, fail, options);
      if (version === this.gpsVersion && geolocation.getCurrentPosition) {
        this.gpsRefreshTimer = setInterval(() => {
          if (version !== this.gpsVersion || globalThis.document?.visibilityState === 'hidden' || this.gpsRefreshing || Date.now() - this.gpsLastFixAt < 10000) return;
          this.gpsRefreshing = true;
          const finish = (handler) => (value) => {
            if (version !== this.gpsVersion) return;
            this.gpsRefreshing = false;
            handler(value);
          };
          try { geolocation.getCurrentPosition(finish(receive), finish(fail), options); }
          catch (error) { finish(fail)(error); }
        }, 10000);
      }
    } catch {
      this.status('gps', 'error', '위치 센서를 시작하지 못했습니다. 브라우저의 위치 권한을 확인해 주세요.');
      return false;
    }
    return true;
  }

  stopGPS() {
    this.gpsVersion += 1;
    clearInterval(this.gpsRefreshTimer);
    this.gpsRefreshTimer = null;
    this.gpsRefreshing = false;
    this.gpsLastFixAt = 0;
    if (this.watchId !== null) globalThis.navigator?.geolocation?.clearWatch(this.watchId);
    this.watchId = null;
  }

  async startHeading() {
    this.stopHeading();
    const Orientation = globalThis.DeviceOrientationEvent;
    const target = globalThis.window;
    if (!Orientation || !target?.addEventListener) {
      this.status('heading', 'missing', '방향 센서를 사용할 수 없습니다. 거리 안내를 확인해 주세요.');
      return false;
    }
    const version = this.headingVersion;
    this.status('heading', 'requesting', '방향 권한을 확인하고 있습니다.');
    try {
      if (typeof Orientation.requestPermission === 'function') {
        const permission = await Orientation.requestPermission(true);
        if (version !== this.headingVersion) return false;
        if (permission !== 'granted') {
          this.status('heading', 'denied', '방향 권한이 꺼져 있습니다. 거리 안내를 확인해 주세요.');
          return false;
        }
      }
    } catch {
      if (version === this.headingVersion) this.status('heading', 'error', '방향 권한을 요청하지 못했습니다. 방향 연결 버튼을 다시 눌러 주세요.');
      return false;
    }
    if (version !== this.headingVersion) return false;
    this.headingListener = (event) => {
      if (version !== this.headingVersion) return;
      if (Number.isFinite(event.webkitCompassAccuracy) && event.webkitCompassAccuracy < 0) {
        this.status('heading', 'error', '나침반을 보정하고 있습니다. 방향이 회복될 때까지 거리만 확인해 주세요.');
        return;
      }
      let heading = null;
      if (Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0
        && !(Number.isFinite(event.webkitCompassAccuracy) && event.webkitCompassAccuracy < 0)) {
        heading = event.webkitCompassHeading;
      } else if (event.absolute === true && Number.isFinite(event.alpha)) {
        heading = 360 - event.alpha;
      }
      if (heading === null) return;
      const screenAngle = globalThis.screen?.orientation?.angle ?? target.orientation ?? 0;
      this.onHeading(normalized(heading + (Number.isFinite(screenAngle) ? screenAngle : 0)));
      clearTimeout(this.headingTimer);
      this.headingTimer = null;
      this.status('heading', 'active', '방향 연결됨. 휴대폰을 수평으로 들고 화면 위쪽이 가리키는 방향을 확인해 주세요.');
    };
    target.addEventListener('deviceorientationabsolute', this.headingListener);
    target.addEventListener('deviceorientation', this.headingListener);
    this.headingTimer = setTimeout(() => {
      if (version === this.headingVersion) this.status('heading', 'missing', '나침반 방향을 받지 못했습니다. 거리 안내를 확인해 주세요.');
    }, 6000);
    this.headingTimer.unref?.();
    return true;
  }

  stopHeading() {
    this.headingVersion += 1;
    if (this.headingListener) {
      globalThis.window?.removeEventListener('deviceorientationabsolute', this.headingListener);
      globalThis.window?.removeEventListener('deviceorientation', this.headingListener);
    }
    this.headingListener = null;
    clearTimeout(this.headingTimer);
    this.headingTimer = null;
  }

  async openCamera(video) {
    this.closeCamera();
    const version = this.cameraVersion;
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      this.status('camera', 'missing', '이 브라우저에서 카메라를 사용할 수 없습니다.');
      return null;
    }
    this.status('camera', 'requesting', '카메라 권한을 확인하고 있습니다.');
    let stream;
    try {
      stream = await globalThis.navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (version !== this.cameraVersion) {
        stopTracks(stream);
        return null;
      }
      this.stream = stream;
      this.video = video;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (version !== this.cameraVersion) return null;
      this.status('camera', 'active', '카메라가 연결됐습니다.');
      return stream;
    } catch (error) {
      stopTracks(stream);
      if (version !== this.cameraVersion) return null;
      if (video.srcObject === stream) video.srcObject = null;
      this.stream = null;
      this.video = null;
      this.status('camera', error.name === 'NotAllowedError' ? 'denied' : 'error', error.name === 'NotAllowedError'
        ? '카메라 권한이 꺼져 있습니다. 브라우저 설정에서 카메라를 허용해 주세요.'
        : '카메라를 열지 못했습니다. 다른 앱의 카메라를 닫고 다시 시도해 주세요.');
      return null;
    }
  }

  closeCamera() {
    this.cameraVersion += 1;
    stopTracks(this.stream);
    if (this.video && this.video.srcObject === this.stream) this.video.srcObject = null;
    this.stream = null;
    this.video = null;
  }

  stop() {
    this.stopGPS();
    this.stopHeading();
    this.closeCamera();
  }
}
