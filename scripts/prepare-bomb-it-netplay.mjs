#!/usr/bin/env node
// Stage the authored bridge and pinned emulator. The viewer serves the original separately.
import path from 'node:path';
import {copyFile, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {
  probe: {type: 'string', default: 'local/original-games/bomb-it/bomb-it-snapshot-probe-v7.swf'},
  preview: {type: 'string', default: 'local/bomb-it-preview'},
}});
const preview = path.resolve(values.preview);
const candidate = path.join(preview, 'packages', 'bomb-it-7');
const runtime = path.join(candidate, 'runtime');
const manifests = path.join(preview, 'manifests');
const ruffle = path.resolve('node_modules/@ruffle-rs/ruffle');
const source = path.resolve('experiments/bomb-it-netplay');
const packageInfo = JSON.parse(await readFile(path.join(ruffle, 'package.json'), 'utf8'));
if (packageInfo.version !== '0.7.1') throw new Error('The original bridge needs the verified Ruffle 0.7.1 build');
const probe = await readFile(values.probe);
if (probe.length > 16_384 || !['CWS', 'FWS'].includes(probe.subarray(0, 3).toString()))
  throw new Error('Expected the compiled local snapshot probe, a small AVM2 SWF');
for (const directory of [runtime, manifests, path.join(preview, 'empty')])
  await mkdir(directory, {recursive: true});
for (const file of ['netplay.mjs', 'movie.html', 'movie-clock.mjs', 'original-file.mjs', 'compatibility.mjs'])
  await copyFile(path.join(source, file), path.join(candidate, file));
for (const file of await readdir(ruffle)) {
  if (/^(ruffle\.js|core\.ruffle\.[a-f0-9]+\.js|[a-f0-9]+\.wasm|LICENSE_(APACHE|MIT))$/.test(file))
    await copyFile(path.join(ruffle, file), path.join(runtime, file));
}
await copyFile('scripts/ruffle-clock.mjs', path.join(candidate, 'ruffle-clock.mjs'));
await copyFile(path.join(source, 'manifest.json'), path.join(manifests, 'bomb-it-7.json'));
await writeFile(path.join(candidate, 'snapshot-probe.swf'), probe);
await writeFile(path.join(candidate, 'levels.json'), '{"levels":[{"id":0}]}\n');
console.log(candidate);
