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
