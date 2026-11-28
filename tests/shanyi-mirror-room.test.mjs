import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {startShanyiMirrorRoom} from '../server/shanyi-mirror-room.mjs';

const TOKEN='a'.repeat(48);

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
function next(ws,type,limit=4000,predicate=null){
  return new Promise((resolve,reject)=>{
    const end=Date.now()+limit;
    const tick=()=>{
      const index=ws.messages.findIndex(message=>message.type===type&&
        (!predicate||predicate(message)));
      if(index>=0)return resolve(ws.messages.splice(index,1)[0]);
      if(Date.now()>end)return reject(Error('timeout waiting for '+type));
      setTimeout(tick,25);
    };
    tick();
  });
}

test('mirror room relays input edges between two seats', async t=>{
  const room=await startShanyiMirrorRoom({port:0,allowedViewerOrigins:['http://127.0.0.1:8797'],
    wsToken:TOKEN,gameId:'shanyi',levelId:1});
  t.after(()=>room.close());
  const base=room.url.replace(/^http/,'ws')+'/ws?token='+TOKEN;
  const a=await open(base+'&seat=0');
  const b=await open(base+'&seat=1');
  t.after(()=>{a.close();b.close();});

  const welcomeA=await next(a,'welcome');
  const welcomeB=await next(b,'welcome');
  assert.equal(welcomeA.seat,0);
  assert.equal(welcomeB.seat,1);
  await next(a,'peer-connection');
  await next(b,'peer-connection');

  a.send(JSON.stringify({type:'ready'}));
  const readyA=await next(a,'ready-state',4000,message=>
    message.ready[0]===true&&message.ready[1]===false);
  assert.deepEqual(readyA.ready,[true,false]);
  assert.equal(readyA.bothReady,false);
  b.send(JSON.stringify({type:'ready'}));
  const readyBoth=await next(a,'ready-state',4000,message=>message.bothReady===true);
  assert.deepEqual(readyBoth.ready,[true,true]);

  const state=await fetch(room.url+'/health').then(response=>response.json());
  assert.deepEqual(state.room.connected,[true,true]);
  assert.equal(state.noVideo,true);

  a.send(JSON.stringify({type:'input',code:68,down:true}));
  assert.deepEqual(await next(b,'peer-input'),{type:'peer-input',code:68,down:true});

  b.send(JSON.stringify({type:'click',x:557.4,y:458.2}));
  assert.deepEqual(await next(a,'peer-click'),{type:'peer-click',x:557,y:458});

  a.send(JSON.stringify({type:'presence',page:'Level1'}));
  assert.deepEqual(await next(b,'peer-presence'),{type:'peer-presence',page:'Level1'});

  a.send(JSON.stringify({type:'hero-state',x:68.4,y:250.2,vx:1.5,vy:0}));
  assert.deepEqual(await next(b,'peer-hero-state'),
    {type:'peer-hero-state',x:68.4,y:250.2,vx:1.5,vy:0});
  a.send(JSON.stringify({type:'hero-state',x:'oops',y:1,vx:0,vy:0}));
  assert.equal((await next(a,'mirror-error')).code,'HERO_STATE_INVALID');

  a.send(JSON.stringify({type:'ping',id:7}));
  assert.deepEqual(await next(a,'pong'),{type:'pong',id:7});

  b.close();
  const readyAfterClose=await next(a,'ready-state',4000,message=>
    message.ready[0]===true&&message.ready[1]===false);
  assert.deepEqual(readyAfterClose.ready,[true,false]);
  assert.equal(readyAfterClose.bothReady,false);
});

test('mirror room rejects a wrong token and a third seat', async t=>{
  const room=await startShanyiMirrorRoom({port:0,allowedViewerOrigins:[],wsToken:TOKEN});
  t.after(()=>room.close());
  const base=room.url.replace(/^http/,'ws')+'/ws';
  await assert.rejects(open(base+'?token=wrong&seat=0'),/403/);
  const a=await open(base+'?token='+TOKEN+'&seat=0');
  const b=await open(base+'?token='+TOKEN+'&seat=1');
  t.after(()=>{a.close();b.close();});
  const third=await open(base+'?token='+TOKEN);
  const error=await next(third,'mirror-error');
  assert.equal(error.code,'ROOM_FULL');
});

test('batched edges keep their order and stop when the two pages diverge', async t=>{
  const room=await startShanyiMirrorRoom({port:0,allowedViewerOrigins:[],wsToken:TOKEN});
  t.after(()=>room.close());
  const base=room.url.replace(/^http/,'ws')+'/ws?token='+TOKEN;
  const a=await open(base+'&seat=0');
  const b=await open(base+'&seat=1');
  t.after(()=>{a.close();b.close();});
  await next(a,'welcome');await next(b,'welcome');

  a.send(JSON.stringify({type:'presence',page:'pages::Level1'}));
  b.send(JSON.stringify({type:'presence',page:'pages::Level1'}));
  await next(b,'peer-presence');
  a.send(JSON.stringify({type:'input-batch',edges:[{code:68,down:true},{code:68,down:false}]}));
  const batch=await next(b,'peer-input-batch');
  assert.deepEqual(batch.edges,[{code:68,down:true},{code:68,down:false}]);

  // 一端回到菜单：移动键停止转发，并给出明确错误码。
  b.send(JSON.stringify({type:'presence',page:'pages::MainPage'}));
  await next(a,'peer-presence');
  a.send(JSON.stringify({type:'input-batch',edges:[{code:65,down:true}]}));
  const error=await next(a,'mirror-error');
  assert.equal(error.code,'PAGE_MISMATCH');
  assert.equal(error.local,'pages::Level1');
  assert.equal(error.peer,'pages::MainPage');
});

test('return votes carry seat numbers, not internal member ids', async t=>{
  const room=await startShanyiMirrorRoom({port:0,allowedViewerOrigins:[],wsToken:TOKEN});
  t.after(()=>room.close());
  const base=room.url.replace(/^http/,'ws')+'/ws?token='+TOKEN;
  const a=await open(base+'&seat=0');
  const b=await open(base+'&seat=1');
  t.after(()=>{a.close();b.close();});
  await next(a,'welcome');await next(b,'welcome');
  a.send(JSON.stringify({type:'ready'}));
  b.send(JSON.stringify({type:'ready'}));
  await next(a,'ready-state',4000,message=>message.bothReady===true);

  a.send(JSON.stringify({type:'return.request'}));
  const request=await next(b,'return-request');
  assert.equal(request.requestedBy,0);
  assert.equal(request.votes,1);

  b.send(JSON.stringify({type:'return.confirm'}));
  const approved=await next(a,'return-approved');
  assert.equal(approved.requestedBy,0);
  assert.equal(approved.votes,2);
});

test('a dropped seat resumes with its token inside the grace window', async t=>{
  const room=await startShanyiMirrorRoom({port:0,allowedViewerOrigins:[],wsToken:TOKEN,
    resumeGraceMs:500});
  t.after(()=>room.close());
  const base=room.url.replace(/^http/,'ws')+'/ws?token='+TOKEN;
  const first=await open(base+'&seat=0');
  const welcome=await next(first,'welcome');
  assert.equal(welcome.resumed,false);
  assert.match(welcome.resumeToken,/^[a-f0-9]{32}$/);
  first.close();
  await new Promise(resolve=>setTimeout(resolve,60));

  const again=await open(base+'&resume='+welcome.resumeToken);
  const resumed=await next(again,'welcome');
  assert.equal(resumed.seat,0);
  assert.equal(resumed.resumed,true);
  assert.notEqual(resumed.resumeToken,welcome.resumeToken,'each connection gets a fresh token');
  again.close();
});

test('taking over a seat does not put the winner into the grace state', async t=>{
  const room=await startShanyiMirrorRoom({port:0,allowedViewerOrigins:[],wsToken:TOKEN,
    resumeGraceMs:5000});
  t.after(()=>room.close());
  const base=room.url.replace(/^http/,'ws')+'/ws?token='+TOKEN;
  const first=await open(base+'&seat=0');
  await next(first,'welcome');
  const takeover=await open(base+'&seat=0');
  const winner=await next(takeover,'welcome');
  assert.equal(winner.seat,0);
  // 旧 socket 的 close 是异步的；等它跑完再看租约。
  await new Promise(resolve=>setTimeout(resolve,150));
  const state=await fetch(room.url+'/health').then(response=>response.json());
  assert.deepEqual(state.room.reserved,[],'the winner must not be marked as away');

  takeover.close();
  await new Promise(resolve=>setTimeout(resolve,80));
  const reserved=await fetch(room.url+'/health').then(response=>response.json());
  assert.deepEqual(reserved.room.reserved,[0]);

  const back=await open(base+'&resume='+winner.resumeToken);
  const resumed=await next(back,'welcome');
  assert.equal(resumed.seat,0);
  assert.equal(resumed.resumed,true,'the winner keeps a working ticket');
  back.close();
});

test('an expired resume token no longer claims the old seat', async t=>{
  const room=await startShanyiMirrorRoom({port:0,allowedViewerOrigins:[],wsToken:TOKEN,
    resumeGraceMs:60});
  t.after(()=>room.close());
  const base=room.url.replace(/^http/,'ws')+'/ws?token='+TOKEN;
  const first=await open(base+'&seat=1');
  const welcome=await next(first,'welcome');
  first.close();
  await new Promise(resolve=>setTimeout(resolve,140));
  const again=await open(base+'&resume='+welcome.resumeToken+'&seat=1');
  const resumed=await next(again,'welcome');
  assert.equal(resumed.resumed,false,'the ticket died with the grace window');
  again.close();
});

test('leaving on purpose frees the seat immediately', async t=>{
  const room=await startShanyiMirrorRoom({port:0,allowedViewerOrigins:[],wsToken:TOKEN,
    resumeGraceMs:5000});
  t.after(()=>room.close());
  const base=room.url.replace(/^http/,'ws')+'/ws?token='+TOKEN;
  const first=await open(base+'&seat=0');
  const welcome=await next(first,'welcome');
  first.send(JSON.stringify({type:'leave'}));
  await new Promise(resolve=>{
    first.once('close',resolve);
    setTimeout(resolve,400);
  });
  const state=await fetch(room.url+'/health').then(response=>response.json());
  assert.deepEqual(state.room.reserved,[],'explicit leave must not reserve the seat');
  const again=await open(base+'&resume='+welcome.resumeToken);
  const resumed=await next(again,'welcome');
  assert.equal(resumed.resumed,false);
  again.close();
});
