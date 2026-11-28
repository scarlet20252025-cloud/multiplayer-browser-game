import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {
  loadGameManifests, loadGameRegistry, manifestToCatalogDefinition,
  validateGameManifest,
} from '../server/game-adapter.mjs';

const html5Manifest = (overrides = {}) => ({
  schemaVersion: 1,
  id: 'forest',
  title: '森林神庙',
  subtitle: 'Forest Temple',
  runtime: 'html5-phaser',
  online: true,
  capabilities: {
    authority: true, spectator: true, levelVote: true,
    restartVote: true, returnVote: true, save: true,
  },
  package: {
    dir: '1-forest-temple', entry: 'index.html',
    levels: 'data/forest/temple.json', templeId: 'forest', storagePrefix: 'fb-forest',
  },
  evidence: ['docs/HTML5_ROUTE_FINDINGS.md'],
  ...overrides,
});

async function writeManifests(dir, entries) {
  await mkdir(dir, { recursive: true });
  for (const [name, manifest] of Object.entries(entries))
    await writeFile(path.join(dir, name + '.json'), JSON.stringify(manifest));
}

test('valid html5 manifest normalizes and maps to a catalog definition', () => {
  const manifest = validateGameManifest(html5Manifest(), { file: 'forest.json' });
  assert.equal(manifest.runtimeLabel, 'HTML5');
  assert.equal(manifest.adapter, 'fireboy-html5');
  assert.equal(manifest.online, true);
  assert.deepEqual(manifest.blockers, []);
  const definition = manifestToCatalogDefinition(manifest);
  assert.equal(definition.id, 'forest');
  assert.equal(definition.adapter, 'fireboy-html5');
  assert.equal(definition.levelsPath, 'data/forest/temple.json');
  assert.equal(definition.entryFile, 'index.html');
  assert.equal(definition.runtime, 'html5-phaser');
});

test('lockstep manifests allow a two-to-four player range', () => {
  const manifest = html5Manifest({
    runtime: 'browser-lockstep', adapter: 'frame-lockstep', seats: 4, minSeats: 2,
    capabilities: {lockstep: true, levelVote: true},
    package: {...html5Manifest().package, bridge: 'netplay.mjs'},
  });
  const definition = manifestToCatalogDefinition(validateGameManifest(manifest));
  assert.equal(definition.seats, 4);
  assert.equal(definition.minSeats, 2);
  const defaultGame = validateGameManifest({...manifest, seats: undefined, minSeats: undefined});
  assert.equal(defaultGame.seats, 2);
  assert.equal(defaultGame.minSeats, 2);
  assert.throws(() => validateGameManifest({...manifest, seats: 5}), /requires two to four players/);
  assert.throws(() => validateGameManifest({...manifest, minSeats: 1}), /requires two to four players/);
});

const flashManifest = (overrides = {}) => ({
  schemaVersion: 1,
  id: 'shanyi',
  title: '闪翼双星',
  runtime: 'flash-ruffle',
  adapter: 'flash-mirror',
  online: true,
  capabilities: { mirrorInput: true, save: true },
  package: {
    dir: 'shanyi', entry: 'index.html', levels: 'levels.json',
    templeId: 'shanyi', storagePrefix: 'shanyi',
    wrapper: 'shanyi-host.swf', game: 'core_4_abc.swf',
  },
  ...overrides,
});

test('flash-ruffle is online only as the mirror-input tier', () => {
  const manifest = validateGameManifest(flashManifest(), { file: 'shanyi.json' });
  assert.equal(manifest.runtimeLabel, 'Flash / Ruffle（实验）');
  assert.equal(manifest.adapter, 'flash-mirror');
  assert.equal(manifest.online, true);
  assert.deepEqual(manifest.capabilities, { mirrorInput: true, save: true });
  const definition = manifestToCatalogDefinition(manifest);
  assert.equal(definition.wrapperFile, 'shanyi-host.swf');
  assert.equal(definition.gameFile, 'core_4_abc.swf');
  assert.equal(definition.dataDir, '');
  assert.throws(() => validateGameManifest(flashManifest({ adapter: 'fireboy-html5' })),
    /require adapter flash-mirror/);
  assert.throws(() => validateGameManifest(flashManifest({
    capabilities: { mirrorInput: true, authority: true },
  })), /unknown capability authority/);
  assert.throws(() => validateGameManifest(flashManifest({
    package: { ...flashManifest().package, wrapper: undefined },
  })), /package\.wrapper/);
});

test('flash-native cannot be declared online and offline games need blockers', () => {
  assert.throws(() => validateGameManifest(html5Manifest({ runtime: 'flash-native' })),
    /cannot be declared online/);
  assert.throws(() => validateGameManifest(html5Manifest({
    runtime: 'flash-native', online: false, package: null, blockers: [],
  })), /at least one blocker/);
  const research = validateGameManifest(html5Manifest({
    runtime: 'flash-native', online: false, package: null,
    blockers: ['NO_BROWSER_RUNTIME'], capabilities: {},
  }));
  assert.equal(research.online, false);
  assert.deepEqual(research.blockers, ['NO_BROWSER_RUNTIME']);
  const roundTrip = validateGameManifest(JSON.parse(JSON.stringify(research)));
  assert.equal(roundTrip.id, 'forest');
  assert.equal(roundTrip.adapter, null);
});

test('manifest validation fails closed on ids, capabilities and paths', () => {
  assert.throws(() => validateGameManifest(html5Manifest({ id: 'Forest' })), /id must match/);
  assert.throws(() => validateGameManifest(html5Manifest({ runtime: 'unknown' })), /unknown runtime/);
  assert.throws(() => validateGameManifest(html5Manifest({ adapter: 'unknown-engine' })),
    /is not installed/);
  assert.throws(() => validateGameManifest(html5Manifest({
    runtime: 'flash-native', online: false, package: null, capabilities: {},
    blockers: ['NO_BROWSER_RUNTIME'], adapter: 'fireboy-html5',
  })), /must not declare an adapter/);
  assert.throws(() => validateGameManifest(html5Manifest({
    capabilities: { authority: true, spectator: true, levelVote: true, restartVote: true },
  })), /requires capability returnVote/);
  assert.throws(() => validateGameManifest(html5Manifest({
    capabilities: { authority: true, spectator: true, levelVote: true,
      restartVote: true, returnVote: true, teleport: true },
  })), /unknown capability teleport/);
  assert.throws(() => validateGameManifest(html5Manifest({
    package: { ...html5Manifest().package, dir: '../outside' },
  })), /stay inside/);
  assert.throws(() => validateGameManifest(html5Manifest({
    runtime: 'flash-native', online: false, package: null, capabilities: {}, blockers: [],
  })), /at least one blocker/);
});

test('manifest directories enforce unique ids and registry separation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const games = path.join(root, 'games');
  const research = path.join(root, 'research');
  await writeManifests(games, { forest: html5Manifest() });
  await writeManifests(research, {
    shanyi: html5Manifest({
      id: 'shanyi', runtime: 'flash-native', online: false, package: null,
      blockers: ['NO_BROWSER_RUNTIME'], capabilities: {},
    }),
  });
  const registry = await loadGameRegistry({ gamesDir: games, researchDir: research });
  assert.deepEqual(registry.playable.map(game => game.id), ['forest']);
  assert.deepEqual(registry.research.map(game => game.id), ['shanyi']);
  assert.equal(registry.playable[0].package, undefined);

  await writeManifests(games, { forest: html5Manifest() });
  await writeManifests(research, { shanyi: html5Manifest({ id: 'forest' }) });
  await assert.rejects(loadGameRegistry({ gamesDir: games, researchDir: research }),
    /duplicate game id across registries/);

  await writeManifests(games, { broken: html5Manifest({ id: 'broken', runtime: 'flash-native', online: false, package: null }) });
  await assert.rejects(loadGameManifests({ dir: games }), /at least one blocker/);
});

test('manifest order controls lobby ordering regardless of file names', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-adapter-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'games');
  await writeManifests(dir, {
    'a-crystal': html5Manifest({ id: 'crystal', title: 'Crystal', order: 4 }),
    'b-forest': html5Manifest({ id: 'forest', title: 'Forest', order: 1 }),
    'c-unsorted': html5Manifest({ id: 'alpha', title: 'Alpha' }),
  });
  const manifests = await loadGameManifests({ dir });
  assert.deepEqual(manifests.map(manifest => manifest.id), ['forest', 'crystal', 'alpha']);
  assert.throws(() => validateGameManifest(html5Manifest({ order: 1.5 })), /order must be an integer/);
});

test('a directory without manifests is an explicit error, not an empty lobby', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-adapter-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(loadGameManifests({ dir: path.join(root, 'missing') }), /GAME_MANIFEST_DIR_MISSING/);
  await assert.rejects(loadGameManifests({ dir: root }), /GAME_MANIFEST_DIR_EMPTY/);
});
