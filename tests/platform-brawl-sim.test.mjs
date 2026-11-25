import assert from 'node:assert/strict';
import test from 'node:test';
import {brawlSnapshot,createBrawl,setBrawlerConnected,stepBrawl} from '../server/platform-brawl-sim.mjs';
import {HEIGHT,SCORE_TO_WIN,TICK_RATE,normalizeBrawlInput} from '../public/platform-brawl/rules.mjs';

function match(playerCount=2){
  const state=createBrawl({playerCount});
  for(let seat=0;seat<playerCount;seat++)setBrawlerConnected(state,seat,true);
  for(const player of state.players)player.protectedUntil=0;
  return state;
}

function advance(state,count){
  for(let i=0;i<count;i++)stepBrawl(state);
}

test('a match creates exactly two to six seats and only applies explicit boolean controls',()=>{
  for(const size of [0,1,7,2.5])assert.throws(()=>createBrawl({playerCount:size}),RangeError);
  const state=match(6);
  assert.equal(state.players.length,6);
  assert.equal(new Set(state.players.map(p=>p.x+':'+p.y)).size,6);
  assert.deepEqual(normalizeBrawlInput({left:1,right:true,jump:'true',light:true,heavy:{}}),
    {left:false,right:true,jump:false,light:true,heavy:false});
});

test('jumping reaches an elevated one-way roof and consumes two separate jump presses',()=>{
  const state=match();
  const player=state.players[0];
  player.x=245;
  stepBrawl(state,[{jump:true}]);
  advance(state,46);
  assert.equal(player.y,302);
  assert.equal(player.grounded,true);
  assert.equal(player.jumps,2);
  stepBrawl(state,[{jump:true}]);
  advance(state,8);
  stepBrawl(state,[{jump:true}]);
  const speed=player.vy;
  stepBrawl(state,[{jump:true}]);
  assert.equal(player.jumps,0);
  assert(player.vy>speed);
  assert(player.y<302);
});

test('a light strike deals damage once while two correctly facing strikes can trade',()=>{
  const state=match();
  const [first,second]=state.players;
  first.x=427;second.x=475;
  stepBrawl(state,[{light:true},{light:true}]);
  advance(state,4);
  assert.deepEqual(state.events.map(({type,source,target})=>[type,source,target]),
    [['hit',0,1],['hit',1,0]]);
  assert.deepEqual(state.players.map(player=>player.damage),[12,12]);
  assert(first.vx<0&&second.vx>0);
  advance(state,9);
  assert.deepEqual(state.players.map(player=>player.damage),[12,12]);
});

test('a player cannot hit behind their facing or hit a protected new spawn',()=>{
  const state=match();
  const [first,second]=state.players;
  first.x=490;second.x=452;
  stepBrawl(state,[{heavy:true}]);
  advance(state,16);
  assert.equal(second.damage,0);
  advance(state,28);
  second.x=530;
  second.protectedUntil=state.tick+60;
  stepBrawl(state,[{heavy:true}]);
  advance(state,16);
  assert.equal(second.damage,0);
});

test('an unassisted fall earns no point and a ring-out from a real strike wins at five',()=>{
  const state=match();
  const [first,second]=state.players;
  second.y=HEIGHT+140;
  stepBrawl(state);
  assert.deepEqual(state.players.map(player=>player.score),[0,0]);
  assert.equal(state.events[0].source,null);
  advance(state,TICK_RATE*2);
  assert.equal(brawlSnapshot(state).players[1].active,true);
  assert.equal(second.damage,0);

  first.score=SCORE_TO_WIN-1;
  first.x=741;
  second.x=793;
  first.y=second.y=427;
  second.protectedUntil=0;
  stepBrawl(state,[{heavy:true}]);
  for(let i=0;i<TICK_RATE*3&&state.phase==='playing';i++)stepBrawl(state);
  const result=brawlSnapshot(state);
  assert.equal(result.phase,'result');
  assert.equal(result.winner,0);
  assert.equal(result.players[0].score,SCORE_TO_WIN);
  assert.deepEqual(result.events.map(({type,source,target})=>[type,source,target]),[['ringout',0,1]]);
  assert.equal(result.remaining,7);

  advance(state,TICK_RATE*7);
  const rematch=brawlSnapshot(state);
  assert.equal(rematch.phase,'playing');
  assert.equal(rematch.round,2);
  assert.equal(rematch.winner,null);
  assert.deepEqual(rematch.players.map(player=>player.score),[0,0]);
});

test('temporary disconnect freezes the same fighter and leaves points intact on return',()=>{
  const state=match();
  const [first]=state.players;
  first.damage=59;first.score=2;
  stepBrawl(state,[{left:true,light:true}]);
  const before=brawlSnapshot(state).players[0];
  setBrawlerConnected(state,0,false);
  advance(state,100);
  assert.equal(brawlSnapshot(state).players[0].active,false);
  setBrawlerConnected(state,0,true);
  const after=brawlSnapshot(state).players[0];
  assert.equal(after.x,before.x);
  assert.equal(after.y,before.y);
  assert.equal(after.damage,59);
  assert.equal(after.score,2);
  assert.equal(after.attack,null);
});

test('the same six-player inputs yield the same wire state across all fixed steps',()=>{
  const first=match(6);
  const second=match(6);
  for(let tick=0;tick<620;tick++){
    const inputs=Array.from({length:6},(_,seat)=>({
      left:(tick+seat*17)%170<70,right:(tick+seat*17)%170>100,
      jump:(tick+seat*7)%41===2,light:(tick+seat*13)%23===3,heavy:(tick+seat*19)%61===7,
    }));
    stepBrawl(first,inputs);
    stepBrawl(second,inputs);
    assert.deepEqual(brawlSnapshot(first),brawlSnapshot(second));
  }
});
