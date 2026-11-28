import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {RoomRegistry,normalizeRoomName,validateRoomPassword} from '../server/room-registry.mjs';

async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'room-registry-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'rooms.json');
  const registry=await new RoomRegistry({file}).load();
  return {dir,file,registry};
}

test('room names are normalized, so look-alike names cannot create a second save',async t=>{
  const {registry}=await fixture(t);
  await registry.create({name:'  森林  小屋 ',password:'pass1234'});
  assert.equal(normalizeRoomName('  森林  小屋 ').key,normalizeRoomName('森林 小屋').key);
  await assert.rejects(registry.create({name:'森林 小屋',password:'other123'}),
    {code:'ROOM_NAME_TAKEN'});
  await registry.create({name:'FOREST',password:'pass1234'});
  await assert.rejects(registry.create({name:'forest',password:'pass1234'}),
    {code:'ROOM_NAME_TAKEN'});
});

test('room name and password boundaries fail before any record is written',async t=>{
  const {registry}=await fixture(t);
  await assert.rejects(registry.create({name:'x',password:'pass1234'}),{code:'ROOM_NAME_LENGTH'});
  await assert.rejects(registry.create({name:'ok',password:'123'}),{code:'PASSWORD_LENGTH'});
  await assert.rejects(registry.create({name:'bad/name',password:'pass1234'}),{code:'ROOM_NAME_CHARSET'});
  assert.equal(Object.keys(registry.data.rooms).length,0);
  assert.throws(()=>validateRoomPassword('bad\u0000pass'),{code:'PASSWORD_CHARSET'});
});

test('authentication matches the password hash and never stores plaintext',async t=>{
  const {file,registry}=await fixture(t);
  await registry.create({name:'联机存档',password:'secret-pass'});
  const raw=await readFile(file,'utf8');
  assert.ok(!raw.includes('secret-pass'));
  const room=await registry.authenticate({name:'联机存档',password:'secret-pass'});
  assert.equal(room.name,'联机存档');
  await assert.rejects(registry.authenticate({name:'联机存档',password:'wrong-pass'}),
    {code:'ROOM_PASSWORD_WRONG'});
  await assert.rejects(registry.authenticate({name:'不存在',password:'secret-pass'}),
    {code:'ROOM_NOT_FOUND'});
});

test('per-game saves survive a registry restart and do not leak across games',async t=>{
  const {file,registry}=await fixture(t);
  const room=await registry.create({name:'长期房间',password:'pass1234'});
  await registry.setSave(room.key,'forest',{levelId:7,round:3});
  await registry.setSave(room.key,'ice',{levelId:2,completed:false});
  const reloaded=await new RoomRegistry({file}).load();
  assert.deepEqual(reloaded.saves(room.key),{
    forest:{levelId:7,round:3,updatedAt:reloaded.saves(room.key).forest.updatedAt},
    ice:{levelId:2,completed:false,updatedAt:reloaded.saves(room.key).ice.updatedAt},
  });
  assert.equal(reloaded.publicRoom(room.key).saves.forest.levelId,7);
  await assert.rejects(reloaded.setSave(room.key,'forest',{levelId:-1}),{code:'SAVE_LEVEL_INVALID'});
  await assert.rejects(reloaded.setSave(room.key,'BAD ID',{levelId:1}),{code:'GAME_ID_INVALID'});
});

test('the latest installed game save groups a legacy room without losing authentication or saves',async t=>{
  const {file,registry}=await fixture(t);
  const room=await registry.create({name:'旧存档房',password:'pass1234'});
  await registry.setSave(room.key,'forest',{levelId:7});
  await registry.setSave(room.key,'ice',{levelId:3});
  await registry.setSave(room.key,'removed-game',{levelId:1});
  Object.assign(registry.record(room.key).saves.forest,{updatedAt:'2026-01-01T00:00:00.000Z'});
  Object.assign(registry.record(room.key).saves.ice,{updatedAt:'2026-01-02T00:00:00.000Z'});
  const bound=await registry.create({name:'死神联机房',password:'pass1234',gameId:'bvn33'});
  const unbound=await registry.create({name:'旧空房',password:'pass1234'});
  await registry.migrateGameBindings(['forest','ice','bvn33']);
  const reopened=await new RoomRegistry({file}).load();
  const savedRoom=await reopened.authenticate({name:room.name,password:'pass1234'});
  assert.equal(savedRoom.gameId,'ice');
  assert.deepEqual(savedRoom.saves,registry.saves(room.key));
  assert.equal(reopened.publicRoom(bound.key).gameId,'bvn33');
  assert.equal(reopened.publicRoom(unbound.key).gameId,undefined);
  await reopened.bindGame(unbound.key,'forest');
  await assert.rejects(reopened.bindGame(unbound.key,'ice'),{code:'ROOM_GAME_LOCKED'});
});

test('an unreadable registry fails closed instead of silently starting empty',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'room-registry-bad-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'rooms.json');
  const {writeFile}=await import('node:fs/promises');
  await writeFile(file,'{"version":99,"rooms":{}}');
  await assert.rejects(new RoomRegistry({file}).load(),{code:'ROOM_REGISTRY_INVALID'});
  await writeFile(file,'not json');
  await assert.rejects(new RoomRegistry({file}).load(),{code:'ROOM_REGISTRY_INVALID'});
});
