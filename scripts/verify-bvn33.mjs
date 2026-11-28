import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:net';
import path from 'node:path';
import {mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {startGameLobby} from './start-game-lobby.mjs';

const [gamesRoot, sidecar, ...options] = process.argv.slice(2);
if (!gamesRoot || !sidecar)
  throw Error('Usage: node scripts/verify-bvn33.mjs <existing games root> <BVN service origin> [--watch] [--same-origin]');

const host = new URL(sidecar).hostname;
const fixtureRoot = fileURLToPath(new URL('../local/lan-playtest/', import.meta.url));
await mkdir(fixtureRoot, {recursive: true});
const temporary = await mkdtemp(path.join(fixtureRoot, 'bvn33-e2e-'));
const checkWitness = options.includes('--watch');
const sameOrigin = options.includes('--same-origin');
const gamePath = sameOrigin ? '/bvn33/' : '/';
const isApi = pathname => pathname.startsWith('/api/') || pathname.startsWith(`${gamePath}api/`);
const room = 'BVN 3.3 check';
const password = 'local-test-only';
let app, browser, viewer;
const pages = [];
const checkpoints = [];
const sockets = [];
const errors = [];
const viewEvidence = {imageFrames: 0, forbiddenRequests: 0};

async function openPorts() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const probes = [createServer(), createServer()];
    const first = randomInt(20_000, 45_000);
    try {
      for (let index = 0; index < probes.length; index++) {
        probes[index].listen(first + index, host);
        await once(probes[index], 'listening');
      }
      return [first, first + 1];
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    } finally {
      await Promise.all(probes.filter(server => server.listening).map(server =>
        new Promise(resolve => server.close(resolve))));
    }
  }
  throw Error('Unable to allocate adjacent viewer and lobby test ports');
}

async function readState(page) {
  return page.evaluate(() => window.netState);
}
async function press(page, key) {
  await page.keyboard.down(key);
  await delay(130);
  await page.keyboard.up(key);
  await delay(330);
}
async function dismissProfile(page) {
  await page.locator('[data-action="save-profile"]').click();
}

try {
  const [viewerPort, lobbyPort] = await openPorts();
  const browserGame = sameOrigin ? `http://${host}:${viewerPort}${gamePath}` : sidecar;
  app = await startGameLobby({
    root: gamesRoot, viewerPort, lobbyPort, host,
    publicHost: host, publicViewerPort: viewerPort, publicLobbyPort: lobbyPort,
    roomsFile: path.join(temporary, 'rooms.json'),
    bvn33ServiceUrl: sidecar, bvn33PublicUrl: browserGame,
  });
  browser = await chromium.launch({timeout: 15000, args: [
    '--no-proxy-server',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ]});
  for (let seat = 0; seat < 2; seat++) {
    const page = await browser.newPage({viewport: {width: 960, height: 720}});
    page.setDefaultTimeout(15000);
    pages.push(page);
    const states = new Map();
    checkpoints.push(states);
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {
      const pathname = new URL(request.url()).pathname;
      const reason = request.failure()?.errorText;
      if (isApi(pathname) && reason !== 'net::ERR_ABORTED') errors.push(pathname + ': ' + reason);
    });
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (isApi(pathname) && response.status() >= 400) errors.push(pathname + ': ' + response.status());
    });
    page.on('websocket', ws => {
      const pathname = new URL(ws.url()).pathname;
      sockets.push(pathname);
      if (pathname !== `${gamePath}socket`) return;
      ws.on('framesent', ({payload}) => {
        if (typeof payload !== 'string') return;
        const message = JSON.parse(payload);
        if (message.type === 'ack' && message.state?.p1 && message.state.p2)
          states.set(message.epoch + ':' + message.n, message.state);
      });
    });
  }
  const [first, second] = pages;
  await first.goto(app.url);
  await dismissProfile(first);
  await first.locator('[data-action="focus-create"][data-game="bvn33"]').click();
  await first.locator('#create-name').fill(room);
  await first.locator('#create-password').fill(password);
  await first.locator('[data-action="create-room"]').click();
  await first.locator('.room-layout').waitFor();
  await second.goto(app.url + '?room=' + encodeURIComponent(room));
  await dismissProfile(second);
  await second.locator('#join-password').fill(password);
  await second.locator('[data-action="confirm-join"]').click();
  await second.locator('.room-layout').waitFor();
  await first.locator('[data-action="level"][data-game="bvn33"]:not(.disabled)').click();
  await second.locator('[data-action="confirm-level"]').click();
  await Promise.all(pages.map((page, i) => page.waitForFunction(
    seat => document.querySelector('#identity')?.textContent.includes('P' + seat), i + 1,
    {timeout: 15000})));
  assert(pages.every(page => !page.url().includes('seat=')));
  await Promise.all(pages.map(page => page.waitForFunction(
    () => window.netState?.stage.endsWith('::SelectFighterStage'), null, {timeout: 100000})));
  console.log('Both real BVN clients reached character selection.');

  if (checkWitness) {
    viewer = await browser.newPage({viewport: {width: 960, height: 720}});
    viewer.setDefaultTimeout(12000);
    viewer.on('pageerror', error => errors.push(error.message));
    viewer.on('request', request => {
      if (/\.(?:swf|wasm)$/.test(new URL(request.url()).pathname)) viewEvidence.forbiddenRequests++;
    });
    viewer.on('websocket', ws => {
      const url = new URL(ws.url());
      if (url.pathname !== `${gamePath}socket` || url.searchParams.get('role') !== 'watch') return;
      ws.on('framereceived', ({payload}) => {
        if (typeof payload !== 'string' && payload.subarray(0, 4).toString() === 'RIFF' &&
            payload.subarray(8, 12).toString() === 'WEBP') viewEvidence.imageFrames++;
      });
    });
    await viewer.goto(app.url);
    await dismissProfile(viewer);
    const spectatorCard = viewer.locator('.catalog-room').filter({hasText: room});
    await spectatorCard.waitFor();
    const earlySpectate = spectatorCard.getByRole('button', {name: '观战', exact: true});
    await earlySpectate.waitFor({state: 'visible'});
    assert(await earlySpectate.isDisabled(), 'Spectating must stay disabled during character selection');
    const denied = await viewer.request.post(new URL('/api/rooms/spectate', app.url).href,
      {data: {name: room, password}});
    assert.equal(denied.status(), 409, 'The server must withhold spectator admission until combat');
    assert.equal((await denied.json()).error, 'ROOM_NOT_WATCHABLE');
    console.log('The spectator button was visible and disabled, and early admission was rejected.');
  }

  await press(second, 'd');
  for (const field of ['fighter1', 'fuzhu']) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await readState(first);
      if (state?.select1?.[field] && state?.select2?.[field]) break;
      for (let seat = 0; seat < 2; seat++)
        if (!state?.['select' + (seat + 1)]?.[field]) await press(pages[seat], 'j');
    }
    await first.waitForFunction(key => window.netState?.select1?.[key] &&
      window.netState?.select2?.[key], field);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await readState(first);
    if (state?.map || state?.stage.endsWith('::LoadingState')) break;
    await press(first, 'j');
  }
  await Promise.all(pages.map(page => page.waitForFunction(
    () => window.netState?.active && window.netState.stage.endsWith('::GameState'),
    null, {timeout: 50000})));
  const start = await readState(first);
  console.log('Actual fight started:', start.p1[0], start.p2[0], 'map', start.map);

  if (viewer) {
    const spectate = viewer.locator('.catalog-room').filter({hasText: room}).locator('[data-action="spectate-room"]');
    await spectate.click();
    await viewer.locator('#join-password').fill(password);
    await viewer.locator('[data-action="confirm-join"]').click();
    await viewer.waitForURL(url => url.origin === new URL(browserGame).origin && url.pathname === `${gamePath}lobby-watch`);
    assert(!viewer.url().includes('view='), 'The viewer ticket fragment should be cleared');
    await viewer.waitForFunction(() => {
      if (!document.getElementById('status')?.hidden) return false;
      const field = document.getElementById('field'), width = field.width;
      const pixels = field.getContext('2d').getImageData(0, 0, width, field.height).data;
      const colors = new Set();
      for (let offset = 0; offset < pixels.length; offset += 4 * 19) {
        colors.add((pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]);
        if (colors.size > 20) return true;
      }
      return false;
    });
    assert(viewEvidence.imageFrames > 0, 'The read-only socket must receive binary WebP');
    assert.equal(viewEvidence.forbiddenRequests, 0, 'The viewer must not download Ruffle or the game');
    console.log('Authorized viewer received nonblank WebP from the genuine Ruffle fight.');
  }

  let damage = [0, 0];
  for (let attempt = 0; attempt < 26 && damage.some(value => value <= 0); attempt++) {
    for (let seat = 0; seat < 2; seat++) {
      const state = await readState(first);
      if (!state.active) break;
      const fighters = [state.p1, state.p2];
      const distance = fighters[1 - seat][1] - fighters[seat][1];
      if (Math.abs(distance) > 70) {
        const direction = distance > 0 ? 'd' : 'a';
        await pages[seat].keyboard.down(direction);
        await delay(270);
        await pages[seat].keyboard.up(direction);
      }
      await press(pages[seat], attempt % 3 === 0 ? 'u' : 'j');
    }
    const state = await readState(first);
    damage = [start.p1[3] - state.p1[3], start.p2[3] - state.p2[3]];
  }
  assert(damage.every(value => value > 0), 'Both seats must reduce the opponent’s HP');
  const common = [...checkpoints[0]].filter(([frame, state]) =>
    state.active && checkpoints[1].has(frame));
  assert(common.length >= 3, 'Both clients must report real same-frame combat checkpoints');
  for (const [frame, state] of common) assert.deepEqual(state, checkpoints[1].get(frame), frame);
  assert(!sockets.includes('/live-socket'), 'No video or audio transport should connect');
  assert.deepEqual(errors, []);

  const viewReturn = viewer?.waitForRequest(request => {
    const url = new URL(request.url());
    return request.isNavigationRequest() && url.origin === new URL(app.url).origin && url.pathname === '/' &&
      url.searchParams.get('watchEnded') === 'room-closed';
  });
  await first.locator('#end').click();
  await first.locator('#end').click();
  if (viewer) {
    await viewReturn;
    await viewer.getByText('对局已结束或房间已关闭，已退出观战。', {exact: true}).waitFor();
    assert.equal(viewer.url(), app.url, 'The viewer should return to the plaza without opening the player join form');
  }
  await first.waitForURL(app.url + '?room=*');
  await second.locator('#leave').click();
  await second.waitForURL(app.url + '?room=*');
  await Promise.all(pages.map(page => page.locator('.room-layout').waitFor()));
  const deadline = Date.now() + 4500;
  while (app.lobby.activeSession && Date.now() < deadline) await delay(200);
  assert.equal(app.lobby.activeSession, null);
  console.log(JSON.stringify({ok: true, fighters: [start.p1[0], start.p2[0]],
    hpLost: damage, matchingCombatCheckpoints: common.length, videoTransport: false,
    returnedToLobby: true, ...(viewer ? {spectator: {...viewEvidence, returnedWithNotice: true}} : {})}));
} catch (error) {
  for (const page of viewer ? [...pages, viewer] : pages) {
    const diagnostic = await page.evaluate(() => ({
      path: location.pathname, state: window.netState ?? null,
      loading: document.querySelector('#loading-text')?.textContent ?? null,
      notice: Array.from(document.querySelectorAll('.notice, .toast')).slice(0, 6).map(node => node.textContent),
    })).catch(() => null);
    console.error(JSON.stringify(diagnostic));
  }
  if (errors.length) console.error(JSON.stringify({errors}));
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  const resolved = await realpath(temporary);
  if (path.dirname(resolved) === await realpath(fixtureRoot) && path.basename(resolved).startsWith('bvn33-e2e-'))
    await rm(resolved, {recursive: true, force: true});
}
