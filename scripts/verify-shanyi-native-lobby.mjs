#!/usr/bin/env node
/** 大厅 E2E：建 native 房 → 两席 session-start → 真实页面同步。 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {chromium} from 'playwright';
import {startGameLobby} from './start-game-lobby.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(REPO, 'config/games/shanyi-native.json');
const original = await readFile(manifest, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let app, browser;
const report = {status: 'blocked', checks: []};
try {
  await writeFile(manifest, JSON.stringify({...JSON.parse(original), listed: true}, null, 2) + '\n', 'utf8');
  app = await startGameLobby({root: 'E:/肥鱼不乐园/flash-archive/02-fireboy-watergirl/html5-online/games',
    viewerPort: 8901, lobbyPort: 8902,
    manifestsDir: path.join(REPO, 'config', 'games')});
  const api = app.lobbyUrl ?? 'http://127.0.0.1:8902';
  const lobbyUrl = app.lobbyWsUrl ?? api.replace(/^http/, 'ws') + '/lobby';
  const viewer = app.viewerUrl ?? 'http://127.0.0.1:8901';
  const name = '原生闪翼E2E', password = 'pass1234';
  const create = await fetch(api + '/api/rooms', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({name, password, gameId: 'shanyi-native'})});
  const created = await create.json();
  const join = await fetch(api + '/api/rooms/join', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({name, password})});
  const joined = await join.json();
  report.checks.push({name: 'room-created', status: create.status, body: created, joinStatus: join.status, joinBody: joined});
  if (create.status !== 200) throw Error('room create failed: ' + JSON.stringify(created));

  const connect = token => new Promise((resolve, reject) => {
    const ws = new WebSocket(lobbyUrl + '?token=' + token);
    const messages = [];
    ws.on('message', b => messages.push(JSON.parse(b.toString())));
    ws.once('open', () => resolve({ws, messages}));
    ws.once('error', reject);
  });
  const waitFor = async (client, predicate, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = client.messages.find(predicate);
      if (hit) return hit;
      await sleep(30);
    }
    throw Error('timeout waiting for lobby message');
  };
  const a = await connect(created.token);
  const b = await connect(joined.token);
  await waitFor(a, m => m.type === 'welcome');
  await waitFor(b, m => m.type === 'welcome');
  await waitFor(a, m => m.type === 'state' && m.room?.bothConnected);

  a.ws.send(JSON.stringify({type: 'select-game', gameId: 'shanyi-native'}));
  a.ws.send(JSON.stringify({type: 'propose-level', gameId: 'shanyi-native', levelId: 1}));
  const proposal = await waitFor(b, m => m.type === 'state' && m.room?.proposal);
  b.ws.send(JSON.stringify({type: 'confirm-level', proposalId: proposal.room.proposal.id}));
  const started = await waitFor(a, m => m.type === 'session-start');
  const session = started.session;
  report.checks.push({name: 'session-start', entryPath: session.entryPath, wsUrl: session.wsUrl, seat: session.seat});

  const urlFor = seat => `${viewer}${session.entryPath}?ws=${encodeURIComponent(session.wsUrl)}&seat=${seat}`;
  browser = await chromium.launch();
  const pages = [];
  for (const seat of [0, 1]) {
    const page = await browser.newPage({viewport: {width: 1000, height: 640}});
    page.on('pageerror', e => report.checks.push({name: 'pageerror', seat, message: e.message}));
    await page.goto(urlFor(seat));
    pages.push(page);
  }
  await sleep(2500);
  const ready = await pages[0].evaluate(() => Boolean(window.__native?.players?.length));
  report.checks.push({name: 'page-booted', ready});
  if (!ready) throw Error('native page did not boot');

  const before = await pages[0].evaluate(() => window.__native.players[0].hero.x);
  await pages[0].keyboard.down('KeyD');
  await sleep(900);
  await pages[0].keyboard.up('KeyD');
  await sleep(200);
  const after0 = await pages[0].evaluate(() => window.__native.players[0].hero.x);
  const after1 = await pages[1].evaluate(() => window.__native.players[0].hero.x);
  report.checks.push({name: 'sync', before: +before.toFixed(1), after0: +after0.toFixed(1), after1: +after1.toFixed(1)});
  report.status = after0 > before + 30 && Math.abs(after0 - after1) < 2 ? 'passed' : 'failed';
} catch (error) {
  report.error = String(error.stack || error);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  await writeFile(manifest, original, 'utf8');
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
