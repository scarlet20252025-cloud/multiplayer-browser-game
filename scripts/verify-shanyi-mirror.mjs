#!/usr/bin/env node
/**
 * Authored acceptance for the Shanyi mirror-input tier:
 * lobby card -> room vote -> relay session -> Ruffle page boots -> menu reacts.
 * Loopback only; the original package stays in the private games root.
 */
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {chromium} from 'playwright';
import {WebSocket} from 'ws';
import {startGameLobby} from './start-game-lobby.mjs';

const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const GAMES=process.env.HTML5_GAMES_ROOT||
  'E:/肥鱼不乐园/flash-archive/02-fireboy-watergirl/html5-online/games';
const VIEWER_PORT=Number(process.env.E2E_SHANYI_VIEWER_PORT||8797);
const LOBBY_PORT=Number(process.env.E2E_SHANYI_LOBBY_PORT||8798);
const PASSWORD='pass1234';
const ROOM='闪翼验收-'+Date.now().toString(36);

function assert(condition,message){
  if(!condition)throw Error(message);
}
async function fetchJson(url,options={}){
  const response=await fetch(url,{...options,
    headers:{'content-type':'application/json',...(options.headers??{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(url+' -> '+response.status+' '+(body.message||body.error||''));
  return body;
}
function open(url){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url);
    ws.messages=[];
    ws.on('message',data=>{
      try{ws.messages.push(JSON.parse(data.toString()));}catch{}
    });
    ws.once('open',()=>resolve(ws));
    ws.once('error',reject);
  });
}
function next(ws,type,limit=15000,predicate=null){
  return new Promise((resolve,reject)=>{
    const end=Date.now()+limit;
    const tick=()=>{
      const index=ws.messages.findIndex(message=>
        message.type===type&&(!predicate||predicate(message)));
      if(index>=0)return resolve(ws.messages.splice(index,1)[0]);
      if(Date.now()>end)return reject(Error('timeout waiting for '+type));
      setTimeout(tick,40);
    };
    tick();
  });
}

const app=await (async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'shanyi-e2e-'));
  const started=await startGameLobby({
    root:GAMES,viewerPort:VIEWER_PORT,lobbyPort:LOBBY_PORT,
    roomsFile:path.join(temporary,'rooms.json'),
  });
  return {app:started,temporary};
})();
let browser=null;
try{
  const lobby=app.app;
  const shanyi=lobby.catalog.find(game=>game.id==='shanyi');
  assert(shanyi,'shanyi missing from lobby catalog');
  console.log('[e2e] catalog',lobby.catalog.map(game=>game.id+':'+game.runtime));

  const created=await fetchJson(lobby.roomServiceUrl+'/api/rooms',{method:'POST',
    body:JSON.stringify({name:ROOM,password:PASSWORD,gameId:'shanyi'})});
  const joined=await fetchJson(lobby.roomServiceUrl+'/api/rooms/join',{method:'POST',
    body:JSON.stringify({name:ROOM,password:PASSWORD})});
  assert(created.seat!==joined.seat,'seats must differ');
  const wsA=await open(lobby.lobbyWsUrl+'?token='+created.token);
  const wsB=await open(lobby.lobbyWsUrl+'?token='+joined.token);
  const welcomeA=await next(wsA,'welcome');
  await next(wsB,'welcome');
  assert(welcomeA.games.some(game=>game.id==='shanyi'&&game.experimental===true),
    'welcome catalog must expose the experimental Shanyi card');

  wsA.send(JSON.stringify({type:'select-game',gameId:'shanyi'}));
  await next(wsA,'state',15000,message=>message.room?.gameId==='shanyi'&&
    message.room?.bothConnected===true);
  wsA.send(JSON.stringify({type:'propose-level',gameId:'shanyi',levelId:1}));
  const proposal=await next(wsA,'state',15000,message=>message.room?.proposal!=null);
  assert(proposal.room.proposal?.gameId==='shanyi','level proposal missing');
  wsB.send(JSON.stringify({type:'confirm-level',proposalId:proposal.room.proposal.id}));
  const startA=await next(wsA,'session-start',30000);
  const startB=await next(wsB,'session-start',30000);
  assert(startA.session.entryPath==='/shanyi/index.html','unexpected entry path');
  assert(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(startA.session.wsUrl),'relay url invalid');
  console.log('[e2e] session started',{entry:startA.session.entryPath,level:startA.session.levelId});

  const relayBase=startA.session.wsUrl+'?token='+startA.session.token;
  const seatA=await open(relayBase+'&seat=0');
  const seatB=await open(relayBase+'&seat=1');
  await next(seatA,'welcome');
  await next(seatB,'welcome');
  seatA.send(JSON.stringify({type:'input',code:68,down:true}));
  const relayed=await next(seatB,'peer-input');
  assert(relayed.code===68&&relayed.down===true,'input relay payload invalid');
  seatA.close();seatB.close();
  console.log('[e2e] input relay verified');

  browser=await chromium.launch({args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1100,height:800}});
  const logs=[];
  page.on('pageerror',error=>logs.push('PAGEERROR '+error.message));
  page.on('console',message=>{
    if(message.type()==='error')logs.push('CONSOLE '+message.text());
  });
  const query=new URLSearchParams({
    room:ROOM,game:'shanyi',level:String(startA.session.levelId),
    ws:startA.session.wsUrl,token:startA.session.token,seat:'0',
  });
  await page.goto(lobby.url.replace(/\/$/,'')+startA.session.entryPath+'?'+query.toString(),
    {waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>
    window.__shanyi&&typeof window.__shanyi.queryPage==='function',null,{timeout:120000});
  let pageClass='';
  for(let attempt=0;attempt<60;attempt++){
    pageClass=await page.evaluate(()=>window.__shanyi.queryPage());
    if(pageClass&&pageClass.includes('MainPage'))break;
    await page.waitForTimeout(1000);
  }
  assert(pageClass&&pageClass.includes('MainPage'),'menu did not reach MainPage: '+pageClass);
  console.log('[e2e] Ruffle menu ready',pageClass);

  const box=await page.locator('canvas').first().boundingBox();
  assert(box&&box.width>200,'canvas missing');
  const clickX=box.x+(557/800)*box.width;
  const clickY=box.y+(458/600)*box.height;
  let afterStart=pageClass;
  for(let attempt=0;attempt<6;attempt++){
    await page.mouse.click(clickX,clickY,{delay:80});
    await page.waitForTimeout(1800);
    afterStart=await page.evaluate(()=>window.__shanyi.queryPage());
    if(afterStart&&!afterStart.includes('MainPage'))break;
  }
  assert(afterStart&&!afterStart.includes('MainPage'),
    'start button did not leave MainPage: '+afterStart);
  console.log('[e2e] start click relayed into game',afterStart);

  const artifacts=path.join(REPO_ROOT,'local','tmp','shanyi-launcher','artifacts');
  await mkdir(artifacts,{recursive:true});
  await page.screenshot({path:path.join(artifacts,'prod_lobby_shanyi.png')});
  console.log(JSON.stringify({ok:true,room:ROOM,entry:startA.session.entryPath,
    pageClass:afterStart,browserErrors:logs.slice(0,5)},null,2));
}finally{
  await browser?.close().catch(()=>{});
  await app.app.close().catch(()=>{});
  await rm(app.temporary,{recursive:true,force:true}).catch(()=>{});
}
