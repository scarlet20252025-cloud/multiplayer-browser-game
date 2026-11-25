import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {WebSocket} from 'ws';
import {startRoomLobby} from '../server/room-lobby.mjs';
import {startHtml5ResearchHost} from './html5-research-host.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'lobby-resume-'));
const viewerPort = 18987;
const lobbyPort = viewerPort + 1;
const origin = `http://127.0.0.1:${viewerPort}`;
const name = '刷新验收房';
const password = 'playtest';
const invite = `${origin}/?room=${encodeURIComponent(name)}`;
const catalog = [{id:'test', title:'双人对局', dir:'test', serveRoot:temporary, runtime:'html5-external',
  entryPath:'/test/index.html', levels:[{id:1, order:0, type:'battle', time:null}]}];
const socketPath = `ws://127.0.0.1:${lobbyPort}/lobby`;
const primarySocketPath = `ws://127.0.0.1:${viewerPort}/lobby`;
const seatToken = page => page.evaluate(name => JSON.parse(sessionStorage.getItem('fb-lobby-token:' + name)), name);
const pageErrors = [];
let lobby, viewer, browser;

function startLobby(){
  return startRoomLobby({port:lobbyPort, viewerOrigin:origin, catalog,
    roomsFile:path.join(temporary, 'rooms.json')});
}
async function welcome(page){
  await page.locator('[data-action="save-profile"]').click();
}
async function join(page){
  await page.locator('#join-password').fill(password);
  await page.locator('[data-action="confirm-join"]').click();
  await page.locator('.room-layout').waitFor();
}
async function bothOnline(page){
  await page.waitForFunction(() => document.querySelectorAll('.seat-pill.on').length === 2);
}

try {
  await mkdir(path.join(temporary, 'test'));
  await writeFile(path.join(temporary, 'test/index.html'), '<!doctype html><title>Lobby fixture</title>');
  lobby = await startLobby();
  viewer = await startHtml5ResearchHost({root:temporary, games:catalog, port:viewerPort,
    lobbyWsUrl:lobby.lobbyWsUrl, lobbyHttpHandler:(req,res)=>lobby.handleHttp(req,res),
    arenaViewerUpgrade:(...args)=>lobby.handleArenaViewerUpgrade(...args)});
  await new Promise((resolve,reject)=>{
    const badOrigin=new WebSocket(primarySocketPath,{origin:'http://127.0.0.1:18700'});
    badOrigin.once('error',error=>{
      if(error.message.includes('403'))resolve();
      else reject(error);
    });
    badOrigin.once('open',()=>{badOrigin.terminate();reject(Error('Mismatched origin was admitted'));});
  });
  browser = await chromium.launch();
  const first = await browser.newPage();
  const second = await browser.newPage();
  const firstSockets=new Set();
  first.on('websocket',socket=>{
    const endpoint=new URL(socket.url());
    if(endpoint.pathname==='/lobby')firstSockets.add(endpoint.port);
  });
  for(const page of [first, second]){
    page.setDefaultTimeout(12_000);
    page.on('pageerror', error => pageErrors.push(error.message));
  }
  await first.goto(origin);
  await welcome(first);
  await first.locator('[data-action="focus-create"][data-game="test"]').click();
  await first.locator('#create-name').fill(name);
  await first.locator('#create-password').fill(password);
  await first.locator('[data-action="create-room"]').click();
  await first.locator('.room-layout').waitFor();
  await second.goto(invite);
  await welcome(second);
  await join(second);
  await bothOnline(first);
  const saved = await Promise.all([first, second].map(seatToken));
  assert.deepEqual(saved.map(entry => entry.seat), [0, 1]);
  assert.deepEqual([...firstSockets],[String(viewerPort)]);

  await Promise.all([first.reload(), second.reload()]);
  await Promise.all([bothOnline(first), bothOnline(second)]);
  assert.deepEqual(await Promise.all([first, second].map(seatToken)), saved);
  assert.match(await first.locator('.seat-0').innerText(), /（你）/);
  assert.match(await second.locator('.seat-1').innerText(), /（你）/);
  console.log('Both browsers recovered their original seats after refreshing');

  // Park the browsers so their tabs keep sessionStorage without reconnecting
  // until the fresh lobby process has loaded the same persistent room records.
  await Promise.all([first.goto('about:blank'), second.goto('about:blank')]);
  await lobby.close();
  lobby = undefined;
  lobby = await startLobby();
  await Promise.all([first.goto(invite), second.goto(invite)]);
  await Promise.all([first, second].map(page => page
    .getByText('房间凭证已失效，请输入密码重新加入。', {exact:true}).waitFor()));
  assert.deepEqual(await Promise.all([first, second].map(seatToken)), [null, null]);
  await join(first);
  await join(second);
  await bothOnline(first);
  const renewed = await Promise.all([first, second].map(seatToken));
  assert.notEqual(renewed[0].token, saved[0].token);
  assert.notEqual(renewed[1].token, saved[1].token);
  console.log('After a lobby restart both browsers cleared expired credentials and rejoined by password');

  const socketRoute = `${socketPath}?*`;
  let stall = false, primaryAttempts=0, fallbackAttempts=0;
  await first.routeWebSocket(`${primarySocketPath}?*`,()=>{primaryAttempts++;});
  await first.routeWebSocket(socketRoute, route => {
    fallbackAttempts++;
    if(!stall)route.connectToServer();
  });
  await first.reload();
  await bothOnline(first);
  assert.deepEqual(await seatToken(first),renewed[0]);
  assert.equal(primaryAttempts,1);
  assert.equal(fallbackAttempts,1);
  console.log('A stalled same-origin lobby socket fell back to the legacy port with the original seat');

  stall=true;
  await first.reload();
  await first.getByText('连接大厅超时，请重试。', {exact:true}).waitFor();
  assert.deepEqual(await seatToken(first), renewed[0]);
  stall = false;
  await first.locator('[data-action="retry-room-connection"]').click();
  await bothOnline(first);
  assert.deepEqual(await seatToken(first), renewed[0]);
  const plaza = await browser.newPage();
  plaza.setDefaultTimeout(12_000);
  plaza.on('pageerror', error => pageErrors.push(error.message));
  const catalogPaths = ['/api/games', '/api/rooms'];
  const failedReads = new Set();
  let outage = false;
  await plaza.route(url => catalogPaths.includes(url.pathname), async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin);
    assert.equal(route.request().headers()['content-type'], undefined);
    if (!outage) return route.continue();
    failedReads.add(url.pathname);
    return route.abort('connectionreset');
  });
  await plaza.goto(origin);
  await welcome(plaza);
  await plaza.locator('.catalog-room').getByText(name, {exact:true}).waitFor();

  outage = true;
  await plaza.reload();
  await plaza.getByText('暂时无法更新大厅，正在自动重试。', {exact:true}).waitFor();
  await plaza.locator('.catalog-game').getByText('双人对局', {exact:true}).waitFor();
  await plaza.locator('.catalog-room').getByText(name, {exact:true}).waitFor();
  assert.deepEqual([...failedReads].sort(), catalogPaths);
  outage = false;
  await plaza.locator('.catalog-connection').waitFor({state:'hidden'});
  console.log('Same-origin plaza kept its catalog and rooms through failed reads and automatically recovered');
  assert.deepEqual(pageErrors, []);
  console.log('A stalled socket timed out and manual retry restored the same seat');
} finally {
  await browser?.close();
  await viewer?.close();
  await lobby?.close();
  await rm(temporary, {recursive:true, force:true});
}
