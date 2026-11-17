import test from 'node:test';
import assert from 'node:assert/strict';
import {installHtml5Spectator} from '../adapters/fireboy-html5/spectator-projection.mjs';
class Diamond{}
const sprite=(x,y)=>({x,y,rotation:0,alpha:1,visible:true,frameName:'test0000',
 scale:{x:1,y:1},animations:{currentAnim:{isPlaying:true}}});
function fixture(){
  const char=()=>({sprite:sprite(5,6),bodyParts:{head:sprite(0,0),legs:sprite(0,0),ice:sprite(0,0)}});
  const diamond=Object.assign(new Diamond(),sprite(12,13),{sprite:sprite(0,0)});
  const mech={options:{type:'pusher'},button:sprite(60,70),lights:[]};
  const level={pers1:char(),pers2:char(),door1:{sprite:sprite(2,3)},door2:{sprite:sprite(3,4)},
    objects:[mech],pauseKey:{onDown:{remove(){},add(){},has(){return false}}},togglePause(){},
    pauseUpdate(){}};
  const game={level,layers:{underGround:{children:[diamond]}},physics:{box2d:{paused:false}},
    paused:false,input:{enabled:true}};
  const entry=(id,kind,path,x,y)=>({id,kind,sourcePaths:[path],position:{x,y},
    display:{x,y,visible:true,frameName:'test0001',scale:{x:1,y:1}}});
  const snapshot={schemaVersion:1,sessionEpoch:'sess',levelEpoch:1,snapshotSeq:1,
    coverage:{requiredPresent:true,allObservedPositionsFinite:true},
    characters:[entry('a','character','level.pers1',10,20),entry('b','character','level.pers2',30,40)],
    diamonds:[{...entry('c','diamond','game.layers.underGround.children[0]',12,13),
      rootDisplay:{x:12,y:13,visible:true}}],
    doors:[entry('d','door','level.door1',0,0),entry('e','door','level.door2',3,4)],
    mechanisms:[entry('f','pusher','level.objects[0]',60,70)]};
  return {game,diamond,mech,level,snapshot,devices:{Diamond}};
}
test('spectator pauses its own game, maps authority entities and displays new positions',()=>{
  const f=fixture(),bridge=installHtml5Spectator(f.game,{devices:f.devices});
  assert.equal(f.game.paused,true);assert.equal(f.game.input.enabled,false);
  const result=bridge.initialize(f.snapshot);
  assert.equal(result.applied,6);
  assert.equal(f.level.pers1.sprite.x,10);
  assert.equal(f.level.pers2.sprite.y,40);
  assert.equal(f.mech.button.x,60);
  assert.equal(bridge.inspect().entityCount,6);
  assert.equal(bridge.uninstall(),true);
  assert.equal(f.game.input.enabled,true);
});
test('stable identities hide removed diamonds and reject stale snapshot',()=>{
  const f=fixture(),b=installHtml5Spectator(f.game,{devices:f.devices});b.initialize(f.snapshot);
  const next={...f.snapshot,snapshotSeq:2,diamonds:[],characters:[
    {...f.snapshot.characters[0],display:{...f.snapshot.characters[0].display,x:99}},
    f.snapshot.characters[1]]};
  assert.equal(b.apply(next).hiddenDiamonds,1);
  assert.equal(f.diamond.visible,false);
  assert.equal(f.level.pers1.sprite.x,99);
  assert.equal(b.apply(next).accepted,false);
  assert.throws(()=>b.apply({...next,levelEpoch:2}),/epoch/);
});
test('viewer does not invent diamond mapping from constructor names or incomplete baseline',()=>{
  const f=fixture();f.game.layers.underGround.children[0]={constructor:{name:'Diamond'},sprite:sprite(1,2)};
  const b=installHtml5Spectator(f.game,{devices:f.devices});
  assert.throws(()=>b.initialize(f.snapshot),/Diamond class mismatch/);
  b.uninstall();
  const g=fixture(),c=installHtml5Spectator(g.game,{devices:g.devices});
  assert.throws(()=>c.initialize({...g.snapshot,coverage:{requiredPresent:false,allObservedPositionsFinite:true}}),/incomplete/);
});
test('freeze fails closed when local game resumes or scene changes',()=>{
  const f=fixture(),b=installHtml5Spectator(f.game,{devices:f.devices});
  b.initialize(f.snapshot);
  f.game.paused=false;
  assert.throws(()=>b.apply({...f.snapshot,snapshotSeq:2}),/resumed locally/);
  f.game.paused=true;f.game.level={};
  assert.throws(()=>b.inspect(),/scene changed/);
  assert.equal(b.uninstall(),true);
});


test('frozen spectator applies movable box sprite without advancing Box2D',()=>{
  const f=fixture();
  const crate={options:{type:'box'},sprite:sprite(10,15),body:{x:10,y:15}};
  f.level.objects.push(crate);
  f.snapshot.mechanisms.push({...f.snapshot.mechanisms[0],
    id:'crate',kind:'box',sourcePaths:['level.objects[1]'],
    position:{x:10,y:15},display:{x:10,y:15,rotation:0}});
  const bridge=installHtml5Spectator(f.game,{devices:f.devices});
  const first=bridge.initialize(f.snapshot);
  assert.equal(first.applied,7);
  assert.equal(crate.sprite.x,10);
  const next={...f.snapshot,snapshotSeq:2,mechanisms:[
    f.snapshot.mechanisms[0],{...f.snapshot.mechanisms[1],
      position:{x:85,y:21},display:{x:85,y:21,rotation:.3}}]};
  const result=bridge.apply(next);
  assert.equal(result.unknownEntities,0);
  assert.equal(crate.sprite.x,85);
  assert.equal(crate.sprite.rotation,.3);
  assert.equal(f.game.paused,true);
  bridge.uninstall();
});
