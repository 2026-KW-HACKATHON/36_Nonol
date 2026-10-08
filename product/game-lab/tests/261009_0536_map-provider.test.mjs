import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapView } from '../public/261009_0536_map-provider.js';

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
}
const point = { lat: 37.619, lon: 127.059 };
const target = { lat: 37.6194, lon: 127.0595 };
const container = () => ({ dataset: {}, replaceChildren() {} });
const element = () => ({ className: '', textContent: '', remove() {} });

function leaflet() {
  const created = [], shapes = [], handlers = {};
  const map = { setView(_point, _zoom, options) { this.viewOptions = options; return this; }, on(name, fn) { handlers[name] = fn; return this; }, fitBounds(points, options) { this.bounds = points; this.boundsOptions = options; }, invalidateSize() {}, stop() { this.stopped = true; }, remove() { this.removed = true; } };
  const layer = { addTo() { return this; }, clearLayers() {} };
  const shape = (kind, coords, options) => { const value = { kind, coords, options, bindTooltip(content) { this.content = content; return this; }, addTo() { shapes.push(this); return this; } }; return value; };
  return { created, shapes, handlers, map, api: {
    map(_root, options) { map.options = options; created.push(map); return map; },
    tileLayer() { return { addTo() { return this; }, on() { return this; } }; },
    layerGroup() { return layer; }, circleMarker: (...args) => shape('marker', ...args), circle: (...args) => shape('circle', ...args), polyline: (...args) => shape('line', ...args),
  } };
}

function kakao() {
  const created = [], shapes = [], handlers = {};
  class LatLng { constructor(lat, lon) { this.lat = lat; this.lon = lon; } getLat() { return this.lat; } getLng() { return this.lon; } }
  class Map {
    constructor(root, options) { this.root = root; this.options = options; created.push(this); }
    setCenter(center) { this.center = center; } setLevel(level) { this.level = level; }
    setBounds(bounds) { this.bounds = bounds; } relayout() { this.relayoutCount = (this.relayoutCount || 0) + 1; }
  }
  class Bounds { points = []; extend(point) { this.points.push(point); } }
  class Shape { constructor(options) { this.options = options; shapes.push(this); } setMap(map) { this.map = map; } }
  return { created, shapes, handlers, api: { Map, LatLng, LatLngBounds: Bounds, Circle: Shape, Polyline: Shape, CustomOverlay: Shape, load(callback) { callback(); }, event: {
    addListener(map, name, fn) { handlers[name] = fn; }, removeListener(map, name) { delete handlers[name]; },
  } } };
}

test('missing Kakao key uses a clearly identified fallback and preserves map selection and GPS overlays', async t => {
  const fallback = leaflet(), messages = [], clicks = [];
  environment(t, { L: fallback.api, document: { createElement: element }, fetch: async url => { assert.equal(url, '/api/map-config'); return { ok: true, json: async () => ({ kakaoJavascriptKey: null }) }; } });
  const root = container(), view = await createMapView(root, { center: point, onStatus: message => messages.push(message), onClick: value => clicks.push(value) });
  assert.equal(view.provider, 'leaflet'); assert.equal(root.dataset.mapProvider, 'leaflet'); assert.match(messages.at(-1), /대체 지도/);
  const unsafeName = '<img src=x onerror=alert(1)>';
  view.draw({ start: point, destination: target, radius: 10, members: [{ ...target, name: unsafeName, mine: true, accuracy: 3 }] });
  assert.equal(fallback.shapes.filter(shape => shape.kind === 'line').length, 1);
  assert.deepEqual(fallback.shapes.filter(shape => shape.kind === 'circle').map(shape => shape.options.radius), [10, 3]);
  assert.equal(fallback.shapes.at(-2).content.textContent, `${unsafeName} (나)`);
  fallback.handlers.click({ latlng: { lat: target.lat, lng: target.lon } }); assert.deepEqual(clicks, [target]);
  view.fit([point, target]); assert.deepEqual(fallback.map.bounds, [[point.lat, point.lon], [target.lat, target.lon]]);
  const count = fallback.shapes.length; view.dispose(); view.draw({ destination: target, radius: 10 });
  assert.equal(fallback.shapes.length, count); assert.equal(fallback.map.removed, true); assert.equal(fallback.map.stopped, true);
  assert.equal(fallback.map.options.zoomAnimation, false); assert.equal(fallback.map.viewOptions.animate, false); assert.equal(fallback.map.boundsOptions.animate, false);
});

test('configured Kakao SDK loads from its official URL and supports equivalent location, bounds and click operations', async t => {
  const sdk = kakao(), urls = [], clicks = [];
  environment(t, { kakao: undefined, document: { createElement: element, head: { appendChild(script) { urls.push(script.src); globalThis.kakao = { maps: sdk.api }; queueMicrotask(() => script.onload()); } } }, fetch: async () => ({ ok: true, json: async () => ({ kakaoJavascriptKey: 'a'.repeat(32) }) }) });
  const root = container(), view = await createMapView(root, { center: point, onClick: value => clicks.push(value) });
  assert.equal(view.provider, 'kakao'); assert.equal(root.dataset.mapProvider, 'kakao');
  const url = new URL(urls[0]); assert.equal(url.origin, 'https://dapi.kakao.com'); assert.equal(url.searchParams.get('autoload'), 'false');
  view.draw({ start: point, destination: target, radius: 10, members: [{ ...target, name: '팀원', mine: true, accuracy: 3 }] });
  assert.deepEqual(sdk.shapes.filter(shape => shape.options.radius !== undefined).map(shape => shape.options.radius), [10, 3]);
  assert.equal(sdk.shapes.find(shape => shape.options.path).options.path.length, 2);
  sdk.handlers.click({ latLng: new sdk.api.LatLng(target.lat, target.lon) }); assert.deepEqual(clicks, [target]);
  view.fit([point, target]); assert.equal(sdk.created[0].bounds.points.length, 2);
  view.invalidate(); assert.equal(sdk.created[0].relayoutCount, 1);
  view.dispose(); assert.equal(sdk.handlers.click, undefined); assert.ok(sdk.shapes.every(shape => shape.map === null));
});

test('failed Kakao SDK produces a fallback instead of claiming that Kakao rendered', async t => {
  const fallback = leaflet(), messages = [];
  environment(t, { L: fallback.api, kakao: undefined, document: { createElement: element, head: { appendChild(script) { queueMicrotask(() => script.onerror()); } } }, fetch: async () => ({ ok: true, json: async () => ({ kakaoJavascriptKey: 'a'.repeat(32) }) }) });
  const { createMapView: freshMapView } = await import('../public/261009_0536_map-provider.js?failed-sdk');
  const view = await freshMapView(container(), { center: point, onStatus: message => messages.push(message) });
  assert.equal(view.provider, 'leaflet'); assert.match(messages.at(-1), /카카오 지도 연결을 확인하지 못해/); view.dispose();
});

test('cancelled asynchronous map initialization never mounts a stale map', async t => {
  const fallback = leaflet(); let finish;
  environment(t, { L: fallback.api, document: { createElement: element }, fetch: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController(), pending = createMapView(container(), { center: point, signal: controller.signal });
  controller.abort(); finish({ ok: true, json: async () => ({ kakaoJavascriptKey: null }) });
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(fallback.created.length, 0);
});


test('changing a loaded Kakao key uses an explicit reload notice instead of reusing the previous credentials', async t => {
  const sdk = kakao(), fallback = leaflet(), messages = [];
  let key = 'a'.repeat(32);
  environment(t, { L: fallback.api, kakao: undefined, document: { createElement: element, head: { appendChild(script) { globalThis.kakao = { maps: sdk.api }; queueMicrotask(() => script.onload()); } } }, fetch: async () => ({ ok: true, json: async () => ({ kakaoJavascriptKey: key }) }) });
  const { createMapView: freshMapView } = await import('../public/261009_0536_map-provider.js?key-switch');
  const first = await freshMapView(container(), { center: point }); assert.equal(first.provider, 'kakao'); first.dispose();
  key = 'b'.repeat(32);
  const next = await freshMapView(container(), { center: point, onStatus: message => messages.push(message) });
  assert.equal(next.provider, 'leaflet'); assert.match(messages.at(-1), /키가 변경/); assert.match(messages.at(-1), /새로고침/);
  assert.equal(sdk.created.length, 1); next.dispose();
});


test('Kakao map initialization errors recover to the fallback after clearing a partial map', async t => {
  const fallback = leaflet(), sdk = kakao(), messages = [];
  sdk.api.Map = class { constructor() { throw new Error('map initialization failed'); } };
  environment(t, { L: fallback.api, kakao: { maps: sdk.api }, document: { createElement: element }, fetch: async () => ({ ok: true, json: async () => ({ kakaoJavascriptKey: 'a'.repeat(32) }) }) });
  const { createMapView: freshMapView } = await import('../public/261009_0536_map-provider.js?initialization-error');
  const view = await freshMapView(container(), { center: point, onStatus: message => messages.push(message) });
  assert.equal(view.provider, 'leaflet'); assert.match(messages.at(-1), /초기화하지 못해/); view.dispose();
});
