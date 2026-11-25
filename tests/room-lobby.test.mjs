import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {startRoomLobby} from '../server/room-lobby.mjs';
import {RoomRegistry} from '../server/room-registry.mjs';
import {BVN33_GAME,createBvn33RoomService} from '../server/bvn33-room-service.mjs';

const catalog=[Object.freeze({
  id:'forest',title:'森林神庙',subtitle:'Forest',dir:'forest',
  script:'forest/game.js',entryPath:'/forest/index.html',
  requireScript:'forest/bower_components/requirejs/require.js',
  templeId:'forest',storagePrefix:'fb-forest',
  capabilities:{save:true},
  levels:[{id:1,order:0,type:'general',time:null},{id:2,order:1,type:'general',time:null}],
})];

async function fakeAuthority({gameId,levelId,templeId,connected}){
  const server=http.createServer((req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:true,room:{connected,suspendedReason:null},
      gameId,levelId,templeId}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  return {url:`http://127.0.0.1:${port}`,servedSha256:'b'.repeat(64),sourceSha256:'a'.repeat(64),
    close:()=>new Promise(resolve=>server.close(()=>resolve())),startedAt:{gameId,levelId,templeId}};
}

async function fixture(t,{games=catalog,connected=[true,true],bvn33Service=null,listAdditionalRooms}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'room-lobby-'));
  const registry=await new RoomRegistry({file:path.join(dir,'rooms.json')}).load();
  const calls=[];
  const app=await startRoomLobby({port:0,catalog:games,registry,bvn33Service,listAdditionalRooms,
    authorityFactory:async options=>{
      const authority={...options,connected:[...connected]};
      calls.push(authority);
      return fakeAuthority(authority);
    }});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {app,calls,registry};
}

const post=async(url,body,headers={})=>{
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},
    body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
};

function client(t,app,token,{url=app.lobbyWsUrl,origin,presence}={}){
  const query=new URLSearchParams({token});
  if(presence)query.set('presence',presence);
  const ws=new WebSocket(url+'?'+query,origin?{origin}:{});
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

test('unlisted games reject new rooms and stay available by invitation in an existing room',async t=>{
  const hidden={...catalog[0],id:'platform-brawl',listed:false};
  const {app,registry}=await fixture(t,{games:[...catalog,hidden]});
  const name='已下架游戏存档';
  const password='pass1234';
  const saved=await registry.create({name,password,gameId:hidden.id});
  await registry.setSave(saved.key,hidden.id,{levelId:2});

  const games=await fetch(app.url+'/api/games').then(response=>response.json());
  assert.deepEqual(games.games.map(game=>game.id),['forest']);
  const rooms=await fetch(app.url+'/api/rooms').then(response=>response.json());
  assert.equal(rooms.rooms.find(room=>room.key===saved.key).listed,false);
  const rejected=await post(app.url+'/api/rooms',{name:'试建下架房',password,gameId:hidden.id});
  assert.equal(rejected.body.error,'GAME_UNLISTED');

  const legacy=await post(app.url+'/api/rooms',{name:'等待选择游戏',password});
  const legacyClient=client(t,app,legacy.body.token);
  await legacyClient.waitFor(message=>message.type==='welcome');
  for(const type of ['select-game','propose-level']){
    legacyClient.messages.length=0;
    legacyClient.ws.send(JSON.stringify({type,gameId:hidden.id,levelId:2}));
    const error=await legacyClient.waitFor(message=>message.type==='lobby-error');
    assert.equal(error.code,'GAME_UNLISTED');
  }

  const first=await post(app.url+'/api/rooms/join',{name,password});
  const second=await post(app.url+'/api/rooms/join',{name,password});
  assert.equal(first.status,200);
  assert.equal(second.status,200);
  assert.equal(first.body.games.find(game=>game.id===hidden.id).save.levelId,2);
  const a=client(t,app,first.body.token),b=client(t,app,second.body.token);
  await a.waitFor(message=>message.type==='state'&&message.room.bothConnected);
  a.ws.send(JSON.stringify({type:'propose-level',gameId:hidden.id,levelId:2}));
  await b.waitFor(message=>message.type==='state'&&message.room.proposal?.gameId===hidden.id);
});

test('persistent room name + password matching runs one authoritative session',async t=>{
  const {app,calls,registry}=await fixture(t);
  const created=await post(app.url+'/api/rooms',{name:'我们的存档房',password:'pass1234'});
  assert.equal(created.status,201);
  assert.equal(created.body.seat,0);
  assert.equal(created.body.games[0].id,'forest');
  const tokenA=created.body.token;

  const duplicate=await post(app.url+'/api/rooms',{name:'我们的存档房',password:'pass9999'});
  assert.equal(duplicate.status,409);
  assert.equal(duplicate.body.error,'ROOM_NAME_TAKEN');
  const wrong=await post(app.url+'/api/rooms/join',{name:'我们的存档房',password:'nope1234'});
  assert.equal(wrong.status,403);
  const missing=await post(app.url+'/api/rooms/join',{name:'查无此房',password:'pass1234'});
  assert.equal(missing.status,404);

  const joined=await post(app.url+'/api/rooms/join',{name:'我们的存档房',password:'pass1234'});
  assert.equal(joined.status,200);
  assert.equal(joined.body.seat,1);
  const tokenB=joined.body.token;
  const third=await post(app.url+'/api/rooms/join',{name:'我们的存档房',password:'pass1234'});
  assert.equal(third.status,409);
  assert.equal(third.body.error,'ROOM_FULL');

  const a=client(t,app,tokenA),b=client(t,app,tokenB);
  const welcomeA=await a.waitFor(message=>message.type==='welcome');
  const welcomeB=await b.waitFor(message=>message.type==='welcome');
  assert.equal(welcomeA.seat,0);assert.equal(welcomeB.seat,1);
  await a.waitFor(message=>message.type==='state'&&message.room.bothConnected);

  a.ws.send(JSON.stringify({type:'select-game',gameId:'forest'}));
  a.ws.send(JSON.stringify({type:'propose-level',gameId:'forest',levelId:2}));
  const banner=await b.waitFor(message=>message.type==='state'&&message.room.proposal);
  assert.equal(banner.room.proposal.bySeat,0);
  assert.equal(banner.room.proposal.levelId,2);

  const other=await post(app.url+'/api/rooms/join',{name:'我们的存档房',password:'pass1234'});
  assert.equal(other.status,409);

  b.ws.send(JSON.stringify({type:'confirm-level',proposalId:banner.room.proposal.id}));
  const started=await a.waitFor(message=>message.type==='session-start');
  assert.equal(started.session.levelId,2);
  assert.equal(started.session.gameId,'forest');
  assert.match(started.session.wsUrl,/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
  assert.match(started.session.token,/^[a-f0-9]{48}$/);
  assert.equal(started.session.seat,0);
  const startedB=await b.waitFor(message=>message.type==='session-start');
  assert.equal(startedB.session.seat,1);
  const lateJoin=await post(app.url+'/api/rooms/join',{name:created.body.room.name,password:'pass1234'});
  assert.equal(lateJoin.body.error,'ROOM_PLAYING');
  assert.equal(startedB.session.token,started.session.token);
  assert.equal(calls.length,1);
  assert.equal(calls[0].levelId,2);
  assert.equal(calls[0].gameId,'forest');
  assert.equal(calls[0].templeId,'forest');
  assert.equal(registry.saves(registry.publicRoom(created.body.room.key).key).forest.levelId,2);

  const health=await fetch(app.url+'/health').then(response=>response.json());
  assert.equal(health.activeSession.levelId,2);
});

test('two rooms play concurrently and only the empty game session is reclaimed',async t=>{
  const {app,calls}=await fixture(t);
  const created=await post(app.url+'/api/rooms',{name:'第一间',password:'pass1234'});
  const joined=await post(app.url+'/api/rooms/join',{name:'第一间',password:'pass1234'});
  const second=await post(app.url+'/api/rooms',{name:'第二间',password:'pass1234'});
  const secondJoin=await post(app.url+'/api/rooms/join',{name:'第二间',password:'pass1234'});

  const a=client(t,app,created.body.token),b=client(t,app,joined.body.token);
  const c=client(t,app,second.body.token),d=client(t,app,secondJoin.body.token);
  await a.waitFor(message=>message.type==='state'&&message.room.bothConnected);
  await c.waitFor(message=>message.type==='state'&&message.room.bothConnected);
  a.ws.send(JSON.stringify({type:'propose-level',gameId:'forest',levelId:1}));
  const proposal=await b.waitFor(message=>message.type==='state'&&message.room.proposal);
  b.ws.send(JSON.stringify({type:'confirm-level',proposalId:proposal.room.proposal.id}));
  const firstMatch=await a.waitFor(message=>message.type==='session-start');

  c.ws.send(JSON.stringify({type:'propose-level',gameId:'forest',levelId:1}));
  const secondProposal=await d.waitFor(message=>message.type==='state'&&message.room.proposal);
  d.ws.send(JSON.stringify({type:'confirm-level',proposalId:secondProposal.room.proposal.id}));
  const secondMatch=await c.waitFor(message=>message.type==='session-start');
  assert.notEqual(firstMatch.session.wsUrl,secondMatch.session.wsUrl);
  assert.notEqual(firstMatch.session.token,secondMatch.session.token);
  assert.deepEqual(app.activeSessions.map(session=>session.room),['第一间','第二间']);

  // The game connections disappear even though both lobby pages are open.
  const deadline=Date.now()+3000;
  while(!app.lobby.roomFor(created.body.room.key).session.sawBoth && Date.now()<deadline)
    await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(app.lobby.roomFor(created.body.room.key).session.sawBoth,true);
  calls[0].connected.fill(false);
  const ended=await a.waitFor(message=>message.type==='session-ended',8000);
  assert.equal(ended.reason,'PLAYERS_LEFT');
  assert.equal(app.lobby.roomFor(created.body.room.key).phase,'select');
  assert.equal(app.lobby.roomFor(second.body.room.key).phase,'playing');
  assert(c.messages.every(message=>message.type!=='session-ended'));
  assert.deepEqual(app.activeSessions.map(session=>session.room),['第二间']);

  a.ws.send(JSON.stringify({type:'propose-level',gameId:'forest',levelId:2}));
  const retry=await b.waitFor(message=>message.type==='state'&&message.room.proposal?.levelId===2);
  b.ws.send(JSON.stringify({type:'confirm-level',proposalId:retry.room.proposal.id}));
  const reopened=await a.waitFor(message=>message.type==='session-start'&&message.session.levelId===2);
  assert.notEqual(reopened.session.token,firstMatch.session.token);
  assert.equal(app.activeSessions.length,2);
});

test('an invalid lobby token gets an explicit rejection without attaching to the room',async t=>{
  const {app}=await fixture(t);
  const created=await post(app.url+'/api/rooms',{name:'凭证测试',password:'pass1234'});
  const messages=[];
  const code=await new Promise((resolve,reject)=>{
    const ws=new WebSocket(app.lobbyWsUrl+'?token='+'0'.repeat(48));
    t.after(()=>ws.terminate());
    ws.on('message',message=>messages.push(JSON.parse(message.toString())));
    ws.once('error',reject);
    ws.once('close',resolve);
  });
  assert.equal(code,4003);
  assert.deepEqual(messages.map(({type,code})=>({type,code})),[
    {type:'lobby-error',code:'LOBBY_TOKEN_INVALID'},
  ]);
  const room=app.lobby.roomFor(created.body.room.key);
  assert.equal(room.members[0].ws,null);
  assert.equal(room.members[0].connected,false);
});

test('flash mirror sessions start without writing a save',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'room-lobby-flash-'));
  const registry=await new RoomRegistry({file:path.join(dir,'rooms.json')}).load();
  const app=await startRoomLobby({port:0,registry,catalog:[Object.freeze({
    id:'shanyi',title:'闪翼双星',runtime:'flash-ruffle',adapter:'flash-mirror',
    entryPath:'/shanyi/index.html',capabilities:{mirrorInput:true},
    levels:[{id:1,order:0,type:'general',time:null}],
  })]});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const created=await post(app.url+'/api/rooms',{name:'闪翼存档测试',password:'pass1234',gameId:'shanyi'});
  const joined=await post(app.url+'/api/rooms/join',{name:'闪翼存档测试',password:'pass1234'});
  assert.equal(created.status,201);
  assert.equal(joined.status,200);
  const a=client(t,app,created.body.token),b=client(t,app,joined.body.token);
  await a.waitFor(message=>message.type==='welcome');
  await b.waitFor(message=>message.type==='welcome');
  await a.waitFor(message=>message.type==='state'&&message.room.bothConnected);
  a.ws.send(JSON.stringify({type:'select-game',gameId:'shanyi'}));
  a.ws.send(JSON.stringify({type:'propose-level',gameId:'shanyi',levelId:1}));
  const proposal=await b.waitFor(message=>message.type==='state'&&message.room.proposal);
  b.ws.send(JSON.stringify({type:'confirm-level',proposalId:proposal.room.proposal.id}));
  const started=await a.waitFor(message=>message.type==='session-start');
  assert.equal(started.session.levelId,1);
  assert.equal(started.session.entryPath,'/shanyi/index.html');
  assert.equal(registry.saves(created.body.room.key).shanyi,undefined);
});

test('a second mirror room accepts players through the lobby when its fixed port is in use',async t=>{
  const listener=http.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const mirrorPort=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const dir=await mkdtemp(path.join(os.tmpdir(),'room-lobby-mirror-ports-'));
  const registry=await new RoomRegistry({file:path.join(dir,'rooms.json')}).load();
  const app=await startRoomLobby({port:0,registry,mirrorPort,mirrorPublicPort:mirrorPort,catalog:[{
    id:'shanyi',title:'闪翼双星',runtime:'flash-ruffle',entryPath:'/shanyi/index.html',
    levels:[{id:1,order:0,type:'general',time:null}],
  }]});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});

  async function start(name){
    const created=await post(app.url+'/api/rooms',{name,password:'pass1234',gameId:'shanyi'});
    const joined=await post(app.url+'/api/rooms/join',{name,password:'pass1234'});
    const first=client(t,app,created.body.token),second=client(t,app,joined.body.token);
    await first.waitFor(message=>message.room?.bothConnected);
    first.ws.send(JSON.stringify({type:'propose-level',gameId:'shanyi',levelId:1}));
    const proposal=await second.waitFor(message=>message.room?.proposal);
    second.ws.send(JSON.stringify({type:'confirm-level',proposalId:proposal.room.proposal.id}));
    return (await first.waitFor(message=>message.type==='session-start')).session;
  }

  const direct=await start('固定端口房');
  const proxied=await start('大厅转发房');
  assert.equal(new URL(direct.wsUrl).port,String(mirrorPort));
  assert.equal(new URL(proxied.wsUrl).port,new URL(app.url).port);
  const target=new URL(proxied.wsUrl);
  target.searchParams.set('token',proxied.token);
  target.searchParams.set('seat','0');
  const ws=new WebSocket(target);
  t.after(()=>ws.terminate());
  const welcome=await new Promise((resolve,reject)=>{
    ws.once('message',buffer=>resolve(JSON.parse(buffer.toString())));
    ws.once('error',reject);
  });
  assert.equal(welcome.type,'welcome');
  assert.equal(welcome.seat,0);
});

test('room plaza lists persisted rooms with live occupancy and no secrets',async t=>{
  const {app,registry}=await fixture(t);
  const alpha=await post(app.url+'/api/rooms',{name:'广场甲',password:'pass1234'});
  const beta=await post(app.url+'/api/rooms',{name:'广场乙',password:'pass1234'});
  assert.equal(alpha.status,201);assert.equal(beta.status,201);
  await registry.setSave(beta.body.room.key,'forest',{levelId:2});
  const listed=await fetch(app.url+'/api/rooms').then(response=>response.json());
  const names=listed.rooms.map(item=>item.name).sort();
  assert.deepEqual(names,['广场乙','广场甲']);
  const second=listed.rooms.find(item=>item.name==='广场乙');
  assert.equal(second.saves.forest.levelId,2);
  assert.equal(second.occupied,1);
  assert.equal(second.available,true);
  const raw=JSON.stringify(listed);
  assert.ok(!raw.includes('salt')&&!raw.includes('hash')&&!raw.includes('token'));
});

test('room plaza reflects the current list from a separate browser game',async t=>{
  let additional=[];
  const {app}=await fixture(t,{listAdditionalRooms:()=>additional});
  await post(app.url+'/api/rooms',{name:'现有合作房间',password:'pass1234'});
  const room={key:'glorton:ABC234',name:'网页对战',code:'ABC234',gameId:'glorton',
    available:true,phase:'select',occupied:1,connected:1,capacity:2};
  const getRooms=()=>fetch(app.url+'/api/rooms').then(response=>response.json()).then(body=>body.rooms);
  additional=[room];
  const rooms=await getRooms();
  assert.deepEqual(rooms.find(item=>item.gameId==='glorton'),room);
  assert(rooms.some(item=>item.name==='现有合作房间'));
  additional=[];
  assert(!(await getRooms()).some(item=>item.gameId==='glorton'));
});

test('BVN spectator admission authenticates the room, checks the live fight and never returns player credentials',async t=>{
  const code='BVN-ROOM',hostToken='host-player-seat',guestToken='guest-player-seat';
  const watchKey='private-watch-authority',viewToken='valid-viewer-ticket';
  const status={players:[true,true],state:'select',watchable:false};
  const calls=[];
  let stalledGrant;
  const sidecar=http.createServer(async(req,res)=>{
    let body='';
    for await(const chunk of req)body+=chunk;
    const data=body?JSON.parse(body):null;
    calls.push({pathname:req.url,data});
    const reply=(httpStatus,result)=>{
      res.writeHead(httpStatus,{'content-type':'application/json'});
      res.end(JSON.stringify(result));
    };
    if(req.url==='/health')return reply(200,{gameInstalled:true,mode:'local-lockstep',spectatorMode:'lobby-lockstep'});
    if(req.url==='/api/create')return reply(200,{code,token:hostToken,watchKey,slot:1});
    if(req.url==='/api/join')return reply(200,{code,token:guestToken,slot:2});
    if(req.url==='/api/lobby-close')return reply(200,{ok:true});
    if(req.url==='/api/lobby-status')return reply(200,status);
    if(req.url==='/api/lobby-watch'){
      if(data.code!==code||data.token!==hostToken||data.watchKey!==watchKey)return reply(404,{error:'invalid host'});
      if(!status.watchable||!status.players.every(Boolean))return reply(409,{error:'fight unavailable'});
      if(stalledGrant)await stalledGrant.promise;
      return reply(200,{role:'watch',code,token:viewToken});
    }
    return reply(404,{error:'unknown test route'});
  });
  await new Promise(resolve=>sidecar.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>sidecar.close(resolve)));
  const publicSidecar='http://bvn-fixture.example.test:18745';
  const bvn33Service=createBvn33RoomService(`http://127.0.0.1:${sidecar.address().port}`,publicSidecar);
  await bvn33Service.check();
  const {app}=await fixture(t,{games:[...catalog,BVN33_GAME],bvn33Service});
  const credentials={name:'联网观战房',password:'fixture-pass-1234',gameId:'bvn33'};
  const spectate=app.url+'/api/rooms/spectate';
  const watchCalls=()=>calls.filter(call=>call.pathname==='/api/lobby-watch');
  const until=async query=>{
    const deadline=Date.now()+4500;
    while(Date.now()<deadline){if(await query())return;await new Promise(resolve=>setTimeout(resolve,30));}
    assert.fail('Spectator state was not observed before the deadline');
  };
  const publicRoom=async()=>{
    const {rooms}=await fetch(app.url+'/api/rooms').then(response=>response.json());
    return rooms.find(room=>room.name===credentials.name);
  };
  const first=await post(app.url+'/api/rooms',credentials);
  assert.equal((await publicRoom()).spectatable,false);
  assert.equal((await post(spectate,credentials)).body.error,'ROOM_NOT_WATCHABLE');
  const second=await post(app.url+'/api/rooms/join',credentials);
  const a=client(t,app,first.body.token),b=client(t,app,second.body.token);
  await a.waitFor(m=>m.room?.canStart);
  a.ws.send(JSON.stringify({type:'propose-level',gameId:'bvn33',levelId:0}));
  const proposal=await b.waitFor(m=>m.room?.proposal);
  b.ws.send(JSON.stringify({type:'confirm-level',proposalId:proposal.room.proposal.id}));
  const playerLaunch=await a.waitFor(m=>m.type==='session-start');
  assert(!playerLaunch.session.launchUrl.includes(watchKey));
  assert.equal((await publicRoom()).phase,'playing');
  const beforeResume=a.messages.length;
  a.ws.send(JSON.stringify({type:'join-active'}));
  const resumed=await a.waitFor(m=>m.type==='session-start'&&a.messages.indexOf(m)>=beforeResume);
  assert.deepEqual(resumed.session,playerLaunch.session);
  assert.equal((await publicRoom()).spectatable,false);
  assert.equal((await post(spectate,credentials)).status,409);

  status.state='running';status.watchable=true;
  await until(async()=>(await publicRoom()).spectatable);
  const count=watchCalls().length;
  assert.equal((await post(spectate,{...credentials,password:'wrong-pass'})).status,403);
  assert.equal(watchCalls().length,count,'an invalid password reached the sidecar');
  const admitted=await post(spectate,{...credentials,nickname:'  测试观众  '},{origin:'http://localhost:8787'});
  assert.equal(admitted.status,200);
  assert.deepEqual(Object.keys(admitted.body),['launchUrl']);
  const address=new URL(admitted.body.launchUrl);
  assert.equal(address.origin,publicSidecar);
  assert.equal(address.pathname,'/lobby-watch');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(address.hash.slice(1))),{watch:code,view:viewToken});
  assert.deepEqual(watchCalls().at(-1).data,{code,token:hostToken,watchKey,nickname:'测试观众',
    returnUrl:'http://localhost:8787/'});
  const info=await publicRoom();
  assert.equal(info.occupied,2);
  assert.equal(info.available,false);
  assert(![hostToken,guestToken,viewToken,watchKey].some(secret=>JSON.stringify(info).includes(secret)));

  status.players=[false,true];
  assert.equal((await post(spectate,credentials)).body.error,'ROOM_NOT_WATCHABLE');
  await until(async()=>!(await publicRoom()).spectatable);

  status.players=[true,true];
  stalledGrant=Promise.withResolvers();
  const upcoming=watchCalls().length+1;
  const pendingGrant=post(spectate,credentials);
  try{
    await until(()=>watchCalls().length>=upcoming);
    a.ws.send(JSON.stringify({type:'leave'}));
    await b.waitFor(m=>m.type==='session-ended');
    stalledGrant.resolve();
    assert.equal((await pendingGrant).body.error,'ROOM_NOT_WATCHABLE');
    assert.equal((await publicRoom()).spectatable,false);
  }finally{stalledGrant.resolve();}
});

test('a game-bound room starts only its confirmed occupants and issues dense match seats',async t=>{
  const arena={id:'tank-trouble',title:'迷宫坦克',runtime:'tank-arena',seats:6,minSeats:2,
    entryPath:'/tank-arena/index.html',levels:[{id:1,order:0,type:'general'}]};
  const {app,registry}=await fixture(t,{games:[...catalog,arena]});
  const data={name:'多人迷宫房',password:'pass1234'};
  const invalid=await post(app.url+'/api/rooms',{...data,gameId:'unknown'});
  assert.equal(invalid.body.error,'GAME_UNKNOWN');
  const created=await post(app.url+'/api/rooms',{...data,gameId:arena.id});
  assert.equal(created.status,201);
  assert.equal(created.body.room.boundGameId,arena.id);
  assert.equal(created.body.room.minimumSeats,2);
  const conflicting=await post(app.url+'/api/rooms/join',{...data,gameId:'forest'});
  assert.equal(conflicting.body.error,'ROOM_GAME_LOCKED');

  // Keep the original reservation at lobby seat 0 offline during the match.
  const occupants=[];
  for(let seat=1;seat<=3;seat++){
    const joined=await post(app.url+'/api/rooms/join',data);
    assert.equal(joined.body.seat,seat);
    occupants.push(client(t,app,joined.body.token));
  }
  const [first,second,third]=occupants;
  await first.waitFor(m=>m.room?.connectedCount===3);
  first.ws.send(JSON.stringify({type:'select-game',gameId:'forest'}));
  await first.waitFor(m=>m.code==='ROOM_GAME_LOCKED');
  first.ws.send(JSON.stringify({type:'propose-level',gameId:arena.id,levelId:1}));
  const state=await second.waitFor(m=>m.room?.proposal);
  const confirmation=JSON.stringify({type:'confirm-level',proposalId:state.room.proposal.id});
  second.ws.send(confirmation);
  await first.waitFor(m=>m.room?.proposal?.confirmations.length===2);
  assert.equal(app.activeSessions.length,0);
  third.ws.send(confirmation);
  const sessions=await Promise.all(occupants.map(player=>player.waitFor(m=>m.type==='session-start')));
  const joinArena=session=>{
    const launch=new URL(session.launchUrl,'http://127.0.0.1:8787');
    const fragment=new URLSearchParams(launch.hash.slice(1));
    return client(t,app,fragment.get('seat'),{url:fragment.get('ws'),origin:launch.origin});
  };
  const matchPeers=sessions.map(({session})=>joinArena(session));
  const allocated=await Promise.all(matchPeers.map(peer=>peer.waitFor(m=>m.type==='seat')));
  assert.deepEqual(allocated.map(player=>player.seat),[0,1,2]);
  const listed=await fetch(app.url+'/api/rooms').then(response=>response.json());
  const info=listed.rooms.find(item=>item.name===data.name);
  assert.equal(info.gameId,arena.id);
  assert.equal(info.phase,'playing');
  assert.equal(info.participants,3);
  assert.equal(info.available,true);
  assert.equal(info.midMatch,true);
  const denied=await post(app.url+'/api/rooms/join',{...data,password:'incorrect'});
  assert.equal(denied.status,403);

  await matchPeers[0].waitFor(m=>m.phase==='playing');
  const joined=await Promise.all(Array.from({length:4},(_,index)=>post(app.url+'/api/rooms/join',
    {...data,profile:{name:`途中玩家 ${index+1}`}})));
  assert.deepEqual(joined.map(result=>result.status).sort(),[200,200,200,409]);
  const admitted=joined.filter(result=>result.status===200);
  const lateSeats=await Promise.all(admitted.map(result=>joinArena(result.body.session).waitFor(m=>m.type==='seat')));
  assert.deepEqual(lateSeats.map(player=>player.seat).sort(),[3,4,5]);
  const full=await fetch(app.url+'/api/rooms').then(response=>response.json());
  assert.equal(full.rooms[0].participants,6);
  assert.equal(full.rooms[0].available,false);

  const oldLaunch=sessions[0].session.launchUrl;
  matchPeers[0].ws.send(JSON.stringify({type:'leave'}));
  await matchPeers[1].waitFor(m=>m.type==='arena'&&m.dropped[0]);
  first.ws.send(JSON.stringify({type:'join-active'}));
  const resumed=await first.waitFor(m=>m.type==='session-start'&&m.session.launchUrl!==oldLaunch);
  assert.equal((await joinArena(resumed.session).waitFor(m=>m.type==='seat')).seat,0);
  const oldFragment=new URLSearchParams(new URL(oldLaunch,'http://127.0.0.1:8787').hash.slice(1));
  const staleSocket=new WebSocket(oldFragment.get('ws')+'?token='+oldFragment.get('seat'),{origin:'http://127.0.0.1:8787'});
  t.after(()=>staleSocket.terminate());
  const staleError=await new Promise(resolve=>{
    staleSocket.once('error',resolve);
    staleSocket.once('open',()=>resolve(null));
  });
  assert.match(staleError?.message??'',/403/);
  assert.equal(registry.publicRoom(created.body.room.key).gameId,arena.id);
});

test('room chat is seat-scoped and validates message text',async t=>{
  const {app}=await fixture(t);
  const created=await post(app.url+'/api/rooms',{name:'聊天房',password:'chat-pass-1234'});
  const joined=await post(app.url+'/api/rooms/join',{name:'聊天房',password:'chat-pass-1234'});
  const a=client(t,app,created.body.token),b=client(t,app,joined.body.token);
  await a.waitFor(message=>message.type==='state'&&message.room.bothConnected);
  a.ws.send(JSON.stringify({type:'chat',text:'你好',name:'测试游客',avatar:'🐸'}));
  const state=await b.waitFor(message=>message.type==='state'&&message.room.chat?.length===1);
  assert.equal(state.room.chat[0].seat,created.body.seat);
  assert.equal(state.room.chat[0].name,'测试游客');
  assert.equal(state.room.chat[0].text,'你好');
  a.ws.send(JSON.stringify({type:'chat',text:'x'.repeat(501)}));
  const error=await a.waitFor(message=>message.type==='lobby-error');
  assert.equal(error.code,'CHAT_INVALID');
});

test('opening game chat does not reclaim an authority still waiting for game clients',async t=>{
  const {app}=await fixture(t,{connected:[false,false]});
  const data={name:'加载中的房间',password:'pass1234',gameId:'forest'};
  const first=await post(app.url+'/api/rooms',data);
  const second=await post(app.url+'/api/rooms/join',data);
  const a=client(t,app,first.body.token),b=client(t,app,second.body.token);
  await a.waitFor(m=>m.room?.canStart);
  a.ws.send(JSON.stringify({type:'propose-level',gameId:data.gameId,levelId:1}));
  const proposal=await b.waitFor(m=>m.room?.proposal);
  b.ws.send(JSON.stringify({type:'confirm-level',proposalId:proposal.room.proposal.id}));
  await b.waitFor(m=>m.type==='session-start');
  const chat=client(t,app,first.body.token,{presence:'chat'});
  await chat.waitFor(m=>m.type==='welcome'&&m.room?.phase==='playing');
  await assert.rejects(chat.waitFor(m=>m.type==='session-ended',7100),/Timed out/);
  assert.equal(app.activeSessions.length,1);
});

test('offline seats can be replaced while connected seats stay protected',async t=>{
  const {app}=await fixture(t);
  const created=await post(app.url+'/api/rooms',{name:'离线重进房',password:'pass1234'});
  const joined=await post(app.url+'/api/rooms/join',{name:'离线重进房',password:'pass1234'});
  const a=client(t,app,created.body.token),b=client(t,app,joined.body.token);
  await a.waitFor(message=>message.type==='state'&&message.room.bothConnected);
  const busyJoin=await post(app.url+'/api/rooms/join',{name:'离线重进房',password:'pass1234'});
  assert.equal(busyJoin.status,409);
  assert.equal(busyJoin.body.error,'ROOM_FULL');
  a.ws.close();b.ws.close();
  await new Promise(resolve=>setTimeout(resolve,250));
  const listed=await fetch(app.url+'/api/rooms').then(response=>response.json());
  const room=listed.rooms.find(item=>item.name==='离线重进房');
  assert.equal(room.connected,0);
  assert.equal(room.available,true);
  const rejoin=await post(app.url+'/api/rooms/join',{name:'离线重进房',password:'pass1234'});
  assert.equal(rejoin.status,200);
  assert.ok(Number.isInteger(rejoin.body.seat));
});
