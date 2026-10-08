import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const directory = new URL('../public/vendor/', import.meta.url);
// 브라우저용 정책 사본은 제품의 canonical 원본에서 생성합니다.
await copyFile(new URL('../../game/public/room-policy.json', import.meta.url), new URL('../public/room-policy.json', import.meta.url));
await mkdir(directory, { recursive: true });
for (const [source, target] of [
  ['leaflet/dist/leaflet.js', 'leaflet.js'],
  ['leaflet/dist/leaflet.css', 'leaflet.css'],
  ['leaflet/LICENSE', 'leaflet-LICENSE.txt'],
  ['three/LICENSE', 'three-LICENSE.txt']
]) await copyFile(new URL(`../node_modules/${source}`, import.meta.url), new URL(target, directory));
await build({
  entryPoints: [fileURLToPath(new URL('../node_modules/three/build/three.module.js', import.meta.url))],
  outfile: fileURLToPath(new URL('three.module.js', directory)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2015',
  supported: { 'template-literal': false },
  minify: true,
  legalComments: 'none'
});
await rm(new URL('three.core.js', directory), { force: true });
await cp(new URL('../node_modules/@8thwall/engine-binary/dist/', import.meta.url), new URL('8thwall/', directory), { recursive: true });
