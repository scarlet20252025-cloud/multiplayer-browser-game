import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJumpTrace } from '../adapters/fireboy-html5/jump-analysis.mjs';
import { installJumpObserver } from '../adapters/fireboy-html5/jump-observer.mjs';

// Invented trajectories, never an execution of the original game's rules.
function fixture({ repeat = false, neverLands = false, noRelease = false } = {}) {
  let time = 0; let step = 0;
  const samples = [];
  for (const [phase,count] of [['settle',20],['hold',101],['release',15],['repress',101]]) {
    for (let i=0;i<count;i++) {
      const up = phase === 'hold' || phase === 'repress';
      const offset = repeat && phase === 'hold' ? i % 50 : i;
      const height = up && offset < 40 ? 90*Math.sin(Math.PI*offset/40) : (neverLands && phase === 'hold' ? 60 : 0);
      samples.push({kind:'after-physics-step',phase,timeMs:time,observedPhysicsSteps:++step,
        gamePaused:false,physicsPaused:false,sameLevel:true,sameCharacters:true,
        fire:{x:100,y:500,up:false,prohibitJump:false,feetContacts:1},
        water:{x:200,y:500-height,up,prohibitJump:up || (noRelease && phase==='release'),feetContacts:height<1?1:0,dying:false,dead:false}});
      time+=20;
    }
  }
  return {samples,errors:[]};
}
test('complete landings and a consumed release establish two distinct presses',()=>{
  const result=analyzeJumpTrace(fixture());
  assert.equal(result.status,'passed');
  assert.equal(result.phases.hold.excursions.length,1);
  assert.equal(result.phases.repress.excursions.length,1);
  assert.equal(result.releaseConsumed,true);
});
test('an unpressed phase boundary sharing the press timestamp is outside the held window',()=>{
  const data=fixture();
  for(const phase of ['hold','repress']){
    const index=data.samples.findIndex(row=>row.phase===phase);
    const boundary=structuredClone(data.samples[index]);
    boundary.kind='phase-boundary';
    boundary.observedPhysicsSteps--;
    boundary.water.up=false;
    boundary.water.prohibitJump=false;
    const press=structuredClone(boundary);
    press.kind='input-write';
    press.water.up=true;
    data.samples.splice(index,0,boundary,press);
  }
  const result=analyzeJumpTrace(data);
  assert.equal(result.status,'passed');
  assert.deepEqual(result.blockers,[]);
  for(const phase of ['hold','repress'])assert.equal(result.phases[phase].durationMs,2000);
});
test('an intervening release cannot disappear when its timestamp matches held observations',()=>{
  for(const phase of ['hold','repress']){
    const data=fixture();
    const held=data.samples.filter(row=>row.phase===phase)[50];
    const release=structuredClone(held);
    release.kind='input-write';
    release.water.up=false;
    const press=structuredClone(release);
    press.water.up=true;
    data.samples.splice(data.samples.indexOf(held)+1,0,release,press);
    const result=analyzeJumpTrace(data);
    assert.equal(result.status,'blocked');
    assert.ok(result.blockers.includes(`${phase}: input was released or game/physics was paused`));
  }
});
test('auto jumping while held fails, even when there are only two input writes',()=>{
  assert.equal(analyzeJumpTrace(fixture({repeat:true})).status,'failed');
});
test('a character still airborne after two seconds cannot prove absence of repeat jumps',()=>{
  assert.equal(analyzeJumpTrace(fixture({neverLands:true})).status,'blocked');
});
test('release must be consumed by gameplay and clear the latch',()=>{
  assert.equal(analyzeJumpTrace(fixture({noRelease:true})).status,'blocked');
});
test('a release observation outside the interval between presses cannot establish the edge',()=>{
  const data=fixture();
  data.samples=data.samples.filter(row=>row.phase!=='release').concat(data.samples.filter(row=>row.phase==='release'));
  data.samples.forEach((row,index)=>{row.timeMs=index*20;row.observedPhysicsSteps=index+1;});
  assert.notEqual(analyzeJumpTrace(data).status,'passed');
});
test('brief ground contact followed by falling cannot satisfy the held-ground window',()=>{
  const data=fixture();
  const hold=data.samples.filter(row=>row.phase==='hold');
  hold.slice(45).forEach((row,index)=>{row.water.y=510+index;row.water.feetContacts=0;});
  assert.notEqual(analyzeJumpTrace(data).status,'passed');
});
test('a final wall-time observation cannot conceal a long gap without physics',()=>{
  const data=fixture();
  for(const phase of ['hold','repress']){
    const group=data.samples.filter(row=>row.phase===phase);
    group.slice(70).forEach(row=>{row.kind='observation';});
  }
  assert.notEqual(analyzeJumpTrace(data).status,'passed');
});
test('missing physics steps cannot be hidden by a short wall-clock gap',()=>{
  const data=fixture();data.samples.splice(32,1);
  assert.notEqual(analyzeJumpTrace(data).status,'passed');
});
test('paused or sparse samples do not establish live jump behavior',()=>{
  const paused=fixture();paused.samples.find(row=>row.phase==='hold').gamePaused=true;
  assert.equal(analyzeJumpTrace(paused).status,'blocked');
  const sparse=fixture();sparse.samples=sparse.samples.filter((row,index)=>index%25===0);
  assert.notEqual(analyzeJumpTrace(sparse).status,'passed');
});
test('NaN, character replacement, and observer errors cannot pass',()=>{
  for(const mutate of [row=>{row.water.y=NaN;},row=>{row.sameCharacters=false;}]){
    const data=fixture();mutate(data.samples[30]);
    assert.notEqual(analyzeJumpTrace(data).status,'passed');
  }
  const data=fixture();data.errors.push('recording failed');
  assert.notEqual(analyzeJumpTrace(data).status,'passed');
});
test('observer delegates actual Step with its original receiver, parameters and return value',()=>{
  const character=()=>({body:{x:0,y:10},cursors:{up:{isDown:false}},feetSensor:{contacts:[{}]}});
  const world={count:0,Step(dt,v,p){assert.equal(this,world);assert.deepEqual([dt,v,p],[0.02,8,3]);this.count++;return 42;}};
  const native=world.Step;
  const game={paused:false,level:{pers1:character(),pers2:character()},physics:{box2d:{paused:false,world}}};
  const observer=installJumpObserver(game);
  assert.equal(world.Step(0.02,8,3),42);
  observer.setPhase('hold');observer.setJump(true);
  assert.equal(game.level.pers2.cursors.up.isDown,true);
  assert.equal(game.level.pers1.cursors.up.isDown,false);
  assert.equal(observer.read().observedPhysicsSteps,1);
  assert.equal(observer.read().samples[0].stepSeconds,0.02);
  observer.stop();observer.stop();
  assert.equal(world.Step,native);assert.equal(game.level.pers2.cursors.up.isDown,false);
});
