import test from 'node:test';
import assert from 'node:assert/strict';
import {Html5RoomCore} from '../server/html5-room-core.mjs';
const room=()=>new Html5RoomCore({roomEpoch:'fixture-room-1',inputTimeoutMs:600});
const input=(seq,moveX,buttons=0)=>({type:'input',seq,moveX,moveY:0,buttons});
const pause=(id,paused,revision=0)=>({type:'room-command',command:'pause.set',
  roomEpoch:'fixture-room-1',commandId:id,baseRevision:revision,desiredPaused:paused});
test('members join assigned seats, cannot spoof seat and start only after both are ready',()=>{
  const x=room();assert.equal(x.attach('client-aaaa'),0);
  assert.equal(x.attach('client-bbbb'),1);
  assert.throws(()=>x.attach('client-cccc'),/ROOM_FULL/);
  assert.equal(x.receiveInput('client-aaaa',input(0,1)).code,'NOT_RUNNING');
  x.markReady('client-aaaa');assert.equal(x.running,false);
  x.markReady('client-bbbb');assert.equal(x.running,true);
  assert.equal(x.receiveInput('client-bbbb',{...input(0,-1),slot:0}).accepted,false);
  assert.equal(x.receiveInput('client-bbbb',input(0,-1),100).slot,1);
  assert.equal(x.receiveInput('client-aaaa',input(0,1),100).slot,0);
  assert.deepEqual(x.sample(101).inputs.map(i=>i.moveX),[1,-1]);
});
test('actual quick tap edges survive an input sample and duplicate input is rejected',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');x.markReady('client-aaaa');x.markReady('client-bbbb');
  x.receiveInput('client-aaaa',input(0,0,1),100);
  x.receiveInput('client-aaaa',input(1,0,0),102);
  const result=x.sample(103).inputs[0];
  assert.deepEqual([result.buttons,result.pressed,result.released,result.seq],[0,1,1,1]);
  assert.equal(x.receiveInput('client-aaaa',input(1,0),104).code,'STALE_INPUT');
  assert.equal(x.sample(105).inputs[0].pressed,0);
});
test('timeout instructs the runtime to force release even without a newer sequence',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');x.markReady('client-aaaa');x.markReady('client-bbbb');
  x.receiveInput('client-aaaa',input(10,1,1),100);
  x.sample(101);
  const expired=x.sample(800);
  assert.deepEqual(expired.resets,[0]);
  assert.deepEqual([expired.inputs[0].seq,expired.inputs[0].moveX,expired.inputs[0].buttons],[10,0,0]);
  assert.deepEqual(x.sample(900).resets,[]);
  x.receiveInput('client-aaaa',input(11,1),901);
  assert.equal(x.sample(902).inputs[0].moveX,1);
});
test('pause requires valid room epoch and revision and is idempotent by command id',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');x.markReady('client-aaaa');x.markReady('client-bbbb');
  const initial=x.proposePause('client-aaaa',pause('first',true));
  assert.equal(initial.accepted,true);
  assert.equal(x.userPaused,false,'proposal is not yet applied');
  const receipt=x.commitPause(initial);
  assert.equal(receipt.pauseRevision,1);assert.equal(x.running,false);
  const duplicate=x.proposePause('client-aaaa',pause('first',true));
  assert.equal(duplicate.replayed,true);assert.equal(duplicate.pauseRevision,1);
  assert.equal(x.proposePause('client-bbbb',pause('outdated',false)).code,'STALE_REVISION');
  assert.equal(x.proposePause('client-bbbb',{...pause('bad',false,1),roomEpoch:'older'}).code,'WRONG_EPOCH');
  const resume=x.proposePause('client-bbbb',pause('resume',false,1));
  x.commitPause(resume);assert.equal(x.running,true);assert.equal(x.pauseRevision,2);
});
test('disconnect suspends room and drops pending actions; new client cannot inherit old input',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');x.markReady('client-aaaa');x.markReady('client-bbbb');
  x.receiveInput('client-aaaa',input(3,1,1),100);
  x.detach('client-aaaa');assert.equal(x.effectivePaused,true);
  assert.deepEqual(x.sample(101).inputs[0],{seq:-1,moveX:0,buttons:0,pressed:0,released:0});
  assert.equal(x.attach('client-cccc'),0);
  x.markReady('client-cccc');assert.equal(x.running,true);
  assert.equal(x.receiveInput('client-cccc',input(0,-1),200).accepted,true);
  assert.equal(x.sample(201).inputs[0].moveX,-1);
});
test('invalid HTML5-only actions, wrong sockets and malformed command fields fail',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');x.markReady('client-aaaa');x.markReady('client-bbbb');
  assert.throws(()=>x.receiveInput('fake-client',input(0,1)),/NOT_JOINED/);
  assert.equal(x.receiveInput('client-aaaa',{...input(0,1),moveY:1}).code,'UNSUPPORTED_HTML5_ACTION');
  assert.equal(x.receiveInput('client-aaaa',{...input(0,1),buttons:2}).code,'UNSUPPORTED_HTML5_ACTION');
  assert.equal(x.proposePause('client-aaaa',{...pause('a',true),seat:1}).code,'INVALID_PAUSE_COMMAND');
  assert.equal(x.proposePause('client-aaaa',{...pause('a',true),desiredPaused:'true'}).code,'INVALID_PAUSE_COMMAND');
});

test('real browser packets with validated jump edge fields are normalized and consumed',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');
  x.markReady('client-aaaa');x.markReady('client-bbbb');
  const packet={...input(4,1,0),pressed:1,released:1};
  assert.equal(x.receiveInput('client-aaaa',packet,100).accepted,true);
  const result=x.sample(102).inputs[0];
  assert.deepEqual([result.seq,result.moveX,result.buttons,result.pressed,result.released],[4,1,0,1,1]);
  assert.equal(x.receiveInput('client-aaaa',{...input(5,0),pressed:2},105).code,'INVALID_HTML5_EDGE');
  assert.equal(x.receiveInput('client-aaaa',{...input(5,0),released:-1},106).code,'INVALID_HTML5_EDGE');
  assert.equal(x.receiveInput('client-aaaa',{...input(5,0),pressed:1,slot:1},107).code,'INVALID_INPUT_FIELDS');
});
