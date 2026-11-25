#!/usr/bin/env node
/**
 * Authored acceptance: two real tabs, persistent room matching, level vote,
 * authority session over the original HTML5 pack, then open a separate game room.
 * Uses isolated ports and a temporary room registry; never touches live rooms.
 */
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startGameLobby} from './start-game-lobby.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = process.env.GAME_MANIFESTS_DIR || path.join(REPO_ROOT, 'config', 'games');

const GAMES = process.env.HTML5_GAMES_ROOT ||
  'E:/肥鱼不乐园/flash-archive/02-fireboy-watergirl/html5-online/games';
const VIEWER_PORT = Number(process.env.E2E_VIEWER_PORT || 8797);
const LOBBY_PORT = Number(process.env.E2E_LOBBY_PORT || 8798);
const ROOM = '验收-' + Date.now().toString(36);
const ICE_ROOM = ROOM + '-ice';
const PASSWORD = 'pass1234';
const log = (...args) => console.log('[e2e]', ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw Error(message);
}

async function waitPlayer(page, label) {
  try {
    await page.waitForFunction(() => {
      const status = window.__localHtml5Player?.status?.();
      return status?.initial === true && status.frames > 0;
    }, null, {timeout: 120000});
  } catch {
    const diag = await page.evaluate(() => ({
      url: location.href,
      player: !!window.__localHtml5Player,
      status: window.__localHtml5Player?.status?.() ?? null,
      hud: document.querySelector('#research-player-status')?.textContent ?? null,
      game: !!window.__game,
      scene: window.__game?.state?.current ?? null,
      ready: document.readyState,
    })).catch(error => ({evaluateError: error.message}));
    throw Error(label + ' player did not initialize: ' + JSON.stringify(diag));
  }
  const status = await page.evaluate(() => window.__localHtml5Player.status());
  log(label, 'player ready', {seat: status.seat, frames: status.frames, error: status.lastError});
  assert(status.lastError == null, label + ' player error: ' + status.lastError);
  return status;
}

async function moveOnce(page, label) {
  const beforeX = await page.evaluate(() =>
    window.__localHtml5Player.lastSnapshot().characters.find(character => character.slot === 0)?.position?.x);
  await page.keyboard.down('KeyD');
  await sleep(900);
  await page.keyboard.up('KeyD');
  await sleep(250);
  let afterX = await page.evaluate(() =>
    window.__localHtml5Player.lastSnapshot().characters.find(character => character.slot === 0)?.position?.x);
  if (!(Math.abs(afterX - beforeX) > 3)) {
    await page.keyboard.down('KeyA');
    await sleep(900);
    await page.keyboard.up('KeyA');
    await sleep(250);
    afterX = await page.evaluate(() =>
      window.__localHtml5Player.lastSnapshot().characters.find(character => character.slot === 0)?.position?.x);
  }
  log(label, 'authority movement', {beforeX, afterX});
  assert(Math.abs(afterX - beforeX) > 3, label + ' did not move under authoritative input');
}

async function frameRate(page, label) {
  const start = await page.evaluate(() => window.__localHtml5Player.status().frames);
  await sleep(2600);
  const end = await page.evaluate(() => window.__localHtml5Player.status().frames);
  const hz = (end - start) / 2.6;
  log(label, 'snapshot rate', {hz: Number(hz.toFixed(1)), frames: end - start});
  assert(hz >= 8, label + ' snapshot rate too low: ' + hz.toFixed(1) + ' Hz');
  return hz;
}

async function dismissWelcome(page) {
  const save = page.locator('[data-action="save-profile"]');
  if (await save.isVisible().catch(() => false)) {
    await save.click();
    await page.waitForSelector('.welcome-modal', {state: 'detached', timeout: 10000});
  }
}

async function enterRoomFromInvite(page, url) {
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('#join-password', {timeout: 20000});
  await dismissWelcome(page);
  await page.fill('#join-password', PASSWORD);
  await page.click('[data-action="confirm-join"]');
  await page.waitForSelector('.room-layout', {timeout: 20000});
}

async function createRoom(page,gameId,name) {
  const create=page.locator(`[data-action="focus-create"][data-game="${gameId}"]`);
  await create.waitFor();
  await dismissWelcome(page);
  await create.click();
  await page.fill('#create-name', name);
  await page.fill('#create-password', PASSWORD);
  await page.click('[data-action="create-room"]');
  await page.waitForSelector('.room-layout', {timeout: 20000});
}

async function confirmProposal(pageA, pageB, selector) {
  await pageA.waitForSelector(selector, {timeout: 15000});
  await pageA.click(selector);
  await pageB.waitForSelector('[data-action="confirm-level"]', {timeout: 15000});
  await pageB.click('[data-action="confirm-level"]');
}

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lobby-e2e-'));
  const roomsFile = path.join(temporary, 'rooms.json');
  let app, browser;
  const consoleErrors = [];
  try {
    app = await startGameLobby({
      root: GAMES, viewerPort: VIEWER_PORT, lobbyPort: LOBBY_PORT, roomsFile,
      manifestsDir: MANIFESTS,
    });
    log('lobby up', {url: app.url, games: app.catalog.map(game => game.id + ':' + game.levels.length)});

    browser = await chromium.launch({timeout: 30000});
    const contextA = await browser.newContext({viewport: {width: 1100, height: 800}});
    const contextB = await browser.newContext({viewport: {width: 1100, height: 800}});
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    for (const [label, page] of [['A', pageA], ['B', pageB]]) {
      page.on('pageerror', error => consoleErrors.push(Date.now() + ' ' + label + ' PAGEERROR ' + error.message));
      page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(Date.now() + ' ' + label + ' CONSOLE ' + message.text());
      });
    }

    await pageA.goto(app.url, {waitUntil: 'domcontentloaded'});
    await createRoom(pageA,'forest',ROOM);
    log('room created', ROOM);

    const viewerOrigin = app.url.replace(/\/$/, '');
    const invite = viewerOrigin + '/?room=' + encodeURIComponent(ROOM);
    await enterRoomFromInvite(pageB, invite);
    await pageA.waitForFunction(() => document.querySelectorAll('.seat-pill.on .dot').length === 2,
      null, {timeout: 20000});
    log('both seats connected');

    await pageA.waitForSelector('[data-action="level"][data-game="forest"][data-level="1"]', {timeout: 15000});
    await pageB.waitForSelector('[data-action="level"][data-game="forest"][data-level="1"]', {timeout: 15000});
    await confirmProposal(pageA, pageB, '[data-action="level"][data-game="forest"][data-level="1"]');
    await Promise.all([
      pageA.waitForURL(/\/1-forest-temple\/index\.html\?/, {timeout: 120000}),
      pageB.waitForURL(/\/1-forest-temple\/index\.html\?/, {timeout: 120000}),
    ]);
    log('both tabs entered forest level 1');
    for (const selector of ['#game-left', '#game-right', '#game-chat-log', '#game-chat-form', '#game-chat-input']) {
      await pageA.waitForSelector(selector, {timeout: 15000});
    }
    log('game page layout present on A');
    for (const page of [pageA, pageB]) {
      try {
        await page.waitForFunction(() => {
          const text = document.querySelector('#game-chat-status')?.textContent ?? '';
          return text.includes('已连接') || text.includes('在线');
        }, null, {timeout: 20000});
      } catch (error) {
        const diag = await page.evaluate(() => ({
          url: location.href,
          status: document.querySelector('#game-chat-status')?.textContent,
          chatConfig: window.__GAME_CHAT__ ?? null,
          keys: Object.keys(sessionStorage),
          token: sessionStorage.getItem('fb-lobby-token:' + (new URLSearchParams(location.search).get('room') || '')),
        })).catch(error => ({evaluateError: error.message}));
        log('chat diagnostic', diag);
        throw error;
      }
    }
    log('room chat connected on both game pages');
    await pageA.fill('#game-chat-input', '联机验收消息');
    await pageA.press('#game-chat-input', 'Enter');
    await pageB.waitForFunction(() =>
      (document.querySelector('#game-chat-log')?.textContent || '').includes('联机验收消息'),
    null, {timeout: 15000});
    log('room chat message delivered to peer');
    await pageB.locator('[data-game-reactions] summary').click();
    await pageB.locator('[data-game-reactions]').getByRole('button',{name:'笑哭'}).click();
    await pageA.locator('[data-game-reaction-shell] [role="status"]').filter({hasText:'P2 😂'}).waitFor();
    log('quick reaction reached peer without opening their reaction panel');
    const statusA = await waitPlayer(pageA, 'A');
    const statusB = await waitPlayer(pageB, 'B');
    assert(statusA.seat !== statusB.seat, 'both viewers received the same seat');
    await pageA.waitForFunction(() => {
      const room = window.__localHtml5Player.status().room;
      return room?.bothReady === true;
    }, null, {timeout: 60000});

    const hzA = await frameRate(pageA, 'A');
    const hzB = await frameRate(pageB, 'B');
    await moveOnce(pageA, 'A');

    await pageA.reload({waitUntil: 'domcontentloaded'});
    const reloadedA = await waitPlayer(pageA, 'A-reload');
    assert(reloadedA.seat === statusA.seat, 'reload changed the viewer seat');
    assert(new URL(pageA.url()).searchParams.has('level'), 'reload URL lost the current level');
    log('game page reload recovered in-room', {seat: reloadedA.seat, level: new URL(pageA.url()).searchParams.get('level')});

    const hud = await pageA.textContent('#research-player-status');
    assert(/正在游戏|火娃|水娃/.test(hud || ''), 'HUD did not report an active room');
    assert((await pageA.textContent('#research-player-room'))?.includes(ROOM), 'HUD room name missing');

    // Return to matching is also a two-seat vote: first prove cancel keeps the
    // game running, then confirm and require both tabs to land in selection.
    await pageA.waitForSelector('#research-player-return:not([disabled])', {timeout: 15000});
    await pageA.click('#research-player-return');
    await pageB.waitForFunction(() => {
      const modal = document.querySelector('#research-return-vote');
      return modal && modal.style.display === 'flex' &&
        (document.querySelector('#research-return-title')?.textContent || '').includes('请求');
    }, null, {timeout: 15000});
    log('return vote proposed on A and shown on B');
    await pageB.click('#research-return-cancel');
    await Promise.all([
      pageA.waitForSelector('#research-return-vote', {state: 'hidden', timeout: 15000}),
      pageB.waitForSelector('#research-return-vote', {state: 'hidden', timeout: 15000}),
    ]);
    assert(/index\.html/.test(pageA.url()), 'cancelling the return vote left the game page');

    await pageA.click('#research-player-return');
    await pageB.waitForFunction(() => {
      const modal = document.querySelector('#research-return-vote');
      return modal && modal.style.display === 'flex' &&
        (document.querySelector('#research-return-title')?.textContent || '').includes('请求');
    }, null, {timeout: 15000});
    await pageB.click('#research-return-confirm');
    await Promise.all([
      pageA.waitForURL(/\/\?room=/, {timeout: 120000}),
      pageB.waitForURL(/\/\?room=/, {timeout: 120000}),
    ]);
    log('both players voted to return and navigated to the lobby');
    // The lobby monitor ends the session once both authority sockets close.
    await pageA.waitForSelector('.room-layout', {timeout: 30000}).catch(async error => {
      const diag = await pageA.evaluate(() => ({
        url: location.href,
        text: document.body.innerText.slice(0, 500),
        stored: Object.keys(sessionStorage),
        hasNameInput: !!document.querySelector('#create-name'),
        toast: document.querySelector('#lobby-toast')?.textContent ?? null,
      })).catch(evaluateError => ({evaluateError: evaluateError.message}));
      throw Error('Return to lobby failed: ' + JSON.stringify(diag) + ' :: ' + error.message);
    });
    await pageA.waitForFunction(() => (document.querySelector('.room-banner')?.textContent || '').includes('等候开局'),
      null, {timeout: 40000});
    log('session ended; both players are back in level selection');

    assert(await pageA.locator('[data-action="select-game"]').count()===0,'bound room showed a game picker');
    await pageA.locator('.room-banner [data-action="leave"]').click();
    await createRoom(pageA,'ice',ICE_ROOM);
    await enterRoomFromInvite(pageB,viewerOrigin + '/?room=' + encodeURIComponent(ICE_ROOM));
    await pageA.waitForSelector('[data-action="level"][data-game="ice"][data-level="0"]', {timeout: 15000});
    await confirmProposal(pageA, pageB, '[data-action="level"][data-game="ice"][data-level="0"]');
    await Promise.all([
      pageA.waitForURL(/\/3-ice-temple\/index\.html\?/, {timeout: 120000}),
      pageB.waitForURL(/\/3-ice-temple\/index\.html\?/, {timeout: 120000}),
    ]);
    log('both tabs entered ice level 0');
    await waitPlayer(pageA, 'A-ice');
    await waitPlayer(pageB, 'B-ice');
    await frameRate(pageA, 'A-ice');

    const stored = JSON.parse(await readFile(roomsFile, 'utf8'));
    const record = Object.values(stored.rooms).find(room => room.name === ROOM);
    const iceRecord = Object.values(stored.rooms).find(room => room.name === ICE_ROOM);
    assert(record?.gameId==='forest','forest room binding missing');
    assert(iceRecord?.gameId==='ice','ice room binding missing');
    assert(record.saves.forest?.levelId === 1, 'forest save not persisted: ' + JSON.stringify(record.saves));
    assert(iceRecord.saves.ice?.levelId === 0, 'ice save not persisted: ' + JSON.stringify(iceRecord.saves));
    log('persistent per-game saves', record.saves, iceRecord.saves);

    const relevantErrors = consoleErrors.filter(text =>
      !/favicon|ERR_ABORTED|NS_BINDING_ABORTED|WebGL|GroupMarkerNotSet/.test(text));
    if (relevantErrors.length) log('browser errors', relevantErrors.slice(0, 10));
    assert(relevantErrors.length === 0, 'browser console errors: ' + relevantErrors.slice(0, 3).join(' | '));
    console.log(JSON.stringify({
      ok: true, room: ROOM, viewer: app.url,
      forestHz: Number(hzA.toFixed(1)), forestHzB: Number(hzB.toFixed(1)),
      saves: {...record.saves,...iceRecord.saves}, browserErrors: relevantErrors.length,
    }, null, 2));
  } catch (error) {
    log('browser diagnostics', consoleErrors.slice(0, 20));
    log('session diagnostics', {active: app?.lobby?.activeSession,
      phases: [...(app?.lobby?.lobby?.rooms?.values() ?? [])].map(room => ({
        name: room.name, phase: room.phase, members: room.members.map(member => !!member),
        connected: room.members.map(member => member?.connected === true),
      }))});
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await app?.close().catch(() => {});
    await rm(temporary, {recursive: true, force: true});
  }
}

main().catch(error => { console.error('E2E_FAILED:', error.message); process.exitCode = 1; });
