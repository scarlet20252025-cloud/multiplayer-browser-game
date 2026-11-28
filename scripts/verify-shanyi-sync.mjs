#!/usr/bin/env node
/**
 * Authored acceptance for Shanyi hero-state reconciliation:
 * both seats run the same level, keys are mirrored, and the remote hero is
 * corrected toward the owner's position. Loopback only; no video, no authority.
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
const VIEWER_PORT=Number(process.env.E2E_SHANYI_SYNC_VIEWER_PORT||8821);
const LOBBY_PORT=Number(process.env.E2E_SHANYI_SYNC_LOBBY_PORT||8822);
const PASSWORD='pass1234';
const ROOM='闪翼同步-'+Date.now().toString(36);

function assert(condition,message){
  if(!condition)throw Error(message);
}
function parseHero(raw){
  if(typeof raw!=='string')return null;
  const [x,y,vx,vy]=raw.split(',').map(Number);
  return [x,y,vx,vy].every(Number.isFinite)?{x,y,vx,vy}:null;
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
function next(ws,type,limit=20000,predicate=null){
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
async function enterLevel(page,label,log){
  const call=(name,...args)=>page.evaluate(({name,args})=>
    window.__shanyi.call(name,...args),{name,args});
  const pageClass=()=>page.evaluate(()=>window.__shanyi.queryPage());
  let menu='';
  for(let attempt=0;attempt<150;attempt++){
    menu=await pageClass();
    if(menu&&menu.includes('MainPage'))break;
    await page.waitForTimeout(800);
  }
  if(!menu.includes('MainPage'))throw Error(label+' menu did not load: '+menu);
  await call('shanyiClickAt',557,458);
  for(let attempt=0;attempt<6;attempt++){
    await page.waitForTimeout(1500);
    if(!(await pageClass()).includes('MainPage'))break;
    await call('shanyiClickAt',557,458);
  }
  log(label+' after start',await pageClass());
  for(let step=0;step<24;step++){
    if(!(await pageClass()).includes('IntroPage'))break;
    await call('shanyiClickAt',669,509);
    await page.waitForTimeout(1900);
  }
  const final=await pageClass();
  if(!final.includes('Level'))throw Error(label+' did not reach a level: '+final);
  log(label+' level',final);
  return {call,pageClass};
}

const temporary=await mkdtemp(path.join(os.tmpdir(),'shanyi-sync-'));
let started=null,browser=null;
try{
  started=await startGameLobby({
    root:GAMES,viewerPort:VIEWER_PORT,lobbyPort:LOBBY_PORT,
    roomsFile:path.join(temporary,'rooms.json'),
  });
  const created=await fetchJson(started.roomServiceUrl+'/api/rooms',{method:'POST',
    body:JSON.stringify({name:ROOM,password:PASSWORD,gameId:'shanyi'})});
  const joined=await fetchJson(started.roomServiceUrl+'/api/rooms/join',{method:'POST',
    body:JSON.stringify({name:ROOM,password:PASSWORD})});
  const wsA=await open(started.lobbyWsUrl+'?token='+created.token);
  const wsB=await open(started.lobbyWsUrl+'?token='+joined.token);
  await next(wsA,'welcome');
  await next(wsB,'welcome');
  wsA.send(JSON.stringify({type:'select-game',gameId:'shanyi'}));
  await next(wsA,'state',20000,message=>message.room?.gameId==='shanyi'&&
    message.room?.bothConnected===true);
  wsA.send(JSON.stringify({type:'propose-level',gameId:'shanyi',levelId:1}));
  const proposal=await next(wsA,'state',20000,message=>message.room?.proposal!=null);
  wsB.send(JSON.stringify({type:'confirm-level',proposalId:proposal.room.proposal.id}));
  const startA=await next(wsA,'session-start',30000);
  const startB=await next(wsB,'session-start',30000);
  wsA.close();wsB.close();

  browser=await chromium.launch({args:['--enable-unsafe-swiftshader']});
  const makePage=async seat=>{
    const session=seat===0?startA.session:startB.session;
    const page=await browser.newPage({viewport:{width:1600,height:900}});
    const errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    page.on('console',message=>{
      if(message.type()==='error')errors.push(message.text());
    });
    const query=new URLSearchParams({
      room:ROOM,game:'shanyi',level:String(session.levelId),
      ws:session.wsUrl,token:session.token,seat:String(seat),
    });
    await page.goto(started.url.replace(/\/$/,'')+session.entryPath+'?'+query.toString(),
      {waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__shanyi&&
      typeof window.__shanyi.queryPage==='function',null,{timeout:150000});
    page.errors=errors;
    return page;
  };
  const [pageA,pageB]=await Promise.all([makePage(0),makePage(1)]);
  const logs=[];
  const log=(...args)=>{
    const line=args.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' ');
    logs.push(line);console.log(line);
  };
  log('seat0',await pageA.evaluate(()=>window.__shanyi.queryPage()).catch(()=>''),
    'seat1',await pageB.evaluate(()=>window.__shanyi.queryPage()).catch(()=>''));
  await pageA.bringToFront();
  await enterLevel(pageA,'A',log);
  await pageB.bringToFront();
  await enterLevel(pageB,'B',log);
  log('waiting level build');
  await pageA.waitForTimeout(22000);

  const read=async(page,seat)=>{
    const raw=await page.evaluate(({seat})=>window.__shanyi.call('shanyiHeroState',seat),{seat});
    return parseHero(raw);
  };
  const snapshot=async()=>{
    const [fireA,iceA,fireB,iceB]=await Promise.all([
      read(pageA,0),read(pageA,1),read(pageB,0),read(pageB,1),
    ]);
    return {fireA,iceA,fireB,iceB};
  };
  const keys=async(page)=>page.evaluate(()=>window.__shanyi.call('shanyiKeys'));

  let settledFrames=0,lastFire=null;
  for(let attempt=0;attempt<30;attempt++){
    const fire=await read(pageA,0);
    if(lastFire&&fire&&Math.abs(fire.x-lastFire.x)<1&&Math.abs(fire.y-lastFire.y)<1)
      settledFrames++;
    else settledFrames=0;
    lastFire=fire;
    if(settledFrames>=2)break;
    await pageA.waitForTimeout(800);
  }
  const box=await pageA.locator('canvas').first().boundingBox();
  assert(box&&box.width>800&&box.height>600,
    'Ruffle canvas did not fill the viewport: '+JSON.stringify(box));

  await pageA.bringToFront();
  await pageA.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await pageA.waitForTimeout(300);
  const pre=await snapshot();
  log('pre',pre);
  assert(pre.fireA&&pre.fireB&&pre.iceA&&pre.iceB,'hero state bridge unavailable');

  await pageA.bringToFront();
  await pageA.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(700);
  const foreignA={keys:await keys(pageA),state:await snapshot()};
  await pageA.keyboard.up('ArrowRight');
  assert(foreignA.keys==='none','seat0 leaked a foreign control key into Ruffle: '+JSON.stringify(foreignA));
  await pageB.bringToFront();
  await pageB.keyboard.down('KeyD');
  await pageB.waitForTimeout(700);
  const foreignB={keys:await keys(pageB),state:await snapshot()};
  await pageB.keyboard.up('KeyD');
  assert(foreignB.keys==='none','seat1 leaked a foreign control key into Ruffle: '+JSON.stringify(foreignB));
  log('foreign key isolation',{a:foreignA.keys,b:foreignB.keys});

  await pageA.bringToFront();
  await pageA.keyboard.down('KeyD');
  await pageA.waitForTimeout(1200);
  const duringFire=await snapshot();
  const keysFire={a:await keys(pageA),b:await keys(pageB)};
  await pageA.keyboard.up('KeyD');
  assert(keysFire.a.includes('68')&&keysFire.b.includes('68'),
    'fire key was not mirrored: '+JSON.stringify(keysFire));
  assert(duringFire.fireA.x-pre.fireA.x>10&&duringFire.fireB.x-pre.fireB.x>10,
    'fire hero did not move in both seats: '+JSON.stringify({pre,duringFire,keysFire}));
  assert(Math.abs(duringFire.fireA.x-duringFire.fireB.x)<20,
    'fire hero diverged during movement: '+JSON.stringify(duringFire));
  assert(Math.abs(duringFire.iceA.x-pre.iceA.x)<10&&
    Math.abs(duringFire.iceB.x-pre.iceB.x)<10,'ice hero moved from a fire key');
  await pageA.waitForTimeout(1200);
  const settledFire=await snapshot();
  assert(Math.abs(settledFire.fireA.x-settledFire.fireB.x)<8&&
    Math.abs(settledFire.iceA.x-settledFire.iceB.x)<8,
    'heroes did not settle together: '+JSON.stringify(settledFire));

  await pageB.bringToFront();
  await pageB.keyboard.down('ArrowRight');
  await pageB.waitForTimeout(1200);
  const duringIce=await snapshot();
  const keysIce={a:await keys(pageA),b:await keys(pageB)};
  await pageB.keyboard.up('ArrowRight');
  assert(keysIce.a.includes('39')&&keysIce.b.includes('39'),
    'ice key was not mirrored: '+JSON.stringify(keysIce));
  assert(duringIce.iceA.x-settledFire.iceA.x>10&&
    duringIce.iceB.x-settledFire.iceB.x>10,
    'ice hero did not move in both seats: '+JSON.stringify({settledFire,duringIce,keysIce}));
  assert(Math.abs(duringIce.iceA.x-duringIce.iceB.x)<20,
    'ice hero diverged during movement: '+JSON.stringify(duringIce));
  await pageB.waitForTimeout(1200);
  const settledIce=await snapshot();
  assert(Math.abs(settledIce.fireA.x-settledIce.fireB.x)<8&&
    Math.abs(settledIce.iceA.x-settledIce.iceB.x)<8,
    'heroes did not settle together after ice movement: '+JSON.stringify(settledIce));

  const buttonText=String(await pageA.evaluate(()=>window.__shanyi.call('shanyiButtons')));
  log('buttons',buttonText);
  const pauseLine=buttonText.split('\n').find(line=>
    line.includes('vis=true')&&line.includes('pauseButton'));
  assert(pauseLine,'pause button was not exposed: '+buttonText);
  const pauseMatch=/@(-?\d+),(-?\d+) (\d+)x(\d+)/.exec(pauseLine);
  assert(pauseMatch,'pause button bounds invalid: '+pauseLine);
  const pauseStageX=Number(pauseMatch[1])+Number(pauseMatch[3])/2;
  const pauseStageY=Number(pauseMatch[2])+Number(pauseMatch[4])/2;
  log('pause button',{pauseLine,pauseStageX,pauseStageY});
  await pageA.mouse.click(box.x+(pauseStageX/800)*box.width,
    box.y+(pauseStageY/600)*box.height,{delay:60});
  await pageA.waitForTimeout(900);
  const pausedA=await pageA.evaluate(()=>window.__shanyi.call('shanyiPaused'));
  const pausedB=await pageB.evaluate(()=>window.__shanyi.call('shanyiPaused'));
  assert(pausedA.includes('paused=true')&&pausedB.includes('paused=true'),
    'pause did not mirror: '+JSON.stringify({pausedA,pausedB}));
  await pageA.mouse.click(box.x+box.width/2,box.y+box.height/2,{delay:60});
  await pageA.waitForTimeout(2200);
  const resumedA=await pageA.evaluate(()=>window.__shanyi.call('shanyiPaused'));
  const resumedB=await pageB.evaluate(()=>window.__shanyi.call('shanyiPaused'));
  assert(resumedA.includes('paused=false')&&resumedB.includes('paused=false')&&
    resumedA.includes('overlay=false')&&resumedB.includes('overlay=false'),
    'resume did not mirror: '+JSON.stringify({resumedA,resumedB}));
  log('pause/resume mirrored',{pausedA,pausedB,resumedA,resumedB});

  const artifacts=path.join(REPO_ROOT,'local','tmp','shanyi-launcher','artifacts');
  await mkdir(artifacts,{recursive:true});
  await pageA.screenshot({path:path.join(artifacts,'sync_seat0.png')});
  await pageB.screenshot({path:path.join(artifacts,'sync_seat1.png')});
  log('errors',{a:pageA.errors.slice(0,5),b:pageB.errors.slice(0,5)});
  console.log(JSON.stringify({ok:true,room:ROOM,canvas:{width:box.width,height:box.height},
    pre,duringFire,settledFire,duringIce,settledIce,
    errors:{a:pageA.errors.slice(0,5),b:pageB.errors.slice(0,5)}},null,2));
}finally{
  await browser?.close().catch(()=>{});
  await started?.close().catch(()=>{});
  await rm(temporary,{recursive:true,force:true}).catch(()=>{});
}