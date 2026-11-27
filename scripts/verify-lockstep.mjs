#!/usr/bin/env node
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {WebSocket} from 'ws';
import {startGameLobby} from './start-game-lobby.mjs';
import {loadGameCatalog} from '../server/game-catalog.mjs';

// A canvas fixture with separately observable seats and no original game content.
const BRIDGE = `
export function createGame({mount, seed, tickRate}) {
  mount.dataset.tickRate = String(tickRate);
  mount.dataset.seed = String(seed);
  mount.dataset.frame = '0';
  mount.dataset.initializations = String(Number(mount.dataset.initializations || 0) + 1);
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 220;
  mount.append(canvas);
  const context = canvas.getContext('2d');
  const position = [100, 380];
  const diverge = sessionStorage.getItem('lockstep-test-desync') === 'true';
  let tick = 0;
  return {
    step({frame, masks, pressed}) {
      tick = frame;
      for (let seat = 0; seat < 2; seat++)
        position[seat] += (masks[seat] & 2 ? 3 : 0) - (masks[seat] & 1 ? 3 : 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (let seat = 0; seat < 2; seat++) {
        context.fillStyle = seat === 0 ? '#ff8a63' : '#77bfff';
        context.fillRect(position[seat], 96, 26, 26);
      }
      mount.dataset.frame = String(frame);
      mount.dataset.positions = position.join(',');
      return pressed[0] & 16 ? {winner: 0} : undefined;
    },
    stateHash() {
      const value = (seed ^ tick ^ (position[0] << 14) ^ position[1] ^
        (diverge && tick > 0 ? 1 : 0)) >>> 0;
      return value.toString(16).padStart(8, '0');
    },
    dispose() { canvas.remove(); },
  };
}`;

const GAME = 'bleach-vs-naruto';
const ROOM = 'Lockstep check';
const PASSWORD = 'lockstep-test';
const VIEWER_PORT = Number(process.env.E2E_VIEWER_PORT ?? 18987);
const LOBBY_PORT = VIEWER_PORT + 1;

async function rejectSocket(url, origin) {
  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {origin, handshakeTimeout: 5000});
    ws.on('error', reject);
    ws.on('open', () => {
      ws.close();
      reject(Error('Unexpectedly accepted a match socket'));
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
  assert.equal(status, 403);
}

async function dismissWelcome(page) {
  const save = page.locator('[data-action="save-profile"]');
  if (await save.isVisible()) await save.click();
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'lockstep-e2e-'));
let app, browser;
try {
  const pack = path.join(temporary, GAME);
  const manifestsDir = path.join(temporary, 'manifests');
  await mkdir(pack);
  await mkdir(manifestsDir);
  const manifestPath = new URL('../config/games/' + GAME + '.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.package.tickRate = 40;
  await writeFile(path.join(manifestsDir, GAME + '.json'), JSON.stringify(manifest));
  await copyFile(new URL('../config/games/tank-trouble.json', import.meta.url),
    path.join(manifestsDir, 'tank-trouble.json'));
  await writeFile(path.join(pack, 'levels.json'), JSON.stringify({levels: [{id: 0}]}));
  const options = {
    root: temporary, shanyiRoot: temporary, roomsFile: path.join(temporary, 'rooms.json'),
    viewerPort: VIEWER_PORT, lobbyPort: LOBBY_PORT, manifestsDir,
  };
  await assert.rejects(loadGameCatalog({root: temporary, manifestsDir: 'config/games'}), /GAME_CATALOG_EMPTY/);
  await writeFile(path.join(pack, 'netplay.mjs'), BRIDGE);
  app = await startGameLobby(options);
  assert.deepEqual(app.catalog.map(game => game.id).sort(), [GAME, 'tank-trouble'].sort());

  const viewerOrigin = new URL(app.url).origin;
  const wsTarget = app.lobbyWsUrl.replace('/lobby', '/lockstep');
  await rejectSocket(wsTarget + '?token=' + '0'.repeat(48), viewerOrigin);

  browser = await chromium.launch({timeout: 15000, args: ['--disable-background-timer-throttling']});
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();
  const pages = [pageA, pageB];
  const credentials = new Map();
  const controlMessages = new Map();
  for (const page of pages) {
    page.setDefaultTimeout(10000);
    controlMessages.set(page, []);
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/lockstep') return;
      credentials.set(page, socket.url());
      socket.on('framereceived', ({payload}) => {
        const message = JSON.parse(payload);
        if (message.type !== 'frame') controlMessages.get(page).push(message);
      });
    });
  }
  await pageB.addInitScript(() => {
    window.WebSocket = class extends WebSocket {
      constructor(...args) {
        super(...args);
        if (new URL(args[0], location.href).pathname === '/lockstep') window.fixtureMatchSocket = this;
      }
    };
  });

  await pageA.goto(app.url);
  const create = pageA.locator(`[data-action="focus-create"][data-game="${GAME}"]`);
  await create.waitFor();
  await dismissWelcome(pageA);
  await create.click();
  await pageA.locator('#create-name').fill(ROOM);
  await pageA.locator('#create-password').fill(PASSWORD);
  await pageA.locator('[data-action="create-room"]').click();
  await pageA.locator('.room-layout').waitFor();
  await pageB.goto(app.url + '?room=' + encodeURIComponent(ROOM));
  await pageB.locator('#join-password').waitFor();
  await dismissWelcome(pageB);
  await pageB.locator('#join-password').fill(PASSWORD);
  await pageB.locator('[data-action="confirm-join"]').click();
  await pageB.locator('.room-layout').waitFor();

  const status = page => page.locator('#match-status');
  const stage = page => page.locator('#match-stage');
  const loaderDetail = page => page.locator('.game-loader__detail');
  const readPositions = page => stage(page).getAttribute('data-positions');
  const waitForFrame = (page, frame) => page.waitForFunction(target =>
    Number(document.querySelector('#match-stage')?.dataset.frame) >= target, frame);
  async function waitForControl(page, predicate, from = 0) {
    const deadline = performance.now() + 10000;
    const messages = controlMessages.get(page);
    while (performance.now() < deadline) {
      const match = messages.slice(from).find(predicate);
      if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Timed out waiting for a lockstep control message');
  }
  async function startRound() {
    await pageA.locator(`[data-action="level"][data-game="${GAME}"]:not(.disabled)`).click();
    await pageB.locator('[data-action="confirm-level"]').click();
    await Promise.all(pages.map(page => page.waitForURL('**/' + GAME + '/index.html?*')));
  }
  async function returnBoth() {
    await Promise.all(pages.map(page => page.locator('#match-return').click()));
    await Promise.all(pages.map(page => page.locator('.room-layout').waitFor()));
    assert.equal(app.lobby.activeSession, null);
  }

  await startRound();
  await Promise.all(pages.map(page => page.waitForFunction(() => Number(
    document.querySelector('#match-stage')?.dataset.frame) > 30)));
  assert.match(await status(pageA).textContent(), /P1/);
  assert.match(await status(pageB).textContent(), /P2/);
  assert.notEqual(credentials.get(pageA), credentials.get(pageB));
  for (const page of pages) {
    assert.equal(new URL(credentials.get(page)).host, new URL(viewerOrigin).host);
    assert.equal(await page.locator('#match-stage').getAttribute('data-tick-rate'), '40');
  }
  assert.equal(new URL(pageA.url()).searchParams.has('token'), false);
  assert.equal(new URL(pageA.url()).hash, '');
  await rejectSocket(credentials.get(pageA), viewerOrigin);

  await pageA.keyboard.down('KeyD');
  await pageA.waitForFunction(() => Number(document.querySelector('#match-stage').dataset.positions.split(',')[0]) > 112);
  await pageA.keyboard.up('KeyD');
  await pageB.keyboard.down('KeyA');
  await pageB.waitForFunction(() => Number(document.querySelector('#match-stage').dataset.positions.split(',')[1]) < 368);
  await pageB.keyboard.up('KeyA');

  const transport = credentials.get(pageB);
  const controlBeforeReconnect = controlMessages.get(pageA).length;
  await pageB.context().setOffline(true);
  await pageB.evaluate(() => window.fixtureMatchSocket?.close(4001, 'Fixture disconnect'));
  const pause = await waitForControl(pageA, message => message.type === 'paused', controlBeforeReconnect);
  await pageA.getByRole('heading', {name: '正在重连'}).waitFor();
  await waitForFrame(pageA, pause.frame);
  await pageA.waitForTimeout(200);
  assert.equal(Number(await stage(pageA).getAttribute('data-frame')), pause.frame);
  await pageB.context().setOffline(false);
  await Promise.all(pages.map(page => waitForFrame(page, pause.frame + 3)));
  await Promise.all(pages.map(page => status(page).waitFor()));
  assert.equal(await stage(pageB).getAttribute('data-initializations'), '1');
  assert.equal(credentials.get(pageB), transport);

  const controlBeforeRefresh = controlMessages.get(pageA).length;
  const positionsBeforeRefresh = await readPositions(pageA);
  await pageB.reload();
  const refreshPause = await waitForControl(pageA, message => message.type === 'paused', controlBeforeRefresh);
  await Promise.all(pages.map(page => waitForFrame(page, refreshPause.frame + 3)));
  assert.equal(await readPositions(pageB), positionsBeforeRefresh);
  assert.equal(credentials.get(pageB), transport);

  // Both edges occur within the same client task.
  await pageA.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyJ'}));
    window.dispatchEvent(new KeyboardEvent('keyup', {code: 'KeyJ'}));
  });
  for (const page of pages) await loaderDetail(page).filter({hasText: /^P1 获胜 · 第 \d+ 帧已结算/}).waitFor();
  const final = await readPositions(pageA);
  assert.equal(final, await readPositions(pageB));
  const [p1, p2] = final.split(',').map(Number);
  assert(p1 > 112 && p2 < 368);

  const previousSeed = await stage(pageA).getAttribute('data-seed');
  const rematch = page => page.getByRole('button', {name: '再来一局', exact: true});
  const controlBeforeRematch = controlMessages.get(pageB).length;
  await rematch(pageA).click();
  const oneVote = await waitForControl(pageB, message => message.type === 'rematch-votes', controlBeforeRematch);
  assert.deepEqual(oneVote.votedSeats, [0]);
  await loaderDetail(pageB).filter({hasText: /再开投票 1\/2/}).waitFor();
  assert.equal(await stage(pageA).getAttribute('data-seed'), previousSeed);
  await rematch(pageB).click();
  await Promise.all(pages.map(page => page.waitForFunction(previous => {
    const stage = document.querySelector('#match-stage');
    return stage?.dataset.seed !== previous && Number(stage?.dataset.frame) >= 3;
  }, previousSeed)));
  const controlBeforeLeave = controlMessages.get(pageB).length;
  await pageA.locator('#match-return').click();
  await waitForControl(pageB, message => message.type === 'ended' &&
    message.reason === 'MATCH_ABORTED', controlBeforeLeave);
  await pageA.locator('.room-layout').waitFor();
  await pageB.locator('#match-return').click();
  await pageB.locator('.room-layout').waitFor();
  assert.equal(app.lobby.activeSession, null);

  await pageB.evaluate(() => sessionStorage.setItem('lockstep-test-desync', 'true'));
  await startRound();
  for (const page of pages) await loaderDetail(page).filter({hasText: /游戏状态不一致/}).waitFor();
  await returnBoth();
  await pageB.evaluate(() => sessionStorage.removeItem('lockstep-test-desync'));

  console.log(JSON.stringify({
    ok: true, fixture: true, transports: 2, positions: [p1, p2],
    checks: ['package gate', 'room and vote', 'same-origin socket', '40 Hz adapter', 'seat authentication', 'checkpoint',
      'independent inputs', 'short tap', 'agreed result', 'desync', 'unanimous rematch', 'explicit leave',
      'disconnect freeze', 'automatic seat recovery', 'refresh replay'],
  }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(temporary, {recursive: true, force: true});
}
