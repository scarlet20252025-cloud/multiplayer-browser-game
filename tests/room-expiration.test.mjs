import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createRoomExpiration,roomOccupiesName} from '../server/room-expiration.mjs';
import {startRoomLobby} from '../server/room-lobby.mjs';
import {RoomLobbyCore} from '../server/room-lobby-core.mjs';
import {RoomRegistry} from '../server/room-registry.mjs';

const TTL=600_000;
const catalog=[
  {id:'tank-trouble',runtime:'tank-arena'},
  {id:'bvn33',runtime:'bvn33-online'},
  {id:'frame-fight',runtime:'browser-lockstep'},
  {id:'forest',runtime:'html5-local'},
  {id:'saved-fight',runtime:'browser-lockstep',capabilities:{save:true}},
];

async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'room-expiration-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'rooms.json');
  const registry=await new RoomRegistry({file}).load();
  let time=1_800_000_000_000;
  const now=()=>time;
  const lobby=new RoomLobbyCore({now});
  const sessions=new Set();
  const manager=target=>createRoomExpiration({registry:target,catalog,now,
    isOccupied:key=>roomOccupiesName(lobby.roomFor(key),sessions.has(key)),
    onExpire:key=>lobby.rooms.delete(key)});
  const create=(name,gameId)=>registry.create({name,password:'test-pass',gameId,now:'2020-01-01T00:00:00.000Z'});
  return {registry,file,now,lobby,sessions,manager,create,advance:ms=>{time+=ms;}};
}

test('legacy competitive rooms start aging at startup and cooperative rooms and saves survive',async t=>{
  const f=await fixture(t);
  const arena=await f.create('Arena Room','tank-trouble');
  const bvn=await f.create('BVN Room','bvn33');
  const lockstep=await f.create('Lockstep Room','frame-fight');
  const forest=await f.create('Cooperative Room','forest');
  const legacySave=await f.create('Legacy Save','tank-trouble');
  const savePolicy=await f.create('Save Policy','saved-fight');
  const unknown=await f.create('Unknown Game','unknown-game');
  await f.registry.setSave(legacySave.key,'forest',{levelId:7});

  const expiration=f.manager(f.registry);
  const epoch=f.now();
  assert.deepEqual(await expiration.sweep(),[]);
  for(const room of [arena,bvn,lockstep])assert.equal(f.registry.record(room.key).vacantSince,epoch);
  f.advance(TTL-1);
  assert.deepEqual(await expiration.sweep(),[]);
  f.advance(1);
  assert.deepEqual(await expiration.sweep(),[arena.key,bvn.key,lockstep.key]);
  for(const room of [forest,legacySave,savePolicy,unknown])assert(f.registry.record(room.key));
  assert.equal(f.registry.saves(legacySave.key).forest.levelId,7);
});

test('reserved seats, short offline recovery, and active or preparing sessions protect room names',async t=>{
  const f=await fixture(t);
  const info=await f.create('Recoverable Arena','tank-trouble');
  const expiration=f.manager(f.registry);
  const room=f.lobby.ensureRoom(info.key,{name:info.name,boundGameId:info.gameId});
  const ws={close(){}};
  await expiration.sweep();
  const member=f.lobby.addMember(info.key);
  await expiration.sync(info.key);
  assert.equal(f.registry.record(info.key).vacantSince,undefined);
  f.lobby.attach(member.token,ws);
  f.sessions.add(info.key);
  room.phase='playing';
  f.lobby.detach(ws);
  f.advance(TTL);
  f.lobby.sweep();
  assert.deepEqual(await expiration.sweep(),[]);
  assert.equal(f.registry.record(info.key).vacantSince,undefined);

  f.sessions.delete(info.key);
  room.phase='starting';
  f.advance(TTL);
  assert.deepEqual(await expiration.sweep(),[]);
  assert.equal(f.registry.record(info.key).vacantSince,undefined);
  room.phase='select';
  member.lastSeen=f.now();
  await expiration.sync(info.key);
  f.advance(89_999);
  f.lobby.sweep();
  assert.deepEqual(await expiration.sweep(),[]);
  assert.equal(room.members[0],member);
  assert.equal(f.registry.record(info.key).vacantSince,undefined);

  f.advance(2);
  f.lobby.sweep();
  assert.deepEqual(await expiration.sweep(),[]);
  assert.equal(room.members[0],null);
  assert.equal(f.registry.record(info.key).vacantSince,f.now());
  f.advance(TTL-1);
  const replacement=f.lobby.addMember(info.key);
  await expiration.sync(info.key);
  f.advance(1);
  assert.deepEqual(await expiration.sweep(),[]);
  assert.equal(room.members[0],replacement);
  assert.equal(f.registry.record(info.key).vacantSince,undefined);
});

test('persisted vacancy survives restart and expired names can be recreated without stale lobby state',async t=>{
  const f=await fixture(t);
  const room=await f.create('Rematch Place','bvn33');
  const stale=f.lobby.ensureRoom(room.key,{name:room.name,boundGameId:room.gameId});
  stale.messages.push({text:'stale message'});
  await f.manager(f.registry).sweep();
  const vacantSince=f.now();
  f.advance(TTL/2);
  const reopened=await new RoomRegistry({file:f.file}).load();
  const expiration=f.manager(reopened);
  assert.deepEqual(await expiration.sweep(),[]);
  assert.equal(reopened.record(room.key).vacantSince,vacantSince);
  f.advance(TTL/2);

  const deleting=expiration.sweep();
  assert.equal(f.lobby.roomFor(room.key),null);
  const creating=reopened.create({name:'rematch place',password:'fresh-pass',gameId:'bvn33'});
  assert.deepEqual(await deleting,[room.key]);
  await creating;
  const onDisk=await new RoomRegistry({file:f.file}).load();
  assert.equal((await onDisk.authenticate({name:room.name,password:'fresh-pass'})).name,'rematch place');
  await assert.rejects(onDisk.authenticate({name:room.name,password:'test-pass'}),{code:'ROOM_PASSWORD_WRONG'});
});

test('a failed registry write is retried by the next maintenance sweep',async t=>{
  const f=await fixture(t);
  const room=await f.create('Retry Persist','bvn33');
  const persist=f.registry.persist.bind(f.registry);
  f.registry.persist=()=>Promise.reject(Error('simulated write failure'));
  const expiration=f.manager(f.registry);
  await assert.rejects(expiration.sweep(),/simulated write failure/);
  assert.equal(f.registry.record(room.key).vacantSince,f.now());
  f.registry.persist=persist;
  assert.deepEqual(await expiration.sweep(),[]);
  const reopened=await new RoomRegistry({file:f.file}).load();
  assert.equal(reopened.record(room.key).vacantSince,f.now());
});

test('lobby startup removes an expired room from the HTTP list and allows the name to be created again',async t=>{
  const f=await fixture(t);
  const expired=await f.create('Reusable Arena','tank-trouble');
  const cooperative=await f.create('Keep Cooperative','forest');
  f.registry.record(expired.key).vacantSince=Date.now()-TTL;
  f.registry.record(cooperative.key).vacantSince=Date.now()-TTL;
  await f.registry.persist();
  const reopened=await new RoomRegistry({file:f.file}).load();
  const games=catalog.map(game=>({...game,title:game.id,levels:[{id:1,order:0}]}));
  const app=await startRoomLobby({port:0,catalog:games,registry:reopened});
  try{
    const endpoint=app.url+'/api/rooms';
    const list=await (await fetch(endpoint)).json();
    assert.deepEqual(list.rooms.map(room=>room.name),[cooperative.name]);
    const create=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({name:expired.name,password:'fresh-pass',gameId:'tank-trouble'})});
    assert.equal(create.status,201);
    assert.equal((await create.json()).room.name,expired.name);
    assert.equal(reopened.record(expired.key).vacantSince,undefined);
  }finally{
    await app.close();
  }
});
