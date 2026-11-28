import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {loadGameCatalog} from '../server/game-catalog.mjs';
import {validateGameManifest} from '../server/game-adapter.mjs';

const manifest = validateGameManifest({
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
});

async function makePack(root) {
  const pack = path.join(root, '1-forest-temple');
  await mkdir(path.join(pack, 'data', 'forest'), { recursive: true });
  await writeFile(path.join(pack, 'index.html'),
    '<html><script src="lib/require.js" data-main="game.js"></script></html>');
  await writeFile(path.join(pack, 'game.json'), JSON.stringify({ title: '&amp; Pack' }));
  await writeFile(path.join(pack, 'data', 'forest', 'temple.json'), JSON.stringify({
    id: 'forest',
    levels: [{ id: 0, filename: '0.json', type: 'normal', time: 60 }, { id: 1, filename: '1.json' }],
  }));
}

test('catalog accepts manifest definitions and exposes runtime capabilities', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-catalog-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makePack(root);
  const catalog = await loadGameCatalog({ root, manifests: [manifest] });
  assert.equal(catalog.length, 1);
  const game = catalog[0];
  assert.equal(game.id, 'forest');
  assert.equal(game.runtime, 'html5-phaser');
  assert.equal(game.adapter, 'fireboy-html5');
  assert.equal(game.capabilities.returnVote, true);
  assert.equal(game.entryPath, '/1-forest-temple/index.html');
  assert.equal(game.levels.length, 2);
  assert.equal(game.subtitle, '& Pack');
});

test('catalog loads the same definitions from a manifests directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-catalog-dir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makePack(root);
  const dir = path.join(root, 'manifests');
  await mkdir(dir);
  await writeFile(path.join(dir, 'forest.json'), JSON.stringify(manifest));
  const catalog = await loadGameCatalog({ root, manifestsDir: dir });
  assert.deepEqual(catalog.map(game => game.id), ['forest']);
});

test('catalog rejects conflicting manifest sources and offline manifests', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-catalog-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makePack(root);
  await assert.rejects(loadGameCatalog({ root, manifests: [manifest], manifestsDir: root }),
    /GAME_CATALOG_SOURCE_CONFLICT/);
  const research = validateGameManifest({
    schemaVersion: 1, id: 'shanyi', title: '闪翼双星', runtime: 'flash-native',
    online: false, blockers: ['NO_BROWSER_RUNTIME'], capabilities: {},
  });
  await assert.rejects(loadGameCatalog({ root, manifests: [research] }), /GAME_ADAPTER_NOT_ONLINE/);
});
