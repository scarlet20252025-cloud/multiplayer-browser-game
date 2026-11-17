import test from 'node:test';
import assert from 'node:assert/strict';
import {Html5SceneGuard} from '../server/html5-scene-guard.mjs';
const hash='a'.repeat(64);
const original=()=>({
  schemaVersion:1,sessionEpoch:'server-room-1',sourceGameSha256:hash,
  levelEpoch:1,snapshotSeq:1,
  level:{started:true,sceneName:'level',ended:false},
  characters:[{slot:0,gameplay:{dead:false,dying:false}},
    {slot:1,gameplay:{dead:false,dying:false}}]
});
const next=(base,patch)=>({...base,...patch,snapshotSeq:base.snapshotSeq+1});
test('same scene and increasing snapshot sequence remain active',()=>{
  const base=original(),guard=new Html5SceneGuard(base);
  assert.equal(guard.observe(next(base,{})).status,'active');
  assert.equal(guard.lastSeq,2);
});
test('native level restart via replaced scene root is a latched fail-closed boundary',()=>{
  const base=original(),guard=new Html5SceneGuard(base);
  const result=guard.observe(next(base,{levelEpoch:2}));
  assert.deepEqual([result.status,result.reason],['suspended','LEVEL_EPOCH_CHANGED']);
  assert.equal(guard.observe(next(base,{snapshotSeq:99})).reason,'LEVEL_EPOCH_CHANGED');
});
test('native end and death are separate terminal reasons, not invented restarts',()=>{
  for(const [label,mutate] of [
    ['LEVEL_ENDED',b=>{b.level.ended=true;}],
    ['CHARACTER_DEAD',b=>{b.characters[0].gameplay.dead=true;}],
    ['CHARACTER_DYING',b=>{b.characters[1].gameplay.dying=true;}],
    ['NATIVE_SCENE_CHANGED',b=>{b.level.sceneName='levelMenu';}],
    ['LEVEL_STOPPED',b=>{b.level.started=false;}]
  ]){
    const b=original(),guard=new Html5SceneGuard(b);
    const modified=structuredClone(b);mutate(modified);modified.snapshotSeq=2;
    assert.equal(guard.observe(modified).reason,label,label);
  }
});
test('stale snapshots and cross-build state do not re-arm gameplay',()=>{
  const b=original(),guard=new Html5SceneGuard(b);
  assert.equal(guard.observe({...b,sourceGameSha256:'b'.repeat(64),snapshotSeq:2}).reason,
    'SOURCE_BUILD_CHANGED');
  assert.equal(guard.observe({...b,snapshotSeq:3}).status,'suspended');
  assert.equal(new Html5SceneGuard(b).observe({...b}).reason,'NON_MONOTONIC_SNAPSHOT');
});
test('invalid starting identity is rejected rather than guessing a baseline',()=>{
  assert.throws(()=>new Html5SceneGuard({...original(),level:{started:false}}),/incomplete/);
  assert.throws(()=>new Html5SceneGuard({...original(),sessionEpoch:null}),/incomplete/);
});


test('original dual-door condition distinguishes native win from generic ended state',()=>{
  const before=original();
  before.doors=[{isUp:false},{isUp:false}];
  const guard=new Html5SceneGuard(before);
  const win=structuredClone(before);
  win.snapshotSeq=2;win.level.ended=true;
  win.doors=[{isUp:true},{isUp:true}];
  assert.equal(guard.observe(win).reason,'LEVEL_WON');
});
test('both doors must be raised AND original level ended, not just proximity',()=>{
  const b=original();b.doors=[{isUp:true},{isUp:true}];
  const guard=new Html5SceneGuard(b);
  assert.equal(guard.observe({...b,snapshotSeq:2}).status,'active');
  const incomplete=structuredClone(b);
  incomplete.snapshotSeq=3;incomplete.level.ended=true;
  incomplete.doors[1].isUp=false;
  assert.equal(guard.observe(incomplete).reason,'LEVEL_ENDED');
});
test('native death takes priority over dual-door success when a character is dead',()=>{
  const b=original();const guard=new Html5SceneGuard(b);
  const state=structuredClone(b);state.snapshotSeq=2;
  state.level.ended=true;
  state.doors=[{isUp:true},{isUp:true}];
  state.characters[0].gameplay.dead=true;
  assert.equal(guard.observe(state).reason,'CHARACTER_DEAD');
});
