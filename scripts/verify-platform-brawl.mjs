import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright';
import {WebSocket} from 'ws';
import {startGameLobby} from './start-game-lobby.mjs';
import {BRAWL_SOCKET, SCORE_TO_WIN} from '../public/platform-brawl/rules.mjs';

const requestedOrigin = process.argv.slice(2).find(arg=>arg.startsWith('http'));
const capture = process.argv.find(arg=>arg.startsWith('--capture='))?.slice(10);
const scratch = requestedOrigin ? null : await mkdtemp(path.join(os.tmpdir(), 'platform-brawl-'));
const roomName = 'Brawl-QA-' + Date.now().toString(36);
const password = 'brawl-' + Date.now().toString(36);
let app, browser;
const players = [];
const pageErrors = [];

async function until(read, explanation, timeout=8_000){
  const deadline = performance.now() + timeout;
  do{
    const value = read();
    if(value) return value;
    await sleep(25);
  }while(performance.now() < deadline);
  throw Error(explanation);
}

async function player(options){
  const page = await browser.newPage(options);
  const client = {page, seat:null, state:null, snapshots:0, routes:new Set()};
  players.push(client);
  page.on('pageerror',error=>pageErrors.push(error.name));
  page.on('websocket',socket=>{
    const endpoint = new URL(socket.url());
    if(endpoint.pathname!==BRAWL_SOCKET)return;
    client.routes.add(endpoint.origin);
    socket.on('framereceived',({payload})=>{
      const packet = JSON.parse(payload.toString());
      if(packet.type==='seat')client.seat=packet.seat;
      if(packet.type==='brawl'){
        client.state=packet;
        client.origin=endpoint.origin;
        client.snapshots++;
      }
    });
  });
  return client;
}

const fighter = (client, seat=client.seat)=>client.state?.players.find(item=>item.seat===seat);

async function pushRight(client, destination){
  await client.page.bringToFront();
  await client.page.keyboard.down('d');
  try{
    await until(()=>fighter(client)?.x>=destination,'The fighter did not reach the edge');
  }finally{
    await client.page.keyboard.up('d');
  }
  await until(()=>Math.abs(fighter(client)?.vx)<6,'The fighter did not stop');
}

function rejectForeignOrigin(origin){
  const endpoint = new URL(BRAWL_SOCKET,origin);
  endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';
  return new Promise((resolve,reject)=>{
    const socket = new WebSocket(endpoint, {origin:'http://127.0.0.1:1',handshakeTimeout:3000});
    socket.once('unexpected-response',(_,response)=>{
      response.resume();
      socket.terminate();
      if(response.statusCode===403)resolve();
      else reject(Error('A foreign origin did not receive 403'));
    });
    socket.once('open',()=>{
      socket.close();
      reject(Error('An unauthenticated foreign socket was accepted'));
    });
    socket.once('error',reject);
  });
}

async function leave(client, origin){
  try{
    if(new URL(client.page.url()).pathname==='/platform-brawl/index.html'){
      const link=client.page.locator('a[href^="/?room="], #return').first();
      if(await link.isVisible())await link.click({timeout:1400});
    }
    if(new URL(client.page.url()).origin===origin){
      const exit=client.page.locator('[data-action="leave"]');
      if(await exit.isVisible())await exit.click({timeout:1400});
    }
  }catch{}
}

let origin;
try{
  if(scratch){
    const manifestsDir=path.join(scratch,'games');
    await mkdir(manifestsDir);
    const manifest=JSON.parse(await readFile(new URL('../config/games/platform-brawl.json',import.meta.url),'utf8'));
    await writeFile(path.join(manifestsDir,'platform-brawl.json'),JSON.stringify({...manifest,listed:true}));
    app=await startGameLobby({root:scratch,manifestsDir,viewerPort:19928,lobbyPort:19929,
      roomsFile:path.join(scratch,'rooms.json')});
  }
  origin = new URL(requestedOrigin??app.url).origin;
  const proxyArgs=process.argv.includes('--direct')
    ?['--proxy-server=direct://','--proxy-bypass-list='+new URL(origin).hostname]:[];
  browser = await chromium.launch({args:proxyArgs});
  const first = await player({viewport:{width:1360,height:850},hasTouch:true});
  const second = await player({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const response=await first.page.goto(origin,{waitUntil:'domcontentloaded'});
  assert.equal(response.status(),200);
  await first.page.locator('[data-action="focus-create"][data-game="platform-brawl"]').click();
  await first.page.locator('#create-name').fill(roomName);
  await first.page.locator('#create-password').fill(password);
  await first.page.locator('[data-action="create-room"]').click();
  await first.page.locator('.room-layout').waitFor();

  const invite = new URL(origin);
  invite.searchParams.set('room',roomName);
  await second.page.goto(invite.href,{waitUntil:'domcontentloaded'});
  await second.page.locator('#join-password').fill(password);
  await second.page.locator('[data-action="confirm-join"]').click();
  await second.page.locator('.room-layout').waitFor();
  await first.page.locator('[data-action="level"][data-game="platform-brawl"]:not(.disabled)').click();
  await second.page.locator('[data-action="confirm-level"]').click();
  await Promise.all(players.map(client=>until(()=>client.state?.phase==='playing'&&!client.state.paused,'The brawl did not start',15_000)));
  assert.deepEqual(players.map(client=>client.seat),[0,1]);
  const primary=new URL(origin.replace(/^http/,'ws'));
  const allowed=new Set([primary.origin]);
  const fallback={'8787':'8788','10011':'10012'}[primary.port];
  if(fallback){
    const alternate=new URL(primary);
    alternate.port=fallback;
    allowed.add(alternate.origin);
  }
  assert(players.every(client=>client.routes.has(primary.origin)&&allowed.has(client.origin)));
  await rejectForeignOrigin(origin);
  console.log(JSON.stringify({started:players.length,primaryAttempted:true,
    activePorts:players.map(client=>new URL(client.origin).port)}));
  await first.page.locator('.controls').waitFor();
  assert.equal(await first.page.locator('.match-touch:visible').count(),0);
  await second.page.locator('.match-touch--brawl').waitFor();
  await first.page.locator('#match-reactions summary').click();
  await first.page.locator('#match-reactions').getByRole('button',{name:'打得好'}).click();
  await second.page.locator('#match-reactions [role="status"]').filter({hasText:'P1 👏'}).waitFor();

  const roomRound = second.state.round;
  const beforeReload = second.snapshots;
  await second.page.reload({waitUntil:'domcontentloaded'});
  await until(()=>second.snapshots>beforeReload&&second.state?.phase==='playing'&&!second.state.paused,
    'Same-seat browser refresh did not resume the game');
  assert.equal(second.seat,1);
  assert.equal(second.state.round,roomRound);
  const dims=await second.page.evaluate(()=>[document.documentElement.clientWidth,document.documentElement.scrollWidth]);
  assert(dims[1]<=dims[0]+1,'Mobile brawl layout extends past the viewport');

  await until(()=>players.every(client=>fighter(client)?.active&&fighter(client)?.grounded&&!fighter(client)?.protected),
    'The fighters did not arrive on the opening roof');
  await pushRight(first,705);
  for(let score=1;score<=SCORE_TO_WIN;score++){
    await until(()=>fighter(first,1)?.active&&fighter(first,1)?.grounded&&!fighter(first,1)?.protected,
      'The opponent did not respawn');
    await pushRight(second,requestedOrigin?755:773);
    await first.page.bringToFront();
    await first.page.keyboard.press('k');
    if(capture&&score===1)await first.page.locator('canvas').screenshot({path:capture});
    await until(()=>fighter(first,0)?.score===score&&fighter(second,0)?.score===score,
      'A real shove did not produce the same scored ring-out for both clients');
  }
  await until(()=>players.every(client=>client.state?.phase==='result'&&client.state.winner===0),
    'Both players did not see the same result');
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({won:SCORE_TO_WIN,opponent:fighter(first,1).score,refreshedSameSeat:true,noPageErrors:true}));
}finally{
  if(origin)await Promise.allSettled(players.map(client=>leave(client,origin)));
  await browser?.close();
  await app?.close();
  if(scratch)await rm(scratch,{force:true,recursive:true});
}
