import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {setTimeout} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {MOVE_SPEED, TURN_SPEED, arenaFor, cellCenter, wrapAngle} from '../public/tank-arena/rules.mjs';
import {createTankArenaMatch,mineConfirmationsFor} from '../server/tank-arena-match.mjs';
import {cellOf, pathsFrom} from './tank-arena-paths.mjs';

class MatchPeer extends EventEmitter{
  readyState=WebSocket.OPEN;
  bufferedAmount=0;
  messages=[];
  autoPong=true;
  inputSequence=0;

  get state(){return this.messages.findLast(message=>message.type==='arena');}

  send(payload){this.messages.push(JSON.parse(payload));}
  receive(type,fields={}){this.emit('message',Buffer.from(JSON.stringify({type,...fields})),false);}

  close(code){
    this.closeCode=code;
    this.readyState=WebSocket.CLOSED;
    this.emit('close');
  }

  ping(nonce){
    this.lastProbe=nonce;
    if(this.autoPong)this.emit('pong',nonce);
  }

  terminate(){this.close(1006);}
}

function attach(match,seat){
  const peer=new MatchPeer();
  match.attach(peer,seat);
  assert.deepEqual(peer.messages[0],{type:'seat',seat});
  return peer;
}

async function waitFor(peer,predicate){
  const until=Date.now()+4500;
  while(Date.now()<until){
    if(predicate(peer.state))return peer.state;
    await setTimeout(20);
  }
  assert.fail(`Unexpected match state ${JSON.stringify(peer.state)}`);
}

function matchClock(t){
  let now=0;
  t.mock.method(performance,'now',()=>now);
  t.mock.timers.enable({apis:['setInterval']});
  return {
    advance(milliseconds,beforeTick){
      const until=now+milliseconds;
      for(let tick=0;now<until;tick++){
        beforeTick?.(tick);
        now+=12;
        t.mock.timers.tick(12);
      }
    },
  };
}

function selfRicochet(peer,clock,seq=0){
  function input(turn,fire){peer.receive('input',{seq:seq++,drive:0,turn,fire});}
  clock.advance(1_200,tick=>{if(tick%6===0)input(1,false);});
  input(0,true);
  clock.advance(24);
  input(0,false);
  clock.advance(380);
  return seq;
}

function control(peer,clock,milliseconds,{drive=0,turn=0,fire=false}={}){
  const send=(drive,turn,fire)=>peer.receive('input',{seq:peer.inputSequence++,drive,turn,fire});
  clock.advance(milliseconds,tick=>{if(tick%6===0)send(drive,turn,fire);});
  send(0,0,false);
  clock.advance(48);
}

function killOpponent(peer,clock,shooterSeat,targetSeat){
  const tank=()=>peer.state.tanks[shooterSeat];
  const target=peer.state.tanks[targetSeat];
  const steer=point=>{
    for(let attempt=0;attempt<5;attempt++){
      const {x,y,hull}=tank();
      const rotation=wrapAngle(Math.atan2(point.y-y,point.x-x)-hull);
      if(Math.abs(rotation)<.08)return;
      control(peer,clock,Math.abs(rotation)*1000/TURN_SPEED,{turn:Math.sign(rotation)});
    }
    assert.fail('Tank did not line up with the next point');
  };
  const route=pathsFrom(peer.state.mapSeed,cellOf(tank())).get(cellOf(target).join(','));
  assert(route);
  for(const [col,row] of route.slice(0,-1)){
    const point=cellCenter(col,row);
    for(let attempt=0;attempt<5;attempt++){
      const {x,y,boostRemaining}=tank();
      const distance=Math.hypot(point.x-x,point.y-y);
      if(distance<9)break;
      steer(point);
      const speed=MOVE_SPEED*(boostRemaining>0?1.3:1);
      control(peer,clock,(distance-3)*1000/speed,{drive:1});
    }
    assert(Math.hypot(point.x-tank().x,point.y-tank().y)<13);
  }
  steer(target);
  if(tank().weapon==='mine'){
    control(peer,clock,24,{fire:true});
    control(peer,clock,410,{drive:1});
    steer(target);
  }
  const duration=tank().weapon==='pulse'?760:tank().weapon==='burst'?420:24;
  control(peer,clock,duration,{fire:true});
  for(let attempt=0;attempt<36&&peer.state.phase==='playing';attempt++)clock.advance(36);
  assert.deepEqual(peer.state.blasts[0],{
    id:1,seat:targetSeat,owner:shooterSeat,x:target.x,y:target.y,hull:target.hull,
  });
}

function finishSettling(peer,clock){
  assert.equal(peer.state.phase,'settling');
  clock.advance(Math.ceil(peer.state.phaseRemaining*1000)+120);
}

test('only a mine owner receives its unarmed placement confirmation',()=>{
  const planted={id:1,x:30,y:70,owner:1,armed:false};
  const mines=[{...planted,life:10},{id:2,x:210,y:85,owner:2,armed:true}];
  assert.deepEqual(mineConfirmationsFor(mines,0),[]);
  assert.deepEqual(mineConfirmationsFor(mines,1),[planted]);
  assert.deepEqual(mineConfirmationsFor(mines,2),[]);
  assert.deepEqual(mineConfirmationsFor([{...planted,armed:true}],1),[]);
});

test('each tank client receives its own server-measured latency for a matching WebSocket pong',t=>{
  const clock=matchClock(t);
  const match=createTankArenaMatch({playerCount:2});
  t.after(()=>match.close());
  const peer=new MatchPeer();
  peer.autoPong=false;
  match.attach(peer,0);
  const other=attach(match,1);
  const samples=target=>target.messages.filter(message=>message.type==='latency').map(message=>message.ms);
  assert.deepEqual(samples(peer),[]);
  assert.deepEqual(samples(other),[0]);

  const firstProbe=peer.lastProbe;
  peer.receive('latency',{ms:1});
  peer.emit('pong',Buffer.alloc(1));
  assert.deepEqual(samples(peer),[]);
  clock.advance(84);
  peer.emit('pong',firstProbe);
  assert.deepEqual(samples(peer),[84]);
  assert.deepEqual(samples(other),[0]);

  clock.advance(1_000);
  assert.notDeepEqual(peer.lastProbe,firstProbe);
  peer.emit('pong',firstProbe);
  assert.deepEqual(samples(peer),[84]);
  const time=performance.now();
  clock.advance(72);
  peer.emit('pong',peer.lastProbe);
  assert(samples(peer).at(-1)>=performance.now()-time);
  assert.equal(samples(peer).length,2);
});

test('a missing latency pong drops only that socket and retains its reconnect window',t=>{
  const clock=matchClock(t);
  const match=createTankArenaMatch({playerCount:2});
  t.after(()=>match.close());
  const peer=new MatchPeer();
  peer.autoPong=false;
  match.attach(peer,0);
  const other=attach(match,1);
  clock.advance(10_800);
  assert.equal(peer.readyState,WebSocket.OPEN);
  clock.advance(2_000);
  assert.equal(peer.closeCode,1006);
  assert.deepEqual(other.state.connected,[false,true]);
  assert.equal(match.canAttach(0),true);
  const restored=attach(match,0);
  assert(restored.messages.some(message=>message.type==='latency'&&message.ms===0));
});

test('a congested tank connection skips snapshots and resumes with the latest state',t=>{
  const clock=matchClock(t);
  const match=createTankArenaMatch({playerCount:2});
  t.after(()=>match.close());
  const first=attach(match,0),second=attach(match,1);
  const tick=first.state.tick;
  first.bufferedAmount=40*1024;
  clock.advance(250);
  assert.equal(first.state.tick,tick);
  assert(second.state.tick>tick);
  first.bufferedAmount=0;
  clock.advance(250);
  assert.equal(first.state.tick,second.state.tick);
  assert.equal(first.readyState,WebSocket.OPEN);
});

test('six arena seats can vote to restart in a new mode with a strict online majority',async t=>{
  const playerNames=['A','B','C','D','E','F'];
  const match=createTankArenaMatch({playerNames,levelId:'arena'});
  t.after(()=>match.close());
  const peers=playerNames.map((_,seat)=>attach(match,seat));
  const [first,second,third,fourth]=peers;
  const original=first.state;
  const {width,height}=arenaFor(original.mapSeed,6);
  assert.deepEqual(original.names,playerNames);
  assert.equal(original.width,width);
  assert.equal(original.height,height);
  assert.equal(original.playerCount,6);
  assert.deepEqual(original.connected,Array(6).fill(true));
  assert.equal(first.state.mode,'beacon');
  assert.equal(match.canAttach(6),false);

  for(const peer of [first,second,third])peer.receive('vote-mode',{mode:'deathmatch'});
  assert.equal(first.state.nextMode,null);
  fourth.receive('vote-mode',{mode:'constructor'});
  assert.deepEqual(first.state.modeVotes,['deathmatch','deathmatch','deathmatch',null,null,null]);
  fourth.receive('vote-mode',{mode:'deathmatch'});
  assert.equal(first.state.phase,'switching');
  assert.equal(first.state.nextMode,'deathmatch');
  const state=await waitFor(first,state=>state.series===2);
  assert.equal(state.mode,'deathmatch');
  assert.equal(state.nextMode,null);
  assert.equal(state.remaining,null);
  assert.equal(state.round,1);
  assert.deepEqual(state.scores,Array(6).fill(0));
  assert.deepEqual(state.modeVotes,Array(6).fill(null));
  assert.notEqual(state.mapSeed,original.mapSeed);
});

test('a disconnected arena seat can reconnect while other players keep playing',async t=>{
  let endCode;
  const match=createTankArenaMatch({playerCount:4,onEnd:code=>{endCode=code;}});
  t.after(()=>match.close());
  const [first,second,third,fourth]=Array.from({length:4},(_,seat)=>attach(match,seat));
  await waitFor(first,state=>state.phase==='playing');
  third.close(1006);
  assert.deepEqual(first.state.connected,[true,true,false,true]);
  assert.equal(first.state.paused,false);
  assert.equal(first.state.remaining,null);
  const previous=first.state.tanks[0];
  first.receive('input',{seq:0,drive:1,turn:0,fire:false});
  await waitFor(first,state=>state.tanks[0].x!==previous.x||state.tanks[0].y!==previous.y);

  const reconnected=attach(match,2);
  assert.deepEqual(reconnected.state.connected,[true,true,true,true]);
  match.leaveSeat(3);
  match.leaveSeat(3);
  assert.equal(fourth.messages.at(-1).code,'PLAYERS_LEFT');
  assert.equal(match.canAttach(3),false);
  assert.equal(first.state.dropped[3],true);
  assert.equal(first.state.paused,false);

  reconnected.receive('leave');
  assert.equal(first.state.paused,false);
  second.close(1006);
  assert.equal(first.state.paused,true);
  assert.equal(endCode,undefined);
  const resumed=attach(match,1);
  assert.equal(resumed.state.paused,false);
  resumed.receive('leave');
  assert.equal(endCode,'PLAYERS_LEFT');
  assert.equal(first.messages.at(-1).type,'ended');
});

test('a six-player reservation can start with two ready peers and accepts the rest late',t=>{
  const clock=matchClock(t);
  const match=createTankArenaMatch({playerCount:6});
  t.after(()=>match.close());
  const first=attach(match,0);
  const second=attach(match,1);
  assert.equal(first.state.phase,'waiting');
  assert.deepEqual(first.state.tanks.map(tank=>tank.armor),[1,1,0,0,0,0]);
  clock.advance(4_990);
  assert.equal(first.state.phase,'waiting');
  clock.advance(1_700);
  assert.equal(first.state.phase,'playing');
  assert.equal(first.state.paused,false);
  assert.equal(first.state.dropped[5],false);
  const late=attach(match,5);
  assert.deepEqual(late.state.connected,[true,true,false,false,false,true]);
  assert(late.state.tanks[5].spawnGrace>0);
  first.receive('vote-mode',{mode:'relay'});
  assert.equal(first.state.nextMode,null);
  second.receive('vote-mode',{mode:'relay'});
  assert.equal(late.state.nextMode,'relay');
  clock.advance(2_000);
  const newSeries=late.state;
  assert.equal(newSeries.mode,'relay');
  assert.equal(newSeries.beacon.captureSeconds,1);
  assert.equal(newSeries.beaconMoveRemaining,10);
  assert.equal(newSeries.remaining,null);
  late.close(1006);
  clock.advance(44_900);
  assert.equal(match.canAttach(5),true);
  clock.advance(200);
  assert.equal(match.canAttach(5),false);
  assert.equal(first.state.paused,false);
  assert.equal(first.state.dropped[5],true);
  clock.advance(12_000);
  assert.equal(first.state.dropped[4],true);
  assert.equal(match.canAttach(4),false);
});

test('a finished series automatically continues in the same match on a fresh map',t=>{
  const clock=matchClock(t);
  let ended;
  const match=createTankArenaMatch({playerCount:2,onEnd:code=>{ended=code;}});
  t.after(()=>match.close());
  const first=attach(match,0);
  const second=attach(match,1);
  for(let round=1;round<=3;round++){
    clock.advance(1_700);
    assert.equal(first.state.phase,'playing');
    assert.equal(first.state.round,round);
    assert.equal(first.state.remaining,null);
    killOpponent(second,clock,1,0);
    assert.equal(first.state.phase,'settling');
    assert.equal(first.state.winner,1);
    assert.deepEqual(first.state.scores,[0,round]);
    const blast=first.state.blasts[0];
    assert.equal(blast.seat,0);
    assert.equal(blast.owner,1);
    assert(first.state.phaseRemaining>3&&first.state.phaseRemaining<=4);
    clock.advance(1_500);
    assert.equal(first.state.phase,'settling');
    assert.deepEqual(first.state.blasts[0],blast);
    finishSettling(first,clock);
    if(round<3){assert.equal(first.state.phase,'between');clock.advance(700);}
  }
  assert.equal(first.state.phase,'result');
  assert.equal(first.state.winner,1);
  const stats=first.state.stats;
  assert.deepEqual(stats[0],{score:0,kills:0,deaths:3,wins:0});
  assert.deepEqual({...stats[1],deaths:0},{score:3,kills:3,deaths:0,wins:1});
  assert.equal(first.state.phaseRemaining>0,true);
  const finalMap=first.state.mapSeed;
  const finalMode=first.state.mode;
  second.receive('rematch');
  first.receive('rematch');
  clock.advance(500);
  assert.equal(first.state.phase,'result');
  assert.equal(first.state.series,1);
  assert.equal(Object.hasOwn(first.state,'votes'),false);
  clock.advance(850);
  assert.equal(first.state.phase,'countdown');
  assert.equal(first.state.series,2);
  assert.equal(first.state.round,1);
  assert.equal(first.state.mode,finalMode);
  assert.deepEqual(first.state.scores,[0,0]);
  assert.deepEqual(first.state.stats,stats);
  assert.notEqual(first.state.mapSeed,finalMap);
  assert.equal(second.state.mapSeed,first.state.mapSeed);
  assert.equal(first.messages.filter(message=>message.type==='seat').length,1);
  assert.equal(second.messages.filter(message=>message.type==='seat').length,1);
  assert.equal(ended,undefined);
  clock.advance(1_700);
  assert.equal(first.state.phase,'playing');
});

test('a new player can join an ongoing survival series without changing the running map or score',t=>{
  const clock=matchClock(t);
  const match=createTankArenaMatch({playerNames:['A','B']});
  t.after(()=>match.close());
  const first=attach(match,0);
  const second=attach(match,1);
  clock.advance(1_700);
  killOpponent(second,clock,1,0);
  finishSettling(first,clock);
  clock.advance(800);
  clock.advance(1_500);
  assert.equal(first.state.phase,'playing');
  assert.equal(first.state.round,2);
  assert.deepEqual(first.state.scores,[0,1]);
  const previous=first.state;
  const seat=match.admitPlayer('C');
  assert.equal(seat,2);
  const newcomer=attach(match,seat);
  assert.deepEqual(newcomer.state.names,['A','B','C']);
  assert.deepEqual(newcomer.state.scores,[0,1,0]);
  assert.equal(newcomer.state.phase,'playing');
  assert.equal(newcomer.state.round,2);
  assert.equal(newcomer.state.mapSeed,previous.mapSeed);
  assert.equal(newcomer.state.mapPlayerCount,2);
  assert.equal(newcomer.state.queued[seat],true);
  assert.equal(newcomer.state.tanks[seat].armor,0);
  killOpponent(second,clock,1,0);
  finishSettling(newcomer,clock);
  clock.advance(700);
  assert.equal(newcomer.state.round,3);
  assert.equal(newcomer.state.mapPlayerCount,3);
  assert.equal(newcomer.state.queued[seat],false);
  assert.equal(newcomer.state.tanks[seat].armor,1);
  assert.deepEqual(newcomer.state.scores,[0,2,0]);
});

test('an ongoing respawn mode admits up to six and reuses a relinquished seat',t=>{
  const clock=matchClock(t);
  const dropped=[];
  const match=createTankArenaMatch({playerNames:['A','B'],onSeatDropped:seat=>dropped.push(seat)});
  t.after(()=>match.close());
  const first=attach(match,0);
  const second=attach(match,1);
  first.receive('vote-mode',{mode:'deathmatch'});
  second.receive('vote-mode',{mode:'deathmatch'});
  clock.advance(3_500);
  assert.equal(first.state.phase,'playing');
  const seed=first.state.mapSeed;
  const entrants=['C','D','E','F'].map(name=>attach(match,match.admitPlayer(name)));
  assert.equal(match.canAdmitPlayer(),false);
  assert.equal(match.admitPlayer('G'),null);
  const last=entrants.at(-1).state;
  assert.equal(last.mapSeed,seed);
  assert.equal(last.mapPlayerCount,2);
  assert.deepEqual(last.connected,Array(6).fill(true));
  assert.deepEqual(last.queued,Array(6).fill(false));
  assert(last.tanks.every(tank=>tank.armor===1));
  assert(last.tanks[5].spawnGrace>0);
  match.leaveSeat(3);
  assert.equal(match.canAttach(3),false);
  assert.deepEqual(dropped,[3]);
  const seat=match.admitPlayer('G');
  assert.equal(seat,3);
  const replacement=attach(match,seat);
  assert.deepEqual(replacement.state.names,['A','B','C','G','E','F']);
  assert.equal(replacement.state.scores[seat],0);
  assert.deepEqual(replacement.state.stats[seat],{score:0,kills:0,deaths:0,wins:0});
  assert.equal(replacement.state.mapSeed,seed);
});

test('admission and a winner reconnect preserve the settling blast and original result',t=>{
  const clock=matchClock(t);
  const match=createTankArenaMatch({playerNames:['A','B']});
  t.after(()=>match.close());
  const first=attach(match,0);
  const second=attach(match,1);
  clock.advance(1_700);
  killOpponent(second,clock,1,0);
  const ending=first.state;
  assert.equal(ending.phase,'settling');
  second.close(1006);
  assert.equal(first.state.connected[1],false);
  assert.equal(first.state.tanks[1].armor,0);
  const third=attach(match,match.admitPlayer('C'));
  assert.equal(third.state.queued[2],true);
  assert.equal(third.state.winnerName,'B');
  assert.deepEqual(third.state.blasts,ending.blasts);
  assert.equal(third.state.mapSeed,ending.mapSeed);
  assert.deepEqual(third.state.scores,[0,1,0]);
  const reconnect=attach(match,1);
  assert.equal(reconnect.state.phase,'settling');
  assert.equal(reconnect.state.paused,false);
  const position=({x,y,hull,armor})=>({x,y,hull,armor});
  assert.deepEqual(reconnect.state.tanks.slice(0,2).map(position),ending.tanks.map(position));
  match.leaveSeat(1);
  const replacement=attach(match,match.admitPlayer('D'));
  assert.equal(replacement.state.winner,null);
  assert.equal(replacement.state.winnerName,'B');
  finishSettling(replacement,clock);
  assert.equal(replacement.state.phase,'between');
  assert.equal(replacement.state.winnerName,'B');
  assert.deepEqual(replacement.state.blasts,ending.blasts);
});

test('explicit withdrawal after a decisive hit leaves time for the finishing animation',t=>{
  const clock=matchClock(t);
  let ended;
  const match=createTankArenaMatch({playerNames:['A','B'],onEnd:code=>{ended=code;}});
  t.after(()=>match.close());
  const first=attach(match,0);
  attach(match,1);
  clock.advance(1_700);
  selfRicochet(first,clock);
  match.leaveSeat(1);
  clock.advance(430);
  assert.equal(first.state.phase,'settling');
  assert.equal(first.state.paused,false);
  assert.equal(ended,undefined);
  finishSettling(first,clock);
  assert.equal(ended,'PLAYERS_LEFT');
});

test('a self-destruction scores no point and the surviving tank can keep playing during settling',t=>{
  const clock=matchClock(t);
  const match=createTankArenaMatch({playerNames:['A','B']});
  t.after(()=>match.close());
  const first=attach(match,0);
  const winner=attach(match,1);
  clock.advance(1_700);
  selfRicochet(first,clock);
  assert.equal(winner.state.phase,'settling');
  assert(winner.state.phaseRemaining>3.5&&winner.state.phaseRemaining<=4);
  const {stats,blasts,scores,winner:winnerSeat}=winner.state;
  assert.equal(winnerSeat,null);
  assert.equal(winner.state.reason,'self-destruction');
  assert.deepEqual(scores,[0,0]);
  assert.deepEqual(stats,[{score:0,kills:0,deaths:1,wins:0},{score:0,kills:0,deaths:0,wins:0}]);
  first.close(1006);
  clock.advance(1_250);
  assert.equal(winner.state.phase,'settling');
  assert.deepEqual(winner.state.connected,[false,true]);
  assert.equal(winner.state.paused,false);
  const start=winner.state.tanks[1];
  winner.receive('input',{seq:0,drive:1,turn:0,fire:true});
  clock.advance(100);
  assert(winner.state.tanks[1].x<start.x);
  assert(winner.state.shots.some(shot=>shot.owner===1));
  winner.receive('input',{seq:1,drive:0,turn:0,fire:false});
  clock.advance(450);
  // The return shot can still destroy the surviving tank after the result is decided.
  selfRicochet(winner,clock,2);
  clock.advance(80);
  assert.equal(winner.state.phase,'settling');
  assert.equal(winner.state.tanks[0].armor,0);
  assert.equal(winner.state.tanks[1].armor,0);
  assert.equal(winner.state.winner,null);
  assert.deepEqual(winner.state.scores,scores);
  const settledStats=[stats[0],{...stats[1],deaths:stats[1].deaths+1}];
  assert.deepEqual(winner.state.stats,settledStats);
  assert.deepEqual(winner.state.blasts.slice(0,1),blasts);
  assert.deepEqual(winner.state.blasts.slice(1).map(({seat,owner})=>[seat,owner]),[[1,1]]);
  const returning=attach(match,0);
  finishSettling(winner,clock);
  assert.equal(returning.state.phase,'between');
  assert.equal(returning.state.round,1);
  clock.advance(720);
  assert.equal(winner.state.phase,'countdown');
  assert.equal(winner.state.round,2);
  assert.deepEqual(winner.state.stats,settledStats);
});
