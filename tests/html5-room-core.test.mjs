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

test('a native scene boundary suspends the whole room and rejects old controls',()=>{
  const core=room();
  core.attach('client-aaaa');core.attach('client-bbbb');
  core.markReady('client-aaaa');core.markReady('client-bbbb');
  core.receiveInput('client-aaaa',input(4,1,1),100);
  assert.equal(core.running,true);
  assert.deepEqual(core.suspend('LEVEL_EPOCH_CHANGED'),
    {changed:true,reason:'LEVEL_EPOCH_CHANGED'});
  assert.equal(core.running,false);
  assert.equal(core.effectivePaused,true);
  assert.equal(core.publicState().suspendedReason,'LEVEL_EPOCH_CHANGED');
  assert.equal(core.receiveInput('client-aaaa',input(5,1),200).code,'ROOM_SUSPENDED');
  assert.equal(core.proposePause('client-bbbb',pause('new',false)).code,'ROOM_SUSPENDED');
  assert.equal(core.sample(201).inputs[0].seq,-1);
  assert.throws(()=>core.markReady('client-aaaa'),/ROOM_SUSPENDED/);
  assert.equal(core.running,false);
  assert.deepEqual(core.suspend('CHARACTER_DEAD'),
    {changed:false,reason:'LEVEL_EPOCH_CHANGED'});
});

test('two authenticated votes start a new round and invalidate previous held inputs',()=>{
  const core=room();core.attach('client-aaaa');core.attach('client-bbbb');
  core.markReady('client-aaaa');core.markReady('client-bbbb');
  core.receiveInput('client-aaaa',input(100,1,1),100);
  core.suspend('CHARACTER_DYING');
  const vote=id=>({type:'room-command',command:'round.restart.vote',
    roomEpoch:'fixture-room-1',roundNumber:0,commandId:id});
  assert.deepEqual(core.voteRestart('client-aaaa',vote('vote-1')),
    {accepted:true,roundNumber:0,votes:1,execute:false,action:'restart'});
  assert.equal(core.voteRestart('client-aaaa',vote('vote-1')).votes,1);
  assert.equal(core.voteRestart('client-bbbb',vote('vote-2')).execute,true);
  assert.equal(core.publicState().restartPending,true);
  const next=core.beginNewRound();
  assert.equal(next.roundNumber,1);
  assert.deepEqual(next.ready,[false,false]);
  assert.equal(next.pauseRevision,1);
  assert.equal(core.running,false);
  assert.equal(core.publicState().suspendedReason,null);
  assert.throws(()=>core.markReady('client-aaaa',0),/WRONG_ROUND/);
  core.markReady('client-aaaa',1);
  assert.equal(core.running,false);
  core.markReady('client-bbbb',1);
  assert.equal(core.running,true);
  assert.equal(core.receiveInput('client-aaaa',input(0,-1),200).accepted,true);
  assert.equal(core.sample(201).inputs[0].moveX,-1);
});
test('restart cannot be spoofed, replayed across round or initiated by one seat',()=>{
  const core=room();core.attach('client-aaaa');core.attach('client-bbbb');
  core.markReady('client-aaaa');core.markReady('client-bbbb');
  const cmd={type:'room-command',command:'round.restart.vote',
    roomEpoch:'fixture-room-1',roundNumber:0,commandId:'x'};
  assert.equal(core.voteRestart('client-aaaa',cmd).code,'ROUND_NOT_SUSPENDED');
  core.suspend('LEVEL_ENDED');
  assert.equal(core.voteRestart('client-aaaa',{...cmd,seat:1}).code,'INVALID_RESTART_COMMAND');
  assert.equal(core.voteRestart('client-aaaa',{...cmd,roundNumber:1}).code,'INVALID_RESTART_COMMAND');
  assert.equal(core.voteRestart('client-aaaa',cmd).votes,1);
  assert.throws(()=>core.beginNewRound(),/NOT_APPROVED/);
  core.detach('client-bbbb');
  assert.equal(core.voteRestart('client-aaaa',cmd).code,'NEED_TWO_MEMBERS');
});


test('return-to-selection requires a second seat and freezes gameplay',()=>{
  const core=room();core.attach('client-aaaa');core.attach('client-bbbb');
  core.markReady('client-aaaa');core.markReady('client-bbbb');
  const cmd=(command,id='r1')=>({type:'room-command',command,
    roomEpoch:'fixture-room-1',roundNumber:0,commandId:id});
  const first=core.voteReturn('client-aaaa',cmd('return.request'));
  assert.equal(first.accepted,true);
  assert.equal(first.returnVotes,1);
  assert.equal(core.voteReturn('client-aaaa',cmd('return.request')).returnVotes,1);
  assert.equal(core.voteReturn('client-aaaa',{...cmd('return.request'),seat:1}).code,
    'INVALID_RETURN_COMMAND');
  assert.equal(core.voteReturn('client-bbbb',cmd('return.request','r3')).code,
    'RETURN_VOTE_PENDING');
  assert.equal(core.voteReturn('client-aaaa',cmd('return.confirm','r4')).code,
    'CANNOT_CONFIRM_OWN');
  const approved=core.voteReturn('client-bbbb',cmd('return.confirm','r5'));
  assert.equal(approved.execute,true);
  assert.equal(approved.returnVotes,2);
  assert.equal(core.returnApproved,true);
  assert.equal(core.running,false);
  assert.equal(core.effectivePaused,true);
  assert.equal(core.receiveInput('client-aaaa',input(0,1),100).code,'NOT_RUNNING');
  assert.equal(core.voteReturn('client-aaaa',cmd('return.request','r6')).code,
    'RETURN_IN_PROGRESS');
});
test('return-to-selection can be cancelled and tolerates a departing seat',()=>{
  const core=room();core.attach('client-aaaa');core.attach('client-bbbb');
  core.markReady('client-aaaa');core.markReady('client-bbbb');
  const cmd=(command,id)=>({type:'room-command',command,
    roomEpoch:'fixture-room-1',roundNumber:0,commandId:id});
  assert.equal(core.voteReturn('client-aaaa',cmd('return.request','a1')).returnVotes,1);
  core.suspend('CHARACTER_DEAD');
  assert.equal(core.voteReturn('client-bbbb',cmd('return.confirm','b1')).execute,true);
  const cancelled=core.voteReturn('client-aaaa',cmd('return.cancel','a2'));
  assert.equal(cancelled.cancelled,true);
  assert.equal(core.returnApproved,false);
  assert.equal(core.publicState().returnRequestedBy,null);
  assert.equal(core.running,false,'death suspension still applies after cancelling');
  core.detach('client-bbbb');
  assert.equal(core.voteReturn('client-aaaa',cmd('return.request','a3')).code,
    'NEED_TWO_MEMBERS');
});
test('a new round clears any prior return vote',()=>{
  const core=room();core.attach('client-aaaa');core.attach('client-bbbb');
  core.markReady('client-aaaa');core.markReady('client-bbbb');
  const ret={type:'room-command',command:'return.request',
    roomEpoch:'fixture-room-1',roundNumber:0,commandId:'return-1'};
  assert.equal(core.voteReturn('client-aaaa',ret).accepted,true);
  core.suspend('CHARACTER_DYING');
  const restart=id=>({type:'room-command',command:'round.restart.vote',
    roomEpoch:'fixture-room-1',roundNumber:0,commandId:id});
  core.voteRestart('client-aaaa',restart('one'));
  core.voteRestart('client-bbbb',restart('two'));
  const next=core.beginNewRound();
  assert.equal(next.returnVotes,0);
  assert.equal(next.returnRequestedBy,null);
  assert.equal(next.returnApproved,false);
});
test('two near-simultaneous P requests atomically toggle the authoritative room',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');
  x.markReady('client-aaaa');x.markReady('client-bbbb');
  const toggle=id=>({type:'room-command',command:'pause.toggle',
    roomEpoch:'fixture-room-1',commandId:id});
  const a=x.proposePauseToggle('client-aaaa',toggle('A-1'));
  assert.equal(a.desiredPaused,true);
  assert.equal(x.commitPause(a).pauseRevision,1);
  // Second viewer still thinks the room is unpaused; its P key must toggle
  // current SERVER state back to false, not submit stale absolute state.
  const b=x.proposePauseToggle('client-bbbb',toggle('B-1'));
  assert.equal(b.desiredPaused,false);
  assert.equal(x.commitPause(b).pauseRevision,2);
  assert.equal(x.running,true);
  assert.equal(x.userPaused,false);
  assert.equal(x.proposePauseToggle('client-aaaa',toggle('A-1')).replayed,true);
  assert.equal(x.pauseRevision,2);
});
test('native pause.toggle rejects malformed, spoofed and suspended commands',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');
  x.markReady('client-aaaa');x.markReady('client-bbbb');
  const cmd={type:'room-command',command:'pause.toggle',
    roomEpoch:'fixture-room-1',commandId:'c-1'};
  assert.equal(x.proposePauseToggle('client-aaaa',{...cmd,slot:1}).code,
    'INVALID_PAUSE_COMMAND');
  assert.equal(x.proposePauseToggle('client-aaaa',{...cmd,roomEpoch:'other'}).code,
    'WRONG_EPOCH');
  x.suspend('CHARACTER_DYING');
  assert.equal(x.proposePauseToggle('client-aaaa',cmd).code,'ROOM_SUSPENDED');
});


test('native dual-door LEVEL_WON is mandatory before two players may advance',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');
  x.markReady('client-aaaa');x.markReady('client-bbbb');
  const vote=(id,action='round.advance.vote')=>({type:'room-command',command:action,
    roomEpoch:'fixture-room-1',roundNumber:0,commandId:id});
  x.suspend('CHARACTER_DYING');
  assert.equal(x.voteRestart('client-aaaa',vote('bad')).code,'NATIVE_WIN_REQUIRED');
  const failed=x.voteRestart('client-aaaa',vote('restart','round.restart.vote'));
  assert.equal(failed.action,'restart');
  assert.equal(x.voteRestart('client-bbbb',vote('mix')).code,'NATIVE_WIN_REQUIRED');
  assert.equal(x.publicState().restartVotes,1);
});
test('death auto-restart needs no votes but still requires a suspended round',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');
  x.markReady('client-aaaa');x.markReady('client-bbbb');
  x.suspend('CHARACTER_DEAD');
  assert.equal(x.prepareAutoRestart().action,'restart');
  assert.equal(x.publicState().restartPending,true);
  const next=x.beginNewRound({force:true});
  assert.equal(next.completedAction,'restart');
  assert.equal(next.roundNumber,1);
  assert.equal(next.suspendedReason,null);
  assert.throws(()=>x.prepareAutoRestart('advance'),/ROUND_NOT_SUSPENDED|NATIVE_WIN_REQUIRED/);
});
test('two valid advance votes select same action, clear old leases and reject mixed intentions',()=>{
  const x=room();x.attach('client-aaaa');x.attach('client-bbbb');
  x.markReady('client-aaaa');x.markReady('client-bbbb');
  x.suspend('LEVEL_WON');
  const vote=(member,action,cmd)=>x.voteRestart(member,{
    type:'room-command',command:action,roomEpoch:'fixture-room-1',
    roundNumber:0,commandId:cmd
  });
  assert.equal(vote('client-aaaa','round.advance.vote','advance-a').action,'advance');
  assert.equal(vote('client-bbbb','round.restart.vote','restart-b').code,'ROUND_ACTION_CONFLICT');
  assert.equal(vote('client-bbbb','round.advance.vote','advance-b').execute,true);
  const newRoom=x.beginNewRound();
  assert.equal(newRoom.completedAction,'advance');
  assert.equal(newRoom.roundNumber,1);
  assert.equal(newRoom.roundAction,null);
  assert.deepEqual(newRoom.ready,[false,false]);
});
