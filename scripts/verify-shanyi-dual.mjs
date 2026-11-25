#!/usr/bin/env node
/**
 * Authored acceptance for two simultaneous Shanyi mirror instances:
 * lobby handshake -> two Ruffle tabs -> both reach the menu -> a start click
 * on seat 0 is injected on seat 1. Loopback only; no video, no authority.
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
const VIEWER_PORT=Number(process.env.E2E_SHANYI_DUAL_VIEWER_PORT||8799);
const LOBBY_PORT=Number(process.env.E2E_SHANYI_DUAL_LOBBY_PORT||8800);
const PASSWORD='pass1234';
const ROOM='闪翼双端-'+Date.now().toString(36);

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
async function waitMenu(page,label){
  await page.waitForFunction(()=>
    window.__shanyi&&typeof window.__shanyi.queryPage==='function',null,{timeout:150000});
  let pageClass='';
  for(let attempt=0;attempt<90;attempt++){
    pageClass=await page.evaluate(()=>window.__shanyi.queryPage());
    if(pageClass&&pageClass.includes('MainPage'))return pageClass;
    await page.waitForTimeout(1000);
  }
  throw Error(label+' menu did not reach MainPage: '+pageClass);
}

const temporary=await mkdtemp(path.join(os.tmpdir(),'shanyi-dual-'));
let started=null,browser=null;
try{
  started=await startGameLobby({
    root:GAMES,viewerPort:VIEWER_PORT,lobbyPort:LOBBY_PORT,
    roomsFile:path.join(temporary,'rooms.json'),
  });
  const shanyi=started.catalog.find(game=>game.id==='shanyi');
  assert(shanyi,'shanyi missing from lobby catalog');

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
  assert(startA.session.entryPath==='/shanyi/index.html','unexpected entry path');
  console.log('[dual] session started',{level:startA.session.levelId});

  browser=await chromium.launch({args:['--enable-unsafe-swiftshader']});
  const errors={a:[],b:[]};
  const makePage=seat=>{
    const session=seat===0?startA.session:startB.session;
    return browser.newPage({viewport:{width:1600,height:900}}).then(page=>{
      page.on('pageerror',error=>errors[seat===0?'a':'b'].push('PAGEERROR '+error.message));
      page.on('console',message=>{
        if(message.type()==='error')
          errors[seat===0?'a':'b'].push('CONSOLE '+message.text());
      });
      const query=new URLSearchParams({
        room:ROOM,game:'shanyi',level:String(session.levelId),
        ws:session.wsUrl,token:session.token,seat:String(seat),
      });
      return page.goto(started.url.replace(/\/$/,'')+session.entryPath+'?'+query.toString(),
        {waitUntil:'domcontentloaded'}).then(()=>page);
    });
  };
  const [pageA,pageB]=await Promise.all([makePage(0),makePage(1)]);
  await pageA.bringToFront();
  const menuA=await waitMenu(pageA,'seat0');
  console.log('[dual] seat0 menu ready',menuA);
  await pageB.bringToFront();
  const menuB=await waitMenu(pageB,'seat1');
  console.log('[dual] seat1 menu ready',menuB);

  const visibility={a:await pageA.evaluate(()=>document.visibilityState),
    b:await pageB.evaluate(()=>document.visibilityState)};
  console.log('[dual] visibility',visibility);

  const box=await pageA.locator('canvas').first().boundingBox();
  assert(box&&box.width>800&&box.height>600,
    'seat0 canvas is not responsive: '+JSON.stringify(box));
  const clickX=box.x+(557/800)*box.width;
  const clickY=box.y+(458/600)*box.height;
  let afterA=menuA;
  for(let attempt=0;attempt<6&&afterA?.includes('MainPage');attempt++){
    await pageA.mouse.click(clickX,clickY,{delay:80});
    await pageA.waitForTimeout(1800);
    afterA=await pageA.evaluate(()=>window.__shanyi.queryPage());
  }
  let afterB=await pageB.evaluate(()=>window.__shanyi.queryPage());
  for(let attempt=0;attempt<10&&afterB?.includes('MainPage');attempt++){
    await pageB.waitForTimeout(1000);
    afterB=await pageB.evaluate(()=>window.__shanyi.queryPage());
  }
  assert(afterA&&!afterA.includes('MainPage'),'seat0 did not leave menu: '+afterA);
  assert(afterB&&!afterB.includes('MainPage'),'seat1 did not mirror the click: '+afterB);
  console.log('[dual] click mirrored',{seat0:afterA,seat1:afterB});

  const artifacts=path.join(REPO_ROOT,'local','tmp','shanyi-launcher','artifacts');
  await mkdir(artifacts,{recursive:true});
  await pageA.screenshot({path:path.join(artifacts,'dual_seat0.png')});
  await pageB.screenshot({path:path.join(artifacts,'dual_seat1.png')});
  console.log(JSON.stringify({ok:true,room:ROOM,seat0:afterA,seat1:afterB,
    visibility,errors:{a:errors.a.slice(0,5),b:errors.b.slice(0,5)}},null,2));
}finally{
  await browser?.close().catch(()=>{});
  await started?.close().catch(()=>{});
  await rm(temporary,{recursive:true,force:true}).catch(()=>{});
}
