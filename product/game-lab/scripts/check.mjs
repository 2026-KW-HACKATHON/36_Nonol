import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'public', 'public/spatial-route', 'scripts', 'tests']) {
  for (const name of await readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
