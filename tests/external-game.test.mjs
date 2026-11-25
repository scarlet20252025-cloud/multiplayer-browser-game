/**
 * html5-external 运行时（TankTrouble 这类自带权威服务的游戏）的针对性测试。
 *
 * 覆盖三块：
 * 1. manifest 校验接受 html5-external / tank-trouble-colyseus；
 * 2. catalog 从 extraRoots 里加载 external 游戏，只读 levels.json；
 * 3. 大厅按席位生成 create/join 的 entryPath，并用 Colyseus 房间列表判定会话存活。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {loadGameCatalog} from '../server/game-catalog.mjs';
import {validateGameManifest} from '../server/game-adapter.mjs';
import {startRoomLobby} from '../server/room-lobby.mjs';
import {RoomRegistry} from '../server/room-registry.mjs';
import {makeRoomCode,probeExternalRoom} from '../server/external-game-server.mjs';

const tankManifest=()=>validateGameManifest({
  schemaVersion:1,id:'tank-trouble',title:'坦克动荡',subtitle:'Tank Trouble',
  runtime:'html5-external',adapter:'tank-trouble-colyseus',online:true,seats:2,
  capabilities:{authority:true,levelVote:true,restartVote:true,returnVote:true,save:false},
  package:{dir:'tank-trouble',entry:'index.html',levels:'levels.json',
    templeId:'tank-trouble',storagePrefix:'tank-trouble'},
});

/** 起一个假的 external 游戏服务：/health + /rooms/all + /rooms，房间表可随时改。 */
async function fakeExternalServer(t,{rooms=[]}={}){
  const state={rooms,healthHits:0,roomListHits:0};
  const server=http.createServer((req,res)=>{
    const send=body=>{res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(body));};
    if(req.url==='/health'){state.healthHits++;send({ok:true,version:'test'});return;}
    if(req.url==='/rooms/all'||req.url==='/rooms'){state.roomListHits++;
      // /rooms 只给 waiting 房间，模拟 TankTrouble 的真实行为。
      const list=req.url==='/rooms'?state.rooms.filter(r=>r.phase==='waiting'):state.rooms;
      send({rooms:list});return;}
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  // fetch 走 undici 的 keep-alive，不主动断开的话 server.close() 会一直等。
  t.after(()=>new Promise(resolve=>{
    server.closeAllConnections?.();
    server.close(()=>resolve());
  }));
  return {state,url:`http://127.0.0.1:${port}`};
}

const post=async(url,body)=>{
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
};

function client(t,app,token){
  const ws=new WebSocket(app.lobbyWsUrl+'?token='+token);
  const messages=[];
  ws.on('message',buffer=>messages.push(JSON.parse(buffer.toString())));
  t.after(()=>ws.terminate());
  return {ws,messages,
    async waitFor(predicate,timeout=5000){
      const end=Date.now()+timeout;
      while(Date.now()<end){
        const found=messages.find(predicate);
        if(found)return found;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw Error('Timed out waiting for lobby message: '+JSON.stringify(messages.slice(-4)));
    }};
}

test('manifest accepts html5-external with the tank-trouble adapter',()=>{
  const manifest=tankManifest();
  assert.equal(manifest.runtime,'html5-external');
  assert.equal(manifest.adapter,'tank-trouble-colyseus');
  assert.equal(manifest.seats,2);
  assert.equal(manifest.package.entry,'index.html');
  assert.equal(manifest.package.levels,'levels.json');
  // external 游戏必须声明 authority，否则大厅无从判断对局是否活着。
  assert.equal(manifest.capabilities.authority,true);
});

test('catalog loads an external game from extraRoots and reads levels.json',async t=>{
  const privateRoot=await mkdtemp(path.join(os.tmpdir(),'external-games-'));
  t.after(()=>rm(privateRoot,{recursive:true,force:true}));
  const pack=path.join(privateRoot,'tank-trouble');
  await mkdir(pack,{recursive:true});
  await writeFile(path.join(pack,'index.html'),'<!doctype html><div id="game"></div>');
  await writeFile(path.join(pack,'levels.json'),JSON.stringify({
    kind:'html5-external-levels',levels:[{id:1,type:'battle',time:null}]}));
  // 私有包目录本身不参与 git，catalog 也不应该要求 game.json / data-main。
  const catalog=await loadGameCatalog({root:privateRoot,
    manifests:[tankManifest()],extraRoots:{'tank-trouble':privateRoot}});
  assert.equal(catalog.length,1);
  const game=catalog[0];
  assert.equal(game.id,'tank-trouble');
  assert.equal(game.runtime,'html5-external');
  assert.equal(game.entryPath,'/tank-trouble/index.html');
  assert.equal(game.external,true);
  assert.equal(game.serveRoot,path.resolve(privateRoot));
  assert.equal(game.levels.length,1);
  assert.equal(game.levels[0].id,1);
  assert.equal(game.levels[0].type,'battle');
});

test('room codes avoid look-alike characters and stay 4 chars',()=>{
  for(let i=0;i<200;i++){
    const code=makeRoomCode();
    assert.match(code,/^[A-Z2-9]{4}$/);
    assert.doesNotMatch(code,/^[OI01]/);
  }
});

test('probeExternalRoom sees playing rooms through /rooms/all',async t=>{
  const server=await fakeExternalServer(t,{rooms:[
    {roomCode:'ABCD',phase:'playing',playerCount:2,rosterSize:4}]});
  const status=await probeExternalRoom(server.url,'abcd');
  assert.equal(status.found,true);
  assert.equal(status.phase,'playing');
  assert.equal(status.playerCount,2);
  const missing=await probeExternalRoom(server.url,'ZZZZ');
  assert.equal(missing.found,false);
});

test('external session hands each seat a create/join URL for the same room code',async t=>{
  const server=await fakeExternalServer(t);
  const catalog=[Object.freeze({
    id:'tank-trouble',title:'坦克动荡',subtitle:'Tank Trouble',runtime:'html5-external',
    adapter:'tank-trouble-colyseus',seats:2,external:true,dir:'tank-trouble',
    entryPath:'/tank-trouble/index.html',serveRoot:'/private',
    capabilities:{authority:true,levelVote:true,restartVote:true,returnVote:true,save:false},
    levels:[{id:1,order:0,type:'battle',time:null}],
  })];
  const dir=await mkdtemp(path.join(os.tmpdir(),'room-lobby-external-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const registry=await new RoomRegistry({file:path.join(dir,'rooms.json')}).load();
  const app=await startRoomLobby({port:0,catalog,registry,
    externalGameServers:{'tank-trouble':{httpUrl:server.url,localUrl:server.url,publicUrl:server.url}},
    authorityFactory:async()=>{throw Error('external game must not use the html5 authority');}});
  t.after(()=>app.close());

  const created=await post(app.url+'/api/rooms',{name:'坦克验收',password:'tank-pass'});
  assert.equal(created.status,201);
  const joined=await post(app.url+'/api/rooms/join',{name:'坦克验收',password:'tank-pass'});
  assert.equal(joined.status,200);
  const a=client(t,app,created.body.token),b=client(t,app,joined.body.token);
  await a.waitFor(message=>message.type==='welcome');
  await b.waitFor(message=>message.type==='welcome');
  await a.waitFor(message=>message.type==='state'&&message.room.bothConnected);

  a.ws.send(JSON.stringify({type:'select-game',gameId:'tank-trouble'}));
  a.ws.send(JSON.stringify({type:'propose-level',gameId:'tank-trouble',levelId:1}));
  const banner=await b.waitFor(message=>message.type==='state'&&message.room.proposal);
  b.ws.send(JSON.stringify({type:'confirm-level',proposalId:banner.room.proposal.id}));

  const startedA=await a.waitFor(message=>message.type==='session-start');
  const startedB=await b.waitFor(message=>message.type==='session-start');
  const urlA=new URL(startedA.session.entryPath,'http://viewer.test');
  const urlB=new URL(startedB.session.entryPath,'http://viewer.test');
  assert.equal(urlA.pathname,'/tank-trouble/index.html');
  assert.equal(urlA.searchParams.get('tank'),'create');
  assert.equal(urlB.searchParams.get('tank'),'join');
  const codeA=urlA.searchParams.get('code'),codeB=urlB.searchParams.get('code');
  assert.match(codeA,/^[A-Z2-9]{4}$/);
  assert.equal(codeA,codeB);
  assert.match(urlA.searchParams.get('ws'),/^ws:\/\//);
  assert.equal(urlA.searchParams.get('ws'),urlB.searchParams.get('ws'));
  assert.equal(startedA.session.roomCode,codeA);
  assert.equal(startedB.session.roomCode,codeA);
  // 两个席位拿到的是不同 URL，否则两人会都去建房。
  assert.notEqual(startedA.session.entryPath,startedB.session.entryPath);
});

test('a vanished external room ends the lobby session',async t=>{
  const server=await fakeExternalServer(t,{rooms:[]});
  const catalog=[Object.freeze({
    id:'tank-trouble',title:'坦克动荡',runtime:'html5-external',
    adapter:'tank-trouble-colyseus',seats:2,external:true,dir:'tank-trouble',
    entryPath:'/tank-trouble/index.html',serveRoot:'/private',
    capabilities:{authority:true,levelVote:true,restartVote:true,returnVote:true,save:false},
    levels:[{id:1,order:0,type:'battle',time:null}],
  })];
  const dir=await mkdtemp(path.join(os.tmpdir(),'room-lobby-vanish-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const registry=await new RoomRegistry({file:path.join(dir,'rooms.json')}).load();
  const app=await startRoomLobby({port:0,catalog,registry,
    externalGameServers:{'tank-trouble':{httpUrl:server.url,localUrl:server.url,publicUrl:server.url}},
    authorityFactory:async()=>{throw Error('unused');}});
  t.after(()=>app.close());

  const created=await post(app.url+'/api/rooms',{name:'消失测试',password:'tank-pass'});
  const joined=await post(app.url+'/api/rooms/join',{name:'消失测试',password:'tank-pass'});
  const a=client(t,app,created.body.token),b=client(t,app,joined.body.token);
  await a.waitFor(message=>message.type==='welcome');
  await b.waitFor(message=>message.type==='welcome');
  await a.waitFor(message=>message.type==='state'&&message.room.bothConnected);
  a.ws.send(JSON.stringify({type:'select-game',gameId:'tank-trouble'}));
  a.ws.send(JSON.stringify({type:'propose-level',gameId:'tank-trouble',levelId:1}));
  const banner=await b.waitFor(message=>message.type==='state'&&message.room.proposal);
  b.ws.send(JSON.stringify({type:'confirm-level',proposalId:banner.room.proposal.id}));
  const started=await a.waitFor(message=>message.type==='session-start');
  const code=started.session.roomCode;

  // 房间先出现（两人在线），随后消失 —— 大厅应结束会话而不是永远挂着。
  server.state.rooms.push({roomCode:code,phase:'playing',playerCount:2,rosterSize:4});
  await new Promise(resolve=>setTimeout(resolve,1200));
  server.state.rooms.length=0;
  const ended=await a.waitFor(message=>message.type==='state'&&message.room.phase!=='playing',15000);
  assert.notEqual(ended.room.phase,'playing');
  assert.equal(ended.room.session??null,null);
});
