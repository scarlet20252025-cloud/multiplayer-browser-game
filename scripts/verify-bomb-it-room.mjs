#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startGameLobby} from './start-game-lobby.mjs';
import {ORIGINAL_SWF_BYTES, ORIGINAL_SWF_PATH} from '../experiments/bomb-it-netplay/original-file.mjs';

const {values} = parseArgs({options: {
  url: {type: 'string'}, room: {type: 'string', default: 'Bomb It local test'},
  create: {type: 'boolean', default: false},
  password: {type: 'string', default: 'bomb-it-local-test'},
  swf: {type: 'string', default: 'local/original-games/bomb-it/bomb-it-7.swf'},
  dpr: {type: 'string', default: '0.25'},
  width: {type: 'string', default: '1050'},
  preview: {type: 'string', default: 'local/bomb-it-preview'},
  players: {type: 'string', default: '2'},
  gpu: {type: 'boolean'},
  'min-fps': {type: 'string'},
  'test-retry': {type: 'boolean', default: false},
  'test-reconnect': {type: 'boolean', default: false},
  'test-rematch': {type: 'boolean', default: false},
  'test-setup': {type: 'boolean', default: false},
  'test-embedded-loader': {type: 'boolean', default: false},
  map: {type: 'string'},
  mode: {type: 'string'},
}});
const preview = path.resolve(values.preview);
const room = values.room;
const password = values.password;
const dpr = Number(values.dpr);
const width = Number(values.width);
const playerCount = Number(values.players);
assert.ok(Number.isFinite(dpr) && dpr > 0);
assert.ok(Number.isInteger(width) && width > 0);
assert.ok([2, 3, 4].includes(playerCount));
let app, browser;
try {
  if (!values.url) app = await startGameLobby({
    root: path.join(preview, 'empty'), manifestsDir: path.join(preview, 'manifests'),
    shanyiRoot: path.join(preview, 'packages'), roomsFile: path.join(preview, 'verify-' + Date.now() + '.json'),
    viewerPort: 17693, lobbyPort: 17694, bombItSwf: values.swf,
  });
  const url = new URL(values.url ?? app.url);
  browser = await chromium.launch(values.gpu ? {args: ['--enable-gpu']} : {});
  const peers = await Promise.all(Array.from({length: playerCount}, async () => {
    const context = await browser.newContext({
      viewport: {width, height: 800}, deviceScaleFactor: dpr, locale: 'en-US', timezoneId: 'UTC',
    });
    const page = await context.newPage();
    const obsoleteLoaderRequests = [];
    if (values['test-embedded-loader']) await page.route('**/Art_Res.swf', route => {
      obsoleteLoaderRequests.push(new URL(route.request().url()).pathname);
      return route.abort();
    });
    await page.addInitScript(() => {
      const processing = [];
      window.__lockstepFrameTimes = processing;
      const OriginalWebSocket = window.WebSocket;
      window.WebSocket = new Proxy(OriginalWebSocket, {
        construct(Socket, args) {
          const socket = new Socket(...args);
          if (new URL(socket.url).pathname !== '/lockstep') return socket;
          window.__lockstepSocket = socket;
          let receivedAt;
          socket.addEventListener('message', () => { receivedAt = performance.now(); });
          const send = socket.send.bind(socket);
          socket.send = raw => {
            const message = JSON.parse(raw);
            if (message.type === 'ack' && message.frame >= 31 && message.frame <= 180)
              processing.push(performance.now() - receivedAt);
            return send(raw);
          };
          return socket;
        },
      });
    });
    const acks = new Map();
    const handshake = [];
    const welcomes = [];
    const processed = new Map();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text().slice(0, 400));
    });
    page.on('response', response => {
      if (response.status() >= 400)
        errors.push(response.status() + ' ' + new URL(response.url()).pathname);
    });
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/lockstep') return;
      assert.equal(new URL(socket.url()).host, url.host);
      socket.on('framereceived', ({payload}) => {
        const message = JSON.parse(payload);
        if (message.type === 'welcome') welcomes.push(message);
      });
      socket.on('framesent', ({payload}) => {
        const message = JSON.parse(payload);
        if (['ready', 'resume'].includes(message.type)) handshake.push(message);
        if (message.type === 'ack' && message.frame <= 180) processed.set(message.frame, performance.now());
        if (message.type === 'ack' && message.hash) acks.set(message.frame, message.hash);
      });
    });
    return {page, acks, errors, processed, handshake, welcomes, obsoleteLoaderRequests};
  }));
  const [first, second] = peers.map(({page}) => page);
  const inspectBridge = async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = '        state = current;';
    assert.ok(source.includes(marker));
    await route.fulfill({response, body: source.replace(marker, `${marker}\n        window.bombItTestState = current;`)
      .replace('    const held = Array(playerCount).fill(0);',
        '    window.bombItInitialState = state;\n    const held = Array(playerCount).fill(0);')});
  };
  await first.route('**/bomb-it-7/netplay.mjs', inspectBridge);
  if (values['test-reconnect']) await second.route('**/bomb-it-7/netplay.mjs', inspectBridge);
  if (values['test-retry']) {
    await second.route('**' + ORIGINAL_SWF_PATH, route => route.fulfill({status: 502}), {times: 1});
  }
  const welcome = async page => {
    const dismiss = page.locator('[data-action="save-profile"]');
    if (await dismiss.isVisible()) await dismiss.click();
  };
  const create = !values.url || values.create;
  if (create) {
    await first.goto(url.href);
    await welcome(first);
    await first.locator('[data-action="focus-create"][data-game="bomb-it-7"]').click();
    await first.locator('#create-name').fill(room);
    await first.locator('#create-password').fill(password);
    await first.locator('[data-action="create-room"]').click();
    await first.locator('.room-layout').waitFor();
  }
  const invite = new URL(url);
  invite.searchParams.set('room', room);
  const joiners = create ? peers.slice(1) : peers;
  await Promise.all(joiners.map(async ({page}) => {
    await page.goto(invite.href);
    await page.locator('#join-password').waitFor();
    await welcome(page);
    await page.locator('#join-password').fill(password);
    await page.locator('[data-action="confirm-join"]').click();
    await page.locator('.room-layout').waitFor();
  }));
  const ready = page => page.locator('[data-action="bomb-it-ready"]');
  const part = (page, key, value) => page.locator(`[data-outfit-part="${key}"][data-outfit-value="${value}"]`);
  const setting = (page, key, value) => page.locator(`[data-bomb-it-setting="${key}"][data-bomb-it-value="${value}"]`);
  const modernSetup = await ready(first).count() > 0;
  if (values['test-setup']) assert.ok(modernSetup, 'Missing Bomb It ready room');
  if (modernSetup) {
    for (const [key, value] of [['mapId', values.map], ['modeId', values.mode]]) {
      if (!value) continue;
      await setting(first, key, value).click();
      await setting(first, key, value).and(first.locator('[aria-pressed="true"]')).waitFor();
    }
    if (values['test-setup']) {
      await part(first, 'robotId', 7).click();
      await part(first, 'robotId', 7).and(first.locator('[aria-pressed="true"]')).waitFor();
      await part(second, 'robotId', 7).and(second.locator(':disabled')).waitFor();
      await part(first, 'clothId', 1).click();
      await part(first, 'clothId', 1).and(first.locator('[aria-pressed="true"]')).waitFor();
      await ready(first).click();
      await ready(first).filter({hasText: '取消准备'}).waitFor();
      await first.reload();
      await ready(first).filter({hasText: '取消准备'}).waitFor();
      await part(first, 'robotId', 7).and(first.locator('[aria-pressed="true"]')).waitFor();
      await part(first, 'clothId', 1).and(first.locator('[aria-pressed="true"]')).waitFor();
      await part(second, 'robotId', 6).click();
      await part(second, 'robotId', 6).and(second.locator('[aria-pressed="true"]')).waitFor();
      await ready(first).filter({hasText: '取消准备'}).waitFor();
    } else {
      if (values['test-rematch']) {
        await part(first, 'clothId', 1).click();
        await part(second, 'hatId', 2).click();
      }
      await ready(first).click();
    }
  } else if (values['test-rematch']) {
    await first.locator('#outfit-clothId').selectOption('1');
    await second.locator('#outfit-hatId').selectOption('2');
  }
  if (!modernSetup) await first.locator('[data-action="level"][data-game="bomb-it-7"]:not(.disabled)').click();
  const downloads = peers.map(({page}) => page.waitForResponse(response =>
    new URL(response.url()).pathname === ORIGINAL_SWF_PATH && response.ok(), {timeout: 50_000}));
  const completed = Promise.all(downloads);
  completed.catch(() => {});
  const startupAt = performance.now();
  await Promise.all(peers.slice(1).map(({page}) => modernSetup ? ready(page).click() :
    page.locator('[data-action="confirm-level"]').click()));
  if (values['test-retry']) {
    await second.getByRole('progressbar').waitFor({state: 'hidden'});
    await second.getByRole('button', {name: '重试加载'}).click();
  }
  for (const response of await completed) {
    assert.equal(new URL(response.url()).origin, url.origin);
    assert.equal(Number(response.headers()['content-length']), ORIGINAL_SWF_BYTES);
  }
  for (const {page} of peers) assert.equal(await page.locator('#match-stage input[type=file]').count(), 0);
  console.log(`All ${playerCount} players downloaded the original automatically.`);
  let loadError;
  try {
    await Promise.all(peers.map(({page}) => page.waitForFunction(() => {
      const status = document.querySelector('#match-status')?.textContent ?? '';
      return /对战中 · P[1-4]/.test(status) || ['error', 'ended'].includes(document.querySelector('.game-loader')?.dataset.phase);
    }, undefined, {polling: 150, timeout: 110_000})));
  } catch (error) { loadError = error; }
  const diagnostics = await Promise.all(peers.map(async ({page, errors}) => ({
    status: await page.locator('#match-status').textContent(), errors: errors.slice(-16),
  })));
  if (loadError || diagnostics.some(peer => !/对战中 · P[1-4]/.test(peer.status)))
    throw new Error(JSON.stringify(diagnostics), {cause: loadError});
  if (values['test-embedded-loader']) {
    assert.deepEqual(peers.flatMap(peer => peer.obsoleteLoaderRequests), []);
    console.log('Every browser initialized the embedded loading screen without requesting Art_Res.swf.');
  }
  for (const {page} of peers) {
    assert.equal(await page.locator('.game-loader').isVisible(), false);
    assert.match(await page.locator('footer').textContent(), /空格攻击/);
    assert.equal(await page.locator('#match-scores, .match-scorecard').count(), 0);
    assert.match(await page.locator('#match-players').textContent(), new RegExp(`^${playerCount} 人 · P[1-4]$`));
    assert.equal(await page.evaluate(() =>
      document.querySelector('#match-stage iframe').contentDocument.querySelector('ruffle-player').ruffle().volume), 0.5);
  }
  const startupMs = Math.round(performance.now() - startupAt);
  console.log(`All ${playerCount} players entered the match after ${startupMs} ms.`);
  const seats = peers.map(({page}) => Number(new URL(page.url()).searchParams.get('seat')));
  assert.deepEqual([...seats].sort((a, b) => a - b), Array.from({length: playerCount}, (_, index) => index));
  if (values['test-setup']) {
    const [{welcomes: [firstMatch]}] = peers;
    assert.equal(new Set(firstMatch.playerOutfits.map(({robotId}) => robotId)).size, playerCount);
    assert.equal(firstMatch.playerOutfits[seats[0]].robotId, 7);
    assert.equal(firstMatch.playerOutfits[seats[0]].clothId, 1);
    assert.equal(firstMatch.playerOutfits[seats[1]].robotId, 6);
    if (values.map) assert.equal(firstMatch.bombItSettings.mapId, values.map);
    if (values.mode) assert.equal(firstMatch.bombItSettings.modeId, values.mode);
    for (const {welcomes: [match]} of peers.slice(1)) {
      assert.deepEqual(match.playerOutfits, firstMatch.playerOutfits);
      assert.deepEqual(match.bombItSettings, firstMatch.bombItSettings);
    }
    console.log(`Ready retained through refresh. All players received ${firstMatch.bombItSettings.mapId}/${firstMatch.bombItSettings.modeId} and distinct roles.`);
  }
  await first.waitForFunction(() => window.bombItTestState, null, {polling: 100});
  if (values['test-setup']) {
    const nativeSettings = await first.evaluate(() => window.bombItTestState[7]);
    assert.deepEqual(nativeSettings, [peers[0].welcomes[0].bombItSettings.mapId, peers[0].welcomes[0].bombItSettings.modeId]);
  }
  const movement = await first.evaluate(() => {
    const state = window.bombItTestState;
    return state[2].map(([, x, y]) => {
      const directions = [['KeyD', x + 1, y], ['KeyA', x - 1, y], ['KeyS', x, y + 1], ['KeyW', x, y - 1]];
      const open = directions.find(([, tx, ty]) => state[5][tx]?.[ty]?.[5] === null);
      return {x, y, key: open?.[0]};
    });
  });
  assert.equal(movement.length, playerCount);
  assert.ok(movement.every(({key}) => key), 'Each spawn needs an open neighboring tile');
  // Dispatch through the page's input handler without switching the OS focus
  // between the simulated players. A real focus change releases held keys.
  const sendKey = (page, type, code) => page.evaluate(({type, code}) => {
    window.dispatchEvent(new KeyboardEvent(type, {code, bubbles: true, cancelable: true}));
  }, {type, code});
  await Promise.all(peers.map(({page}, index) => sendKey(page, 'keydown', movement[seats[index]].key)));
  try {
    await first.waitForFunction(positions => window.bombItTestState[2].every(([, x, y], index) =>
      x !== positions[index].x || y !== positions[index].y), movement, {polling: 100, timeout: 12_000});
  } catch (error) {
    const positions = await first.evaluate(() => window.bombItTestState[2].map(robot => robot.slice(0, 3)));
    throw new Error(`Movement from ${JSON.stringify(movement)} to ${JSON.stringify(positions)}`, {cause: error});
  }
  await Promise.all(peers.map(async ({page}, index) => {
    await sendKey(page, 'keyup', movement[seats[index]].key);
    await sendKey(page, 'keydown', 'Space');
    await sendKey(page, 'keyup', 'Space');
  }));
  const deadline = performance.now() + 40_000;
  while (!peers.every(peer => peer.acks.has(180)) && performance.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  for (const peer of peers.slice(1))
    assert.deepEqual([...peer.acks].filter(([frame]) => frame <= 180),
      [...peers[0].acks].filter(([frame]) => frame <= 180));
  if (!peers.every(peer => peer.acks.has(180))) {
    const state = await Promise.all(peers.map(async ({page, acks, errors}) => ({
      status: await page.locator('#match-status').textContent(), frames: [...acks.keys()], errors: errors.slice(-6),
    })));
    throw new Error('Missing confirmed frame 180: ' + JSON.stringify(state));
  }
  assert.ok(new Set([...peers[0].acks].filter(([frame]) => frame >= 30 && frame <= 180).map(([, hash]) => hash)).size > 1,
    'The original match stayed paused after startup');
  const rate = await Promise.all(peers.map(async ({page, processed}) => {
    const frameMs = (await page.evaluate(() => window.__lockstepFrameTimes)).sort((a, b) => a - b);
    return {
      fps: Number((150_000 / (processed.get(180) - processed.get(30))).toFixed(1)),
      medianMs: Math.round(frameMs[75]), p95Ms: Math.round(frameMs[142]),
    };
  }));
  const canvas = await first.evaluate(() => {
    const iframe = document.querySelector('#match-stage iframe');
    const canvas = iframe.contentDocument.querySelector('ruffle-player').shadowRoot.querySelector('canvas');
    return {width: canvas.width, height: canvas.height, displayedWidth: Math.round(iframe.getBoundingClientRect().width * devicePixelRatio)};
  });
  console.log(JSON.stringify({dpr, rate, canvas}));
  assert.ok(canvas.width >= 700, 'Default rendering fell below the stock stage width');
  if (values['min-fps']) assert.ok(rate.every(peer => peer.fps >= Number(values['min-fps'])), 'Match FPS fell below its minimum');
  if (values['test-reconnect']) {
    const waitForRecovery = async () => {
      await Promise.all(peers.map(({page}) => page.waitForFunction(() =>
        /对战中 · P[1-4]/.test(document.querySelector('#match-status').textContent) ||
        ['error', 'ended'].includes(document.querySelector('.game-loader').dataset.phase), null, {timeout: 72_000})));
      for (const {page, errors, handshake} of peers) assert.match(await page.locator('#match-status').textContent(),
        /对战中 · P[1-4]/, JSON.stringify({errors: errors.slice(-7), handshake}));
    };
    const originalUrl = second.url();
    await second.context().setOffline(true);
    await second.evaluate(() => window.__lockstepSocket.close());
    await first.getByRole('heading', {name: '正在重连'}).waitFor();
    await second.context().setOffline(false);
    await waitForRecovery();
    const initial = await second.evaluate(() => window.bombItInitialState);
    await second.reload({waitUntil: 'domcontentloaded'});
    assert.equal(second.url(), originalUrl);
    try { await waitForRecovery(); }
    catch (error) {
      const reloaded = await second.evaluate(() => window.bombItInitialState);
      const components = initial?.map((value, index) => JSON.stringify(value) !== JSON.stringify(reloaded?.[index]) ? index : null);
      console.log(JSON.stringify({differences: components, initialClock: initial?.[1], reloadedClock: reloaded?.[1],
        original: peers[0].handshake, reloaded: peers[1].handshake,
        match: [...peers[0].acks].slice(0, 4), other: [...peers[1].acks].slice(0, 4)}));
      throw error;
    }
    const confirmed = Math.max(...peers[0].acks.keys()) + 60;
    const deadline = performance.now() + 15_000;
    while (!peers.every(peer => peer.acks.has(confirmed)) && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(peers[0].acks.has(confirmed), 'Match stopped after reconnect');
    for (const peer of peers.slice(1)) assert.equal(peer.acks.get(confirmed), peers[0].acks.get(confirmed));
    console.log(`Transport disconnect and reload recovered seat P${seats[1] + 1}, matching frame ${confirmed}.`);
  }
  if (values['test-rematch']) {
    const rematch = page => page.getByRole('button', {name: '再来一局', exact: true});
    await Promise.all(peers.map(({page}) => rematch(page).waitFor({timeout: 270_000})));
    const previousGame = await first.locator('.game-loader__detail').textContent();
    assert.match(previousGame, /(?:P[1-4] 获胜|平局) · 第 \d+ 帧已结算/);
    await rematch(first).click();
    await second.locator('.game-loader__detail').filter({hasText: `再开投票 1/${playerCount}`}).waitFor();
    const priorUrls = peers.map(({page}) => page.url());
    await Promise.all(peers.slice(1).map(({page}) => rematch(page).click()));
    await Promise.all(peers.map(({page}) => page.locator('#match-status').filter({hasText: /对战中 · P[1-4]/})
      .waitFor({timeout: 105_000})));
    assert.deepEqual(peers.map(({page}) => page.url()), priorUrls);
    console.log(`Native game finished (${previousGame}) and the same ${playerCount} seats entered the next round.`);
  }
  await first.locator('#match-return').click();
  await Promise.all(peers.slice(1).map(async ({page}) => {
    await page.locator('.game-loader__detail').filter({hasText: '有玩家返回了房间'}).waitFor();
    await page.locator('#match-return').click();
  }));
  await Promise.all(peers.map(({page}) => page.locator('[data-action="leave"]').click()));
  const reentry = await first.context().newPage();
  await reentry.route('**' + ORIGINAL_SWF_PATH, route => route.abort());
  await reentry.goto(url.href);
  const cached = await reentry.evaluate(async () => {
    const {downloadOriginalSwf} = await import('/bomb-it-7/original-file.mjs');
    const phases = [];
    const bytes = await downloadOriginalSwf({onProgress: ({phase}) => phases.push(phase)});
    return {size: bytes.byteLength, phases};
  });
  assert.deepEqual(cached, {size: ORIGINAL_SWF_BYTES, phases: ['cache', 'cache']});
  console.log(JSON.stringify({passed: true, runtime: 'Bomb It 7 SWF', playerCount, startupMs, confirmedFrame: 180, cachedReentry: true, volume: 0.5}));
} finally {
  await browser?.close();
  await app?.close();
}
