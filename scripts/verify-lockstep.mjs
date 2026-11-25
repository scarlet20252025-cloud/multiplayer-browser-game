#!/usr/bin/env node
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {WebSocket} from 'ws';
import {startGameLobby} from './start-game-lobby.mjs';
import {loadGameCatalog} from '../server/game-catalog.mjs';

// A canvas fixture with separately observable seats and no original game content.
const BRIDGE = `
export function createGame({mount, seed}) {
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
  await mkdir(pack);
  await writeFile(path.join(pack, 'levels.json'), JSON.stringify({levels: [{id: 0}]}));
  const options = {
    root: temporary, shanyiRoot: temporary, roomsFile: path.join(temporary, 'rooms.json'),
    viewerPort: VIEWER_PORT, lobbyPort: LOBBY_PORT,
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
  for (const page of pages) {
    page.setDefaultTimeout(10000);
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname === '/lockstep') credentials.set(page, socket.url());
    });
  }

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
  const readPositions = page => page.locator('#match-stage').getAttribute('data-positions');
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
  assert.equal(new URL(pageA.url()).searchParams.has('token'), false);
  assert.equal(new URL(pageA.url()).hash, '');
  await rejectSocket(credentials.get(pageA), viewerOrigin);

  await pageA.keyboard.down('KeyD');
  await pageA.waitForFunction(() => Number(document.querySelector('#match-stage').dataset.positions.split(',')[0]) > 112);
  await pageA.keyboard.up('KeyD');
  await pageB.keyboard.down('KeyA');
  await pageB.waitForFunction(() => Number(document.querySelector('#match-stage').dataset.positions.split(',')[1]) < 368);
  await pageB.keyboard.up('KeyA');
  // Both edges occur within the same client task.
  await pageA.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyJ'}));
    window.dispatchEvent(new KeyboardEvent('keyup', {code: 'KeyJ'}));
  });
  for (const page of pages) await page.getByText(/^P1 获胜 · 第 \d+ 帧已结算$/).waitFor();
  const final = await readPositions(pageA);
  assert.equal(final, await readPositions(pageB));
  const [p1, p2] = final.split(',').map(Number);
  assert(p1 > 112 && p2 < 368);
  await returnBoth();

  await pageB.evaluate(() => sessionStorage.setItem('lockstep-test-desync', 'true'));
  await startRound();
  for (const page of pages) await page.getByText(/双方游戏状态不一致/).waitFor();
  await returnBoth();
  await pageB.evaluate(() => sessionStorage.removeItem('lockstep-test-desync'));

  await startRound();
  await Promise.all(pages.map(page => page.getByText(/对战中 · P/).waitFor()));
  await pageB.close();
  await pageA.getByText(/有玩家已断线/).waitFor();
  await pageA.locator('#match-return').click();
  await pageA.locator('.room-layout').waitFor();
  assert.equal(app.lobby.activeSession, null);
  console.log(JSON.stringify({
    ok: true, fixture: true, transports: 2, positions: [p1, p2],
    checks: ['package gate', 'room and vote', 'seat authentication', 'checkpoint',
      'independent inputs', 'short tap', 'agreed result', 'desync', 'rematch', 'disconnect'],
  }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(temporary, {recursive: true, force: true});
}
